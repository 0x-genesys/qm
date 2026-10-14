import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { browserEnv } from "./browser-env.ts";
import type { TranscriptPage } from "../src/core-bridge.ts";

const entry = (seq: number, text: string) => ({
  seq,
  type: seq % 2 ? "assistant" : "user",
  createdAt: 1_700_000_000_000 + seq,
  payload: { text },
});
const page = (...seqs: number[]): TranscriptPage =>
  ({ entries: seqs.map((seq) => entry(seq, `message ${seq}`)) }) as TranscriptPage;

const pin = (id: string) => ({ id, addedBy: "tester", createdAt: 1 });

const transcripts = new Map<string, ReturnType<typeof entry>[]>();
const requests: string[] = [];
const env = await browserEnv({
  fetch: async (input) => {
    const path = String(input);
    requests.push(path);
    if (path.startsWith("/api/runtime-config"))
      return Response.json({
        scopeId: "personal:tester",
        approvedHarnesses: [],
        modelsByHarness: {},
        modelCatalog: {},
        effective: { harnessId: "pi", modelId: "m" },
      });
    if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
    if (path === "/api/sessions") return Response.json({ sessions: [...transcripts.keys()].map(session) });
    const match = path.match(/^\/api\/sessions\/([^/?]+)(?:\?(.*))?$/);
    if (match) {
      const since = Number(new URLSearchParams(match[2] ?? "").get("sinceSeq") ?? 0);
      const entries = (transcripts.get(match[1]!) ?? []).filter((e) => e.seq >= since);
      return Response.json({ entries, ...(since > 0 ? { earlierEntries: since } : {}) });
    }
    return Response.json({ contexts: [], items: [], crons: [] });
  },
});
after(env.close);

let cache: Record<string, any>;
let sessions: Record<string, any>;
let shell: Record<string, any>;
let conversations: Record<string, any>;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div><main></main>';
  env.dom.window.history.replaceState(null, "", "/");
  env.vite.moduleGraph.invalidateAll();
  shell = await env.vite.ssrLoadModule("/src/shell.ts");
  sessions = await env.vite.ssrLoadModule("/src/sessions.ts");
  cache = await env.vite.ssrLoadModule("/src/transcript-cache.ts");
  conversations = await env.vite.ssrLoadModule("/src/conversations.ts");
  shell.appState.me = { user: "tester", org: "test" };
  shell.appState.currentView = "chats";
  shell.appState.mainEl = document.querySelector("main");
  requests.length = 0;
  transcripts.clear();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
function session(id: string) {
  return {
    id,
    threadRef: `web:tester:${id}`,
    scopeId: "personal:tester",
    title: `Title ${id}`,
    canContinue: true,
  };
}
const mounted = () =>
  JSON.stringify(
    conversations.allConversations().find((conv: any) => conv.state.host?.isConnected)?.state.agent?.state.messages ??
      [],
  );

test("the cache evicts the least recently used session past its capacity", () => {
  for (let i = 0; i < 41; i++) cache.storeTranscript(`s${i}`, page(i));
  assert.equal(cache.cachedTranscript("s0"), undefined);
  assert.ok(cache.cachedTranscript("s1"));
  cache.storeTranscript("s41", page(41));
  assert.ok(cache.cachedTranscript("s1"), "a read refreshes recency");
  assert.equal(cache.cachedTranscript("s2"), undefined);
});

test("a delta appends only newer entries and replaces pins", () => {
  const base = { ...page(1, 2, 3), earlierEntries: 5, pins: [pin("old")] } as TranscriptPage;
  const merged = cache.mergeTranscriptDelta(base, {
    ...page(3, 4, 5),
    earlierEntries: 99,
    pins: [pin("new")],
  } as TranscriptPage);
  assert.deepEqual(
    merged.entries.map((e: { seq: number }) => e.seq),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(merged.pins, [pin("new")]);
  assert.equal(merged.earlierEntries, 5, "the cached window keeps its own earlier count");
  assert.equal(cache.lastSeq(merged), 5);
});

test("an empty delta returns the cached page unchanged", () => {
  const base = { ...page(1, 2), pins: [pin("p")] } as TranscriptPage;
  assert.equal(cache.mergeTranscriptDelta(base, { entries: [], pins: [pin("p")] } as TranscriptPage), base);
  assert.equal(cache.mergeTranscriptDelta(page(1, 2), page(2)).entries.length, 2);
  assert.notEqual(cache.mergeTranscriptDelta(base, page()), base, "dropped pins are a change");
});

test("a first open stores the fetched transcript", async () => {
  transcripts.set("a", [entry(0, "hello there"), entry(1, "hi back")]);
  await sessions.openSession(session("a"));
  const stored = cache.cachedTranscript("a");
  assert.deepEqual(
    stored.page.entries.map((e: { seq: number }) => e.seq),
    [0, 1],
  );
  assert.deepEqual(stored.approvals, []);
});

test("revisiting a session mounts from cache at once, then reconciles new entries from the last seq", async () => {
  transcripts.set("a", [entry(0, "first question"), entry(1, "first answer")]);
  transcripts.set("b", [entry(0, "other chat")]);
  await sessions.openSession(session("a"));
  await sessions.openSession(session("b"));
  await settle();
  transcripts.get("a")!.push(entry(2, "follow up question"), entry(3, "fresh answer"));
  requests.length = 0;

  const opening = sessions.openSession(session("a"));
  assert.equal(document.querySelector(".chat-loading"), null, "no loading pane on a cache hit");
  assert.match(mounted(), /first answer/);
  assert.doesNotMatch(mounted(), /fresh answer/);
  await opening;
  await settle();

  assert.ok(requests.includes("/api/sessions/a?sinceSeq=2"), requests.join(", "));
  assert.ok(!requests.some((path) => path.startsWith("/api/sessions/a?tailTurns")));
  assert.match(mounted(), /fresh answer/);
  assert.match(mounted(), /first answer/);
  assert.deepEqual(
    cache.cachedTranscript("a").page.entries.map((e: { seq: number }) => e.seq),
    [0, 1, 2, 3],
  );
});
