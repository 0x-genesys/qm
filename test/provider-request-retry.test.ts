import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { buildModelRuntime } from "../src/harness/pi-harness.ts";
import { summarizeHistory } from "../src/harness/history-summary.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";

const summary = "## Goal\nKeep going.";

function okStream(): Response {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_summary" } },
    { type: "response.output_text.delta", output_index: 0, delta: summary },
    { type: "response.completed", response: { id: "resp_summary", status: "completed", output: [] } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function stubFetch(t: { after(fn: () => void): void }, responses: Array<() => Response>): { calls: () => number } {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const encoded = new Headers(init?.headers).get("content-encoding") === "zstd";
    JSON.parse(encoded ? zstdDecompressSync(init?.body as Uint8Array).toString() : String(init?.body));
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    return next();
  }) as typeof fetch;
  return { calls: () => calls };
}

const unavailable = (): Response =>
  new Response(JSON.stringify({ error: { message: "service unavailable" } }), {
    status: 503,
    headers: { "retry-after-ms": "1" },
  });

test("a transient provider 503 is retried inside the turn instead of failing the attempt", async (t) => {
  const runtime = await buildModelRuntime({ openai: "sk-offline-test-key" });
  const http = stubFetch(t, [unavailable, okStream]);
  const result = await summarizeHistory([], getRequiredModel("gpt-6-astra"), (model, context, options) =>
    runtime.streamSimple(model, context, { ...options, transport: "sse" }),
  );
  assert.equal(result, summary);
  assert.equal(http.calls(), 2, "one failed request, one retry");
});

test("the in-turn retry is bounded and a caller can turn it off", async (t) => {
  const runtime = await buildModelRuntime({ openai: "sk-offline-test-key" });
  const http = stubFetch(t, [unavailable]);
  await assert.rejects(
    summarizeHistory([], getRequiredModel("gpt-6-astra"), (model, context, options) =>
      runtime.streamSimple(model, context, { ...options, transport: "sse" }),
    ),
  );
  assert.equal(http.calls(), 3, "the first request plus two retries");

  await assert.rejects(
    summarizeHistory([], getRequiredModel("gpt-6-astra"), (model, context, options) =>
      runtime.streamSimple(model, context, { ...options, transport: "sse", maxRetries: 0 }),
    ),
  );
  assert.equal(http.calls(), 4, "maxRetries: 0 makes exactly one request");
});
