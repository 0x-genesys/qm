import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "run-binding-test-secret-value!".repeat(2);
const GRACE_MS = 60_000;

test("a run-bound token is refused once its run is gone or has been over for the background-job ceiling", async () => {
  const now = Date.now();
  const runs = new Map<string, { id: string; status: string; finishedAt: number | null }>([
    ["run-live", { id: "run-live", status: "running", finishedAt: null }],
    ["run-just-done", { id: "run-just-done", status: "done", finishedAt: now - GRACE_MS / 2 }],
    ["run-long-done", { id: "run-long-done", status: "done", finishedAt: now - GRACE_MS }],
    ["run-failed", { id: "run-failed", status: "failed", finishedAt: now - 2 * GRACE_MS }],
  ]);
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    runs: { get: async (id: string) => runs.get(id) ?? null } as never,
    backgroundJobTtlMaxMs: GRACE_MS,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const list = async (runId?: string) => {
    const token = await mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: scopeId("personal", "U1"),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
        liveActor: true,
        ...(runId ? { runId } : {}),
      },
      SECRET,
    );
    const res = await fetch(`${base}/v1/apis`, { headers: { "x-agent-capability": token } });
    return { status: res.status, body: (await res.json()) as { message?: string } };
  };
  try {
    assert.equal((await list()).status, 200, "tokens without a run stay governed by their expiry alone");
    assert.equal((await list("run-live")).status, 200);
    assert.equal((await list("run-just-done")).status, 200, "background jobs keep access for the job ceiling");
    for (const ended of ["run-long-done", "run-failed", "run-unknown"]) {
      const refused = await list(ended);
      assert.equal(refused.status, 401, ended);
      assert.match(refused.body.message ?? "", /turn that issued this token has ended/);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
