import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPiHarness, probeModel } from "../src/harness/pi-harness.ts";
import { createHarnessRouter } from "../src/harness/harness-router.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import type { ModelRequestContext } from "../src/model/provider-endpoints.ts";
import type { Session } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";

const gateway = {
  url: "https://gateway.test",
  apiKey: "gateway-key",
  apiKeyHeader: "api-key",
  models: { "claude-haiku-4-5": "router/haiku", "claude-haiku-5-5": "router/haiku-5-5" },
};

const cronContext: ModelRequestContext = {
  sessionId: "session-cron",
  actorId: "owner@example.com",
  scopeId: "channel:C123",
  origin: "cron",
};

const cronHeaders = {
  "x-qm-session-id": "session-cron",
  "x-qm-actor": "owner@example.com",
  "x-qm-scope": "channel:C123",
  "x-qm-origin": "cron",
};

function anthropicStream(text: string): string {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_context",
        type: "message",
        role: "assistant",
        model: "router/haiku",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function recordRequests(t: TestContext): Array<{ url: string; headers: Headers }> {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(anthropicStream("ok"), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return requests;
}

const contextHeaders = (headers: Headers) =>
  Object.fromEntries([...headers].filter(([name]) => name.startsWith("x-qm-")));

function turn(requestContext: ModelRequestContext, extra: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: "session-cron" } as Session,
    input: "hello",
    systemPrompt: "Reply ok.",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "channel:C123",
    orgScopeId: "org:test",
    requestContext,
    emit: async (entry) => ({ ...entry, sessionId: "session-cron", seq: seq++, parentSeq: null, createdAt: 0 }),
    recordModelCall: () => {},
    cancel: AbortSignal.timeout(10_000),
    ...extra,
  };
}

test("a gateway turn carries the session, actor, scope, purpose and origin it works for", async (t) => {
  const requests = recordRequests(t);
  const harness = createPiHarness({ defaultModelId: "claude-haiku-4-5", modelGateway: gateway });

  assert.equal((await harness.turns.runTurn(turn(cronContext))).reply, "ok");
  assert.equal(requests.at(-1)!.url, "https://gateway.test/v1/messages");
  assert.equal(requests.at(-1)!.headers.get("api-key"), "gateway-key");
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), { ...cronHeaders, "x-qm-purpose": "turn" });

  await harness.turns.runTurn(turn({ sessionId: "session-bare" }));
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), {
    "x-qm-session-id": "session-bare",
    "x-qm-purpose": "turn",
  });
});

test("an actor the credential broker could not attest is left off", async (t) => {
  const requests = recordRequests(t);
  const harness = createPiHarness({ defaultModelId: "claude-haiku-4-5", modelGateway: gateway });

  for (const actorId of ["Owner Example", "a".repeat(257)]) {
    await harness.turns.runTurn(turn({ ...cronContext, actorId }));
    assert.deepEqual(contextHeaders(requests.at(-1)!.headers), {
      "x-qm-session-id": "session-cron",
      "x-qm-scope": "channel:C123",
      "x-qm-origin": "cron",
      "x-qm-purpose": "turn",
    });
  }
});

test("turns on a user's or the org's own provider key send no request context", async (t) => {
  const requests = recordRequests(t);
  const harness = createPiHarness({ defaultModelId: "claude-haiku-4-5", apiKey: "org-key", modelGateway: gateway });

  await harness.turns.runTurn(turn(cronContext, { runtime: { modelId: "claude-opus-4-8" } }));
  await harness.turns.runTurn(turn(cronContext, { providerKeys: { anthropic: "user-key" } }));
  assert.deepEqual(
    requests.map((request) => [request.url, request.headers.get("x-api-key"), contextHeaders(request.headers)]),
    [
      ["https://api.anthropic.com/v1/messages", "org-key", {}],
      ["https://api.anthropic.com/v1/messages", "user-key", {}],
    ],
  );
});

test("helper calls keep the context they are given and name their own purpose", async (t) => {
  const requests = recordRequests(t);
  const harness = createPiHarness({
    defaultModelId: "claude-haiku-4-5",
    detectModelId: "claude-haiku-4-5",
    titleModelId: "claude-haiku-4-5",
    modelGateway: gateway,
  });
  const sent = () => contextHeaders(requests.at(-1)!.headers);
  const session = { id: "session-cron" } as Session;

  await harness.models.shouldRespond!({
    session,
    message: "anyone around?",
    recentContext: "",
    systemPrompt: "",
    history: [],
    requestContext: cronContext,
    recordModelCall: () => {},
  });
  assert.deepEqual(sent(), { ...cronHeaders, "x-qm-purpose": "detect" });

  await harness.models.compactHistory!({
    session,
    history: [
      {
        sessionId: "session-cron",
        seq: 1,
        parentSeq: null,
        type: "user",
        payload: { text: "summarize the nightly report" },
        scopeLabel: "channel:C123",
        createdAt: 0,
      },
    ],
    requestContext: cronContext,
    recordModelCall: () => {},
  });
  assert.deepEqual(sent(), { ...cronHeaders, "x-qm-purpose": "compaction" });

  await harness.models.summarizeApproval!("rm -rf build", "deletes files", cronContext);
  assert.deepEqual(sent(), { ...cronHeaders, "x-qm-purpose": "approval_summary" });

  await harness.models.screenSecurity!({
    payload: "[]",
    signal: AbortSignal.timeout(10_000),
    requestContext: cronContext,
    recordModelCall: () => {},
  });
  assert.deepEqual(sent(), { ...cronHeaders, "x-qm-purpose": "security_screen" });

  await harness.models.pickAckEmoji!("can you check the deploy?", ["eyes"]);
  assert.deepEqual(sent(), { "x-qm-purpose": "ack_emoji" });

  await probeModel(getRequiredModel("claude-haiku-4-5"), {}, AbortSignal.timeout(10_000), false, gateway);
  assert.deepEqual(sent(), { "x-qm-purpose": "probe" });
});

