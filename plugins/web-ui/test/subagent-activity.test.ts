import test from "node:test";
import assert from "node:assert/strict";
import type { CoreSession, SessionEntry } from "../src/core-bridge.ts";
import {
  ackKey,
  descendantsOf,
  peekLines,
  subagentCounts,
  subagentRows,
  subagentSummary,
  subagentTiming,
  subagentQueueTiming,
  visibleSubagents,
} from "../src/subagent-activity.ts";
import { backgroundLabel, conversationBackground, rowIndicators } from "../src/session-list.ts";

function row(id: string, parentSessionId?: string, extra: Partial<CoreSession> = {}): CoreSession {
  return {
    id,
    type: "dm",
    scopeId: "personal:a",
    threadRef: `agent:main:subagent:${id}`,
    createdAt: 1_000,
    lastActivityAt: 61_000,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...extra,
  };
}

const list = [
  row("root"),
  row("a", "root", { working: true }),
  row("b", "root", {
    latestRun: { id: "run-b", status: "failed", createdAt: 11_000, startedAt: 21_000, finishedAt: 61_000 },
  }),
  row("c", "root", { awaitingInput: true }),
  row("a1", "a", { working: true }),
  row("other"),
];

test("descendants roll grandchildren up to the top-level parent", () => {
  assert.deepEqual(
    descendantsOf(list, "root").map(({ session, depth }) => [session.id, depth]),
    [
      ["a", 1],
      ["b", 1],
      ["c", 1],
      ["a1", 2],
    ],
  );
  assert.deepEqual(
    descendantsOf([row("x", "y"), row("y", "x")], "x").map(({ session }) => session.id),
    ["y"],
  );
});

test("running and waiting counts feed the sidebar and tab badge", () => {
  assert.deepEqual(subagentCounts(list, "root"), { running: 2, waiting: 1 });
  assert.deepEqual(subagentCounts(list, "other"), { running: 0, waiting: 0 });
  assert.equal(rowIndicators(list[0]!, null, list).awaiting, true, "a child waiting on approval lights the parent");
  assert.deepEqual(conversationBackground(list, "root", null), {
    jobs: 0,
    watches: 0,
    crons: 0,
    subagents: 3,
    goal: false,
    label: "2 subagents running · 1 subagent needs you",
  });
  assert.equal(backgroundLabel(1, 0, 0, 1)?.label, "1 subagent running · 1 background job running");
});

test("rows retain completed and failed run timings until that run is dismissed", () => {
  const rows = subagentRows(list, "root");
  assert.deepEqual(
    rows.map((r) => [r.session.id, r.state]),
    [
      ["a", "working"],
      ["b", "failed"],
      ["c", "waiting"],
      ["a1", "working"],
    ],
  );
  assert.equal(rows[0]!.endedAt, null);
  assert.equal(rows[1]!.endedAt, 61_000);
  assert.equal(subagentSummary(rows), "Runs: 2 running, 1 needs you, 1 failed");
  const failed = rows[1]!;
  assert.deepEqual(
    visibleSubagents(rows, new Set([ackKey(failed)])).map((r) => r.session.id),
    ["a", "c", "a1"],
  );
  const done = subagentRows(
    list.map((s) => (s.id === "b" ? { ...s, latestRun: { ...s.latestRun!, status: "done" as const } } : s)),
    "root",
  );
  assert.equal(
    visibleSubagents(done, new Set()).some((r) => r.session.id === "b"),
    true,
  );
  assert.equal(
    visibleSubagents(done, new Set([ackKey(done[1]!)])).some((r) => r.session.id === "b"),
    false,
  );
});

test("peek shows the latest tool steps and message", () => {
  const entry = (type: SessionEntry["type"], payload: unknown): SessionEntry => ({ type, payload, createdAt: 0 });
  const lines = peekLines(
    [
      entry("user", { text: "go" }),
      entry("tool_call", { tool: "sandbox", action: "exec", command: "npm test" }),
      entry("tool_result", { tool: "sandbox", ok: true }),
      entry("text", { text: "Tests  pass.\nOpening PR" }),
      entry("tool_call", { tool: "github" }),
    ],
    3,
  );
  assert.deepEqual(lines, [
    { kind: "tool", text: "sandbox exec · npm test" },
    { kind: "text", text: "Tests pass. Opening PR" },
    { kind: "tool", text: "github" },
  ]);
});

