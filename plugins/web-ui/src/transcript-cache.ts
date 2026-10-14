import type { PendingApproval, TranscriptPage } from "./core-bridge";

export interface CachedTranscript {
  page: TranscriptPage;
  approvals: PendingApproval[] | null;
}

const CAPACITY = 40;
const cache = new Map<string, CachedTranscript>();

export function cachedTranscript(id: string): CachedTranscript | undefined {
  const hit = cache.get(id);
  if (!hit) return undefined;
  cache.delete(id);
  cache.set(id, hit);
  return hit;
}

export function storeTranscript(id: string, page: TranscriptPage, approvals: PendingApproval[] | null = null): void {
  cache.delete(id);
  cache.set(id, { page, approvals });
  while (cache.size > CAPACITY) cache.delete(cache.keys().next().value!);
}

export function dropTranscript(id: string): void {
  cache.delete(id);
}

export function clearTranscriptCache(): void {
  cache.clear();
}

export function lastSeq(page: TranscriptPage): number {
  let last = -1;
  for (const entry of page.entries ?? []) if (entry.seq !== undefined && entry.seq > last) last = entry.seq;
  return last;
}

export function mergeTranscriptDelta(page: TranscriptPage, delta: TranscriptPage): TranscriptPage {
  const after = lastSeq(page);
  const added = (delta.entries ?? []).filter((entry) => entry.seq !== undefined && entry.seq > after);
  const samePins = JSON.stringify(page.pins ?? []) === JSON.stringify(delta.pins ?? []);
  if (!added.length && samePins) return page;
  return { ...page, entries: [...(page.entries ?? []), ...added], pins: delta.pins };
}
