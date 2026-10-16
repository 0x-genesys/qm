import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import type { RunStore } from "../src/runs/run-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { scopeId } from "../src/types.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const sourceSecret = "source-only-secret".repeat(3);
const statusToken = "session-status-only-token".repeat(3);
const hookSecret = "hook-secret";
const auth = { authorization: `Bearer ${statusToken}` };

function fixture(options: { token?: string | null; sessions?: SessionStore | null; runs?: RunStore | null } = {}) {
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const sessions = options.sessions === null ? undefined : (options.sessions ?? createMemorySessionStore());
  const runs = options.runs === null ? undefined : (options.runs ?? createMemoryRunStore().runs);
  const token = options.token === undefined ? statusToken : options.token;
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    requireSignedPortalIdentity: true,
    admin: built.admin,
    auditLog: built.auditLog,
    ...(sessions ? { sessions } : {}),
    ...(runs ? { runs } : {}),
    ...(token ? { sessionStatusToken: token } : {}),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const status = (session: string, headers: Record<string, string> = auth) =>
    fetch(`${base}/v1/session-status?session=${encodeURIComponent(session)}`, { headers });
  return { sessions, runs, base, status, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const request = (threadRef: string) =>
  ({
    surface: "webhook",
    actor: { id: "U1", externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    text: "private webhook payload",
    triggered: true,
  }) as unknown as OrchestratorInput;

test("session status: absent unless a token is configured", async () => {
  const s = fixture({ token: null });
  try {
    assert.equal((await s.status("webhook:w1:d1")).status, 404);
  } finally {
    await s.close();
  }
});

test("session status: missing, wrong, source-signed and admin-identity requests are refused before any read", async () => {
  const sessions = createMemorySessionStore();
  let reads = 0;
  const getByThread = sessions.getByThread.bind(sessions);
  sessions.getByThread = async (ref) => {
    reads++;
    return getByThread(ref);
  };
  const s = fixture({ sessions });
  try {
    const path = "/v1/session-status?session=webhook%3Aw1%3Ad1";
    const ts = Math.floor(Date.now() / 1000);
    for (const headers of [
      {},
      { authorization: `Bearer ${statusToken}x` },
      { authorization: statusToken },
      { authorization: `Bearer ${sourceSecret}` },
      { "x-admin-actor": "admin-alice@default-org" },
      { "x-timestamp": String(ts), "x-signature": signRequest(sourceSecret, ts, `GET\n${path}\n`) },
    ] as Record<string, string>[]) {
      const res = await fetch(s.base + path, { headers });
      assert.equal(res.status, 401, JSON.stringify(headers));
    }
    assert.equal(reads, 0);
  } finally {
    await s.close();
  }
});

test("session status: the token authorizes nothing else", async () => {
  const s = fixture();
  try {
    const sessionId = (
      await s.sessions!.getOrCreateByThread("webhook:w1:d1", "dm", scopeId("personal", "U1"), undefined, "webhook")
    ).id;
    for (const path of [
      `/v1/sessions/${sessionId}`,
      `/v1/sessions/${sessionId}/entries`,
      "/v1/spend/export?from=2026-01-01&to=2026-01-02",
      "/v1/admin/whoami",
      "/v1/webhooks",
    ]) {
      const res = await fetch(s.base + path, { headers: auth });
      assert.ok(res.status === 401 || res.status === 404, `${path} answered ${res.status}`);
    }
  } finally {
    await s.close();
  }
});

test("session status: a webhook session reports accepted, queued, running, idle and failed without content", async () => {
  const s = fixture();
  try {
    const ref = "webhook:w1:d1";
    const accepted: any = await (await s.status(ref)).json();
    assert.deepEqual(accepted, {
      sessionRef: ref,
      sessionId: null,
      state: "accepted",
      outcome: null,
      runId: null,
      queuedAt: null,
      startedAt: null,
      finishedAt: null,
    });

    const { run } = await s.runs!.enqueue({ sessionId: ref, request: request(ref) });
    let body: any = await (await s.status(ref)).json();
    assert.equal(body.state, "queued");
    assert.equal(body.runId, run.id);
    assert.equal(body.queuedAt, run.createdAt);
    assert.equal(body.startedAt, null);

    const session = await s.sessions!.getOrCreateByThread(ref, "dm", scopeId("personal", "U1"), undefined, "webhook");
    const claimed = await s.runs!.claim("worker-1", 60_000);
    assert.equal(claimed?.id, run.id);
    body = await (await s.status(ref)).json();
    assert.equal(body.state, "running");
    assert.equal(body.sessionId, session.id);
    assert.equal(typeof body.startedAt, "number");

    await s.runs!.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "secret reply text" });
    const byRef = await (await s.status(ref)).text();
    const byId = await (await s.status(session.id)).text();
    assert.equal(byId, byRef);
    body = JSON.parse(byRef);
    assert.equal(body.state, "idle");
    assert.equal(body.outcome, "ok");
    assert.equal(typeof body.finishedAt, "number");
    assert.doesNotMatch(byRef, /secret reply text|private webhook payload/);

    const failedRef = "webhook:w1:d2";
    await s.runs!.enqueue({ sessionId: failedRef, request: request(failedRef) });
    const failing = await s.runs!.claim("worker-1", 60_000);
    await s.runs!.fail(failing!.id, failing!.leaseToken!, "boom", { retry: false });
    body = await (await s.status(failedRef)).json();
    assert.equal(body.state, "failed");
    assert.doesNotMatch(JSON.stringify(body), /boom/);
  } finally {
    await s.close();
  }
});

test("session status: non-webhook sessions and unknown ids are not found", async () => {
  const s = fixture();
  try {
    const dm = await s.sessions!.getOrCreateByThread("dm:U1:t1", "dm", scopeId("personal", "U1"));
    for (const key of [dm.id, dm.threadRef, "no-such-session", "webhook:"]) {
      assert.equal((await s.status(key)).status, 404, key);
    }
    assert.equal((await fetch(`${s.base}/v1/session-status`, { headers: auth })).status, 400);
    assert.equal((await s.status(`webhook:${"x".repeat(600)}`)).status, 400);
  } finally {
    await s.close();
  }
});

test("session status: an unavailable store is an error, not an empty status", async () => {
  for (const missing of [{ sessions: null }, { runs: null }] as const) {
    const s = fixture(missing);
    try {
      assert.equal((await s.status("webhook:w1:d1")).status, 503);
    } finally {
      await s.close();
    }
  }
});

test("session status: core receives the configured token", () => {
  const config = testConfig({ sessionStatusToken: statusToken });
  assert.equal(serverDeps(config, buildApp(config)).sessionStatusToken, statusToken);
  assert.equal(serverDeps(testConfig(), buildApp(testConfig())).sessionStatusToken, undefined);
});

test("session status: a webhook delivery's sessionRef tracks its session through to idle", async () => {
  const built = buildApp(testConfig({ signingSecret: sourceSecret, dataDir: mkdtempSync(join(tmpdir(), "wh-")) }));
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    webhookReceiver: built.webhookReceiver,
    sessions: built.sessions,
    runs: built.runs,
    sessionStatusToken: statusToken,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const webhook = await built.app.createWebhook({
      ownerScopeId: scopeId("personal", "U1"),
      owner: "U1",
      createdBy: "U1",
      action: "triage",
      verification: { scheme: "github", secret: hookSecret },
    });
    const eventBody = JSON.stringify({ action: "opened" });
    const accepted = await fetch(`${base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + createHmac("sha256", hookSecret).update(eventBody).digest("hex"),
        "x-github-delivery": "gh-1",
        "x-github-event": "issues",
      },
      body: eventBody,
    });
    assert.equal(accepted.status, 202);
    const receipt: any = await accepted.json();
    assert.equal(receipt.ok, true);
    assert.equal(typeof receipt.deliveryId, "string");
    assert.equal(receipt.sessionRef, `webhook:${webhook.id}:${receipt.deliveryId}`);

    let body: any;
    for (let i = 0; i < 200; i++) {
      body = await (
        await fetch(`${base}/v1/session-status?session=${encodeURIComponent(receipt.sessionRef)}`, { headers: auth })
      ).json();
      if (body.state === "idle" || body.state === "failed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(body.state, "idle");
    const session = await built.sessions.getByThread(receipt.sessionRef);
    assert.ok(session);
    assert.equal(body.sessionId, session.id);
    assert.equal(typeof body.runId, "string");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
