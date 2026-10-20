import { test } from "node:test";
import assert from "node:assert/strict";
import { configurePgPooling, createPgPool, type PgPool } from "../src/persistence/pg-pool.ts";
import {
  detachStartup,
  startupMark,
  startupStop,
  traceStartup,
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
      await pg.q("SELECT 1");
      startupMark("serial");
      await Promise.all([1, 2, 3].map(() => pg.q("SELECT pg_sleep(0.2)")));
      startupMark("parallel");
      const client = await (await pg.pool()).connect();
      try {
        await client.query("BEGIN");
        await client.query({ text: "SELECT $1::int", values: [1] });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      startupStop("handoff");
      await pg.q("SELECT 1");
    });
    await pg.close();
    assert.ok(record);
    assert.equal(record.outcome, "handoff");
    assert.deepEqual(
      record.segments.map((s) => [s.at, s.queries]),
      [
        ["serial", 1],
        ["parallel", 3],
        ["handoff", 3],
      ],
    );
    const parallel = record.segments[1]!;
    assert.ok(parallel.queryRoundTripMs >= 195 && parallel.queryRoundTripMs < 450, JSON.stringify(parallel));
    assert.ok(record.dbBusyMs <= record.totalMs, JSON.stringify(record));
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
        await new Promise<void>(
          (resolve, reject) =>
            void pg
              .pool()
              .then((p) => p.query("SELECT 1", (err: Error | undefined) => (err ? reject(err) : resolve()))),
        );
      }),
    ]);
    await outside;
    await pg.close();
    assert.equal(a[0]!.queries, 4);
    assert.equal(a[0]!.untracedCalls, 0);
    assert.equal(b[0]!.queries, 6);
    assert.equal(b[0]!.untracedCalls, 1);
  },
);

test("real pg: a failing query closes its span and a failing turn still emits one record", { skip }, async () => {
  const pg = await pgFor("startup-trace-error");
  const records = await traced(async () => {
    await pg.q("SELECT * FROM startup_trace_missing_table").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    throw new Error("boom");
  });
  await pg.close();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.outcome, "error");
  assert.equal(records[0]!.queries, 1);
  assert.ok(records[0]!.dbBusyMs < 250, JSON.stringify(records[0]));
});

const actor: Principal = { id: "internal:U1", type: "internal" };
const request: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
  origin: { kind: "direct" },
  text: "x",
};

test("each worker attempt writes one turn.startup audit event, and a broken record never changes the turn", async () => {
  const outcomes: Array<() => Promise<TurnResult>> = [
    async () => {
      startupMark("turn");
      startupStop("pi_payload_ready");
      startupStop("pi_payload_ready");
      return { status: "ok", sessionId: "s1" } as TurnResult;
    },
    async () => {
      throw new Error("turn failed");
    },
  ];
  const { runs } = createMemoryRunStore();
  const audit = createAuditLog();
  const orchestrator = { handleTurn: () => outcomes.shift()!() } as unknown as Orchestrator;
  for (const expectFailure of [false, true]) {
    await runs.enqueue({ sessionId: `s${expectFailure}`, request, maxAttempts: 3 });
    const run = (await runs.claim("w", 60_000))!;
    const done = processRun({ runs, orchestrator, leaseTtlMs: 60_000, audit }, run);
    if (expectFailure) await assert.rejects(done, /turn failed/);
    else assert.equal((await done).status, "ok");
  }
  const events = (await audit.events()).filter((e) => e.action === "turn.startup");
  assert.deepEqual(
    events.map((e) => [e.status, /^run:.+#1$/.test(e.resource)]),
    [
      ["pi_payload_ready", true],
      ["error", true],
    ],
  );
  const detail = JSON.parse(events[0]!.detail!) as StartupRecord;
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
