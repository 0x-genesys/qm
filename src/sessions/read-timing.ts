import { AsyncLocalStorage } from "node:async_hooks";

type ReadStage =
  | "total"
  | "acl"
  | "continue"
  | "transcript"
  | "participant_windows"
  | "latest_seq"
  | "entries"
  | "suffix_check"
  | "tape"
  | "projection"
  | "fallback"
  | "pins"
  | "pin_previews";

const timings = new AsyncLocalStorage<Map<ReadStage, number>>();

export async function timeSessionRead<T>(stage: ReadStage, read: () => T | Promise<T>): Promise<T> {
  const current = timings.getStore();
  if (!current) return read();
  const start = performance.now();
  try {
    return await read();
  } finally {
    current.set(stage, (current.get(stage) ?? 0) + performance.now() - start);
  }
}

export async function collectSessionReadTiming<T>(read: () => Promise<T>): Promise<{ value: T; header: string }> {
  const current = new Map<ReadStage, number>();
  const value = await timings.run(current, () => timeSessionRead("total", read));
  const header = [...current].map(([stage, ms]) => `qm_session_${stage};dur=${ms.toFixed(2)}`).join(", ");
  return { value, header };
}
