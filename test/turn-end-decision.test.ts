import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnEndHook } from "../src/decisions/hooks.ts";
import { createHarnessRouter } from "../src/harness/harness-router.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { ProviderTurnError } from "../src/core/turn-error.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { DecisionResult } from "../src/decisions/decisions.ts";

const choice = { harnessId: "pi" as const, modelId: "gpt-6-astra" };
const fallback = { harnessId: "pi" as const, modelId: "claude-sonnet-5" };
const decision: DecisionResult = {
  ruleId: "refusal",
  action: "use_runtime",
  option: "refused",
  mode: "enforce",
  probabilities: { refused: 1 },
  runtime: fallback,
};

function turn(extra: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  return {
    session: { id: "s" },
    input: "Please do the task",
    runtime: choice,
    tools: {},
    history: [],
    systemPrompt: "",
    scopeLabel: "personal:alice",
    orgScopeId: "org:example",
    emit: async (entry) => ({ ...entry, sessionId: "s", seq: 0, parentSeq: null, createdAt: 1 }),
    ...extra,
  } as HarnessTurnInput;
}

test("post-response decisions use the runtime service and journal a recoverable runtime handoff", async () => {
  const entries: unknown[] = [];
  const requests: unknown[] = [];
  let classified: unknown;
  const hook = createTurnEndHook(async (hook, state) => {
    assert.equal(hook, "turn_end");
    classified = JSON.parse(state);
    return decision;
  });
  const result = await hook(
    turn({
      runtimeControl: async (_active, request) => {
        requests.push(request);
        return { ok: true, handoff: { choice: fallback, lifetime: "task" } };
      },
      emit: async (entry) => {
        entries.push(entry);
        return entry as never;
      },
    }),
    { reply: "I cannot help with that request.", modelCalls: 2 },
  );
  assert.equal(result.modelCalls, 2);
  assert.deepEqual(result.runtimeHandoff, { choice: fallback, lifetime: "task" });
  assert.equal((classified as { response: string }).response, "I cannot help with that request.");
  assert.equal((requests[0] as { lifetime: string }).lifetime, "task");
  assert.equal(entries.length, 2);
});

test("keep decisions, same runtime, and denied account switches preserve the result", async () => {
  for (const chosen of [undefined, { ...decision, runtime: choice }, decision]) {
    let writes = 0;
    const input = turn({
      runtimeControl: async () => ({ ok: false, error: "account_runtime_unavailable" }),
      emit: async (entry) => {
        writes++;
        return entry as never;
      },
    });
    const reply = { reply: "Original response" };
    assert.equal(await createTurnEndHook(async () => chosen)(input, reply), reply);
    assert.equal(writes, chosen === decision ? 1 : 0);
  }
});

test("router sends only structured refusals to the post-turn handler and preserves other errors", async () => {
  for (const code of ["refusal", "auth", "rate_limit"] as const) {
    const error = new ProviderTurnError("Provider rejected request", { code, raw: "", retryable: false });
    const adapter = createMockHarness();
    adapter.turns.runTurn = async () => {
      throw error;
    };
    let calls = 0;
    const router = createHarnessRouter(
      new Map([["pi", adapter]]),
      adapter,
      () => choice,
      async (_input, result, failure) => {
        calls++;
        assert.equal(failure, error);
        return { ...result, runtimeHandoff: { choice: fallback, lifetime: "task" } };
      },
    );
    if (code === "refusal") assert.ok((await router.turns.runTurn(turn())).runtimeHandoff);
    else await assert.rejects(router.turns.runTurn(turn()), (caught) => caught === error);
    assert.equal(calls, code === "refusal" ? 1 : 0);
  }
});
