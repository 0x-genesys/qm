import type { ProcessSandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { ProcessRegistry } from "./process-registry.ts";
import { reconcileProcesses } from "./reconcile.ts";

const SCRATCH_JOB_PREFIX = "scratch-job:";

export const scratchJobComputerId = (scratchKey: string): string => `${SCRATCH_JOB_PREFIX}${scratchKey}`;

export const isScratchJobComputer = (sandboxId: string): boolean => sandboxId.startsWith(SCRATCH_JOB_PREFIX);

export const SCRATCH_JOB_GONE_MESSAGE =
  "this background job's computer belonged to an earlier server process and was retired on deploy; the job and its files are gone";

export interface HeldComputers {
  get(sandboxId: string): SandboxHandle | undefined;
  holds(handle: SandboxHandle): boolean;
}

export interface ScratchJobComputers extends HeldComputers {
  hold(sandboxId: string, scopeId: string, handle: SandboxHandle): void;
  retainWhileJobsRun(sandboxId: string, retire: () => Promise<void>): Promise<boolean>;
  drain(): Promise<void>;
}

const FINISH_ATTEMPTS = 3;

export function createScratchJobComputers(deps: {
  sandbox: ProcessSandbox;
  processes: ProcessRegistry;
  finish: (handle: SandboxHandle, processId: string) => Promise<void>;
  onError: (code: string, error: unknown, scopeId: string) => void;
  pollMs?: number;
}): ScratchJobComputers {
  const pollMs = deps.pollMs ?? 10_000;
  const held = new Map<
    string,
    {
      handle: SandboxHandle;
      scopeId: string;
      retire?: () => Promise<void>;
      timer?: NodeJS.Timeout;
      failedChecks: number;
    }
  >();
  const jobs = async (sandboxId: string, scopeId: string) =>
    (await deps.processes.listByScope(scopeId)).filter((process) => process.sandboxId === sandboxId);
  const schedule = (sandboxId: string): void => {
    const entry = held.get(sandboxId);
    if (!entry) return;
    entry.timer = setTimeout(() => void check(sandboxId), pollMs);
    entry.timer.unref();
  };
  const retire = async (sandboxId: string): Promise<void> => {
    const entry = held.get(sandboxId);
    if (!entry?.retire) return;
    clearTimeout(entry.timer);
    try {
      await entry.retire();
      held.delete(sandboxId);
    } catch (error) {
      deps.onError("scratch_job_retire_failed", error, entry.scopeId);
      schedule(sandboxId);
    }
  };
  const check = async (sandboxId: string): Promise<void> => {
    const entry = held.get(sandboxId);
    if (!entry) return;
    try {
      await reconcileProcesses(deps.sandbox, entry.handle, deps.processes, entry.scopeId, deps.finish, sandboxId);
      entry.failedChecks = 0;
    } catch (error) {
      entry.failedChecks += 1;
      deps.onError("scratch_job_check_failed", error, entry.scopeId);
    }
    const remaining = await jobs(sandboxId, entry.scopeId).catch((error) => {
      deps.onError("scratch_job_check_failed", error, entry.scopeId);
      return null;
    });
    const running = remaining?.some((process) => process.status === "running");
    const pending = remaining?.some((process) => process.credentialsPending);
    if (remaining && !running && (!pending || entry.failedChecks >= FINISH_ATTEMPTS)) return retire(sandboxId);
    schedule(sandboxId);
  };
  return {
    hold(sandboxId, scopeId, handle) {
      if (!held.has(sandboxId)) held.set(sandboxId, { handle, scopeId, failedChecks: 0 });
    },
    get: (sandboxId) => held.get(sandboxId)?.handle,
    holds: (handle) => [...held.values()].some((entry) => entry.handle === handle),
    async retainWhileJobsRun(sandboxId, retireComputer) {
      const entry = held.get(sandboxId);
      if (!entry) return false;
      const running = await jobs(sandboxId, entry.scopeId).then(
        (records) => records.some((process) => process.status === "running"),
        (error) => {
          held.delete(sandboxId);
          throw error;
        },
      );
      if (!running) {
        held.delete(sandboxId);
        return false;
      }
      entry.retire = retireComputer;
      schedule(sandboxId);
      return true;
    },
    async drain() {
      await Promise.all(
        [...held].map(async ([sandboxId, entry]) => {
          if (!entry.retire) return;
          clearTimeout(entry.timer);
          const records = await jobs(sandboxId, entry.scopeId).catch((error) => {
            deps.onError("scratch_job_check_failed", error, entry.scopeId);
            return [];
          });
          for (const process of records) {
            if (process.status !== "running") continue;
            if (await deps.processes.markStatus(process.processId, "reaped"))
              await deps
                .finish(entry.handle, process.processId)
                .catch((error) => deps.onError("scratch_job_finish_failed", error, entry.scopeId));
          }
          await entry.retire().then(
            () => void held.delete(sandboxId),
            (error) => deps.onError("scratch_job_retire_failed", error, entry.scopeId),
          );
        }),
      );
    },
  };
}
