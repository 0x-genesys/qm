import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";
import { createBackgroundBroker } from "../src/connectors/background-exec-broker.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import { createReaperKillHook } from "../src/processes/process-reaper.ts";
import { createScratchJobComputers } from "../src/processes/scratch-job-computers.ts";
import type { ProcessSandbox, ProvisionOptions, SandboxHandle, TeardownOptions } from "../src/sandbox/sandbox.ts";
import type { WorkspaceLayer } from "../src/types.ts";

const settle = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate());
};

function fixture() {
  const exited = new Set<string>();
  const provisions: string[] = [];
  const destroyed: string[] = [];
  const signals: string[] = [];
  let next = 0;
  const sandbox = {
    profile: { processSessions: true },
    async provision(_layers: WorkspaceLayer[], opts?: ProvisionOptions) {
      const id = opts?.scratch ? `scratch-${++next}` : (opts?.sandboxId ?? "room");
      provisions.push(id);
      return { id, rootDir: "/workspace", ...(opts?.scratch ? { scratch: true } : {}) };
    },
    async teardown(handle: SandboxHandle, opts?: TeardownOptions) {
      if (opts?.destroy) destroyed.push(handle.id);
    },
    async startProcess(handle: SandboxHandle) {
      return { processId: `job-on-${handle.id}` };
    },
    async readProcess(_handle: SandboxHandle, processId: string) {
      return {
        chunks: "",
        cursor: 0,
        status: exited.has(processId) ? { state: "exited", code: 0 } : { state: "running" },
      };
    },
    async signalProcess(_handle: SandboxHandle, processId: string, signal: string) {
      signals.push(`${processId}:${signal}`);
      exited.add(processId);
    },
    async listProcesses() {
      return [];
    },
    async writeStdin() {},
  } as unknown as ProcessSandbox;
  const processes = createMemoryProcessRegistry();
  const finished: string[] = [];
  const scratchJobs = createScratchJobComputers({
    sandbox,
    processes,
    finish: async (_handle, processId) => void finished.push(processId),
    pollMs: 5,
  });
  const broker = createBackgroundBroker({ sandbox, registry: processes, scopeId: "channel:room", pollMs: 1 });
  const turn = (transferId: string) =>
    createTurnSandboxes({
      deps: { sandbox, processes, scratchJobs, auditLog: { record() {} } },
      input: {},
      actor: { id: "alice", type: "internal" },
      session: { id: "session-one" },
      resolution: { layers: [{ scopeId: "channel:room", mode: "rw", mountPath: "" }] },
      scopeId: "channel:room",
      memoryScopeId: "channel:room",
      transferId,
      connectorEnv: { AGENT_API_TOKEN: "turn-capability" },
    } as unknown as TurnSandboxContext);
  return { sandbox, processes, scratchJobs, broker, turn, exited, provisions, destroyed, signals, finished };
}

test("a scratch computer running a background job outlives its turn until the job exits", async () => {
  const f = fixture();
  const first = f.turn("turn-one");
  const { handle, sandboxId } = await first.provisionScratchJob();
  const job = await f.broker.start(handle, "sync", "Sync mail", 60_000, undefined, sandboxId);
  const record = await f.processes.get(job.processId);
  assert.equal(record?.sandboxId, sandboxId);
  await first.reclaimBox();
  assert.deepEqual(f.destroyed, []);
  assert.equal(f.scratchJobs.get(sandboxId)?.id, handle.id);
  const quiet = f.turn("turn-two");
  await quiet.provisionScratch();
  await quiet.reclaimBox();
  assert.deepEqual(f.destroyed, ["scratch-2"]);
  f.exited.add(job.processId);
  await settle(() => f.destroyed.includes(handle.id));
  assert.equal((await f.processes.get(job.processId))?.status, "exited");
  assert.deepEqual(f.finished, [job.processId]);
  assert.equal(f.scratchJobs.get(sandboxId), undefined);
});

test("the reaper kills a retained scratch job in place and skips one this process no longer holds", async () => {
  const f = fixture();
  const first = f.turn("turn-one");
  const { handle, sandboxId } = await first.provisionScratchJob();
  const job = await f.broker.start(handle, "sync", "Sync mail", 60_000, undefined, sandboxId);
  await first.reclaimBox();
  const kill = createReaperKillHook(f.sandbox, { termGraceMs: 5, killGraceMs: 5, scratchJobs: f.scratchJobs });
  const provisionsBefore = f.provisions.length;
  await kill((await f.processes.get(job.processId))!);
  assert.deepEqual(f.signals, [`${job.processId}:TERM`]);
  await kill({ ...(await f.processes.get(job.processId))!, sandboxId: "scratch-job:turn:gone" });
  assert.equal(f.provisions.length, provisionsBefore);
  await settle(() => f.destroyed.includes(handle.id));
});

test("draining destroys scratch computers still held for background jobs", async () => {
  const f = fixture();
  const first = f.turn("turn-one");
  const { handle, sandboxId } = await first.provisionScratchJob();
  await f.broker.start(handle, "sync", "Sync mail", 60_000, undefined, sandboxId);
  await first.reclaimBox();
  assert.deepEqual(f.destroyed, []);
  await f.scratchJobs.drain();
  assert.deepEqual(f.destroyed, [handle.id]);
});
