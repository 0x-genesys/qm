import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresEventSink, scopedEventMigrationId, type EventColumn } from "../src/admin/scoped-event-sink.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres scoped-event sink tests";

type Ev = { ts: number; scopeLabel: string; a?: number; b?: number };
const BASE: readonly EventColumn<keyof Ev & string>[] = [
  ["ts", "ts", "BIGINT", "number", true],
  ["scope_label", "scopeLabel", "TEXT", "string", true],
  ["a", "a", "INT", "number"],
];
const common = { defaultLimit: 10, equalityFilters: {}, persistErrorMessage: "x" };

async function withTable(run: (table: string) => Promise<void>): Promise<void> {
  const table = `sink_${randomUUID().replaceAll("-", "")}`;
  try {
    await run(table);
  } finally {
    const admin = new pg.Pool({ connectionString: URL });
    await admin.query(`DROP TABLE IF EXISTS ${table}`);
    await admin.query("DELETE FROM qm_schema_migrations WHERE id LIKE $1", [`admin/scoped-events/${table}/%`]);
    await admin.end();
  }
}

test("a sink column that no migration created is refused on first use", { skip }, () =>
  withTable(async (table) => {
    const sink = createPostgresEventSink<Ev>({
      ...common,
      connectionString: URL!,
      table,
      columns: [...BASE, ["b", "b", "INT", "number"]],
      schema: {
        initialColumns: BASE,
        followUps: [{ id: scopedEventMigrationId(table, 2), statements: [`COMMENT ON TABLE ${table} IS 'b'`] }],
      },
    });
    await assert.rejects(sink.list(), /has no column b after its migrations/);
  }),
);

test("a sink column added by a follow-up migration is read and written", { skip }, () =>
  withTable(async (table) => {
    const sink = createPostgresEventSink<Ev>({
      ...common,
      connectionString: URL!,
      table,
      columns: [...BASE, ["b", "b", "INT", "number"]],
      schema: {
        initialColumns: BASE,
        followUps: [
          { id: scopedEventMigrationId(table, 2), statements: [`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS b INT`] },
        ],
      },
    });
    sink.record({ scopeLabel: "s", a: 1, b: 2 });
    await sink.flush();
    const [event] = await sink.list();
    assert.equal(event?.b, 2);
  }),
);