test("latest run elapsed includes queue time and survives reload without counting child lifetime", () => {
  const session = row("reused", "root", {
    createdAt: 1,
    lastActivityAt: 900_000,
    latestRun: { id: "second-run", status: "pending", createdAt: 100_000, startedAt: null, finishedAt: null },
  });
  const [queued] = subagentRows([session], "root");
  assert.equal(queued!.state, "queued");
  assert.equal(subagentTiming(queued!, 160_000), "1m elapsed (incl. queue)");
  assert.equal(subagentSummary([queued!]), "Runs: 1 queued");
  const running = { ...session, latestRun: { ...session.latestRun!, status: "running" as const, startedAt: 160_000 } };
  assert.equal(subagentTiming(subagentRows([running], "root")[0]!, 180_000), "1m 20s elapsed (incl. queue)");
  const completed = { ...running, latestRun: { ...running.latestRun, status: "done" as const, finishedAt: 200_000 } };
  const [done] = subagentRows([completed], "root");
  const [reloaded] = subagentRows(JSON.parse(JSON.stringify([completed])), "root");
  assert.equal(subagentTiming(done!, 210_000), "1m 40s elapsed (incl. queue)");
  assert.equal(subagentTiming(reloaded!, 500_000), subagentTiming(done!, 210_000));
  assert.equal(subagentSummary([done!]), "Runs: 1 done");
  assert.equal(visibleSubagents([done!], new Set()).length, 1);
  const dismissed = new Set([ackKey(done!)]);
  assert.equal(visibleSubagents([reloaded!], dismissed).length, 0);
  const nextRun = { ...completed, latestRun: { ...completed.latestRun, id: "third-run" } };
  assert.equal(visibleSubagents(subagentRows([nextRun], "root"), dismissed).length, 1);
});

test("missing run timestamps never fall back to session lifetime or an indefinitely ticking terminal run", () => {
  const [working] = subagentRows([row("legacy", "root", { working: true })], "root");
  assert.equal(subagentTiming(working!, 500_000), null);
  assert.deepEqual(subagentRows([row("empty", "root")], "root"), []);
  const [done] = subagentRows(
    [
      row("missing-end", "root", {
        latestRun: { id: "run", status: "done", createdAt: 100_000, startedAt: null, finishedAt: null },
      }),
    ],
    "root",
  );
  assert.equal(subagentTiming(done!, 500_000), null);
});

test("an older running task stays visible when a newer follow-up queues, including after reload", () => {
  const active = { id: "active", status: "running" as const, createdAt: 100_000, startedAt: 130_000, finishedAt: null };
  const queued = { id: "follow-up", status: "pending" as const, createdAt: 200_000, startedAt: null, finishedAt: null };
  const session = row("child", "root", { working: true, latestRun: queued, inFlightRuns: [active, queued] });
  for (const input of [session, JSON.parse(JSON.stringify(session))]) {
    const [current] = subagentRows([input], "root");
    assert.equal(current!.state, "working");
    assert.equal(current!.run?.id, active.id);
    assert.equal(subagentTiming(current!, 260_000), "2m 40s elapsed (incl. queue)");
    assert.equal(subagentQueueTiming(current!, 260_000), "1 queued · oldest 1m");
    assert.equal(subagentSummary([current!]), "Runs: 1 queued, 1 running");
  }
});

test("a finished parent run does not hide its active grandchild", () => {
  const done = { id: "done", status: "done" as const, createdAt: 100_000, startedAt: 120_000, finishedAt: 160_000 };
  const active = { id: "active", status: "running" as const, createdAt: 130_000, startedAt: 140_000, finishedAt: null };
  const rows = subagentRows(
    [
      row("child", "root", { working: true, latestRun: done }),
      row("grandchild", "child", { working: true, latestRun: active, inFlightRuns: [active] }),
    ],
    "root",
  );
  assert.deepEqual(
    rows.map((row) => [row.state, row.depth]),
    [
      ["done", 1],
      ["working", 2],
    ],
  );
  assert.equal(subagentTiming(rows[0]!, 200_000), "1m elapsed (incl. queue)");
  assert.equal(subagentTiming(rows[1]!, 200_000), "1m 10s elapsed (incl. queue)");
  assert.equal(visibleSubagents(rows, new Set([ackKey(rows[0]!)])).length, 1);
});
