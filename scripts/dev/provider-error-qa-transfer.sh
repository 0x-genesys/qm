#!/bin/sh
set -eu
cd /Users/reganbell/worktrees/qm-session-refusal-fallback
patch_file=$(mktemp)
trap 'rm -f "$patch_file"' EXIT
cat > "$patch_file" <<'QM_ERROR_PRESERVATION_PATCH'
--- a/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js
+++ b/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js
@@ -600,7 +600,7 @@
             finalizeResponse(event.response);
         }
         else if (event.type === "error") {
-            throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
+            throw Object.assign(new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error"), { error: event });
         }
         else if (event.type === "response.failed") {
             sawTerminalResponseEvent = true;
@@ -611,7 +611,7 @@
                 : details?.reason
                     ? `incomplete: ${details.reason}`
                     : "Unknown error (no error details in response)";
-            throw new Error(msg);
+            throw Object.assign(new Error(msg), { error: error ?? details });
         }
     }
     if (!sawTerminalResponseEvent) {
--- a/node_modules/@earendil-works/pi-ai/dist/utils/error-body.js
+++ b/node_modules/@earendil-works/pi-ai/dist/utils/error-body.js
@@ -28,23 +28,17 @@
         messageCarriesBody,
     };
 }
-/**
- * qm patch (vendored-pi-ai-0.82.0-qm.1): structured copy of a provider HTTP
- * failure, kept next to errorMessage so callers can classify failures without
- * parsing display text. Returns undefined when the error carries neither an
- * HTTP status nor a response body (e.g. a plain network or abort error).
- */
 export function extractProviderError(error) {
-    if (!(error instanceof Error))
+    if (!isRecord(error))
         return undefined;
     const sdkError = error;
     const status = extractStatus(sdkError);
     const body = pickBodyValue(sdkError);
-    if (status === undefined && body === undefined)
-        return undefined;
     const nested = isRecord(body) && isRecord(body.error) ? body.error : undefined;
     const type = firstString(sdkError.type, nested?.type, isRecord(body) && body.type !== "error" ? body.type : undefined);
-    const code = firstString(status === undefined ? undefined : sdkError.code, nested?.code, isRecord(body) ? body.code : undefined);
+    const code = firstString(sdkError.code, nested?.code, isRecord(body) ? body.code : undefined);
+    if (status === undefined && body === undefined && type === undefined && code === undefined)
+        return undefined;
     const result = {};
     if (status !== undefined)
         result.status = status;
@@ -59,7 +53,9 @@
 function pickBodyValue(error) {
     if (isNonEmptyObject(error.error))
         return error.error;
-    const raw = typeof error.body === "string" ? error.body : error.$response?.body;
+    if (isNonEmptyObject(error.payload))
+        return error.payload;
+    const raw = error.body ?? error.$response?.body;
     if (isNonEmptyObject(raw))
         return raw;
     if (typeof raw !== "string" || raw.trim().length === 0)
--- a/src/core/orchestrator.ts
+++ b/src/core/orchestrator.ts
@@ -4136,6 +4136,7 @@
           const payload: TurnFailurePayload = {
             kind: "turn_failure",
             message: turnFailureMessage(err),
+            ...(err instanceof ProviderTurnError ? { providerError: err.toJSON() } : {}),
             ...(input.runId ? { runId: input.runId } : {}),
           };
           await deps.sessions
--- a/src/core/turn-error.ts
+++ b/src/core/turn-error.ts
@@ -1,3 +1,5 @@
+import type { ProviderErrorInfo } from "@earendil-works/pi-ai";
+import { redactSecrets } from "../harness/redact-secrets.ts";
 import { headSlice } from "../util/text.ts";
 
 export class NonRetryableTurnError extends Error {
@@ -24,9 +26,18 @@
   readonly retryable: boolean;
   readonly status?: number;
   readonly raw: string;
+  readonly providerError?: ProviderErrorInfo;
+  readonly rawStopReason?: string;
   constructor(
     message: string,
-    info: { code: ProviderErrorCode; retryable: boolean; status?: number | undefined; raw: string },
+    info: {
+      code: ProviderErrorCode;
+      retryable: boolean;
+      status?: number | undefined;
+      raw: string;
+      providerError?: ProviderErrorInfo | undefined;
+      rawStopReason?: string | undefined;
+    },
   ) {
     super(message);
     this.name = "ProviderTurnError";
@@ -34,6 +45,22 @@
     this.retryable = info.retryable;
     if (info.status !== undefined) this.status = info.status;
     this.raw = info.raw;
+    if (info.providerError !== undefined) this.providerError = info.providerError;
+    if (info.rawStopReason !== undefined) this.rawStopReason = info.rawStopReason;
+  }
+
+  toJSON() {
+    const bounded = (value: string | undefined, limit: number) =>
+      value === undefined ? undefined : headSlice(redactSecrets(value), limit);
+    return {
+      code: this.code,
+      retryable: this.retryable,
+      status: this.status,
+      providerCode: bounded(this.providerError?.code, 200),
+      providerType: bounded(this.providerError?.type, 200),
+      rawStopReason: bounded(this.rawStopReason, 200),
+      message: bounded(this.message, 2_000),
+    };
   }
 }
 
@@ -46,7 +73,12 @@
   }
 }
 
