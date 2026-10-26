import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoalRecord, type GoalRecord } from "../src/harness/goal.ts";
import { createSwarmGoalContinuation } from "../src/swarms/swarm-goal-continuation.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

async function goalWorker(settings?: { messages: number; notifications: number }) {
  const f = await swarmFixture();
  const [worker] = await f.service.spawn(f.caller, {
    requestId: "initial",
    text: "work",
    ...(settings ? { settings } : {}),
  });
  await f.service.sweep();
  const member = (await f.store.get(f.root.id))!.members.find((peer) => peer.id === worker!.id)!;
  const continuation = createSwarmGoalContinuation(f.serviceOptions);
  const setGoal = async (goal: GoalRecord) => {
    const { lease } = await f.sessions.acquireLease(member.sessionId!);
    await f.sessions.setGoal(lease!, goal);
    await f.sessions.releaseLease(lease!);
  };
  const workerRuns = async () => (await f.runs.list()).filter((run) => run.request.swarm?.recipientId === member.id);
  const claimOpenRun = async () => {
    await f.service.sweep();
    const run = (await workerRuns()).find((item) => item.status === "pending")!;
    return (await f.runs.claimById(run.id, "test", 60_000))!;
  };
  const finishOpenRun = async (whileRunning?: () => Promise<void>) => {
    const run = await claimOpenRun();
    await whileRunning?.();
    await f.runs.complete(run.id, run.leaseToken!, {
      status: "ok",
      reply: "(stopped)",
      stopped: true,
      sessionId: member.sessionId!,
    });
  };
  const continuations = async () =>
    (await f.store.get(f.root.id))!.messages.filter(
      (message) => message.senderId === member.id && message.audience.join() === member.id,
    );
  return { f, member, setGoal, workerRuns, claimOpenRun, finishOpenRun, continuation, continuations };
}

test("a worker whose turn is interrupted while its goal is active is woken to continue until it stops making progress", async () => {
  const { f, member, setGoal, workerRuns, finishOpenRun, continuation, continuations } = await goalWorker();
  const goal = { ...createGoalRecord({ objective: "Exhaust the lane" }), tokensUsed: 10 };
  await setGoal(goal);
  await finishOpenRun();
  await continuation.sweep();
  await continuation.sweep();
  const [first, ...rest] = await continuations();
  assert.equal(rest.length, 0);
  assert.equal(first!.notifications[member.id]?.state, "pending");
  await f.service.sweep();
  const resumed = (await workerRuns()).find((run) => run.request.swarm?.messageId === first!.id)!;
  assert.ok(await f.service.binding({ ...resumed.request, runId: resumed.id }));

  await setGoal({ ...goal, tokensUsed: 20 });
  await finishOpenRun();
  await continuation.sweep();
  assert.equal((await continuations()).length, 2);

  await finishOpenRun();
  await continuation.sweep();
  assert.equal((await continuations()).length, 2);
  assert.equal((await workerRuns()).filter((run) => run.status === "pending").length, 0);
});

test("a goal continuation is queued even when the swarm's message and notification budgets are spent", async () => {
  const { f, member, setGoal, finishOpenRun, continuation, continuations } = await goalWorker({
    messages: 1,
    notifications: 1,
  });
  await setGoal({ ...createGoalRecord({ objective: "Exhaust the lane" }), tokensUsed: 10 });
  await finishOpenRun();
  await assert.rejects(f.service.send(f.caller, { requestId: "over", audience: [member.id], text: "more" }), /budget/);
  await continuation.sweep();
  assert.equal((await continuations()).length, 1);
});

for (const [name, prepare] of [
  [
    "its goal is paused",
    async (w: Awaited<ReturnType<typeof goalWorker>>) => {
      await w.setGoal({ ...createGoalRecord({ objective: "Wait for a decision" }), status: "paused", tokensUsed: 5 });
    },
  ],
  [
    "its goal token cap is spent",
    async (w: Awaited<ReturnType<typeof goalWorker>>) => {
      await w.setGoal({ ...createGoalRecord({ objective: "Capped", capTokens: 100 }), tokensUsed: 100 });
    },
  ],
  [
    "the worker is stopped",
    async (w: Awaited<ReturnType<typeof goalWorker>>) => {
      await w.setGoal({ ...createGoalRecord({ objective: "Exhaust the lane" }), tokensUsed: 5 });
      await w.f.service.control(w.f.caller, { memberId: w.member.id, state: "stopped" });
    },
  ],
  ["it has no goal", async () => {}],
] as const)
  test(`a worker is not woken to continue when ${name}`, async () => {
    const w = await goalWorker();
    await w.finishOpenRun(() => prepare(w));
    await w.continuation.sweep();
    assert.equal((await w.continuations()).length, 0);
  });

test("a swarm turn resumed after an interruption keeps its dispatch provenance", async () => {
  const { f, workerRuns } = await goalWorker();
  const [run] = await workerRuns();
  assert.ok(await f.service.binding({ ...run!.request, runId: run!.id, resumeCause: { kind: "shutdown" } }));
});

test("a run that failed after a shutdown hand-back is continued, but an ordinary failure is not", async () => {
  for (const handedBack of [true, false]) {
    const { f, setGoal, claimOpenRun, continuation, continuations } = await goalWorker();
    await setGoal({ ...createGoalRecord({ objective: "Exhaust the lane" }), tokensUsed: 10 });
    let run = await claimOpenRun();
    if (handedBack) {
      await f.runs.releaseLease(run.id, run.leaseToken!, { kind: "shutdown" });
      run = (await f.runs.claimById(run.id, "test", 60_000))!;
    }
    await f.runs.fail(run.id, run.leaseToken!, "swarm claim budget exhausted", { retry: false });
    await continuation.sweep();
    assert.equal((await continuations()).length, handedBack ? 1 : 0);
  }
});
