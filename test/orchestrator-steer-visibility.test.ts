import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockHarness from "../src/harness/mock-harness.ts";
import { recordSteerIntake } from "../src/harness/harness-shared.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "../src/harness/harness.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

let exercise: ((turn: HarnessTurnInput) => Promise<HarnessTurnResult | void>) | undefined;
mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      const run = harness.turns.runTurn;
      harness.turns.runTurn = async (turn) => {
        if (!exercise) return run(turn);
        return (await exercise(turn)) ?? { reply: "Done" };
      };
      return harness;
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

for (const mode of ["retry", "handoff"] as const) {
  test(`a ${mode} hides its synthetic trigger but not real steer intake in entries or activity`, async () => {
    const built = buildApp(testConfig());
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "resume-steer-visibility" },
      text: "!work-then-boom",
      idempotencyKey: "resume-steer-visibility",
    };
    if (mode === "retry") await assert.rejects(built.app.turn(request), /boom/);
    let runId: string | undefined;
    exercise = async (turn) => {
      runId = turn.runId;
      if (mode === "handoff" && turn.input === request.text) {
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        return {
          reply: "",
          runtimeHandoff: {
            choice: { harnessId: turn.runtime!.harnessId!, modelId: turn.runtime!.modelId! },
            lifetime: "task",
          },
        };
      }
      if (mode === "retry") assert.equal(turn.continueTurn, true);
      else {
        assert.match(turn.input, /Runtime switched/);
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
      }
      await recordSteerIntake(turn, { text: "Change of plan", ts: "steer-visible" });
      await turn.emit({
        type: "user",
        payload: { text: "private steer", steered: true, hidden: true },
        scopeLabel: turn.scopeLabel,
      });
    };
    try {
      const result = await built.app.turn(request);
      assert.equal(result.status, "ok");
      const session = await built.app.getSession(result.sessionId!);
      const users = session!.entries.filter((entry) => entry.type === "user");
      const steerAt = mode === "retry" ? 1 : 2;
      if (mode !== "retry") assert.equal((users[1]!.payload as { hidden?: boolean }).hidden, true);
      assert.equal(users.length, steerAt + 2);
      assert.equal((users[steerAt]!.payload as { text?: string }).text, "Change of plan");
      assert.notEqual((users[steerAt]!.payload as { hidden?: boolean }).hidden, true);
      assert.equal((users[steerAt + 1]!.payload as { hidden?: boolean }).hidden, true);
      const activity = (await built.app.getRun(runId!))!.activity ?? [];
      const liveSteer = activity.find(
        (entry) => entry.type === "user" && (entry.payload as { text?: string }).text === "Change of plan",
      );
      assert.ok(liveSteer);
      assert.notEqual((liveSteer.payload as { hidden?: boolean }).hidden, true);
    } finally {
      exercise = undefined;
    }
  });
}

for (const prior of ["empty", "hidden"] as const) {
  test(`a turn's retraction boundary is the raw journal tail with ${prior} prior history`, async () => {
    const built = buildApp(testConfig());
    const request = (text: string): TurnRequest => ({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `turn-start-boundary-${prior}` },
      text,
      idempotencyKey: `turn-start-boundary-${prior}-${text}`,
    });
    let hiddenSeq = -1;
    let seen: { turnStartSeq?: number; historyTail?: number; firstSeq: number } | undefined;
    try {
      if (prior === "hidden") {
        exercise = async (turn) => {
          await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
          hiddenSeq = (await turn.emit({ type: "text", payload: { text: "unstepped" }, scopeLabel: turn.scopeLabel }))
            .seq;
        };
        await built.app.turn(request("earlier"));
      }
      exercise = async (turn) => {
        const first = await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        seen = { turnStartSeq: turn.turnStartSeq, historyTail: turn.history.at(-1)?.seq, firstSeq: first.seq };
      };
      await built.app.turn(request("refused"));
    } finally {
      exercise = undefined;
    }
    assert.equal(seen!.turnStartSeq, seen!.firstSeq - 1);
    assert.ok(seen!.turnStartSeq! >= hiddenSeq);
    if (prior === "hidden") assert.ok((seen!.historyTail ?? -1) < hiddenSeq);
  });
}
