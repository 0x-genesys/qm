import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverCanaryChannel, pickCanaryChannel } from "../scripts/dev/lib/canary.ts";
import { startFakeSlackApi } from "./support/fake-slack-api.ts";

test("pickCanaryChannel prefers #dev-canary, then ci-*, never plain human channels", () => {
  const human = { id: "C1", name: "project-alpha" };
  const ci = { id: "C2", name: "ci-bot2-pong-13526" };
  const dedicated = { id: "C3", name: "dev-canary" };
  assert.equal(pickCanaryChannel([human, ci, dedicated])?.id, "C3");
  assert.equal(pickCanaryChannel([human, ci])?.id, "C2");
  assert.equal(pickCanaryChannel([human]), null);
  assert.equal(pickCanaryChannel([]), null);
});

test("pickCanaryChannel rejects human ci-* channels without a numeric throwaway suffix", () => {
  assert.equal(pickCanaryChannel([{ id: "C7", name: "ci-alerts" }]), null);
  assert.equal(pickCanaryChannel([{ id: "C8", name: "ci-migration" }]), null);
  assert.equal(pickCanaryChannel([{ id: "C9", name: "ci-ping2-15533" }])?.id, "C9");
  assert.equal(pickCanaryChannel([{ id: "C10", name: "ci-envnote-500" }])?.id, "C10");
});

test("discoverCanaryChannel paginates and finds dev-canary on a later page", async (t) => {
  const api = await startFakeSlackApi(({ params }) =>
    Response.json(
      params.get("cursor") === "p2"
        ? { ok: true, channels: [{ id: "C2", name: "dev-canary" }], response_metadata: { next_cursor: "" } }
        : { ok: true, channels: [{ id: "C1", name: "project-alpha" }], response_metadata: { next_cursor: "p2" } },
    ),
  );
  t.after(() => api.close());
  const found = await discoverCanaryChannel("xoxb-test", api.apiUrl);
  assert.equal(found?.id, "C2");
  assert.deepEqual(
    api.calls.map((call) => [call.method, call.params.get("cursor"), call.params.get("types")]),
    [
      ["users.conversations", null, "public_channel,private_channel"],
      ["users.conversations", "p2", "public_channel,private_channel"],
    ],
  );
});

test("discoverCanaryChannel survives a mid-pagination failure with what it has", async (t) => {
  const api = await startFakeSlackApi(({ params }) =>
    params.get("cursor")
      ? new Response("unavailable", { status: 503 })
      : Response.json({
          ok: true,
          channels: [{ id: "C3", name: "ci-ping-99" }],
          response_metadata: { next_cursor: "p2" },
        }),
  );
  t.after(() => api.close());
  const found = await discoverCanaryChannel("xoxb-test", api.apiUrl);
  assert.equal(found?.id, "C3");
  assert.equal(api.calls.length, 2);
});

test("pickCanaryChannel skips archived channels", () => {
  assert.equal(
    pickCanaryChannel([
      { id: "C4", name: "dev-canary", is_archived: true },
      { id: "C5", name: "ci-x-1" },
    ])?.id,
    "C5",
  );
  assert.equal(pickCanaryChannel([{ id: "C6", name: "ci-x-1", is_archived: true }]), null);
});
