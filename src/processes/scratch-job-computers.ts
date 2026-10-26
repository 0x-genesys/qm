import type { ProcessSandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { ProcessRegistry } from "./process-registry.ts";
import { reconcileProcesses } from "./reconcile.ts";
import type { HeldComputers } from "../sandbox/held-computers.ts";

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
  keepAfterExitMs?: number;
}): ScratchJobComputers {
  const pollMs = deps.pollMs ?? 10_000;
  const keepAfterExitMs = deps.keepAfterExitMs ?? 5 * 60_000;
  let draining = false;
  const held = new Map<
    string,
    {
      handle: SandboxHandle;
      scopeId: string;
      retire?: () => Promise<void>;
      timer?: NodeJS.Timeout;
      checking?: Promise<void>;
      failedChecks: number;
      idleSince?: number;
    }
  >();
  const jobs = async (sandboxId: string, scopeId: string) =>
    (await deps.processes.listByScope(scopeId)).filter((process) => process.sandboxId === sandboxId);
  const schedule = (sandboxId: string): void => {
    const entry = held.get(sandboxId);
    if (!entry) return;
    entry.timer = setTimeout(() => {
      entry.checking = check(sandboxId).finally(() => (entry.checking = undefined));
    }, pollMs);
    entry.timer.unref();
  };
  const reapRunning = async (sandboxId: string, handle: SandboxHandle, scopeId: string): Promise<void> => {
    const records = await jobs(sandboxId, scopeId).catch((error) => {
      deps.onError("scratch_job_check_failed", error, scopeId);
      return [];
    });
    for (const process of records) {
      if (process.status !== "running") continue;
      if (await deps.processes.markStatus(process.processId, "reaped"))
        await deps
          .finish(handle, process.processId)
          .catch((error) => deps.onError("scratch_job_finish_failed", error, scopeId));
    }
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
    if (!entry || draining) return;
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
    const settled = remaining && !running && (!pending || entry.failedChecks >= FINISH_ATTEMPTS);
    entry.idleSince = settled ? (entry.idleSince ?? Date.now()) : undefined;
    if (entry.idleSince !== undefined && Date.now() - entry.idleSince >= keepAfterExitMs) return retire(sandboxId);
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
      const live = await jobs(sandboxId, entry.scopeId).then(
        (records) => records.some((process) => process.status === "running" || process.credentialsPending),
        (error) => {
          held.delete(sandboxId);
          throw error;
        },
      );
      if (!live || draining) {
        held.delete(sandboxId);
        if (live) await reapRunning(sandboxId, entry.handle, entry.scopeId);
        return false;
      }
      entry.retire = retireComputer;
      schedule(sandboxId);
      return true;
    },
    async drain() {
      draining = true;
      await Promise.all(
        [...held].map(async ([sandboxId, entry]) => {
          clearTimeout(entry.timer);
          await entry.checking;
          if (!entry.retire) return;
          await reapRunning(sandboxId, entry.handle, entry.scopeId);
          await entry.retire().then(
            () => void held.delete(sandboxId),
            (error) => deps.onError("scratch_job_retire_failed", error, entry.scopeId),
          );
        }),
      );
    },
  };
}
