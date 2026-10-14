import type { CoreSession, SessionEntry } from "./core-bridge.ts";
import { goalElapsedLabel } from "./goal-strip.ts";

type SubagentState = "queued" | "working" | "waiting" | "done" | "failed";

export interface SubagentRow {
  session: CoreSession;
  run: CoreSession["latestRun"];
  queued: NonNullable<CoreSession["latestRun"]>[];
  state: SubagentState;
  depth: number;
  startedAt: number | null;
  endedAt: number | null;
}

type SessionLink = Pick<CoreSession, "id" | "parentSessionId" | "working" | "awaitingInput">;

export function descendantsOf<T extends SessionLink>(
  list: readonly T[],
  rootId: string,
): { session: T; depth: number }[] {
  const out: { session: T; depth: number }[] = [];
  const seen = new Set([rootId]);
  let frontier = [rootId];
  for (let depth = 1; frontier.length; depth++) {
    const parents = new Set(frontier);
    frontier = [];
    for (const session of list) {
      if (!session.parentSessionId || !parents.has(session.parentSessionId) || seen.has(session.id)) continue;
      seen.add(session.id);
      out.push({ session, depth });
      frontier.push(session.id);
    }
  }
  return out;
}

export function subagentCounts(
  list: readonly SessionLink[],
  rootId: string | null | undefined,
): { running: number; waiting: number } {
  const counts = { running: 0, waiting: 0 };
  if (!rootId) return counts;
  for (const { session } of descendantsOf(list, rootId)) {
    if (session.awaitingInput) counts.waiting++;
    else if (session.working) counts.running++;
  }
  return counts;
}

export function subagentRows(list: readonly CoreSession[], rootId: string): SubagentRow[] {
  return descendantsOf(list, rootId)
    .filter(({ session }) => session.latestRun || session.working || session.awaitingInput)
    .map(({ session, depth }) => {
      const inFlight = session.inFlightRuns ?? [];
      const run = inFlight.find((run) => run.status === "running") ?? inFlight[0] ?? session.latestRun;
      const queued = inFlight.filter((candidate) => candidate.status === "pending" && candidate.id !== run?.id);
      let state: SubagentState = "done";
      if (session.awaitingInput) state = "waiting";
      else if (run?.status === "pending") state = "queued";
      else if (run?.status === "running" || (!run && session.working)) state = "working";
      else if (run?.status === "failed") state = "failed";
      return {
        session,
        run,
        queued,
        state,
        depth,
        startedAt: run?.createdAt ?? null,
        endedAt: run?.finishedAt ?? null,
      };
    });
}

export function visibleSubagents(rows: readonly SubagentRow[], acknowledged: ReadonlySet<string>): SubagentRow[] {
  return rows.filter((row) => !((row.state === "done" || row.state === "failed") && acknowledged.has(ackKey(row))));
}

export function ackKey(row: Pick<SubagentRow, "session" | "run">): string {
  return `${row.session.id}@${row.run?.id ?? "unknown"}`;
}

export function subagentTiming(row: SubagentRow, now = Date.now()): string | null {
  const run = row.run;
  if (row.startedAt === null || !run) return null;
  if ((run.status === "done" || run.status === "failed") && row.endedAt === null) return null;
  return `${goalElapsedLabel(row.startedAt, row.endedAt ?? now)} elapsed (incl. queue)`;
}

export function subagentQueueTiming(row: SubagentRow, now = Date.now()): string | null {
  if (!row.queued.length) return null;
  const oldest = Math.min(...row.queued.map((run) => run.createdAt));
  return `${row.queued.length} queued · oldest ${goalElapsedLabel(oldest, now)}`;
}

export function subagentSummary(rows: readonly SubagentRow[]): string {
  const count = (state: SubagentState) => rows.filter((row) => row.state === state).length;
  const parts: string[] = [];
  const working = count("working");
  const queued = count("queued") + rows.reduce((count, row) => count + row.queued.length, 0);
  const done = count("done");
  const waiting = count("waiting");
  const failed = count("failed");
  if (queued) parts.push(`${queued} queued`);
  if (done) parts.push(`${done} done`);
  if (working) parts.push(`${working} running`);
  if (waiting) parts.push(`${waiting} need${waiting === 1 ? "s" : ""} you`);
  if (failed) parts.push(`${failed} failed`);
  return `Runs: ${parts.join(", ")}`;
}

export interface PeekLine {
  kind: "tool" | "text";
  text: string;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toolLine(payload: { tool?: unknown; action?: unknown; command?: unknown }): string | null {
  if (typeof payload.tool !== "string" || !payload.tool) return null;
  const action = typeof payload.action === "string" && payload.action ? ` ${payload.action}` : "";
  const command = typeof payload.command === "string" && payload.command ? ` · ${payload.command}` : "";
  return clip(`${payload.tool}${action}${command}`, 120);
}

export function peekLines(entries: readonly SessionEntry[], max = 4): PeekLine[] {
  const lines: PeekLine[] = [];
  for (const entry of entries) {
    const payload = (entry.payload ?? {}) as { tool?: unknown; action?: unknown; command?: unknown; text?: unknown };
    const tool = entry.type === "tool_call" ? toolLine(payload) : null;
    if (tool) lines.push({ kind: "tool", text: tool });
    else if ((entry.type === "assistant" || entry.type === "text") && typeof payload.text === "string") {
      const text = clip(payload.text, 240);
      if (text) lines.push({ kind: "text", text });
    }
  }
  return lines.slice(-max);
}
