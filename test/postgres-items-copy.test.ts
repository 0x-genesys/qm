import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { ITEMS_BUCKET_DELETE_SQL, itemsBucketParams, itemsCopySql } from "../src/sessions/items-copy.ts";
import { ITEM_INDEXES } from "../src/sessions/items-schema.ts";
import { runItemsBulkCopy } from "../scripts/items-bulk-copy.ts";
import { scopeId } from "../src/types.ts";

type Pool = import("pg").Pool;

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the items copy test";

async function withSchema(fn: (raw: Pool, url: string) => Promise<void>): Promise<void> {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: URL });
  const schema = `items_copy_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new globalThis.URL(URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const raw = new pg.Pool({ connectionString: url.toString() });
  try {
    createPostgresSessionStore(url.toString());
    await applyPgMigrations(
      raw,
      registeredPgMigrations(url.toString()).filter((migration) => migration.id < "sessions/store/0035"),
    );
    await fn(raw, url.toString());
  } finally {
    await raw.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

const scope = scopeId("personal", "alice");

async function seed(raw: Pool, id: string, entries: Array<[string, unknown] | [string, unknown, "raw"]>, from = 0) {
  await raw.query(
    "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ($1, 'dm', $2, $3, 1) ON CONFLICT DO NOTHING",
    [id, scope, `web:${id}`],
  );
  for (const [i, [type, payload, raw_]] of entries.entries())
    await raw.query(
      "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1, $2, NULL, $3, $4, $5, $6)",
      [id, from + i, type, raw_ ? payload : JSON.stringify(payload), scope, 1_700_000_000_000 + from + i],
    );
}

async function copyAll(raw: Pool, buckets = 4, delta = false): Promise<number> {
  let total = 0;
  for (let bucket = 0; bucket < buckets; bucket++)
    total += (await raw.query(itemsCopySql({ delta }), itemsBucketParams(bucket, buckets))).rowCount ?? 0;
  return total;
}

const items = async (raw: Pool, sessionId: string) =>
  (
    await raw.query(
      `SELECT seq::int, turn_id, kind, author, call_id, elicit_id, wake_cause, error_code, body,
              (extract(epoch FROM created_at) * 1000)::bigint::text AS ms
         FROM items WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    )
  ).rows as Array<Record<string, unknown> & { seq: number; body: Record<string, unknown> }>;

