import type { ProcessSandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { ProcessRecord, ProcessRegistry } from "./process-registry.ts";
import { reconcileProcesses } from "./reconcile.ts";

const STARTUP_GRACE_MS = 2 * 60_000;
const RECONCILE_EVERY_MS = 5 * 60_000;

const live = (job: ProcessRecord): boolean => job.status === "running" || Boolean(job.credentialsPending);

export function createJobComputerSweep(deps: {
  resources: Pick<SandboxResources, "jobComputers" | "retireJobComputer">;
  sandbox: ProcessSandbox;
  processes: ProcessRegistry;
  finish: (handle: SandboxHandle, processId: string) => Promise<void>;
  onError: (error: unknown, scopeId: string) => void;
  now?: () => number;
}): () => Promise<void> {
  const reconciledAt = new Map<string, number>();
  const clock = deps.now ?? Date.now;
  return async () => {
    const now = clock();
    for (const computer of await deps.resources.jobComputers()) {
      try {
        const jobs = async () =>
          (await deps.processes.listByScope(computer.ownerScopeId)).filter((job) => job.sandboxId === computer.id);
        let current = await jobs();
        if (!current.length && now - Date.parse(computer.createdAt) < STARTUP_GRACE_MS) continue;
        if (current.some(live)) {
          if (now - (reconciledAt.get(computer.id) ?? 0) < RECONCILE_EVERY_MS) continue;
          reconciledAt.set(computer.id, now);
          const handle = await deps.sandbox.provision([{ scopeId: computer.ownerScopeId, mode: "rw", mountPath: "" }], {
            sandboxId: computer.id,
          });
          try {
            await reconcileProcesses(deps.sandbox, handle, deps.processes, computer.ownerScopeId, deps.finish);
          } finally {
            await deps.sandbox
              .teardown(handle, { keepWarm: true })
              .catch((error: unknown) => deps.onError(error, computer.ownerScopeId));
          }
          current = await jobs();
          if (current.some(live)) continue;
        }
        await deps.resources.retireJobComputer(computer.id);
        reconciledAt.delete(computer.id);
      } catch (error) {
        deps.onError(error, computer.ownerScopeId);
      }
    }
  };
}
