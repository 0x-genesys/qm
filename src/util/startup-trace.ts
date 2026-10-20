import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import { swallow } from "./errors.ts";

const MAX_MARKS = 16;

interface Busy {
  active: number;
  since: number;
  total: number;
}

export interface StartupTotals {
  queries: number;
  poolWaitMs: number;
  queryRoundTripMs: number;
  dbBusyMs: number;
}

export interface StartupSegment extends StartupTotals {
  at: string;
  ms: number;
}

export interface StartupRecord extends StartupTotals {
  outcome: string;
  untracedCalls: number;
  totalMs: number;
  segments: StartupSegment[];
}

interface Trace {
  start: number;
  closed: boolean;
  queries: number;
  untraced: number;
  wait: Busy;
  roundTrip: Busy;
  db: Busy;
  marks: Array<{ at: string; ms: number } & StartupTotals>;
  emit: (record: StartupRecord) => void;
}

const traces = new AsyncLocalStorage<Trace>();

const busy = (): Busy => ({ active: 0, since: 0, total: 0 });

function enter(b: Busy, now: number): void {
  if (b.active++ === 0) b.since = now;
}

function leave(b: Busy, now: number): void {
  if (b.active > 0 && --b.active === 0) b.total += now - b.since;
}

function elapsed(b: Busy, now: number): number {
  return b.total + (b.active > 0 ? now - b.since : 0);
}

function totals(trace: Trace, now: number): StartupTotals {
  return {
    queries: trace.queries,
    poolWaitMs: elapsed(trace.wait, now),
    queryRoundTripMs: elapsed(trace.roundTrip, now),
    dbBusyMs: elapsed(trace.db, now),
  };
}

function live(): Trace | undefined {
  const trace = traces.getStore();
  return trace && !trace.closed ? trace : undefined;
}

function close(trace: Trace, outcome: string): void {
  if (trace.closed) return;
  const now = performance.now();
  const end = totals(trace, now);
  trace.closed = true;
  let prev: StartupTotals & { ms: number } = { ms: 0, queries: 0, poolWaitMs: 0, queryRoundTripMs: 0, dbBusyMs: 0 };
  const segments: StartupSegment[] = [];
  for (const mark of [...trace.marks, { at: outcome, ms: now - trace.start, ...end }]) {
    segments.push({
      at: mark.at,
      ms: Math.round(mark.ms - prev.ms),
      queries: mark.queries - prev.queries,
      poolWaitMs: Math.round(mark.poolWaitMs - prev.poolWaitMs),
      queryRoundTripMs: Math.round(mark.queryRoundTripMs - prev.queryRoundTripMs),
      dbBusyMs: Math.round(mark.dbBusyMs - prev.dbBusyMs),
    });
    prev = mark;
  }
  const record: StartupRecord = {
    outcome,
    totalMs: Math.round(now - trace.start),
    queries: end.queries,
    poolWaitMs: Math.round(end.poolWaitMs),
    queryRoundTripMs: Math.round(end.queryRoundTripMs),
    dbBusyMs: Math.round(end.dbBusyMs),
    untracedCalls: trace.untraced,
    segments,
  };
  const emit = trace.emit;
  trace.emit = () => {};
  trace.marks = [];
  try {
    emit(record);
  } catch (error) {
    swallow("startup trace: record", error);
  }
}

export async function traceStartup<T extends { status: string }>(
  emit: (record: StartupRecord) => void,
  work: () => Promise<T>,
  failed: (error: unknown) => string,
): Promise<T> {
  const trace: Trace = {
    start: performance.now(),
    closed: false,
    queries: 0,
    untraced: 0,
    wait: busy(),
    roundTrip: busy(),
    db: busy(),
    marks: [],
    emit,
  };
  try {
    const result = await traces.run(trace, work);
    close(trace, result.status);
    return result;
  } catch (error) {
    close(trace, failed(error));
    throw error;
  }
}

export function startupMark(at: string): void {
  const trace = live();
  if (!trace || trace.marks.length >= MAX_MARKS - 1 || trace.marks.some((m) => m.at === at)) return;
  const now = performance.now();
  trace.marks.push({ at, ms: now - trace.start, ...totals(trace, now) });
}

export function startupStop(at: string): void {
  const trace = live();
  if (trace) close(trace, at);
}

export function detachStartup<T>(work: () => T): T {
  return traces.exit(work);
}

interface Span {
  acquired(): void;
  end(): void;
}

function span(trace: Trace, phase: "wait" | "roundTrip", query: boolean): Span {
  const now = performance.now();
  if (query) trace.queries += 1;
  enter(trace.db, now);
  enter(trace[phase], now);
  let current = trace[phase];
  let open = true;
  return {
    acquired() {
      if (!open || current !== trace.wait || trace.closed) return;
      const at = performance.now();
      leave(trace.wait, at);
      current = trace.roundTrip;
      enter(current, at);
    },
    end() {
      if (!open || trace.closed) return;
      open = false;
      const at = performance.now();
      leave(current, at);
      leave(trace.db, at);
    },
  };
}

function settle<R>(run: () => unknown, s: Span): Promise<R> {
  let result: Promise<R>;
  try {
    result = run() as Promise<R>;
  } catch (error) {
    s.end();
    throw error;
  }
  return result.then(
    (value) => {
      s.end();
      return value;
    },
    (error: unknown) => {
      s.end();
      throw error;
    },
  );
}

const untraceable = (args: unknown[]): boolean =>
  args.some(
    (arg) =>
      typeof arg === "function" ||
      (typeof arg === "object" && arg !== null && typeof (arg as { submit?: unknown }).submit === "function"),
  );

function traced(args: unknown[]): Trace | undefined {
  const trace = live();
  if (!trace || !untraceable(args)) return trace;
  trace.untraced += 1;
  return undefined;
}

export function traceStartupQueries(pool: Pool): Pool {
  let poolQuerySpan: Span | "untraced" | undefined;
  const internalClients = new WeakSet<object>();
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  pool.connect = ((...args: unknown[]) => {
    const inner = poolQuerySpan;
    poolQuerySpan = undefined;
    if (inner && typeof args[0] === "function") {
      const callback = args[0] as (...cbArgs: unknown[]) => void;
      return connect((...cbArgs: unknown[]) => {
        if (inner !== "untraced") inner.acquired();
        if (cbArgs[1]) internalClients.add(cbArgs[1] as object);
        callback(...cbArgs);
      });
    }
    const trace = traced(args);
    if (!trace) return connect(...args);
    return settle(() => connect(...args), span(trace, "wait", false));
  }) as Pool["connect"];
  pool.query = ((...args: unknown[]) => {
    const trace = traced(args);
    if (!trace) {
      poolQuerySpan = "untraced";
      try {
        return query(...args);
      } finally {
        poolQuerySpan = undefined;
      }
    }
    const s = span(trace, "wait", true);
    poolQuerySpan = s;
    try {
      return settle(() => query(...args), s);
    } finally {
      poolQuerySpan = undefined;
    }
  }) as Pool["query"];
  pool.on("connect", (client: PoolClient) => {
    const clientQuery = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      if (internalClients.delete(client)) return clientQuery(...args);
      const trace = traced(args);
      if (!trace) return clientQuery(...args);
      return settle(() => clientQuery(...args), span(trace, "roundTrip", true));
    }) as PoolClient["query"];
  });
  return pool;
}
