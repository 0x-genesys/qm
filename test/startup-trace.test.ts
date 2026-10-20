import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { configurePgPooling, createPgPool, type PgPool } from "../src/persistence/pg-pool.ts";
import {
  detachStartup,
  startupMark,
  startupStop,
  traceStartup,
  traceStartupQueries,
  type StartupRecord,
} from "../src/util/startup-trace.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { processRun } from "../src/runs/worker.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal, TurnResult } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the startup trace tests";

async function pgFor(name: string, queryMax?: number): Promise<PgPool> {
  const url = new globalThis.URL(URL!);
  url.searchParams.set("application_name", name);
  if (queryMax !== undefined) configurePgPooling({ queryMax });
  const pg = createPgPool(url.toString());
  await pg.q("SELECT 1");
  if (queryMax !== undefined) configurePgPooling({});
  return pg;
}

async function traced(work: () => Promise<void>, failed = () => "error"): Promise<StartupRecord[]> {
  const records: StartupRecord[] = [];
  await traceStartup(
    (r) => records.push(r),
    async () => {
      await work();
      return { status: "ok" };
    },
    failed,
  ).catch(() => undefined);
  return records;
}

test(
  "real pg: serial and parallel queries union their time, and work after the stop is not counted",
  { skip },
  async () => {
    const pg = await pgFor("startup-trace-union");
    const [record] = await traced(async () => {
      assert.deepEqual(await pg.q("SELECT 1 AS n"), [{ n: 1 }]);
      startupMark("turn");
      await Promise.all([1, 2, 3].map(() => pg.q("SELECT pg_sleep(0.2)")));
      startupMark("runtime");
      const client = await (await pg.pool()).connect();
      try {
        await client.query("BEGIN");
        assert.deepEqual((await client.query({ text: "SELECT $1::int AS n", values: [7] })).rows, [{ n: 7 }]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      startupStop("pi_payload_ready");
      await pg.q("SELECT 1");
    });
    await pg.close();
    assert.ok(record);
    assert.equal(record.outcome, "pi_payload_ready");
    assert.deepEqual(
      record.segments.map((s) => [s.at, s.queries]),
      [
        ["turn", 1],
        ["runtime", 3],
        ["pi_payload_ready", 3],
      ],
    );
    const parallel = record.segments[1]!;
    assert.ok(parallel.queryRoundTripMs >= 195 && parallel.queryRoundTripMs < 600, JSON.stringify(parallel));
    assert.equal(record.queries, 7);
  },
);

test("real pg: a saturated pool reports connection wait separately from the round trip", { skip }, async () => {
  const pg = await pgFor("startup-trace-wait", 1);
  const [record] = await traced(async () => {
    await Promise.all([pg.q("SELECT pg_sleep(0.15)"), pg.q("SELECT pg_sleep(0.15)")]);
  });
  await pg.close();
  assert.ok(record);
  assert.equal(record.queries, 2);
  assert.ok(record.poolWaitMs >= 120, JSON.stringify(record));
  assert.ok(record.queryRoundTripMs >= 280, JSON.stringify(record));
  assert.ok(record.dbBusyMs < record.poolWaitMs + record.queryRoundTripMs, JSON.stringify(record));
});

test(
  "real pg: concurrent turns on one shared pool keep separate counts, untraced and detached work count nowhere",
  { skip },
  async () => {
    const pg = await pgFor("startup-trace-leak", 2);
    const outside = (async () => {
      for (let i = 0; i < 5; i++) await pg.q("SELECT pg_sleep(0.01)");
    })();
    const [a, b] = await Promise.all([
      traced(async () => {
        for (let i = 0; i < 4; i++) await pg.q("SELECT pg_sleep(0.01)");
        await detachStartup(() => pg.q("SELECT 1").then(() => pg.q("SELECT 1")));
      }),
      traced(async () => {
        for (let i = 0; i < 6; i++) await pg.q("SELECT pg_sleep(0.01)");
        const p = await pg.pool();
        await new Promise<void>((resolve, reject) =>
          p.query("SELECT 1", (err: Error | undefined) => (err ? reject(err) : resolve())),
        );
        const client = await new Promise<PoolClient>((resolve, reject) =>
          p.connect((err, c) => (err || !c ? reject(err ?? new Error("no client")) : resolve(c))),
        );
        await new Promise<void>((resolve, reject) =>
          client.query("SELECT 1", (err: Error | undefined) => (err ? reject(err) : resolve())),
        );
        client.release();
      }),
    ]);
    await outside;
    await pg.close();
    assert.equal(a[0]!.queries, 4);
    assert.equal(a[0]!.untracedCalls, 0);
    assert.equal(b[0]!.queries, 6);
    assert.equal(b[0]!.untracedCalls, 3);
  },
);

test("real pg: a failing query closes its span and a failing turn still emits one record", { skip }, async () => {
  const pg = await pgFor("startup-trace-error");
  const records = await traced(async () => {
    await assert.rejects(pg.q("SELECT * FROM startup_trace_missing_table"), { code: "42P01" });
    await new Promise((r) => setTimeout(r, 300));
    throw new Error("boom");
  });
  await pg.close();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.outcome, "error");
  assert.equal(records[0]!.queries, 1);
  assert.ok(records[0]!.dbBusyMs < 250, JSON.stringify(records[0]));
});

test("a failed connection acquisition counts as pool wait and never as a round trip", async () => {
  const pg = (await import("pg")).default;
  const pool = traceStartupQueries(new pg.Pool({ connectionString: "postgres://x@127.0.0.1:1/x" }));
  const [record] = await traced(async () => {
    await assert.rejects(pool.query("SELECT 1"), { code: "ECONNREFUSED" });
  });
  await pool.end();
  assert.equal(record!.queries, 1);
  assert.equal(record!.queryRoundTripMs, 0);
  assert.equal(record!.dbBusyMs, record!.poolWaitMs);
});

const actor: Principal = { id: "internal:U1", type: "internal" };
const request: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
  origin: { kind: "direct" },
  text: "x",
};

