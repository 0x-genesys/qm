import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createPostgresAdminGrantStore } from "../../src/admin/postgres-admin-grant-store.ts";
import { createAdminGrantStore, type AdminGrant, type AdminGrantStore } from "../../src/admin/admin-grant-store.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createPostgresMapFactory, type DurableMap } from "../../src/persistence/durable-map.ts";
import { createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";
import { configStoreMaps, createConfigStore } from "../../src/resolution/config-store.ts";
import { orgId } from "../../src/config.ts";
import { scopeId } from "../../src/types.ts";

const CREATE = `import pg from "pg";
const client = new pg.Client({ connectionString: process.argv[1] });
await client.connect();
await client.query('CREATE DATABASE "' + process.argv[2] + '"');
await client.end();`;

export function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("Set DATABASE_URL to a Postgres server the tests may create databases on");
  const url = new URL(base);
  const name = `${url.pathname.slice(1)}_${randomBytes(6).toString("hex")}`;
  execFileSync(process.execPath, ["--input-type=module", "-e", CREATE, base, name], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  url.pathname = `/${name}`;
  return url.toString();
}

let shared: { url: string; maps: ReturnType<typeof createPostgresMapFactory> } | undefined;

function sharedDatabase(): NonNullable<typeof shared> {
  if (!shared) {
    const url = testDatabaseUrl();
    shared = { url, maps: createPostgresMapFactory(url) };
  }
  return shared;
}

export function testMap<T>(indexedFields?: readonly Extract<keyof T, string>[]): DurableMap<T> {
  return sharedDatabase().maps.map<T>(`t_${randomBytes(8).toString("hex")}`, indexedFields);
}

export function testPgPool(): PgPool {
  return createPgPool(sharedDatabase().url);
}

export function testAdvisoryLock(): AdvisoryLock {
  return createPostgresAdvisoryLock(createPgPool(testDatabaseUrl()));
}

export function testConfigStore(orgId: string, opts: Partial<Parameters<typeof createConfigStore>[1]> = {}) {
  return createConfigStore(orgId, { ...configStoreMaps(() => testMap<never>()), ...opts });
}

export const TEST_ADMIN_GRANTS = "admin-alice:org_admin,admin-bob:org_admin";

export function testAdminGrantStore(
  seed: AdminGrant[] = ["admin-alice", "admin-bob"].map((principalId) => ({
    principalId,
    scopeId: scopeId("org", orgId()),
    role: "org_admin" as const,
  })),
): AdminGrantStore {
  return createAdminGrantStore(createPostgresAdminGrantStore(testDatabaseUrl()), { seed });
}

export function testDeployBackings(
  backings: Partial<Parameters<typeof import("../../src/deploy/deploy-store.ts").createDeployStore>[0]> = {},
) {
  const url = testDatabaseUrl();
  return {
    deployments:
      createPostgresMapFactory(url).map<import("../../src/deploy/deploy-store.ts").Deployment>("deployments"),
    pg: createPgPool(url),
    ...backings,
  };
}