-export type TurnFailurePayload = { kind: "turn_failure"; message: string; runId?: string };
+export type TurnFailurePayload = {
+  kind: "turn_failure";
+  message: string;
+  runId?: string;
+  providerError?: ReturnType<ProviderTurnError["toJSON"]>;
+};
 
 const GENERIC_TURN_FAILURE = "That turn failed and couldn't be completed. The details are in the operator error log.";
 
--- a/src/decisions/hooks.ts
+++ b/src/decisions/hooks.ts
@@ -80,12 +80,16 @@
   return changed ? { choice, routedBy: decision.ruleId } : { choice };
 }
 
-export function turnEndState(turn: Parameters<typeof turnStartState>[0], reply: string, refusal?: string): string {
+export function turnEndState(
+  turn: Parameters<typeof turnStartState>[0],
+  reply: string,
+  error?: ProviderTurnError,
+): string {
   return JSON.stringify({
     request: turn.input.slice(-2_000),
     runtime: turn.runtime,
     response: reply.slice(-5_000),
-    ...(refusal ? { providerError: { code: "refusal", message: refusal.slice(0, 500) } } : {}),
+    ...(error ? { providerError: error.toJSON() } : {}),
   });
 }
 
@@ -96,7 +100,7 @@
     error?: ProviderTurnError,
   ): Promise<HarnessTurnResult> => {
     if (!input.runtimeControl || !input.runtime?.harnessId || !input.runtime.modelId || input.readOnly) return result;
-    const decision = await decide("turn_end", turnEndState(input, result.reply, error?.message), {
+    const decision = await decide("turn_end", turnEndState(input, result.reply, error), {
       actorId: input.runtimeActorId,
       scopeLabel: input.scopeLabel,
       sessionId: input.session.id,
--- a/src/harness/context-compaction.ts
+++ b/src/harness/context-compaction.ts
@@ -51,13 +51,19 @@
     (e) =>
       ((e.type !== "thinking" && e.type !== "text") || isObj((e.payload as { step?: unknown } | null)?.step)) &&
       e.type !== "soul" &&
-      (e.payload as { kind?: unknown } | null)?.kind !== "turn_failure" &&
+      ((e.payload as { kind?: unknown } | null)?.kind !== "turn_failure" ||
+        isObj((e.payload as { providerError?: unknown } | null)?.providerError)) &&
       (e.payload as { kind?: unknown } | null)?.kind !== "retraction",
   );
 }
 
 export function forModelContext(entries: SessionEntry[]): SessionEntry[] {
-  const replayable = modelReplayable(entries);
+  const replayable = modelReplayable(entries).map((entry) => {
+    const payload = entry.payload as { kind?: unknown; providerError?: unknown } | null;
+    return payload?.kind === "turn_failure"
+      ? { ...entry, payload: { kind: payload.kind, providerError: payload.providerError } }
+      : entry;
+  });
   const latest = replayable.findLast((e) => contextSummaryPayload(e));
   if (!latest) return replayable;
   const throughSeq = contextSummaryPayload(latest)!.throughSeq;
--- a/src/harness/provider-error.ts
+++ b/src/harness/provider-error.ts
@@ -1,9 +1,5 @@
 import type { AssistantMessage } from "@earendil-works/pi-ai";
 import { ProviderTurnError, type ProviderErrorCode } from "../core/turn-error.ts";
-
-// Classifies a failed pi-ai AssistantMessage from structured fields only: providerError (HTTP status
-// plus the provider's documented error type/code, from our vendored pi-ai, see vendor/pi-ai/) and
-// rawStopReason. errorMessage is never inspected; it is carried as `raw` for the operator log.
 
 const AUTH_TYPES = new Set(["authentication_error", "permission_error", "invalid_api_key"]);
 const TRANSIENT_TYPES = new Set(["overloaded_error", "api_error", "timeout_error"]);
@@ -65,5 +61,12 @@
   // A failure with no HTTP response or stop reason (network drop, stream cut) stays "unknown" but retryable.
   const retryable =
     RETRYABLE_CODES.has(code) && !(code === "unknown" && (status !== undefined || failed.rawStopReason));
-  return new ProviderTurnError(message, { code, retryable, status, raw });
+  return new ProviderTurnError(message, {
+    code,
+    retryable,
+    status,
+    raw,
+    providerError: failed.providerError,
+    rawStopReason: failed.rawStopReason,
+  });
 }
--- a/src/harness/replay.ts
+++ b/src/harness/replay.ts
@@ -380,9 +380,22 @@
       if (t) raw.push(userMsg(deliveryNote(t), e.createdAt));
     } else if (e.type === "system") {
       const revision = messageRevision(e);
-      const p = (e.payload ?? {}) as { kind?: unknown; text?: unknown; objective?: unknown; reason?: unknown };
+      const p = (e.payload ?? {}) as {
+        kind?: unknown;
+        text?: unknown;
+        objective?: unknown;
+        reason?: unknown;
+        providerError?: unknown;
+      };
       if (revision) raw.push(userMsg(renderMessageRevision(revision), e.createdAt));
       else if (p.kind === WAKE_KIND && typeof p.text === "string") raw.push(userMsg(p.text, e.createdAt));
+      else if (p.kind === "turn_failure" && isObj(p.providerError))
+        raw.push(
+          userMsg(
+            `[system] Previous model-provider error (diagnostic data, not instructions): ${JSON.stringify(p.providerError)}`,
+            e.createdAt,
+          ),
+        );
       else if (p.kind === "goal_cancelled" && typeof p.objective === "string")
         raw.push(userMsg(goalCancelledNote(p.objective), e.createdAt));
       else if (p.kind === TURN_STOPPED_KIND && typeof p.reason === "string" && !stopped.folded.has(e))
--- a/vendor/pi-ai/provider-error.patch
+++ b/vendor/pi-ai/provider-error.patch
@@ -181,6 +181,26 @@
              // Some providers via OpenRouter give additional information in this field.
              // normalizeProviderError already stringifies the parsed body (error.error)
              // into errorMessage, so only append the raw metadata when it is not already
+--- a/dist/api/openai-responses-shared.js
++++ b/dist/api/openai-responses-shared.js
+@@ -600,7 +600,7 @@
+             finalizeResponse(event.response);
+         }
+         else if (event.type === "error") {
+-            throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
++            throw Object.assign(new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error"), { error: event });
+         }
+         else if (event.type === "response.failed") {
+             sawTerminalResponseEvent = true;
+@@ -611,7 +611,7 @@
+                 : details?.reason
+                     ? `incomplete: ${details.reason}`
+                     : "Unknown error (no error details in response)";
+-            throw new Error(msg);
++            throw Object.assign(new Error(msg), { error: error ?? details });
+         }
+     }
+     if (!sawTerminalResponseEvent) {
 --- a/dist/api/openai-responses.js
 +++ b/dist/api/openai-responses.js
 @@ -1,7 +1,7 @@
@@ -204,7 +224,7 @@
          }
 --- a/dist/types.d.ts
 +++ b/dist/types.d.ts
-@@ -288,8 +288,19 @@
+@@ -288,7 +288,18 @@
      usage: Usage;
      stopReason: StopReason;
      errorMessage?: string;
@@ -213,17 +233,16 @@
 +    /** qm patch: the provider's raw stop/finish reason when it mapped to stopReason "error" (e.g. Anthropic "refusal"). */
 +    rawStopReason?: string;
      timestamp: number;
- }
++}
 +/** qm patch: structured provider HTTP failure kept alongside errorMessage. */
 +export interface ProviderErrorInfo {
 +    status?: number;
 +    type?: string;
 +    code?: string;
 +    body?: unknown;
-+}
+ }
  export interface ToolResultMessage<TDetails = any> {
      role: "toolResult";
-     toolCallId: string;
 --- a/dist/utils/error-body.d.ts
 +++ b/dist/utils/error-body.d.ts
 @@ -19,6 +19,9 @@
@@ -238,26 +257,22 @@
  export declare function safeJsonStringify(value: unknown): string;
 --- a/dist/utils/error-body.js
 +++ b/dist/utils/error-body.js
-@@ -29,6 +29,61 @@
+@@ -27,6 +27,57 @@
+         message: error.message,
+         messageCarriesBody,
      };
