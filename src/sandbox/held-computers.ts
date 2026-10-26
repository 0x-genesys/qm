import type { SandboxHandle } from "./sandbox.ts";

const SCRATCH_JOB_PREFIX = "scratch-job:";

export const scratchJobComputerId = (scratchKey: string): string => `${SCRATCH_JOB_PREFIX}${scratchKey}`;

export const isScratchJobComputer = (sandboxId: string): boolean => sandboxId.startsWith(SCRATCH_JOB_PREFIX);

export class ScratchJobComputerGoneError extends Error {
  constructor() {
    super(
      "this background job's computer is held by another server process, or was retired when that process stopped (for example on deploy); this process cannot reach the job or its files",
    );
  }
}

export interface HeldComputers {
  get(sandboxId: string): SandboxHandle | undefined;
  holds(handle: SandboxHandle): boolean;
}
