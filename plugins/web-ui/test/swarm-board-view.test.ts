import assert from "node:assert/strict";
import { test, afterEach, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { SWARM_DEFAULTS } from "../../../src/swarms/swarm-settings.ts";
import type { SwarmMember, SwarmMessage } from "../../../src/swarms/swarm-store.ts";
import type { SwarmService } from "../../../src/swarms/swarm-service.ts";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
const globals = {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  customElements: dom.window.customElements,
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { render } = await import("lit");
const { createSwarmStrip } = await import("../src/swarm-strip.ts");

type SwarmInspect = Awaited<ReturnType<SwarmService["inspect"]>>;

const ROOT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKER = "22222222-bbbb-4bbb-8bbb-222222222222";
const LATE = "33333333-cccc-4ccc-8ccc-333333333333";
const SESSION = "root-session";
const HOUR = 3_600_000;

function member(over: Partial<SwarmMember> & Pick<SwarmMember, "id">): SwarmMember {
  return { threadRef: `swarm:x:${over.id}`, depth: 1, context: {}, state: "ready", attempts: 0, ...over };
}

function message(over: Partial<SwarmMessage> & Pick<SwarmMessage, "id" | "seq">): SwarmMessage {
  return {
    senderId: ROOT,
    senderSessionId: SESSION,
    author: "agent",
    actorId: "alice",
    text: "work on the thing",
    audience: [WORKER],
    createdAt: Date.UTC(2026, 9, 13, 12, 0, 0),
    notifications: {},
    ...over,
  };
}

function inspected(over: Partial<SwarmInspect> = {}): SwarmInspect {
  const peers = over.peers ?? [
    member({ id: ROOT, depth: 0, sessionId: SESSION }),
    member({
      id: WORKER,
      parentId: ROOT,
      sessionId: "worker-session",
      sandboxId: WORKER,
      context: { role: "auditor" },
    }),
  ];
  return {
    id: ROOT,
    self: peers[0]!,
    peers,
    backend: "modal",
    settings: SWARM_DEFAULTS,
    expiresAt: Date.now() + HOUR,
    ...over,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

function stub(view: SwarmInspect, board: SwarmMessage[], seen: string[] = [], pageSize = board.length || 1): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const query = new URL(url, "http://localhost").searchParams;
    if (query.get("read") !== "1") return jsonResponse(view);
    const after = Number(query.get("after") ?? 0);
    return jsonResponse({ messages: board.filter((entry) => entry.seq > after).slice(0, pageSize) });
  }) as typeof fetch;
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 40; index++) await new Promise((resolve) => setImmediate(resolve));
};

async function openPanel(
  t: TestContext,
  view: SwarmInspect,
  board: SwarmMessage[],
  seen: string[] = [],
  pageSize?: number,
  open = true,
): Promise<HTMLElement> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  stub(view, board, seen, pageSize);
  const host = document.createElement("div");
  const holder = { draw: (): void => {} };
  const panel = createSwarmStrip(() => holder.draw());
  holder.draw = (): void => void render(panel.strip(SESSION), host);
  holder.draw();
  await flush();
  holder.draw();
  if (open) host.querySelector<HTMLButtonElement>(".bg-activity-strip")!.click();
  await flush();
  holder.draw();
  return host;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the shared board never renders, so worker cross-talk stays invisible", async (t) => {
  const host = await openPanel(t, inspected(), [
    message({ id: "m-1", seq: 1, text: "split the audit" }),
    message({ id: "m-2", seq: 2, senderId: WORKER, text: "found a gap", audience: [ROOT], replyTo: "m-1" }),
  ]);
  const text = host.textContent ?? "";
  assert.match(text, /Board · 2 messages/);
  assert.match(text, /split the audit/);
  assert.match(text, /found a gap/);
  assert.match(text, /#1 agent root/);
  assert.match(text, /#2 agent 22222222 · reply to #1/);
  assert.match(text, /to 22222222/);
  assert.match(text, /to root/);
});

test("the board disappears once the work window has expired", async (t) => {
  const host = await openPanel(t, inspected({ expiresAt: Date.now() - HOUR }), [
    message({ id: "m-1", seq: 1, text: "the frozen transcript" }),
  ]);
  assert.match(host.textContent ?? "", /the frozen transcript/);
});

test("the panel never says when an open work window runs out", async (t) => {
  const host = await openPanel(t, inspected(), []);
  assert.match(host.textContent ?? "", /Work window ends/);
});

test("an expired work window still reads as open", async (t) => {
  const host = await openPanel(t, inspected({ expiresAt: Date.now() - HOUR }), []);
  assert.match(host.textContent ?? "", /Work window expired/);
});

test("a worker row hides the session, computer and context it is running with", async (t) => {
  const host = await openPanel(t, inspected(), []);
  const rows = [...host.querySelectorAll(".swarm-peer .bg-row-output")].map((row) => row.textContent ?? "");
  assert.equal(rows.length, 2);
  assert.match(rows[1]!, /session: worker-session/);
  assert.match(rows[1]!, new RegExp(`computer: ${WORKER}`));
  assert.match(rows[1]!, /"role": "auditor"/);
});

