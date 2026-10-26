import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHostFront,
  normalizeHost,
  proxyTarget,
  requestHost,
  routeForHost,
  type HostRoute,
  type HostTarget,
} from "../plugins/chassis/src/tenant-hosts.ts";
import { relocateEmbeddedAuth, tenantServiceEnv } from "../plugins/chassis/src/tenant-workers.ts";
import { tenantCoreEnv, tenantTarget } from "../src/tenants/host.ts";
import { tenant, tenantFor } from "../src/tenant.ts";
import { tenantQueue } from "../src/turns/absurd-schema.ts";
import type { TenantRecord } from "../src/tenants/registry.ts";

const ACME_ID = "0f8e2c4a-1b2c-4d3e-8f90-123456789abc";

const record: TenantRecord = {
  id: ACME_ID,
  slug: "acme",
  orgId: "acme",
  hosts: ["acme.example.test"],
  status: "active",
  env: { core: { PUBLIC_API_URL: "https://acme.example.test" }, portal: { PORTAL_FAVICON_EMOJI: "A" } },
  secretEnv: { core: { CORE_SIGNING_SECRET: "core-secret" }, portal: { PORTAL_SESSION_SECRET: "portal-secret" } },
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function named(name: string): HostTarget {
  return {
    request: (_req, res) => void res.end(name),
    upgrade: (_req, socket) => void socket.end(),
  };
}

test("request host prefers the forwarded host and drops the port", () => {
  assert.equal(
    requestHost({ host: "core.internal:8080", "x-forwarded-host": "Acme.Example.test:443" }),
    "acme.example.test",
  );
  assert.equal(requestHost({ host: "acme.example.test:8080" }), "acme.example.test");
  assert.equal(requestHost({ "x-forwarded-host": "a.test, b.test", host: "c.test" }), "a.test");
  assert.equal(requestHost({}), undefined);
  assert.equal(normalizeHost("[::1]:8080"), "[::1]");
});

test("routes match exact hosts before published-app domains", () => {
  const routes: HostRoute<string>[] = [
    { hosts: ["acme.example.test"], appsDomain: "apps.acme.example.test", target: "acme" },
    { hosts: ["beta.example.test"], appsDomain: "apps.beta.example.test", target: "beta" },
  ];
  assert.equal(routeForHost(routes, "acme.example.test"), "acme");
  assert.equal(routeForHost(routes, "dash.apps.beta.example.test"), "beta");
  assert.equal(routeForHost(routes, "apps.acme.example.test"), "acme");
  assert.equal(routeForHost(routes, "evilapps.acme.example.test"), undefined);
  assert.equal(routeForHost(routes, "other.example.test"), undefined);
  assert.equal(routeForHost(routes, undefined), undefined);
});

test("the front dispatches by host and sends unknown hosts to home only for health checks", async (t) => {
  const front = createHostFront(
    () => [
      { hosts: ["acme.example.test"], target: named("acme") },
      { hosts: ["home.example.test"], target: named("home") },
    ],
    () => named("home"),
  );
  const port = await listen(front);
  t.after(() => front.close());
  assert.deepEqual(await get(port, "/v1/x", { host: "acme.example.test" }), { status: 200, body: "acme" });
  assert.deepEqual(await get(port, "/v1/x", { host: "internal", "x-forwarded-host": "home.example.test" }), {
    status: 200,
    body: "home",
  });
  assert.deepEqual(await get(port, "/healthz", { host: "10.0.0.7:8080" }), { status: 200, body: "home" });
  assert.equal((await get(port, "/v1/x", { host: "stranger.test" })).status, 404);
});

test("the proxy target keeps the original host for the tenant worker", async (t) => {
  const upstream = createServer((req, res) => res.end(String(req.headers.host)));
  const upstreamPort = await listen(upstream);
  const front = createHostFront(
    () => [{ hosts: ["acme.example.test"], target: proxyTarget(upstreamPort) }],
    () => undefined,
  );
  const port = await listen(front);
  t.after(() => {
    front.close();
    upstream.close();
  });
  assert.deepEqual(await get(port, "/", { host: "acme.example.test" }), { status: 200, body: "acme.example.test" });
});

test("a tenant target runs the tenant server inside that tenant's context", async (t) => {
  const acme = tenantFor("acme", ACME_ID, "acme");
  const server = createServer((_req, res) => res.end(`${tenant().orgId}:${tenant().id ?? ""}`));
  const front = createHostFront(
    () => [{ hosts: ["acme.example.test"], target: tenantTarget(acme, server) }],
    () => undefined,
  );
  const port = await listen(front);
  t.after(() => front.close());
  assert.deepEqual(await get(port, "/", { host: "acme.example.test" }), { status: 200, body: `acme:${ACME_ID}` });
});

test("core env overlays the tenant record on the deployment env", () => {
  const env = tenantCoreEnv({ DATABASE_URL: "postgres://db/qm", ORG_ID: "home", PORT: "8080" }, record);
  assert.equal(env.ORG_ID, "acme");
  assert.equal(env.PUBLIC_API_URL, "https://acme.example.test");
  assert.equal(env.CORE_SIGNING_SECRET, "core-secret");
  assert.equal(env.DATABASE_URL, "postgres://db/qm");
  assert.equal(env.PORTAL_SESSION_SECRET, undefined);
});

test("surface env overlays only that service and names the tenant to core", () => {
  const env = tenantServiceEnv({ CORE_ORG_ID: "home", PORT: "8097" }, record, "portal");
  assert.equal(env.CORE_ORG_ID, "acme");
  assert.equal(env.CORE_TENANT_HOST, "acme.example.test");
  assert.equal(env.PORTAL_SESSION_SECRET, "portal-secret");
  assert.equal(env.PORTAL_FAVICON_EMOJI, "A");
  assert.equal(env.CORE_SIGNING_SECRET, undefined);
});

test("embedded auth moves to its own loopback port, rewriting endpoints that pointed at it", async () => {
  const env = await relocateEmbeddedAuth({
    AUTH_EMBEDDED: "1",
    AUTH_BROKER_UPSTREAM: "http://127.0.0.1:8099",
    OIDC_TOKEN_ENDPOINT: "http://127.0.0.1:8099/idp/token",
    OIDC_ISSUER: "https://acme.example.test/idp",
  });
  const moved = new URL(env.AUTH_BROKER_UPSTREAM!);
  assert.equal(moved.hostname, "127.0.0.1");
  assert.notEqual(moved.port, "8099");
  assert.equal(env.OIDC_TOKEN_ENDPOINT, `${env.AUTH_BROKER_UPSTREAM}/idp/token`);
  assert.equal(env.OIDC_ISSUER, "https://acme.example.test/idp");
  const plain = { AUTH_BROKER_UPSTREAM: "http://127.0.0.1:8099" };
  assert.equal(await relocateEmbeddedAuth(plain), plain);
});

test("Absurd queues are tenant-scoped except for the home tenant", () => {
  assert.equal(tenantQueue("turns_people", undefined), "turns_people");
  assert.equal(tenantQueue("turns_background", ACME_ID), "turns_background_t0f8e2c4a1b2c");
  assert.equal(tenantQueue("turns_people"), "turns_people");
});
