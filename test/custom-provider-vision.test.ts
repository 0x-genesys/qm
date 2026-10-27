import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { buildModelRuntime } from "../src/harness/pi-harness.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

afterEach(() => setCustomProviders([]));

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function fakeChatCompletions(): Promise<{
  url: string;
  bodies: Array<Record<string, unknown>>;
  close: () => void;
}> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "cmpl-vision", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: finish }], usage: finish ? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } : undefined })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: "red" }, null));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    bodies,
    close: () => server.close(),
  };
}

async function sendImage(id: string): Promise<void> {
  const model = resolveModel(`custom/gpu/${id}`) as Model<Api>;
  const context: Context = {
    systemPrompt: "terse",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what colour is this pixel?" },
          { type: "image", data: PIXEL, mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      },
    ],
  };
  const runtime = await buildModelRuntime({ gpu: "sk-gpu" });
  const reply = await runtime.streamSimple(model, context, {}).result();
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
}

test("a vision custom model receives the image; a text-only one gets the omission placeholder", async () => {
  const upstream = await fakeChatCompletions();
  try {
    setCustomProviders([
      {
        id: "gpu",
        name: "Own GPU",
        protocol: "openai",
        baseUrl: upstream.url,
        models: [{ id: "qwen-vl", vision: true }, { id: "qwen-text" }],
      },
    ]);
    await sendImage("qwen-vl");
    await sendImage("qwen-text");
    const [vision, text] = upstream.bodies.map((b) => JSON.stringify(b.messages));
    assert.ok(vision?.includes(`data:image/png;base64,${PIXEL}`), "vision model request carries the image");
    assert.ok(!vision?.includes("image omitted"));
    assert.ok(!text?.includes(PIXEL), "text-only model request never carries the image bytes");
    assert.ok(text?.includes("(image omitted: model does not support images)"));
  } finally {
    upstream.close();
  }
});
