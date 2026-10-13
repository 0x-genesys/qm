import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { test } from "node:test";
import { createServer } from "../../src/api/server.ts";
import { orgId } from "../../src/config.ts";
import { PROVIDERS } from "../../src/connectors/oauth.ts";
import { scopeId } from "../../src/types.ts";
import { serverDeps } from "../../src/wiring.ts";
import { signedHeaders, withSourceAuthNonce } from "../../plugins/chassis/src/core-client.ts";
import type { ModelReply, ModelRequest } from "./support/fake-gateway.ts";
import { startFakeGoogle, type FakeGoogle } from "./support/fake-google.ts";
import { journeyTestOptions, startJourneyApp, type JourneyApp } from "./support/journey-app.ts";

const ACTOR = "founder@example.com";
const SECRET = "journey-w3-source-signing-secret".repeat(2);
const GMAIL = "connector:gmail.googleapis.com:default";
const DRAFT_PURPOSE = "Save Gmail draft";
const SUBJECT = "Design partner pilot next Tuesday";
const BODY = "Hi Dana, thanks for the call today. Could we start the pilot next Tuesday?";
const ASK = `Draft an email to dana@example.com with the subject "${SUBJECT}" saying: ${BODY}`;
const CONNECT_URL = /https?:\/\/\S+\/connect\/redeem\/[A-Za-z0-9-]+\?p=google/g;

type Block = { type?: string; content?: unknown; text?: string };

interface Harness {
  app: JourneyApp;
  google: FakeGoogle;
  api: string;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startHarness(): Promise<Harness> {
  const google = await startFakeGoogle();
  const api = `http://127.0.0.1:${await freePort()}`;
  const app = await startJourneyApp(
    { maxRequestBytes: 10 * 1024 * 1024, contextWindowTokens: 200_000, maxOutputTokens: 32_000 },
    { signingSecret: SECRET, apiBaseUrl: api, publicUrl: api },
  );
  await app.built.config.setConnectorClient(scopeId("org", orgId()), "google", {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
  });
  const server: Server = createServer(app.built.app, serverDeps(app.config, app.built));
  await new Promise<void>((resolve) => server.listen(Number(new URL(api).port), "127.0.0.1", resolve));
  return {
    app,
    google,
    api,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.stop();
      await google.close();
    },
  };
}

async function connectGoogle(h: Harness, token: { accessToken: string; refreshToken: string; expiresAt: number }) {
  for (const host of PROVIDERS.google!.hosts)
    await h.app.built.connectorTokens.setConnectorToken(
      host,
      ACTOR,
      { ...token, clientRef: `org:${orgId()}:google`, accountType: "default", orgId: orgId() },
      "default",
    );
}

function text(block: Block | undefined): string {
  if (!block) return "";
  if (typeof block.content === "string") return block.content;
  if (typeof block.text === "string") return block.text;
  return Array.isArray(block.content) ? (block.content as Block[]).map(text).join("") : "";
}

function lastToolResult(req: ModelRequest): string | undefined {
  const last = req.messages.at(-1);
  if (last?.role !== "user" || !Array.isArray(last.content)) return undefined;
  const result = (last.content as Block[]).filter((b) => b.type === "tool_result").at(-1);
  return result ? text(result) : undefined;
}

function lastPurpose(req: ModelRequest): string | undefined {
  const last = req.messages.at(-2);
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return undefined;
  const call = (last.content as Array<{ type?: string; input?: { purpose?: string } }>).find(
    (b) => b.type === "tool_use",
  );
  return call?.input?.purpose;
}

function latestSection(req: ModelRequest, heading: string): string {
  const all = req.messages.flatMap((m) =>
    Array.isArray(m.content) ? (m.content as Block[]).map(text) : [String(m.content)],
  );
  const hit = all.filter((t) => t.includes(heading)).at(-1) ?? "";
  return hit.slice(hit.lastIndexOf(heading)).split("\n## ")[0]!;
}

const draftCommand = [
  `raw=$(printf 'To: dana@example.com\\r\\nSubject: ${SUBJECT}\\r\\nContent-Type: text/plain; charset=UTF-8\\r\\n\\r\\n${BODY}\\r\\n' | base64 -w0 | tr '+/' '-_' | tr -d '=')`,
  `curl -sS -X POST https://gmail.googleapis.com/gmail/v1/users/me/drafts -H "Authorization: Bearer $VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM" -H 'content-type: application/json' -d "{\\"message\\":{\\"raw\\":\\"$raw\\"}}"`,
].join("\n");

const mintCommand = `curl -sS -X POST "$AGENT_API_URL/v1/connectors/oauth/consent/mint" -H "X-Agent-Capability: $AGENT_OAUTH_CONSENT_TOKEN" -H 'content-type: application/json' -d '{"provider":"google"}'`;