test("items copy maps every legacy entry type and system kind", { skip }, async () => {
  await withSchema(async (raw) => {
    const run = randomUUID();
    await seed(raw, "s1", [
      ["soul", { text: "persona" }],
      ["user", { text: "hi", runId: run, securityTainted: true }],
      ["user", { text: "also", steered: true }],
      ["text_start", {}],
      ["text", { text: "narrating" }],
      ["thinking", { thinking: "hmm" }],
      ["tool_call", { tool: "execute", callId: "c1", args: { cmd: "ls" } }],
      [
        "tool_result",
        { tool: "execute", callId: "c1", result: "out: hello\nerr: boom", stdout: "hello", stderr: "nope" },
      ],
      ["tool_call", { tool: "execute" }],
      ["assistant", { text: "done", deliveryKey: "k1", runId: "not-a-uuid", via: "cron" }],
      ["delivery", { files: ["a.txt"] }],
      ["approval_request", { requestId: "r1", command: "rm" }],
      ["approval_resolved", { approved: true }],
      ["system", { kind: "context_summary", text: "summary", throughSeq: 3 }],
      ["system", { kind: "turn_failure", message: "failed", deliveryKey: "k2", runId: run }],
      ["system", { kind: "wake", text: "follow-up" }],
      ["system", { kind: "wake", cause: "cron", text: "fire" }],
      ["system", { kind: "message_revision", action: "deleted", ts: "1.2" }],
      ["system", { kind: "goal", goal: {} }],
      ["system", { kind: "memory_context", snapshot: {} }],
      ["system", { kind: "file_event", direction: "in" }],
      ["user", "just a string"],
      ["user", "not json {", "raw"],
      ["user", { type: "x", $type: "y", text: "t" }],
      ["assistant", 5],
      ["tool_result", { callId: "", result: { ok: true }, stdout: "kept" }],
    ]);
    await raw.query(
      `INSERT INTO legacy_tape_steps(session_id, seq, step, wire) VALUES ('s1', 6, '{"id":"tape:1"}', '{"x":1}')`,
    );

    assert.equal(await copyAll(raw), 21);
    const rows = await items(raw, "s1");
    const at = (seq: number) => rows.find((row) => row.seq === seq)!;
    assert.deepEqual(
      rows.map((row) => [row.seq, row.kind]),
      [
        [1, "UserMessage"],
        [2, "SteeringMessage"],
        [4, "AgentMessage"],
        [5, "Reasoning"],
        [6, "ToolCall"],
        [7, "ToolResult"],
        [8, "ToolCall"],
        [9, "AgentMessage"],
        [10, "AgentMessage"],
        [11, "Elicitation"],
        [12, "ElicitationResponse"],
        [13, "ContextCompaction"],
        [14, "Error"],
        [15, "Wake"],
        [16, "Wake"],
        [17, "Retraction"],
        [21, "UserMessage"],
        [22, "UserMessage"],
        [23, "UserMessage"],
        [24, "AgentMessage"],
        [25, "ToolResult"],
      ],
    );
    assert.equal(
      rows.every((row) => row.author === null),
      true,
    );
    assert.deepEqual(at(1).body, { text: "hi", runId: run });
    assert.equal(at(1).turn_id, run);
    assert.equal(at(1).ms, String(1_700_000_000_001));
    assert.deepEqual(at(4).body, { text: "narrating", variant: "narration" });
    assert.deepEqual(at(6).body, {
      tool: "execute",
      callId: "c1",
      args: { cmd: "ls" },
      step: { id: "tape:1" },
      wire: { x: 1 },
    });
    assert.equal(at(6).call_id, "c1");
    assert.equal(at(7).call_id, "c1");
    assert.deepEqual(at(7).body, { tool: "execute", callId: "c1", result: "out: hello\nerr: boom", stderr: "nope" });
    assert.equal(at(8).call_id, "missing-call:8");
    assert.deepEqual(at(9).body, { text: "done", runId: "not-a-uuid", via: "cron" });
    assert.equal(at(9).turn_id, null);
    assert.deepEqual(at(10).body, { files: ["a.txt"], variant: "files_delivered" });
    assert.equal(at(11).elicit_id, "r1");
    assert.equal(at(12).elicit_id, "missing-elicit:12");
    assert.deepEqual(at(14).body, { kind: "turn_failure", message: "failed", runId: run });
    assert.equal(at(14).error_code, "turn_failure");
    assert.equal(at(14).turn_id, run);
    assert.equal(at(15).wake_cause, "system");
    assert.equal(at(16).wake_cause, "cron");
    assert.deepEqual(at(17).body, { kind: "message_revision", action: "deleted", ts: "1.2" });
    assert.deepEqual(at(21).body, { text: "just a string" });
    assert.deepEqual(at(22).body, { text: "not json {" });
    assert.deepEqual(at(23).body, { $type: "x", $$type: "y", text: "t" });
    assert.deepEqual(at(24).body, { value: 5 });
    assert.equal(at(25).call_id, "missing-call:25");
    assert.deepEqual(at(25).body, { callId: "", result: { ok: true }, stdout: "kept" });
  });
});

test("items copy repairs payloads jsonb rejects: escaped NULs and lone surrogates", { skip }, async () => {
  await withSchema(async (raw) => {
    await seed(raw, "r", [
      ["user", String.raw`{"text":"a\u0000b","keep":"\\u0000"}`, "raw"],
      ["user", String.raw`{"text":"x\ud800y"}`, "raw"],
      ["user", String.raw`{"text":"\udc00 \ud83d\ude00"}`, "raw"],
      ["user", String.raw`{"text":"\ud800","literal":"\\ud800"}`, "raw"],
    ]);
    assert.equal(await copyAll(raw, 1), 4);
    assert.deepEqual(
      (await items(raw, "r")).map((row) => row.body),
      [
        { text: "ab", keep: "\\u0000" },
        { text: "x\ufffdy" },
        { text: "\ufffd \u{1f600}" },
        { text: "\ufffd", literal: "\\ud800" },
      ],
    );
  });
});