test("each worker attempt writes one turn.startup audit event keyed by attempt, and a broken record never changes the turn", async () => {
  const shutdown = new AbortController();
  const outcomes: Array<() => Promise<TurnResult>> = [
    async () => {
      shutdown.abort();
      throw new Error("turn interrupted");
    },
    async () => {
      throw new Error("turn failed");
    },
    async () => {
      startupMark("turn");
      startupStop("pi_payload_ready");
      startupStop("pi_payload_ready");
      return { status: "ok", sessionId: "s2" } as TurnResult;
    },
  ];
  const { runs } = createMemoryRunStore();
  const audit = createAuditLog();
  const orchestrator = { handleTurn: () => outcomes.shift()!() } as unknown as Orchestrator;
  const deps = { runs, orchestrator, leaseTtlMs: 60_000, audit };
  const first = (await runs.enqueue({ sessionId: "s1", request, maxAttempts: 3 })).run;
  await assert.rejects(
    processRun(deps, (await runs.claim("w", 60_000))!, { shutdown: shutdown.signal }),
    /interrupted/,
  );
  await assert.rejects(processRun(deps, (await runs.claim("w", 60_000))!), /turn failed/);
  await runs.enqueue({ sessionId: "s2", request, maxAttempts: 3 });
  assert.equal((await processRun(deps, (await runs.claim("w", 60_000))!)).status, "ok");
  const events = (await audit.events()).filter((e) => e.action === "turn.startup");
  assert.deepEqual(
    events.map((e) => [e.status, e.resource.startsWith(`run:${first.id}#`) ? e.resource.split("#")[1] : "other"]),
    [
      ["cancelled", "1"],
      ["error", "2"],
      ["pi_payload_ready", "other"],
    ],
  );
  const detail = JSON.parse(events[2]!.detail!) as StartupRecord;
  assert.deepEqual(
    detail.segments.map((s) => s.at),
    ["turn", "pi_payload_ready"],
  );
  const result = await traceStartup(
    () => {
      throw new Error("sink down");
    },
    async () => ({ status: "ok" }),
    () => "error",
  );
  assert.equal(result.status, "ok");
});
