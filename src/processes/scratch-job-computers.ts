import type { ProcessSandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { ProcessSessionGoneError } from "../sandbox/exec-process-session.ts";
import type { ProcessRegistry } from "./process-registry.ts";
import { swallow } from "../util/errors.ts";

const SCRATCH_JOB_PREFIX = "scratch-job:";

export const scratchJobComputerId = (scratchKey: string): string => `${SCRATCH_JOB_PREFIX}${scratchKey}`;

export const isScratchJobComputer = (sandboxId: string): boolean => sandboxId.startsWith(SCRATCH_JOB_PREFIX);

export const SCRATCH_JOB_GONE_MESSAGE =
  "this background job's computer belonged to an earlier server process and was retired on deploy; the job and its files are gone";

export interface ScratchJobComputers {
  hold(sandboxId: string, handle: SandboxHandle): void;
  get(sandboxId: string): SandboxHandle | undefined;
  retainWhileJobsRun(sandboxId: string, retire: () => Promise<void>): Promise<boolean>;
  drain(): Promise<void>;
}

export function createScratchJobComputers(deps: {
  sandbox: ProcessSandbox;
  processes: ProcessRegistry;
  finish: (handle: SandboxHandle, processId: string) => Promise<void>;
  pollMs?: number;
}): ScratchJobComputers {
  const pollMs = deps.pollMs ?? 10_000;
  const held = new Map<string, { handle: SandboxHandle; retire?: () => Promise<void>; timer?: NodeJS.Timeout }>();
  const running = async (sandboxId: string) =>
    (await deps.processes.listLive()).filter((process) => process.sandboxId === sandboxId);
  const retire = async (sandboxId: string): Promise<void> => {
    const entry = held.get(sandboxId);
    if (!entry?.retire) return;
    held.delete(sandboxId);
    clearTimeout(entry.timer);
    await entry.retire();
  };
  const check = async (sandboxId: string): Promise<void> => {
    const entry = held.get(sandboxId);
    if (!entry) return;
    for (const process of await running(sandboxId)) {
      const exited = await deps.sandbox
        .readProcess(entry.handle, process.processId, { sinceCursor: 0, maxBytes: 1, waitMs: 0 })
        .then(
          (read) => read.status.state === "exited",
          (error) => {
            if (error instanceof ProcessSessionGoneError) return true;
            throw error;
          },
        );
      if (exited && (await deps.processes.markStatus(process.processId, "exited")))
        await deps.finish(entry.handle, process.processId);
    }
    if ((await running(sandboxId)).length === 0) return retire(sandboxId);
    entry.timer = setTimeout(() => void watch(sandboxId), pollMs);
    entry.timer.unref();
  };
  const watch = (sandboxId: string): Promise<void> =>
    check(sandboxId).catch((error) => {
      swallow("scratch job computers: exit check", error);
      const entry = held.get(sandboxId);
      if (!entry) return;
      entry.timer = setTimeout(() => void watch(sandboxId), pollMs);
      entry.timer.unref();
    });
  return {
    hold(sandboxId, handle) {
      if (!held.has(sandboxId)) held.set(sandboxId, { handle });
    },
    get: (sandboxId) => held.get(sandboxId)?.handle,
    async retainWhileJobsRun(sandboxId, retireComputer) {
      const entry = held.get(sandboxId);
      if (!entry) return false;
      if ((await running(sandboxId)).length === 0) {
        held.delete(sandboxId);
        return false;
      }
      entry.retire = retireComputer;
      entry.timer = setTimeout(() => void watch(sandboxId), pollMs);
      entry.timer.unref();
      return true;
    },
    async drain() {
      const retained = [...held.keys()].filter((sandboxId) => held.get(sandboxId)?.retire);
      await Promise.all(
        retained.map((sandboxId) => retire(sandboxId).catch((error) => swallow("scratch job computers: drain", error))),
      );
    },
  };
}
