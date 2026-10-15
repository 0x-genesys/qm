import pg from "pg";
import {
  ITEMS_BUCKET_DELETE_SQL,
  ITEMS_COPY_DEFAULT_BUCKETS,
  itemsBucketParams,
  itemsCopySql,
} from "../src/sessions/items-copy.ts";
import { ITEM_INDEXES, itemIndexSql } from "../src/sessions/items-schema.ts";
import { errMessage } from "../src/util/errors.ts";

export interface ItemsBulkCopyOptions {
  connectionString: string;
  buckets?: number;
  concurrency?: number;
  only?: number[];
  delta?: boolean;
  indexes?: boolean;
  indexesOnly?: boolean;
  log?: (line: string) => void;
}

interface BucketResult {
  bucket: number;
  rows: number;
  ms: number;
  error?: string;
}

export interface ItemsBulkCopyResult {
  rows: number;
  results: BucketResult[];
  failed: Array<{ bucket: number; error: string }>;
}
function pgErrorText(error: unknown): string {
  const pgError = error as { code?: string; detail?: string; where?: string };
  return [errMessage(error), pgError.code && `SQLSTATE ${pgError.code}`, pgError.detail, pgError.where]
    .filter(Boolean)
    .join(" | ");
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

async function copyBucket(
  pool: pg.Pool,
  bucket: number,
  buckets: number,
  delta: boolean,
): Promise<Omit<BucketResult, "ms">> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 0");
    await client.query("SET LOCAL lock_timeout = '10s'");
    const params = itemsBucketParams(bucket, buckets);
    if (!delta) await client.query(ITEMS_BUCKET_DELETE_SQL, params);
    const inserted = await client.query(itemsCopySql({ delta }), params);
    await client.query("COMMIT");
    return { bucket, rows: inserted.rowCount ?? 0 };
  } catch (error) {
    const rollback = await client.query("ROLLBACK").then(
      () => "",
      (rollbackError: unknown) => {
        broken = true;
        return `; rollback also failed: ${errMessage(rollbackError)}`;
      },
    );
    return { bucket, rows: 0, error: `${pgErrorText(error)}${rollback}` };
  } finally {
    client.release(broken);
  }
}

async function buildIndexes(pool: pg.Pool, log: (line: string) => void): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 0");
    await client.query("SET maintenance_work_mem = '1GB'");
    for (const index of ITEM_INDEXES) {
      const existing = await client.query(
        `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
        [index.name],
      );
      if (existing.rows[0]?.indisvalid === false) {
        log(`index ${index.name}: dropping invalid leftover`);
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
      }
      const started = Date.now();
      await client.query(itemIndexSql(index, { concurrently: true }));
      log(`index ${index.name}: built in ${seconds(Date.now() - started)}`);
    }
    const started = Date.now();
    await client.query("ANALYZE items");
    log(`analyze items: ${seconds(Date.now() - started)}`);
  } finally {
    client.release();
  }
}

export async function runItemsBulkCopy(opts: ItemsBulkCopyOptions): Promise<ItemsBulkCopyResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const buckets = opts.buckets ?? ITEMS_COPY_DEFAULT_BUCKETS;
  const delta = opts.delta ?? false;
  const targets = opts.only?.length ? [...new Set(opts.only)] : Array.from({ length: buckets }, (_, i) => i);
  for (const bucket of targets) itemsBucketParams(bucket, buckets);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? targets.length, targets.length));
  const pool = new pg.Pool({ connectionString: opts.connectionString, max: concurrency });
  const results: BucketResult[] = [];
  try {
    if (!opts.indexesOnly) {
      if (!delta) {
        const triggers = await pool.query(
          "SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'items'::regclass AND NOT tgisinternal",
        );
        if (triggers.rows[0].n > 0)
          throw new Error("items has triggers (cutover E landed); bulk mode deletes buckets, use --delta");
      }
      const started = Date.now();
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < targets.length) {
          const bucket = targets[next++]!;
          const t0 = Date.now();
          const result = { ...(await copyBucket(pool, bucket, buckets, delta)), ms: Date.now() - t0 };
          results.push(result);
          const first = results.length === 1 ? " (first bucket done: speed measurement)" : "";
          log(
            result.error
              ? `bucket ${bucket}/${buckets}: FAILED after ${seconds(result.ms)}: ${result.error}`
              : `bucket ${bucket}/${buckets}: ${result.rows} rows in ${seconds(result.ms)}${first}`,
          );
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      const rows = results.reduce((sum, r) => sum + r.rows, 0);
      log(`copy: ${rows} rows from ${results.length} buckets in ${seconds(Date.now() - started)}`);
    }
    const failed = results.filter((r) => r.error).map((r) => ({ bucket: r.bucket, error: r.error! }));
    if (failed.length)
      log(`rerun failed buckets with: --bucket ${failed.map((f) => f.bucket).join(",")} --buckets ${buckets}`);
    else if (opts.indexes ?? !delta) await buildIndexes(pool, log);
    return { rows: results.reduce((sum, r) => sum + r.rows, 0), results, failed };
  } finally {
    await pool.end();
  }
}

function intArg(name: string, fallback?: number): number | undefined {
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  const value = Number(process.argv[at + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} needs a non-negative integer`);
  return value;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("set DATABASE_URL");
  const at = process.argv.indexOf("--bucket");
  const only = at < 0 ? undefined : (process.argv[at + 1] ?? "").split(",").map(Number);
  const opts: ItemsBulkCopyOptions = {
    connectionString,
    buckets: intArg("--buckets", ITEMS_COPY_DEFAULT_BUCKETS),
    concurrency: intArg("--concurrency"),
    only,
    delta: process.argv.includes("--delta"),
    indexesOnly: process.argv.includes("--indexes-only"),
    ...(process.argv.includes("--no-indexes") ? { indexes: false } : {}),
  };
  if (!process.argv.includes("--apply")) {
    console.log(`plan (add --apply to run): ${JSON.stringify({ ...opts, connectionString: "<DATABASE_URL>" })}`);
    return;
  }
  const result = await runItemsBulkCopy(opts);
  if (result.failed.length) process.exitCode = 1;
}

if (import.meta.main) await main();
