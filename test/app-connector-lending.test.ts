import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, deploymentView } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { personalScope, scopeId } from "../src/types.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../src/auth/portal-identity.ts";
import { VIEWER_ATTESTATION_HEADER, viewerAttestationKey, viewerIdentityKey } from "../src/deploy/access-token.ts";
import {
  CONTROL_PLANE_AUD,
  CREDENTIAL_BROKER_AUD,
  DEPLOYMENT_CREDENTIAL_TTL_MS,
  mintCapabilityToken,
} from "../src/auth/capability-token.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { singleProcessDeps } from "./support/single-process.ts";

const SIGNING = "s".repeat(64);
const SESSION_SECRET = "portal-session-secret";
const GMAIL = "gmail.googleapis.com";
const PUBLISHER = "pub@example.com";
const VIEWER = "viewer@example.com";
const PUBLISHER_TOKEN = "publisher-oauth-access-token";

function portalCookie(sub: string): string {
  const key = createHmac("sha256", SESSION_SECRET).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + 3600 })).toString(
    "base64url",
  );
  return `portal_session=${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function visit(port: number, sub: string, extra: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "localhost",
        port,
        path: "/",
        method: "GET",
        headers: { Host: "mailer.apps.example.com", Cookie: portalCookie(sub), ...extra },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const audits: AuditEvent[] = [];
  const auditLog = {
    record: (e: AuditEvent) => void audits.push(e),
    recordOnce: async (_key: string, e: AuditEvent) => void audits.push(e),
    events: async () => [],
    tail: async () => [],
  };
  const seenByApp: Array<Record<string, string | string[] | undefined>> = [];
  const upstreamApp = createHttpServer((req, res) => {
    seenByApp.push({ ...req.headers });
    res.end("ok");
  });
  await new Promise<void>((resolve) => upstreamApp.listen(0, resolve));
  const acl = createAclStore();
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: (upstreamApp.address() as AddressInfo).port }),
      destroy: async () => {},
    },
    auditLog,
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "connector-lending-")),
  });
  const app = createApp({
    deploy,
    acl,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({
    ownerScopeId: scopeId("org", "default-org"),
    createdBy: PUBLISHER,
    entrypoint: "x",
    files: [],
    name: "mailer",
  });
  let publisherToken: string | null = PUBLISHER_TOKEN;
  const upstreamCalls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const server = createServer(app, {
    signingSecret: SIGNING,
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    deployAppsSessionSecret: SESSION_SECRET,
    deployAppsLoginUrl: "https://portal.example.com",
    auditLog,
    keychain: {
      connectorAccessToken: async (host: string, principalId: string, accountType?: string) =>
        host === GMAIL && principalId === PUBLISHER && accountType === "personal" ? publisherToken : null,
    } as never,
    brokerFetch: async (url, init) => {
      upstreamCalls.push({ url, ...init });
      return { status: 200, contentType: "application/json", text: async () => '{"id":"m1"}' };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamApp.close(() => resolve()));
  });
  const appToken = await mintCapabilityToken(
    {
      actorId: PUBLISHER,
      scopeId: personalScope(PUBLISHER),
      aud: CREDENTIAL_BROKER_AUD,
      credentials: [],
      deployment: d.id,
      exp: Date.now() + DEPLOYMENT_CREDENTIAL_TTL_MS,
    },
    SIGNING,
  );
  const broker = async (body: Record<string, unknown>, token = appToken) => {
    const res = await fetch(`http://localhost:${port}/v1/credentials/broker`, {
      method: "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const lend = async (actorId: string, connectors: unknown, liveActor = true) => {
    const token = await mintCapabilityToken(
      {
        actorId,
        scopeId: personalScope(actorId),
        aud: CONTROL_PLANE_AUD,
        ...(liveActor ? { liveActor: true } : {}),
        exp: Date.now() + 60_000,
      },
      SIGNING,
    );
    const res = await fetch(`http://localhost:${port}/v1/deployments/${d.id}/connectors`, {
      method: "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      body: JSON.stringify({ connectors }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return {
    d,
    port,
    app,
    audits,
    seenByApp,
    upstreamCalls,
    broker,
    lend,
    disconnect: () => (publisherToken = null),
  };
}

const send = { connector: GMAIL, method: "POST", url: `https://${GMAIL}/gmail/v1/users/me/messages/send`, body: "{}" };
const read = { connector: GMAIL, url: `https://${GMAIL}/gmail/v1/users/me/messages` };

test("only the live publisher can lend an app their connectors, and only real connected-app hosts", async (t) => {
  const h = await harness(t);
  const someoneElse = await h.lend(VIEWER, [GMAIL]);
  assert.equal(someoneElse.status, 403);
  assert.match(String(someoneElse.json.message), /only the person who published/);
  const unattended = await h.lend(PUBLISHER, [GMAIL], false);
  assert.equal(unattended.status, 403);
  assert.match(String(unattended.json.message), /live conversation/);
  assert.equal((await h.lend(PUBLISHER, ["evil.example"])).status, 400);
  assert.equal((await h.lend(PUBLISHER, GMAIL)).status, 400);
  assert.equal((await h.broker(read)).json.error, "connector_not_lent", "nothing is lent by default");
  const lent = await h.lend(PUBLISHER, ["GMAIL.googleapis.com", GMAIL]);
  assert.equal(lent.status, 200);
  assert.deepEqual((lent.json.deployment as { connectors?: string[] }).connectors, [GMAIL]);
  assert.deepEqual(deploymentView((await h.app.getDeployment(h.d.id))!).connectors, [GMAIL]);
  assert.ok(h.audits.some((e) => e.action === "deploy_connectors" && e.detail === GMAIL));
});