test("the goal governor judges with its turn's context", async (t) => {
  const requests = recordRequests(t);
  const pi = createPiHarness({
    defaultModelId: "claude-haiku-4-5",
    judgeModelId: "claude-haiku-4-5",
    modelGateway: gateway,
  });
  const adapter = {
    ...pi,
    turns: {
      runTurn: async (input: HarnessTurnInput) => {
        await input.governGoal!({ objective: "ship the release", trigger: "checkpoint", recentWork: "" });
        return { reply: "" };
      },
    },
  };
  const router = createHarnessRouter(new Map([["pi", adapter]]), adapter, async () => ({
    harnessId: "pi",
    modelId: "claude-haiku-4-5",
  }));

  await router.turns.runTurn(turn(cronContext));
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), { ...cronHeaders, "x-qm-purpose": "judge" });
});

test("app turns and their helper calls tell the gateway which session they serve", async (t) => {
  const seen: Array<Record<string, unknown>> = [];
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.method !== "POST") {
      res.writeHead(404);
      return res.end();
    }
    seen.push(Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.startsWith("x-qm-"))));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(anthropicStream('{"decision":"auto"}'));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const built = buildApp(
    testConfig({
      harness: "pi",
      modelId: "claude-haiku-4-5",
      titleModelId: "claude-haiku-4-5",
      detectModelId: "claude-haiku-4-5",
      judgeModelId: "claude-haiku-4-5",
      modelGateway: { ...gateway, url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` },
    }),
  );
  const sent = (purpose: string, sessionId?: string) =>
    seen.find(
      (headers) =>
        headers["x-qm-purpose"] === purpose && (sessionId === undefined || headers["x-qm-session-id"] === sessionId),
    );

  const dm = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:context" },
    conversationHeader: "You are in a direct message.",
    text: "Summarize the nightly report",
  });
  await settle(async () => !!sent("title") && !!sent("memory_capture"));
  const session = (await built.sessions.get(dm.sessionId!))!;
  const parent = { "x-qm-session-id": session.id, "x-qm-actor": "U1", "x-qm-scope": session.scopeId };
  assert.deepEqual(sent("security_screen"), {
    "x-qm-actor": "U1",
    "x-qm-scope": session.scopeId,
    "x-qm-purpose": "security_screen",
  });
  assert.deepEqual(sent("turn"), { ...parent, "x-qm-origin": "conversation", "x-qm-purpose": "turn" });
  assert.deepEqual(sent("title"), { ...parent, "x-qm-origin": "conversation", "x-qm-purpose": "title" });
  assert.deepEqual(sent("memory_capture"), {
    ...parent,
    "x-qm-origin": "conversation",
    "x-qm-purpose": "memory_capture",
  });

  const ambient = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "channel", threadRef: "ch:C1:context", channelRef: "C1", audience: [{ externalId: "U1" }] },
    text: "anyone around?",
    unprompted: true,
  });
  const channel = (await built.sessions.get(ambient.sessionId!))!;
  assert.deepEqual(sent("detect"), {
    "x-qm-session-id": channel.id,
    "x-qm-actor": "U1",
    "x-qm-scope": channel.scopeId,
    "x-qm-origin": "conversation",
    "x-qm-purpose": "detect",
  });

  await built.app.setChannelPolicy("C2", "", "U-admin", undefined, undefined, true);
  await built.app.ingestSurfaceEvents([
    { container: "C2", ts: "1.0", authorId: "U1", text: "did the launch slip?", createdAt: 1 },
  ]);
  await built.app.judgeAmbientContainer("slack", "C2");
  assert.deepEqual(sent("ambient_judge"), { "x-qm-purpose": "ambient_judge" });

  const cron = await built.sessions.getOrCreateByThread("agent:main:cron:nightly", "dm", session.scopeId);
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:context", "dm", session.scopeId);
  const conversation = { kind: "dm" as const, threadRef: child.threadRef };
  const actor = { id: "U1", type: "internal" as const };
  await built.sessions.setParentSession(child.id, cron.id);
  await built.sessions.addParticipant(child.id, "U1");
  await built.sessions.setSpawnMeta(child.id, {
    surface: "test",
    actor,
    conversation: { ...conversation, audience: [actor] },
  });
  assert.equal(
    (await built.app.turn({ surface: "test", actor: { externalId: "U1" }, conversation, text: "check the report" }))
      .status,
    "ok",
  );
  assert.deepEqual(sent("turn", child.id), {
    ...parent,
    "x-qm-session-id": child.id,
    "x-qm-origin": "cron",
    "x-qm-purpose": "turn",
  });
});
