import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GOOGLE_HOSTS = ["gmail.googleapis.com", "oauth2.googleapis.com", "accounts.google.com"];

interface GmailDraft {
  id: string;
  to: string;
  subject: string;
  body: string;
}

interface GoogleState {
  drafts: GmailDraft[];
  tokenGrants: string[];
  rejectedApiCalls: number;
}

export interface FakeGoogle {
  clientId: string;
  clientSecret: string;
  grant(opts: { expired: boolean }): { accessToken: string; refreshToken: string; expiresAt: number };
  revoke(refreshToken: string): void;
  state(): GoogleState;
  close(): Promise<void>;
}

interface Grant {
  access: string;
  refresh: string;
  accessExpiresAt: number;
  revoked: boolean;
}

function serveGoogle(clientId: string, clientSecret: string, tls: { key: string; cert: string }) {
  const grants: Grant[] = [];
  const codes = new Map<string, string>();
  const state: GoogleState = { drafts: [], tokenGrants: [], rejectedApiCalls: 0 };
  const token = () => `ya29.${randomBytes(12).toString("hex")}`;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  const issue = (expired: boolean): Grant => {
    const g = {
      access: token(),
      refresh: `1//${randomBytes(12).toString("hex")}`,
      accessExpiresAt: Date.now() + (expired ? -60_000 : 3_600_000),
      revoked: false,
    };
    grants.push(g);
    return g;
  };
  const authorize = (url: URL, res: ServerResponse) => {
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    if (url.searchParams.get("client_id") !== clientId || !redirect) return json(res, 400, { error: "invalid_client" });
    const code = `4/${randomBytes(8).toString("hex")}`;
    codes.set(code, redirect);
    const dest = new URL(redirect);
    dest.searchParams.set("code", code);
    dest.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: dest.toString() });
    res.end();
  };
  const tokenEndpoint = (form: URLSearchParams, res: ServerResponse) => {
    const grantType = form.get("grant_type") ?? "";
    state.tokenGrants.push(grantType);
    if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret)
      return json(res, 401, { error: "invalid_client" });
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      if (codes.get(code) !== form.get("redirect_uri"))
        return json(res, 400, { error: "invalid_grant", error_description: "Bad Request" });
      codes.delete(code);
      const g = issue(false);
      return json(res, 200, {
        access_token: g.access,
        refresh_token: g.refresh,
        expires_in: 3599,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.modify openid email",
      });
    }
    const g = grants.find((x) => x.refresh === form.get("refresh_token") && !x.revoked);
    if (grantType !== "refresh_token" || !g)
      return json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    g.access = token();
    g.accessExpiresAt = Date.now() + 3_600_000;
    return json(res, 200, { access_token: g.access, expires_in: 3599, token_type: "Bearer" });
  };
  const createDraft = (req: IncomingMessage, body: string, res: ServerResponse) => {
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!grants.some((x) => x.access === bearer && x.accessExpiresAt > Date.now())) {
      state.rejectedApiCalls++;
      return json(res, 401, {
        error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" },
      });
    }
    const raw = Buffer.from(String(JSON.parse(body).message?.raw ?? ""), "base64url").toString("utf8");
    const [head = "", ...rest] = raw.split(/\r?\n\r?\n/);
    const header = (name: string) =>
      head
        .split(/\r?\n/)
        .find((l) => l.toLowerCase().startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim() ?? "";
    const draft = {
      id: `r${randomBytes(6).toString("hex")}`,
      to: header("to"),
      subject: header("subject"),
      body: rest.join("\n\n").trim(),
    };
    state.drafts.push(draft);
    return json(res, 200, { id: draft.id, message: { id: randomBytes(8).toString("hex"), labelIds: ["DRAFT"] } });
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = String(req.headers["x-fake-host"] ?? req.headers.host ?? "").split(":")[0];
    const url = new URL(req.url ?? "/", `https://${host}`);
    const body = await read(req);
    const route = `${req.method} ${host}${url.pathname}`;
    if (route === "GET accounts.google.com/o/oauth2/v2/auth") return authorize(url, res);
    if (route === "POST oauth2.googleapis.com/token") return tokenEndpoint(new URLSearchParams(body), res);
    if (route === "POST gmail.googleapis.com/gmail/v1/users/me/drafts") return createDraft(req, body, res);
    return json(res, 404, { error: { code: 404, message: `no route ${route}` } });
  };
  const plain = createHttpServer((req, res) => void handle(req, res));
  const secure = createHttpsServer(tls, (req, res) => void handle(req, res));
  return { plain, secure, state, issue, grants };
}

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const dir = mkdtempSync(join(tmpdir(), "fake-google-"));
  const san = GOOGLE_HOSTS.map((h) => `DNS:${h}`).join(",");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=googleapis.com"].concat([
      "-addext",
      `subjectAltName=${san}`,
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ]),
    { stdio: "ignore" },
  );
  const clientId = `${randomBytes(6).toString("hex")}.apps.googleusercontent.com`;
  const clientSecret = `GOCSPX-${randomBytes(9).toString("hex")}`;
  const google = serveGoogle(clientId, clientSecret, {
    key: readFileSync(join(dir, "key.pem"), "utf8"),
    cert: readFileSync(join(dir, "cert.pem"), "utf8"),
  });
  const ports = { http: await listen(google.plain), https: await listen(google.secure) };
  const origin = `http://127.0.0.1:${ports.http}`;
  writeFileSync(
    join(dir, ".curlrc"),
    [
      ...GOOGLE_HOSTS.map((h) => `connect-to = ${h}:443:127.0.0.1:${ports.https}`),
      `cacert = ${join(dir, "cert.pem")}`,
      `noproxy = ${[...GOOGLE_HOSTS, "127.0.0.1", "localhost"].join(",")}`,
      "",
    ].join("\n"),
  );
  const previousCurlHome = process.env.CURL_HOME;
  process.env.CURL_HOME = dir;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.protocol !== "https:" || !GOOGLE_HOSTS.includes(url.hostname)) return previousFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("x-fake-host", url.hostname);
    return previousFetch(`${origin}${url.pathname}${url.search}`, { ...init, headers });
  }) as typeof fetch;
  return {
    clientId,
    clientSecret,
    grant({ expired }) {
      const g = google.issue(expired);
      return { accessToken: g.access, refreshToken: g.refresh, expiresAt: g.accessExpiresAt };
    },
    revoke(refreshToken) {
      for (const g of google.grants) if (g.refresh === refreshToken) g.revoked = true;
    },
    state: () => structuredClone(google.state),
    async close() {
      globalThis.fetch = previousFetch;
      if (previousCurlHome === undefined) delete process.env.CURL_HOME;
      else process.env.CURL_HOME = previousCurlHome;
      google.plain.closeAllConnections();
      google.secure.closeAllConnections();
      await Promise.all([google.plain, google.secure].map((x) => new Promise((r) => x.close(r))));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