test("a lent connector proxies reads for any viewer without the token ever reaching the app", async (t) => {
  const h = await harness(t);
  await h.lend(PUBLISHER, [GMAIL]);
  const res = await h.broker({ ...read, headers: { accept: "application/json", authorization: "Bearer stolen" } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: 200, contentType: "application/json", body: '{"id":"m1"}' });
  assert.ok(!JSON.stringify(res.json).includes(PUBLISHER_TOKEN));
  assert.equal(h.upstreamCalls.length, 1);
  assert.equal(h.upstreamCalls[0]!.headers.authorization, `Bearer ${PUBLISHER_TOKEN}`, "the broker injects the token");
  assert.equal(h.upstreamCalls[0]!.headers.accept, "application/json");
  const use = h.audits.find((e) => e.action === "connector.broker.use");
  assert.equal(use?.principalId, PUBLISHER);
  assert.equal(use?.resource, GMAIL);
  assert.equal(use?.detail, `deployment:${h.d.id} GET viewer:(unverified) upstream:200`);
});

test("a write is honoured only with the gateway's attestation that the publisher is the signed-in viewer", async (t) => {
  const h = await harness(t);
  await h.lend(PUBLISHER, [GMAIL]);

  assert.equal(await visit(h.port, VIEWER, { [VIEWER_ATTESTATION_HEADER]: "forged" }), 200);
  assert.equal(h.seenByApp.at(-1)![VIEWER_ATTESTATION_HEADER], undefined, "another viewer gets no attestation");
  assert.equal((await h.broker(send)).json.error, "publisher_viewer_required");
  const otherViewer = await mintPortalIdentity(
    { p: VIEWER, exp: Date.now() + 60_000 },
    viewerAttestationKey(SIGNING, h.d.id),
  );
  assert.equal((await h.broker({ ...send, viewer: otherViewer })).json.error, "publisher_viewer_required");
  const appMinted = await mintPortalIdentity(
    { p: PUBLISHER, exp: Date.now() + 60_000 },
    viewerIdentityKey(SIGNING, h.d.id),
  );
  assert.equal(
    (await h.broker({ ...send, viewer: appMinted })).json.error,
    "publisher_viewer_required",
    "the app holds the key behind its viewer identity header, so that header cannot authorize a write",
  );

  assert.equal(await visit(h.port, PUBLISHER), 200);
  const attestation = h.seenByApp.at(-1)![VIEWER_ATTESTATION_HEADER];
  assert.equal(typeof attestation, "string", "the publisher's own visit carries an attestation");
  assert.equal(typeof h.seenByApp.at(-1)![PORTAL_IDENTITY_HEADER], "string");
  const sent = await h.broker({ ...send, viewer: attestation });
  assert.equal(sent.status, 200);
  assert.equal(h.upstreamCalls.length, 1, "only the attested write reached the provider");
  assert.equal(h.upstreamCalls[0]!.method, "POST");
  const denied = h.audits.filter((e) => e.action === "connector.broker.denied").length;
  assert.equal(denied, 3, "every refused use is audited");
  assert.equal(
    h.audits.find((e) => e.action === "connector.broker.use")?.detail,
    `deployment:${h.d.id} POST viewer:${PUBLISHER} upstream:200`,
  );
});

test("the broker pins the connector's host and refuses agent tokens, withdrawn loans and lost connections", async (t) => {
  const h = await harness(t);
  await h.lend(PUBLISHER, [GMAIL]);
  assert.equal((await h.broker({ ...read, url: "https://evil.example/x" })).json.error, "host_not_allowed");
  assert.equal((await h.broker({ ...read, url: `http://${GMAIL}/x` })).json.error, "scheme_not_allowed");
  assert.equal((await h.broker({ ...read, url: `https://${GMAIL}:8443/x` })).json.error, "scheme_not_allowed");
  assert.equal(
    (await h.broker({ ...read, connector: "sheets.googleapis.com", url: "https://sheets.googleapis.com/v4" })).json
      .error,
    "connector_not_lent",
  );
  const agentToken = await mintCapabilityToken(
    {
      actorId: PUBLISHER,
      scopeId: personalScope(PUBLISHER),
      aud: CREDENTIAL_BROKER_AUD,
      credentials: [],
      exp: Date.now() + 60_000,
    },
    SIGNING,
  );
  assert.equal((await h.broker(read, agentToken)).json.error, "not_entitled");
  h.disconnect();
  assert.equal((await h.broker(read)).status, 409);
  await h.lend(PUBLISHER, []);
  assert.equal((await h.broker(read)).json.error, "connector_not_lent", "withdrawing the loan takes effect at once");
  assert.equal(h.upstreamCalls.length, 0);
});
