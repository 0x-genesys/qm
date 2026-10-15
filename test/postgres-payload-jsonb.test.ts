import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createContextSummaryPayload } from "../src/sessions/session-store.ts";
import { jsonbSafeStringify } from "../src/util/text.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the payload jsonb migration tests";
const CONVERT = "sessions/store/0033-payload-jsonb";
const scope = scopeId("channel", "jsonb");

test("payload jsonb: the startup migration converts a TEXT table in place and repairs bad rows", { skip }, async () => {
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const store = createPostgresSessionStore(URL!);
  try {
    const before = registeredPgMigrations(URL!).filter((m) => m.id < CONVERT);
    await applyPgMigrations(raw, before);
    const type = async () =>
      (
        await raw.query(
          "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'session_entries'::regclass AND attname = 'payload'",
        )
      ).rows[0].t;
    assert.equal(await type(), "text");
    await raw.query(
      "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, messages, turns) VALUES ('legacy', 'channel', $1, 'legacy-thread', 1, 6, 3)",
      [scope],
    );
    await raw.query(
      await readFile(new globalThis.URL("./fixtures/legacy-participant-activity.sql", import.meta.url), "utf8"),
    );
    const legacy: [number, string, string | null][] = [
      [0, "user", '{"text":"nul\\u0000inside","name":"Ada"}'],
      [1, "assistant", '{"text":"lone \\ud800 high and \\udc00 low, pair \\ud83d\\ude00"}'],
      [2, "user", '{"text":"overheard","overheard":true}'],
      [3, "system", '{"kind":"context_summary","throughSeq":1,"text":"summary"}'],
      [4, "text", '"plain string"'],
      [5, "user", '{"text":"truncated'],
      [6, "tool_result", null],
    ];
    for (const [seq, type, payload] of legacy)
      await raw.query(
        "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ('legacy', $1, NULL, $2, $3, $4, $5)",
        [seq, type, payload, scope, seq],
      );

    assert.equal(
      (await raw.query("SELECT user_last_activity_seq FROM sessions WHERE id='legacy'")).rows[0].user_last_activity_seq,
      5,
    );
    const conversion = registeredPgMigrations(URL!).filter((m) => m.id === CONVERT);
    await raw.query(conversion[0]!.statements.find((sql) => sql.includes("FUNCTION entry_payload_repair"))!);
    for (const text of [
      "\\u0000",
      "\\ud800",
      "\\udc00",
      "\ud800\ud800",
      "\udc00\udc00",
      "😀\ud800😀",
      'quoted "\u0000 tail',
    ]) {
      const encoded = JSON.stringify({ text });
      const repaired = await raw.query("SELECT entry_payload_repair($1) AS payload", [encoded]);
      assert.deepEqual(repaired.rows[0].payload, JSON.parse(jsonbSafeStringify({ text })), encoded);
    }
    await assert.rejects(applyPgMigrations(raw, conversion), /invalid input syntax for type json/);
    assert.equal(await type(), "text", "an unrepairable row rolls back the entire conversion");
    assert.equal(
      (await raw.query("SELECT payload FROM session_entries WHERE session_id = 'legacy' AND seq = 5")).rows[0].payload,
      '{"text":"truncated',
    );
    await raw.query("DELETE FROM session_entries WHERE session_id = 'legacy' AND seq = 5");
    assert.equal((await store.getEntries("legacy")).length, 6, "the store's first query runs the conversion");
    assert.equal(await type(), "jsonb");
    assert.equal(
      (await raw.query("SELECT to_regprocedure('participant_activity_on_entry_v3()') IS NULL AS gone")).rows[0].gone,
      true,
    );
    assert.equal(
      (await raw.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='participant_activity_entry_v3'"))
        .rows[0].n,
      0,
    );
    const payloads = (await store.getEntries("legacy")).map((e) => e.payload);
    assert.deepEqual(payloads, [
      { text: "nulinside", name: "Ada" },
      { text: "lone \uFFFD high and \uFFFD low, pair \u{1F600}" },
      { text: "overheard", overheard: true },
      { kind: "context_summary", throughSeq: 1, text: "summary" },
      "plain string",
      null,
    ]);
    const schema = (
      await raw.query(
        `SELECT (SELECT array_agg(indexrelid::regclass::text ORDER BY 1) FROM pg_index
                  WHERE indrelid = 'session_entries'::regclass) AS indexes,
                (SELECT count(*) FROM pg_attribute WHERE attrelid = 'session_entries'::regclass
                  AND attname = 'search_tsv' AND NOT attisdropped)::int AS search_tsv,
                to_regprocedure('safe_json(text)') IS NULL AND to_regprocedure('entry_search_text(text)') IS NULL
                  AND to_regprocedure('entry_payload_repair(text)') IS NULL AS helpers_gone`,
      )
    ).rows[0];
    assert.deepEqual(schema.indexes.sort(), [
      "session_entries_agent_reply",
      "session_entries_context_markers",
      "session_entries_pkey",
      "session_entries_session_created",
      "session_entries_user_activity",
      "session_entries_user_attributed",
      "session_entries_user_ts",
    ]);
    assert.equal(schema.search_tsv, 0);
    assert.equal(schema.helpers_gone, true);

    const { lease } = await store.acquireLease("legacy");
    await store.append(lease!, { type: "user", payload: { text: "after conversion", name: "Bea" }, scopeLabel: scope });
    await store.releaseLease(lease!);
    const indexed = await raw.query(
      "SELECT seq, author, text FROM session_entry_search WHERE session_id = 'legacy' ORDER BY seq",
    );
    assert.deepEqual(
      indexed.rows.filter((r) => r.seq >= 7),
      [{ seq: 7, author: "Bea", text: "after conversion" }],
      "the search trigger was recreated on the converted column",
    );
    const turns = await raw.query("SELECT turns FROM sessions WHERE id = 'legacy'");
    assert.equal(turns.rows[0].turns, 2, "the recount skips overheard rows");

    await raw.query("DELETE FROM qm_schema_migrations WHERE id = $1", [CONVERT]);
    await applyPgMigrations(
      raw,
      registeredPgMigrations(URL!).filter((m) => m.id === CONVERT),
    );
    assert.deepEqual(
      (await store.getEntries("legacy")).map((e) => e.payload).slice(0, 6),
      payloads,
      "re-running against an already-jsonb column changes nothing",
    );
  } finally {
    await raw.end();
  }
});

test(
  "payload jsonb: the context window finds markers through the partial index and reports load cost",
  { skip },
  async () => {
    const store = createPostgresSessionStore(URL!);
    const session = await store.getOrCreateByThread("jsonb-window", "channel", scope);
    const { lease } = await store.acquireLease(session.id);
    for (let i = 0; i < 4; i++)
      await store.append(lease!, { type: "user", payload: { text: `u${i}` }, scopeLabel: scope });
    await store.append(lease!, {
      type: "system",
      payload: { kind: "memory_context", snapshot: { audience: "a" }, throughSeq: -1 },
      scopeLabel: scope,
    });
    await store.append(lease!, {
      type: "system",
      payload: createContextSummaryPayload(4, "so far"),
      scopeLabel: scope,
    });
    await store.append(lease!, { type: "text", payload: "a bare string payload", scopeLabel: scope });
    await store.releaseLease(lease!);

    const window = await store.getContextWindow(session.id);
    assert.deepEqual(
      window.entries.map((e) => [e.seq, e.payload]),
      [
        [4, { kind: "memory_context", snapshot: { audience: "a" }, throughSeq: -1 }],
        [5, createContextSummaryPayload(4, "so far")],
        [6, "a bare string payload"],
      ],
    );
    assert.ok(window.load && window.load.bytes > 0 && window.load.queryMs >= 0 && window.load.parseMs >= 0);

    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query("SET enable_seqscan = off");
      await client.query("SET enable_bitmapscan = off");
      const plan = await client.query(
        `EXPLAIN SELECT seq FROM session_entries WHERE session_id = $1 AND type = 'system'
         AND payload ->> 'kind' = 'context_summary' ORDER BY seq DESC LIMIT 1`,
        [session.id],
      );
      assert.match(plan.rows.map((r) => r["QUERY PLAN"]).join("\n"), /session_entries_context_markers/);
      const attributed = await client.query(
        `EXPLAIN SELECT 1 FROM session_entries e WHERE e.session_id = $1 AND e.type = 'user'
         AND (e.payload IS NULL OR NOT e.payload @> '{"overheard":true}') ORDER BY e.created_at, e.seq`,
        [session.id],
      );
      assert.match(attributed.rows.map((r) => r["QUERY PLAN"]).join("\n"), /session_entries_user_attributed/);
    } finally {
      await client.end();
    }
  },
);
