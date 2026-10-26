import type { ProcessSandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import type { SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { ProcessRegistry } from "./process-registry.ts";
import { reconcileProcesses } from "./reconcile.ts";

const STARTUP_GRACE_MS = 2 * 60_000;

export async function retireFinishedJobComputers(deps: {
  resources: Pick<SandboxResources, "jobComputers" | "retireJobComputer">;
  sandbox: ProcessSandbox;
  processes: ProcessRegistry;
  finish: (handle: SandboxHandle, processId: string) => Promise<void>;
  onError: (error: unknown, scopeId: string) => void;
  now?: number;
}): Promise<void> {
  const now = deps.now ?? Date.now();
  for (const computer of await deps.resources.jobComputers()) {
    try {
      const jobs = async () =>
        (await deps.processes.listByScope(computer.ownerScopeId)).filter((job) => job.sandboxId === computer.id);
      const unfinished = async () => (await jobs()).some((job) => job.status === "running" || job.credentialsPending);
      if (!(await jobs()).length && now - Date.parse(computer.createdAt) < STARTUP_GRACE_MS) continue;
      if (await unfinished()) {
        const handle = await deps.sandbox.provision([{ scopeId: computer.ownerScopeId, mode: "rw", mountPath: "" }], {
          sandboxId: computer.id,
        });
        try {
          await reconcileProcesses(deps.sandbox, handle, deps.processes, computer.ownerScopeId, deps.finish);
        } finally {
          await deps.sandbox.teardown(handle, { keepWarm: true });
        }
        if (await unfinished()) continue;
      }
      await deps.resources.retireJobComputer(computer.id);
    } catch (error) {
      deps.onError(error, computer.ownerScopeId);
    }
  }
}
