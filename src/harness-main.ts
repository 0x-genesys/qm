import "./runs/instrument.ts";
import { loadConfig } from "./config.ts";
import { buildApp, stopWithBackstop } from "./wiring.ts";
import { shutdownOnUncaught } from "./util/process-guard.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { errMessage } from "./util/errors.ts";

const config = loadConfig();
if (!config.roles.includes("harness"))
  throw new Error(`QM_ROLES=${config.roles.join(",")} has no harness role; this entry point only runs the harness.`);
const built = buildApp(config);
await migrateRegisteredPgSchemas(config.databaseUrl);
await built.sandboxResources.initialize();
await built.config.hydrate?.();
await built.refreshCustomProviders();
await built.identity.hydrate();
const { runtime } = built;
runtime.start();
if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) built.scheduler.start(1000);
console.log(
  `[qm:harness] running turns, crons and sweepers (org=${config.orgId}, runStore=${config.runStore}, workers=${config.workers})`,
);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[qm:harness] ${signal} received, handing turns back`);
  void built.scheduler
    .stop()
    .catch((e: unknown) => console.error("[qm:harness] scheduler stop failed:", errMessage(e)));
  stopWithBackstop(runtime, config.shutdownDrainMs, "qm:harness");
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
shutdownOnUncaught("qm:harness", shutdown);
