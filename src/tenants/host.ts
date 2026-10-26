import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHostFront,
  hostOfUrl,
  proxyTarget,
  type HostRoute,
  type HostTarget,
} from "../../plugins/chassis/src/tenant-hosts.ts";
import {
  appsDomainOf,
  homeHosts,
  relocateEmbeddedAuth,
  startTenantWorker,
  tenantServiceEnv,
  type RegistryTenant,
  type TenantWorker,
} from "../../plugins/chassis/src/tenant-workers.ts";
import type { Config } from "../config.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { tenant, tenantFor, withTenant, type Tenant } from "../tenant.ts";
import { reportFailure } from "../util/errors.ts";
import { bootTenant, type BootedTenant } from "./boot.ts";
import {
  assertRowSecurityEnforced,
  homeTenantId,
  listTenants,
  tenantSecretsKey,
  tenantServiceEnv as tenantRecordEnv,
  type TenantRecord,
} from "./registry.ts";

const REGISTRY_RELOAD_MS = 60_000;

type Boot = typeof bootTenant;

export function tenantTarget(t: Tenant, server: Server): HostTarget {
  return {
    request: (req, res) => withTenant(t, () => void server.emit("request", req, res)),
    upgrade: (req, socket, head) => withTenant(t, () => void server.emit("upgrade", req, socket, head)),
  };
}

export function tenantCoreEnv(base: NodeJS.ProcessEnv, rec: TenantRecord): NodeJS.ProcessEnv {
  return { ...tenantRecordEnv(base, rec, "core"), ORG_ID: rec.orgId };
}

function configHosts(config: Config): string[] {
  return [config.publicUrl, config.apiBaseUrl, config.publicWebUrl]
    .map(hostOfUrl)
    .filter((host): host is string => Boolean(host));
}

export interface MultitenantHost {
  tenants: BootedTenant[];
  servers: Server[];
  stopWorkers(): Promise<void>;
}

export async function startMultitenant(env: NodeJS.ProcessEnv, boot: Boot = bootTenant): Promise<MultitenantHost> {
  if (!env.DATABASE_URL) throw new Error("QM_MULTITENANT=1 needs DATABASE_URL to read the tenant registry");
  const registry = createPgPool(env.DATABASE_URL);
  const key = tenantSecretsKey(env);
  const tenants: BootedTenant[] = [];
  const servers: Server[] = [];
  const workers: TenantWorker[] = [];
  const coreRoutes: HostRoute<HostTarget>[] = [];
  const edgeRoutes: HostRoute<HostTarget>[] = [];
  const booted = new Set<string>();
  let homeCore: HostTarget | undefined;
  let homeEdge: HostTarget | undefined;
  let publicPort: number | undefined;

  async function startEdge(
    t: Tenant,
    tenantEnv: NodeJS.ProcessEnv,
    rec: RegistryTenant,
    target: HostTarget,
  ): Promise<void> {
    const loopback = createHttpServer((req, res) => target.request(req, res));
    loopback.on("upgrade", (req, socket, head) => target.upgrade(req, socket, head));
    await new Promise<void>((resolve) => loopback.listen(0, "127.0.0.1", resolve));
    servers.push(loopback);
    const core = { CORE_API_URL: `http://127.0.0.1:${(loopback.address() as AddressInfo).port}`, CORE_ORG_ID: t.orgId };
    const web = await startTenantWorker(new URL("../../plugins/web-ui/server/index.ts", import.meta.url), {
      ...tenantServiceEnv(tenantEnv, rec, "web-ui"),
      ...core,
    });
    workers.push(web);
    const webUrl = `http://127.0.0.1:${web.port}`;
    const portalBase = {
      ...tenantServiceEnv(tenantEnv, rec, "portal"),
      ...core,
      WEB_UI_UPSTREAM: webUrl,
      ADMIN_UPSTREAM: `${webUrl}/admin`,
    };
    const portalEnv = t.id ? await relocateEmbeddedAuth(portalBase) : portalBase;
    const portal = await startTenantWorker(new URL("../../plugins/portal/src/index.ts", import.meta.url), portalEnv);
    workers.push(portal);
    const edge = proxyTarget(portal.port);
    if (!t.id) homeEdge = edge;
    const appsDomain = appsDomainOf(portalEnv);
    edgeRoutes.push({ hosts: rec.hosts, ...(appsDomain ? { appsDomain } : {}), target: edge });
  }

  async function add(t: Tenant, tenantEnv: NodeJS.ProcessEnv, rec: RegistryTenant): Promise<void> {
    const started = await withTenant(t, () =>
      boot(tenantEnv, async (server, config) => {
        if (!server) return;
        const target = tenantTarget(t, server);
        if (!t.id) {
          homeCore = target;
          publicPort = config.publicPort;
        }
        const hosts = [...new Set([...rec.hosts, ...configHosts(config)])];
        coreRoutes.push({ hosts, ...(config.deployAppsDomain ? { appsDomain: config.deployAppsDomain } : {}), target });
        if (publicPort) await startEdge(t, tenantEnv, { ...rec, hosts }, target);
      }),
    );
    tenants.push(started);
    console.log(`[qm] tenant ${t.slug ?? "home"} (org ${t.orgId}) booted`);
  }

  async function addNew(records: TenantRecord[], homeId: string): Promise<void> {
    for (const rec of records) {
      if (rec.id === homeId || rec.status !== "active" || booted.has(rec.id)) continue;
      booted.add(rec.id);
      try {
        await add(tenantFor(rec.orgId, rec.id, rec.slug), tenantCoreEnv(env, rec), rec);
      } catch (error) {
        reportFailure(`tenant ${rec.slug} failed to boot`, error);
      }
    }
  }

  await assertRowSecurityEnforced(registry);
  const home = tenant();
  await add(home, env, { id: "", slug: "home", orgId: home.orgId, hosts: homeHosts(env), env: {}, secretEnv: {} });
  const homeId = await homeTenantId(registry);
  await addNew(await listTenants(registry, key), homeId);

  const homeConfig = tenants[0]!.config;
  if (homeCore) {
    const front = createHostFront(
      () => coreRoutes,
      () => homeCore,
    );
    front.requestTimeout = 0;
    front.headersTimeout = 10_000;
    front.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve) => front.listen(homeConfig.port, resolve));
    servers.push(front);
  }
  if (publicPort) {
    const edge = createHostFront(
      () => edgeRoutes,
      () => homeEdge,
    );
    await new Promise<void>((resolve) => edge.listen(publicPort, resolve));
    servers.push(edge);
  }
  console.log(
    `[qm] multitenant: ${tenants.length} tenant(s) on :${homeConfig.port}${publicPort ? `, public :${publicPort}` : ""}`,
  );

  const reload = setInterval(() => {
    void listTenants(registry, key)
      .then((latest) => addNew(latest, homeId))
      .catch((error: unknown) => reportFailure("tenant registry reload failed", error));
  }, REGISTRY_RELOAD_MS);
  reload.unref();

  return {
    tenants,
    servers,
    async stopWorkers() {
      clearInterval(reload);
      await Promise.all(workers.map((worker) => worker.stop()));
    },
  };
}
