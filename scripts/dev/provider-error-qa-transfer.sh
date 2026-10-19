#!/bin/sh
set -eu
cd /Users/reganbell/worktrees/qm-session-refusal-fallback
patch_file=$(mktemp)
trap 'rm -f "$patch_file"' EXIT
git checkout -- test/turn-end-decision.test.ts
cat > "$patch_file" <<'QM_REFUSAL_FLOW_PATCH'
diff --git a/src/harness/harness-router.ts b/src/harness/harness-router.ts
index b393f9e6..d0663cee 100644
--- a/src/harness/harness-router.ts
+++ b/src/harness/harness-router.ts
@@ -332,13 +332,12 @@ export function createHarnessRouter(
             ? adapter.turns.runTurn(dispatched)
             : runTurnEnforcingGoal(adapter, dispatched, choice.harnessId));
         } catch (error) {
-          if (!afterTurn || !(error instanceof ProviderTurnError) || error.code !== "refusal" || input.cancel?.aborted)
-            throw error;
+          if (!afterTurn || !(error instanceof ProviderTurnError) || input.cancel?.aborted) throw error;
           let recovered: HarnessTurnResult;
           try {
             recovered = await afterTurn(dispatched, { reply: "" }, error);
           } catch (recoveryError) {
-            throw new AggregateError([error, recoveryError], "Provider refusal recovery failed", {
+            throw new AggregateError([error, recoveryError], "Provider error recovery failed", {
               cause: recoveryError,
             });
           }
diff --git a/test/turn-end-decision.test.ts b/test/turn-end-decision.test.ts
index 0da21728..cdc92c65 100644
--- a/test/turn-end-decision.test.ts
+++ b/test/turn-end-decision.test.ts
@@ -1,5 +1,7 @@
 import assert from "node:assert/strict";
 import { test } from "node:test";
+import { createRuntimeService } from "../src/harness/runtime-control.ts";
+import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
 import { createTurnEndHook } from "../src/decisions/hooks.ts";
 import { forModelContext } from "../src/harness/context-compaction.ts";
 import type { SessionEntry } from "../src/types.ts";
@@ -61,7 +63,7 @@ test("post-response decisions use the runtime service and journal a recoverable
       turnStartSeq: 7,
       runtimeControl: async (_active, request) => {
         requests.push(request);
-        return { ok: true, handoff: { choice: fallback, lifetime: "task" } };
+        return { ok: true, handoff: { choice: fallback, lifetime: "scope" } };
       },
       emit: async (entry) => {
         entries.push(entry);
@@ -71,10 +73,10 @@ test("post-response decisions use the runtime service and journal a recoverable
     { reply: "I cannot help with that request.", modelCalls: 2 },
   );
   assert.equal(result.modelCalls, 2);
-  assert.deepEqual(result.runtimeHandoff, { choice: fallback, lifetime: "task" });
+  assert.deepEqual(result.runtimeHandoff, { choice: fallback, lifetime: "scope" });
   assert.equal((classified as { response: string }).response, "I cannot help with that request.");
-  assert.equal((requests[0] as { lifetime: string }).lifetime, "task");
-  assert.equal(entries.length, 3);
+  assert.equal((requests[0] as { lifetime: string }).lifetime, "scope");
+  assert.equal(entries.length, 2);
   const marker = entries[0] as { type: string; payload: { kind?: string; fromSeq?: number; cause?: string } };
   assert.equal(marker.type, "system");
   assert.equal(marker.payload.kind, "retraction");
@@ -88,7 +90,7 @@ test("a structured refusal retraction records the provider cause", async () => {
   await hook(
     turn({
       turnStartSeq: 4,
-      runtimeControl: async () => ({ ok: true, handoff: { choice: fallback, lifetime: "task" } }),
+      runtimeControl: async () => ({ ok: true, handoff: { choice: fallback, lifetime: "scope" } }),
       emit: async (entry_) => {
         entries.push(entry_);
         return entry_ as never;
@@ -142,26 +144,105 @@ test("keep decisions, same runtime, and denied account switches preserve the res
   }
 });
 
-test("router sends only structured refusals to the post-turn handler and preserves other errors", async () => {
+test("router routes provider errors through the turn-end handler and preserves them without a handoff", async () => {
   for (const code of ["refusal", "auth", "rate_limit"] as const) {
-    const error = new ProviderTurnError("Provider rejected request", { code, raw: "", retryable: false });
-    const adapter = createMockHarness();
-    adapter.turns.runTurn = async () => {
-      throw error;
-    };
-    let calls = 0;
-    const router = createHarnessRouter(
-      new Map([["pi", adapter]]),
-      adapter,
-      () => choice,
-      async (_input, result, failure) => {
-        calls++;
-        assert.equal(failure, error);
-        return { ...result, runtimeHandoff: { choice: fallback, lifetime: "task" } };
-      },
+    for (const recover of [true, false]) {
+      const error = new ProviderTurnError("Provider rejected request", { code, raw: "", retryable: false });
+      const adapter = createMockHarness();
+      adapter.turns.runTurn = async () => {
+        throw error;
+      };
+      let calls = 0;
+      const router = createHarnessRouter(
+        new Map([["pi", adapter]]),
+        adapter,
+        () => choice,
+        async (_input, result, failure) => {
+          calls++;
+          assert.equal(failure, error);
+          return recover ? { ...result, runtimeHandoff: { choice: fallback, lifetime: "task" } } : result;
+        },
+      );
+      if (recover) assert.ok((await router.turns.runTurn(turn())).runtimeHandoff);
+      else await assert.rejects(router.turns.runTurn(turn()), (caught) => caught === error);
+      assert.equal(calls, 1);
+    }
+  }
+  const plain = new Error("Plain failure");
+  const adapter = createMockHarness();
+  adapter.turns.runTurn = async () => {
+    throw plain;
+  };
+  let plainCalls = 0;
+  const router = createHarnessRouter(
+    new Map([["pi", adapter]]),
+    adapter,
+    () => choice,
+    async () => {
+      plainCalls++;
+      return {} as never;
+    },
+  );
+  await assert.rejects(router.turns.runTurn(turn()), (caught) => caught === plain);
+  assert.equal(plainCalls, 0);
+});
+
+async function runtimeSetup() {
+  const config = createMemoryConfigStore("example");
+  config.setApprovedHarnesses(["pi"]);
+  await config.flushScope("org:example");
+  await config.setRuntimeSelectionLatest("org:example", choice);
+  const service = createRuntimeService(
+    { config, harnessId: "pi", baseModelDefault: choice.modelId },
+    { authorizesCapabilityScope: async () => true },
+  );
+  const claims = { actorId: "alice", scopeId: "personal:alice", liveActor: true, exp: Date.now() + 60_000 };
+  return { config, service, claims };
+}
+
+test("a refusal saves the fallback for future requests until the user changes the setting", async () => {
+  const { config, service, claims } = await runtimeSetup();
+  const hook = createTurnEndHook(async () => decision);
+  const result = await hook(turn({ runtimeControl: (active, request) => service(claims, active, request) }), {
+    reply: "I cannot help with that request.",
+  });
+  assert.equal(
+    result.runtimeHandoff && "lifetime" in result.runtimeHandoff ? result.runtimeHandoff.lifetime : undefined,
+    "scope",
+  );
+  assert.equal((await config.getRuntimeSelectionDurable("personal:alice"))?.modelId, fallback.modelId);
+  const next = await service(claims, fallback, { action: "get" });
+  assert.ok(next.ok);
+  assert.equal((next.effective as { modelId: string }).modelId, fallback.modelId);
+  assert.equal((await config.getRuntimeSelectionDurable("org:example"))?.modelId, choice.modelId);
+  assert.equal(await config.getRuntimeSelectionDurable("personal:bob"), null);
+  await service(claims, fallback, { action: "set", model: choice.modelId, lifetime: "scope" });
+  assert.equal((await config.getRuntimeSelectionDurable("personal:alice"))?.modelId, choice.modelId);
+});
+
+test("background fallbacks switch only the task without changing saved defaults", async () => {
+  for (const background of ["cron", "session"] as const) {
+    const { config, service, claims } = await runtimeSetup();
+    const requests: string[] = [];
+    const hook = createTurnEndHook(async () => decision);
+    const result = await hook(
+      turn({
+        runtimeControl: (active, request) => {
+          requests.push(request.lifetime!);
+          const caller =
+            background === "cron"
+              ? { ...claims, triggered: true }
+              : { ...claims, liveActor: request.lifetime !== "scope" };
+          return service(caller, active, request, undefined, false, undefined, background === "cron");
+        },
+      }),
+      { reply: "I cannot help with that request." },
     );
-    if (code === "refusal") assert.ok((await router.turns.runTurn(turn())).runtimeHandoff);
-    else await assert.rejects(router.turns.runTurn(turn()), (caught) => caught === error);
-    assert.equal(calls, code === "refusal" ? 1 : 0);
+    assert.deepEqual(requests, ["scope", "task"]);
+    assert.deepEqual(result.runtimeHandoff, {
+      choice: { ...fallback, effortLevel: "auto", fastMode: false },
+      lifetime: "task",
+    });
+    assert.equal(await config.getRuntimeSelectionDurable("personal:alice"), null);
   }
 });
QM_REFUSAL_FLOW_PATCH
git apply --check "$patch_file"
git apply "$patch_file"
shasum -a 256 src/harness/harness-router.ts
node --experimental-test-module-mocks --test test/turn-end-decision.test.ts test/provider-error-evidence.test.ts test/provider-error.test.ts test/replay.test.ts test/context-compaction.test.ts
node scripts/dev/cli.ts restart core
sleep 3
curl -s -o /dev/null -w 'core http:%{http_code}\n' http://localhost:8130/
echo "refusal-flow rework applied; core restarted"