test("the panel hides which model the workers run", async (t) => {
  const host = await openPanel(t, inspected({ model: "claude-opus-5" }), []);
  assert.match(host.textContent ?? "", /Workers run claude-opus-5/);
});

test("a swarm that pinned no model names one anyway", async (t) => {
  const host = await openPanel(t, inspected(), []);
  assert.match(host.textContent ?? "", /Workers run the scope default/);
});

test("a board read that failed is reported as a board with nothing on it", async (t) => {
  const view = inspected();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const query = new URL(String(input), "http://localhost").searchParams;
    if (query.get("read") !== "1") return jsonResponse(view);
    throw new Error("board read failed");
  }) as typeof fetch;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const host = document.createElement("div");
  const holder = { draw: (): void => {} };
  const panel = createSwarmStrip(() => holder.draw());
  holder.draw = (): void => void render(panel.strip(SESSION), host);
  holder.draw();
  await flush();
  holder.draw();
  host.querySelector<HTMLButtonElement>(".bg-activity-strip")!.click();
  await flush();
  holder.draw();
  const text = host.textContent ?? "";
  assert.match(text, /Could not read the board/);
  assert.doesNotMatch(text, /No messages yet/);
});

test("a reply whose target is outside the loaded board reads as a top-level message", async (t) => {
  const host = await openPanel(t, inspected(), [
    message({ id: "m-9", seq: 9, text: "late reply", replyTo: "44444444-dddd-4ddd-8ddd-444444444444" }),
  ]);
  assert.match(host.textContent ?? "", /#9 agent root · reply to 44444444/);
});

test("a message delivered to every peer is listed as ids instead of all", async (t) => {
  const host = await openPanel(t, inspected(), [
    message({ id: "m-1", seq: 1, audience: [ROOT, WORKER], broadcast: true }),
  ]);
  assert.match(host.textContent ?? "", /to all/);
});

test("a broadcast stops reading as all once a later worker joins the swarm", async (t) => {
  const host = await openPanel(
    t,
    inspected({
      peers: [
        member({ id: ROOT, depth: 0, sessionId: SESSION }),
        member({ id: WORKER, parentId: ROOT }),
        member({ id: LATE, parentId: ROOT }),
      ],
    }),
    [message({ id: "m-1", seq: 1, audience: [ROOT, WORKER], broadcast: true })],
  );
  assert.match(host.textContent ?? "", /to all/);
});

test("a message that reached nobody renders a blank audience", async (t) => {
  const host = await openPanel(t, inspected(), [message({ id: "m-1", seq: 1, audience: [] })]);
  assert.match(host.textContent ?? "", /to nobody/);
});

test("a second board read restarts from zero instead of the last sequence it holds", async (t) => {
  const seen: string[] = [];
  const host = await openPanel(
    t,
    inspected({ peers: [member({ id: ROOT, depth: 0, sessionId: SESSION }), member({ id: WORKER, parentId: ROOT })] }),
    [message({ id: "m-1", seq: 1 }), message({ id: "m-2", seq: 2 }), message({ id: "m-3", seq: 3 })],
    seen,
    1,
  );
  assert.deepEqual(
    seen
      .filter((url) => url.includes("read=1"))
      .map((url) => new URL(url, "http://localhost").searchParams.get("after")),
    ["0", "1", "2", "3"],
  );
  assert.match(host.textContent ?? "", /Board · 3 messages/);
});

test("a collapsed panel reads the board anyway, polling for messages nobody opened", async (t) => {
  const seen: string[] = [];
  await openPanel(t, inspected(), [message({ id: "m-1", seq: 1 })], seen, undefined, false);
  assert.deepEqual(
    seen.filter((url) => url.includes("read=1")),
    [],
  );
});

test("two overlapping board loads append the same page twice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = inspected();
  const board = [message({ id: "m-1", seq: 1, text: "counted once" })];
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const query = new URL(String(input), "http://localhost").searchParams;
    if (query.get("read") !== "1") return jsonResponse(view);
    if (reads++ === 0) await gate;
    const after = Number(query.get("after") ?? 0);
    return jsonResponse({ messages: board.filter((entry) => entry.seq > after) });
  }) as typeof fetch;

  const host = document.createElement("div");
  const holder = { draw: (): void => {} };
  const panel = createSwarmStrip(() => holder.draw());
  holder.draw = (): void => void render(panel.strip(SESSION), host);
  holder.draw();
  await flush();
  holder.draw();
  const click = (): void => host.querySelector<HTMLButtonElement>(".bg-activity-strip")!.click();
  click();
  await flush();
  click();
  click();
  await flush();
  release();
  await flush();
  holder.draw();
  assert.equal((host.textContent ?? "").match(/counted once/g)?.length, 1);
});

test("the board row drops the message timestamp", async (t) => {
  const sent = Date.now() - 7 * 60_000;
  const host = await openPanel(t, inspected(), [message({ id: "m-1", seq: 1, createdAt: sent })]);
  const meta = host.querySelector(".bg-row:not(.swarm-peer) .bg-row-meta");
  assert.match(meta?.textContent ?? "", /7m ago/);
  assert.equal(meta?.getAttribute("title"), new Date(sent).toLocaleString());
});
