import type { RunStop } from "../runs/run-store.ts";
import { isObj } from "../util/objects.ts";

export type WaitStop = Extract<RunStop, { kind: "waiting" }>;

export type WaitRequest = Pick<WaitStop, "reason" | "callId" | "until">;

export interface TurnWait {
  resumedFrom(callId: string): WaitStop | undefined;
  childrenBusy(): Promise<boolean>;
  suspend(wait: WaitRequest): void;
  waiting(): boolean;
}

export const APPROVAL_WAIT_MS = 24 * 60 * 60_000;
export const CLIENT_RESULT_GRACE_MS = 2_000;
export const CLIENT_RESULT_MIN_CHECK_MS = 250;
export const BARRIER_MAIL_GRACE_MS = 5_000;

export function isWaitStop(stop: unknown): stop is WaitStop {
  return isObj(stop) && stop.kind === "waiting";
}

export function waitEvent(turnId: string, wait: number): string {
  return `wake:${turnId}:${wait}`;
}
