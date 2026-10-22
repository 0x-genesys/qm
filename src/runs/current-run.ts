import type { CapabilityClaims } from "../auth/capability-token.ts";
import { samePerson } from "../directory/person.ts";
import type { Run, RunStore } from "./run-store.ts";

export type RunClaims = Pick<CapabilityClaims, "runId" | "runLeaseToken" | "runAttempt" | "threadRef" | "actorId">;

export async function currentRun(claims: RunClaims, runs: Pick<RunStore, "get"> | undefined): Promise<Run | null> {
  const run = claims.runId ? await runs?.get(claims.runId) : null;
  if (
    !run ||
    run.status !== "running" ||
    !claims.runLeaseToken ||
    run.leaseToken !== claims.runLeaseToken ||
    run.attempts !== claims.runAttempt ||
    run.sessionId !== claims.threadRef ||
    !samePerson(run.request.actor.id, claims.actorId) ||
    (run.leaseExpiresAt ?? 0) <= Date.now()
  )
    return null;
  return run;
}