test("items copy fails loudly on an unmapped entry type or system kind", { skip }, async () => {
  await withSchema(async (raw) => {
    await seed(raw, "ok", [["user", { text: "fine" }]]);
    await seed(raw, "bad", [["system", { kind: "mystery" }]]);
    await assert.rejects(copyAll(raw, 1), /unmapped system entry kind=mystery at bad\/0/);
    await raw.query("DELETE FROM session_entries WHERE session_id = 'bad'");
    await seed(raw, "bad2", [["weird", { text: "?" }]]);
    await assert.rejects(copyAll(raw, 1), /unmapped entry type=weird at bad2\/0/);
    assert.equal((await raw.query("SELECT count(*)::int AS n FROM items")).rows[0].n, 0);
  });
});

test("a bucket can be deleted and recopied, and delta mode copies only new entries", { skip }, async () => {
  await withSchema(async (raw) => {
    for (let i = 0; i < 12; i++)
      await seed(raw, `s${i}`, [
        ["user", { text: `q${i}` }],
        ["assistant", { text: `a${i}` }],
      ]);
    assert.equal(await copyAll(raw), 24);
    const snapshot = async () =>
      (await raw.query("SELECT session_id, seq, kind, body FROM items ORDER BY session_id, seq")).rows;
    const before = await snapshot();
    const deleted = await raw.query(ITEMS_BUCKET_DELETE_SQL, itemsBucketParams(1, 4));
    assert.ok((deleted.rowCount ?? 0) > 0);
    const recopied = await raw.query(itemsCopySql(), itemsBucketParams(1, 4));
    assert.equal(recopied.rowCount, deleted.rowCount);
    assert.deepEqual(await snapshot(), before);

    assert.equal(await copyAll(raw, 4, true), 0);
    await seed(
      raw,
      "s3",
      [
        ["user", { text: "later" }],
        ["system", { kind: "goal" }],
        ["thinking", { thinking: "x" }],
      ],
      2,
    );
    await seed(raw, "fresh", [["user", { text: "new session" }]]);
    assert.equal(await copyAll(raw, 4, true), 3);
    assert.deepEqual(
      (await items(raw, "s3")).map((row) => [row.seq, row.kind]),
      [
        [0, "UserMessage"],
        [1, "AgentMessage"],
        [2, "UserMessage"],
        [4, "Reasoning"],
      ],
    );
    assert.equal(await copyAll(raw, 4, true), 0);
  });
});

test("the bulk-copy runner copies every bucket, reruns one, and builds the indexes", { skip }, async () => {
  await withSchema(async (raw, url) => {
    for (let i = 0; i < 6; i++)
      await seed(raw, `s${i}`, [
        ["user", { text: `q${i}` }],
        ["tool_call", { tool: "deliver", callId: `c${i}` }],
      ]);
    const log: string[] = [];
    const first = await runItemsBulkCopy({
      connectionString: url,
      buckets: 3,
      concurrency: 2,
      log: (l) => log.push(l),
    });
    assert.equal(first.failed.length, 0);
    assert.equal(first.rows, 12);
    assert.match(log.join("\n"), /bucket 0\/3: \d+ rows/);
    const rerun = await runItemsBulkCopy({
      connectionString: url,
      buckets: 3,
      only: [2],
      indexes: false,
      log: () => {},
    });
    assert.equal(rerun.failed.length, 0);
    assert.equal((await raw.query("SELECT count(*)::int AS n FROM items")).rows[0].n, 12);
    const built = await raw.query(
      `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'items'::regclass AND i.indisvalid AND c.relname = ANY($1)`,
      [ITEM_INDEXES.map((index) => index.name)],
    );
    assert.equal(built.rowCount, ITEM_INDEXES.length);
    await raw.query("UPDATE session_entries SET type = 'mystery' WHERE session_id = 's0' AND seq = 0");
    await raw.query("TRUNCATE items");
    const failing = await runItemsBulkCopy({ connectionString: url, buckets: 3, indexes: false, log: () => {} });
    assert.equal(failing.failed.length, 1);
    assert.match(failing.failed[0]!.error, /unmapped entry type=mystery/);
  });
});
