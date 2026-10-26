import { test } from "node:test";
import assert from "node:assert/strict";
import { retireFinishedJobComputers } from "../src/processes/job-computers.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import type { SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import type { ProcessSandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

function fixture() {
  const exited = new Set<string>();
  const retired: string[] = [];
  const finished: string[] = [];
  const errors: unknown[] = [];
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const computers: SandboxResource[] = ["job-a", "job-b", "job-new"].map((id) => ({
    id,
    backend: "local",
    ownerScopeId: "channel:room",
    backingScopeId: `sandbox-${id}`,
    name: "background job",
    createdBy: "alice",
    createdAt: id === "job-new" ? new Date().toISOString() : old,
    legacy: false,
    state: "ready",
    jobOnly: true,
  }));
  const processes = createMemoryProcessRegistry();
  const sandbox = {
    async provision(_layers: unknown, opts?: { sandboxId?: string }) {
      return { id: opts!.sandboxId!, rootDir: "/workspace", resourceId: opts!.sandboxId! };
    },
    async teardown() {},
    async listProcesses(handle: SandboxHandle) {
      return (await processes.listByScope("channel:room"))
        .filter((job) => job.sandboxId === handle.resourceId)
        .map((job) => ({
          processId: job.processId,
          status: exited.has(job.processId) ? { state: "exited", code: 0 } : { state: "running" },
        }));
    },
  } as unknown as ProcessSandbox;
  const sweep = () =>
    retireFinishedJobComputers({
      resources: {
        jobComputers: async () => computers.filter((computer) => !retired.includes(computer.id)),
        retireJobComputer: async (id) => void retired.push(id),
      },
      sandbox,
      processes,
      finish: async (_handle, processId) => void finished.push(processId),
      onError: (error) => void errors.push(error),
    });
  return { processes, exited, retired, finished, errors, sweep };
}

test("the job sweep retires a job computer only after its jobs end and write back", async () => {
  const f = fixture();
  for (const [processId, sandboxId] of [
    ["p-a", "job-a"],
    ["p-b", "job-b"],
  ] as const)
    await f.processes.register({
      processId,
      scopeId: "channel:room",
      sandboxId,
      kind: "background",
      command: "bg: sync",
      ttlMs: 600_000,
    });
  f.exited.add("p-a");
  await f.sweep();
  assert.deepEqual(f.retired, ["job-a"]);
  assert.deepEqual(f.finished, ["p-a"]);
  assert.equal((await f.processes.get("p-a"))?.status, "exited");
  f.exited.add("p-b");
  await f.sweep();
  assert.deepEqual(f.retired, ["job-a", "job-b"]);
  assert.deepEqual(f.errors, []);
});