function assistant(sandbox: { id: string }) {
  return (req: ModelRequest): ModelReply => {
    if (JSON.stringify(req.system).includes("security boundary classifier")) return { text: '{"decision":"auto"}' };
    if (!req.tools?.length) return { text: "Gmail draft" };
    const result = lastToolResult(req);
    if (!sandbox.id && result === undefined)
      return { tool: "sandbox", input: { action: "create", backend: "sprites", purpose: "Computer for email" } };
    if (!sandbox.id) {
      sandbox.id = /"id":"([^"]+)"/.exec(result ?? "")?.[1] ?? "";
      if (!sandbox.id) return { text: `No computer: ${result}` };
      return { tool: "sandbox", input: { action: "set_default", sandbox_id: sandbox.id, purpose: "Use computer" } };
    }
    const draft = /"id":\s*"(r[0-9a-f]+)"/.exec(result ?? "");
    if (draft) return { text: `Saved a Gmail draft to Dana titled "${SUBJECT}" (draft ${draft[1]}).` };
    const link = /"connectUrl":\s*"([^"]+)"/.exec(result ?? "");
    if (link)
      return { text: `Google needs to be reconnected before I can save the draft. Open ${link[1]} and tap Allow.` };
    const handleOffered = latestSection(req, "## Credentials").includes(`\`${GMAIL}\``);
    if (handleOffered && lastPurpose(req) !== DRAFT_PURPOSE)
      return {
        tool: "execute",
        input: { command: draftCommand, credentials: [GMAIL], sandbox_id: sandbox.id, purpose: DRAFT_PURPOSE },
      };
    return { tool: "execute", input: { command: mintCommand, sandbox_id: sandbox.id, purpose: "Mint Google link" } };
  };
}

async function tapConnectLink(h: Harness, url: string): Promise<void> {
  const linkId = new URL(url).pathname.split("/").at(-1)!;
  const path = withSourceAuthNonce(`/v1/connectors/oauth/consent/redeem/${encodeURIComponent(linkId)}`, SECRET);
  const redeemed = (await (
    await fetch(`${h.api}${path}`, { headers: { ...signedHeaders(SECRET, "GET", path), "x-consent-clicker": ACTOR } })
  ).json()) as { status: string; authorizeUrl?: string };
  assert.equal(redeemed.status, "authorize", `the link opens Google consent: ${JSON.stringify(redeemed)}`);
  const consent = await fetch(redeemed.authorizeUrl!, { redirect: "manual" });
  assert.equal(consent.status, 302, "Google accepts the consent request");
  const callback = await fetch(consent.headers.get("location")!, { redirect: "manual" });
  assert.ok(callback.status < 400, `the OAuth callback succeeds: ${await callback.text()}`);
}

async function draftTurn(h: Harness, threadRef: string, ask = ASK) {
  const result = await h.app.webTurn(ACTOR, threadRef, ask);
  assert.equal(result.status, "ok", `turn failed: ${result.reason}`);
  return result.reply ?? "";
}

test("a Google draft is created through the connector", journeyTestOptions(120_000), async () => {
  const h = await startHarness();
  try {
    await connectGoogle(h, h.google.grant({ expired: false }));
    h.app.gateway.respond = assistant({ id: "" });
    const reply = await draftTurn(h, `web:${ACTOR}:w3-fresh-${Date.now()}`);
    const { drafts, tokenGrants } = h.google.state();
    assert.equal(drafts.length, 1, "one draft exists in Gmail");
    assert.deepEqual(
      { to: drafts[0]!.to, subject: drafts[0]!.subject, body: drafts[0]!.body },
      { to: "dana@example.com", subject: SUBJECT, body: BODY },
    );
    assert.ok(reply.includes(drafts[0]!.id), `the reply confirms the draft: ${reply}`);
    assert.deepEqual(tokenGrants, [], "a valid token needs no refresh");
  } finally {
    await h.close();
  }
});

test(
  "an expired Google token refreshes silently and the draft is created in the same turn",
  journeyTestOptions(120_000),
  async () => {
    const h = await startHarness();
    try {
      const stale = h.google.grant({ expired: true });
      await connectGoogle(h, stale);
      h.app.gateway.respond = assistant({ id: "" });
      const reply = await draftTurn(h, `web:${ACTOR}:w3-refresh-${Date.now()}`);
      const { drafts, tokenGrants, rejectedApiCalls } = h.google.state();
      assert.deepEqual(tokenGrants, ["refresh_token"], "the stored refresh token was used once");
      assert.equal(rejectedApiCalls, 0, "Gmail never saw the expired token");
      assert.equal(drafts.length, 1, "the draft exists in Gmail");
      assert.equal(drafts[0]!.subject, SUBJECT);
      assert.ok(reply.includes(drafts[0]!.id), `the reply confirms the draft: ${reply}`);
      assert.doesNotMatch(reply, CONNECT_URL, "the user is not asked to reconnect");
    } finally {
      await h.close();
    }
  },
);

test(
  "a revoked Google grant gets one reconnect link, and the draft succeeds after reconnecting",
  journeyTestOptions(120_000),
  async () => {
    const h = await startHarness();
    try {
      const stale = h.google.grant({ expired: true });
      h.google.revoke(stale.refreshToken);
      await connectGoogle(h, stale);
      h.app.gateway.respond = assistant({ id: "" });
      const threadRef = `web:${ACTOR}:w3-reconnect-${Date.now()}`;
      const first = await draftTurn(h, threadRef);
      const links = first.match(CONNECT_URL) ?? [];
      assert.equal(links.length, 1, `the user gets exactly one reconnect link: ${first}`);
      assert.equal(h.google.state().drafts.length, 0, "no draft was saved with a dead grant");
      assert.equal(h.google.state().rejectedApiCalls, 0, "the dead token was never sent to Gmail");
      await tapConnectLink(h, links[0]!);
      const second = await draftTurn(h, threadRef, "Done, I reconnected Google. Please save that draft now.");
      const { drafts } = h.google.state();
      assert.equal(drafts.length, 1, "the draft exists in Gmail after reconnecting");
      assert.equal(drafts[0]!.subject, SUBJECT);
      assert.ok(second.includes(drafts[0]!.id), `the reply confirms the draft: ${second}`);
      assert.doesNotMatch(second, CONNECT_URL, "no second reconnect prompt");
    } finally {
      await h.close();
    }
  },
);