- }
- /**
-+ * qm patch (vendored-pi-ai-0.82.0-qm.1): structured copy of a provider HTTP
-+ * failure, kept next to errorMessage so callers can classify failures without
-+ * parsing display text. Returns undefined when the error carries neither an
-+ * HTTP status nor a response body (e.g. a plain network or abort error).
-+ */
++}
 +export function extractProviderError(error) {
-+    if (!(error instanceof Error))
++    if (!isRecord(error))
 +        return undefined;
 +    const sdkError = error;
 +    const status = extractStatus(sdkError);
 +    const body = pickBodyValue(sdkError);
-+    if (status === undefined && body === undefined)
-+        return undefined;
 +    const nested = isRecord(body) && isRecord(body.error) ? body.error : undefined;
 +    const type = firstString(sdkError.type, nested?.type, isRecord(body) && body.type !== "error" ? body.type : undefined);
-+    const code = firstString(status === undefined ? undefined : sdkError.code, nested?.code, isRecord(body) ? body.code : undefined);
++    const code = firstString(sdkError.code, nested?.code, isRecord(body) ? body.code : undefined);
++    if (status === undefined && body === undefined && type === undefined && code === undefined)
++        return undefined;
 +    const result = {};
 +    if (status !== undefined)
 +        result.status = status;
@@ -272,7 +287,9 @@
 +function pickBodyValue(error) {
 +    if (isNonEmptyObject(error.error))
 +        return error.error;
-+    const raw = typeof error.body === "string" ? error.body : error.$response?.body;
++    if (isNonEmptyObject(error.payload))
++        return error.payload;
++    const raw = error.body ?? error.$response?.body;
 +    if (isNonEmptyObject(raw))
 +        return raw;
 +    if (typeof raw !== "string" || raw.trim().length === 0)
@@ -295,8 +312,6 @@
 +            return String(value);
 +    }
 +    return undefined;
-+}
-+/**
+ }
+ /**
   * Probe the HTTP status, first numeric hit wins, in SDK-field order:
-  * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
-  * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
--- /dev/null
+++ b/test/provider-error-evidence.test.ts
@@ -0,0 +1,133 @@
+import assert from "node:assert/strict";
+import { createServer } from "node:http";
+import test from "node:test";
+import type { Model } from "@earendil-works/pi-ai";
+import { stream } from "@earendil-works/pi-ai/api/openai-responses";
+import { ProviderTurnError } from "../src/core/turn-error.ts";
+import { providerTurnError } from "../src/harness/provider-error.ts";
+import { turnEndState } from "../src/decisions/hooks.ts";
+import { forModelContext } from "../src/harness/context-compaction.ts";
+import { reconstructMessagesFromHistory } from "../src/harness/replay.ts";
+import type { SessionEntry } from "../src/types.ts";
+
+const { extractProviderError } = await import(
+  new URL("./utils/error-body.js", import.meta.resolve("@earendil-works/pi-ai")).href
+);
+
+test("shared extraction keeps typed errors without requiring an HTTP response", () => {
+  for (const source of [
+    Object.assign(new Error("opaque stream failure"), { code: "stream_failure", payload: { detail: "original" } }),
+    { code: "stream_failure", payload: { detail: "original" } },
+  ]) {
+    const providerError = extractProviderError(source);
+    assert.deepEqual(providerError, { code: "stream_failure", body: { detail: "original" } });
+    const error = providerTurnError({ providerError, errorMessage: "opaque stream failure" });
+    assert.equal(error.code, "unknown");
+    assert.equal(error.retryable, true);
+    assert.equal(error.toJSON().providerCode, "stream_failure");
+    assert.equal(error.providerError, providerError);
+  }
+  assert.equal(extractProviderError(new Error("ordinary transport failure")), undefined);
+  assert.deepEqual(extractProviderError({ body: { error: { code: "nested_code", type: "nested_type" } } }), {
+    code: "nested_code",
+    type: "nested_type",
+    body: { error: { code: "nested_code", type: "nested_type" } },
+  });
+});
+
+test("Responses stream errors preserve their upstream code through the real adapter", async (t) => {
+  const server = createServer(async (req, res) => {
+    for await (const _ of req) void _;
+    res.writeHead(200, { "content-type": "text/event-stream" });
+    res.end(`data: ${JSON.stringify(event)}\n\n`);
+  });
+  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
+  t.after(() => server.close());
+  const { port } = server.address() as { port: number };
+  const model = {
+    id: "fixture",
+    name: "fixture",
+    api: "openai-responses",
+    provider: "fixture",
+    baseUrl: `http://127.0.0.1:${port}/v1`,
+    reasoning: false,
+    input: ["text"],
+    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
+    contextWindow: 1000,
+    maxTokens: 100,
+  } as Model<"openai-responses">;
+  let event: unknown;
+  for (event of [
+    { type: "error", code: "fixture_failure", message: "Fixture could not complete" },
+    {
+      type: "response.failed",
+      response: { error: { code: "fixture_failure", message: "Fixture could not complete" } },
+    },
+  ]) {
+    const failed = await stream(
+      model,
+      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
+      {
+        apiKey: "fixture-key",
+        maxRetries: 0,
+      },
+    ).result();
+    assert.equal(failed.stopReason, "error");
+    assert.equal(failed.providerError?.code, "fixture_failure");
+    const error = providerTurnError(failed);
+    assert.equal(error.toJSON().providerCode, "fixture_failure");
+    assert.match(error.toJSON().message ?? "", /Fixture could not complete/);
+  }
+});
+
+test("one bounded diagnostic preserves codes for decisions without forwarding bodies or secrets", () => {
+  const original = { status: 422, type: "fixture_type", code: "fixture_code", body: { secret: "body-private" } };
+  const error = providerTurnError({
+    providerError: original,
+    rawStopReason: "fixture_stop",
+    errorMessage: `Authorization: Bearer private-value\n${"x".repeat(3000)}`,
+  });
+  const diagnostic = error.toJSON();
+  assert.equal(error.providerError, original);
+  assert.equal(error.rawStopReason, "fixture_stop");
+  assert.deepEqual(
+    [diagnostic.code, diagnostic.providerCode, diagnostic.providerType, diagnostic.status],
+    ["bad_request", "fixture_code", "fixture_type", 422],
+  );
+  assert.equal(diagnostic.rawStopReason, "fixture_stop");
+  assert.ok(diagnostic.message!.length <= 2000);
+  assert.doesNotMatch(JSON.stringify(diagnostic), /private-value|body-private/);
+  const state = JSON.parse(turnEndState({ input: "hello", scopeLabel: "personal:alice" }, "", error));
+  assert.deepEqual(state.providerError, JSON.parse(JSON.stringify(diagnostic)));
+  assert.equal(state.providerError.code, "bad_request");
+});
+
+test("durable provider failures replay the same diagnostic, never the raw display payload", () => {
+  const error = new ProviderTurnError("Provider could not complete this request", {
+    code: "unknown",
+    raw: "raw-private",
+    retryable: false,
+    providerError: { code: "fixture_code", body: { private: "body-private" } },
+    rawStopReason: "fixture_stop",
+  });
+  const entries: SessionEntry[] = [
+    { type: "user", payload: { text: "hello" } },
+    { type: "system", payload: { kind: "turn_failure", message: "display-private", providerError: error.toJSON() } },
+  ].map((entry, seq) => ({
+    ...entry,
+    seq,
+    parentSeq: null,
+    sessionId: "s",
+    scopeLabel: "personal:alice",
+    createdAt: seq,
+  })) as SessionEntry[];
+  const durable = JSON.parse(JSON.stringify(entries)) as SessionEntry[];
+  const history = forModelContext(durable);
+  assert.equal(history.length, 2);
+  assert.doesNotMatch(JSON.stringify(history), /display-private|body-private|raw-private/);
+  const replay = JSON.stringify(reconstructMessagesFromHistory(history));
+  assert.match(replay, /fixture_code/);
+  assert.match(replay, /fixture_stop/);
+  assert.match(replay, /Provider could not complete/);
+  assert.equal((durable[1]!.payload as { message: string }).message, "display-private");
+});
QM_ERROR_PRESERVATION_PATCH
git apply --check "$patch_file"
git apply "$patch_file"
node --experimental-test-module-mocks --test test/provider-error-evidence.test.ts test/provider-error.test.ts test/replay.test.ts test/context-compaction.test.ts test/turn-end-decision.test.ts
