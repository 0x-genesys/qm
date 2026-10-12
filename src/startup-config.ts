import { loadConfig, type Config } from "./config.ts";
import { createPostgresMapFactory } from "./persistence/durable-map.ts";
import { configurePgCaTrust } from "./persistence/pg-pool.ts";
import { decodeSandboxConfiguration, type StoredSandboxConfiguration } from "./sandbox/configuration.ts";
import { withCleanup } from "./util/errors.ts";

export async function loadStartupConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  if (!env.DATABASE_URL) return loadConfig(env);
  configurePgCaTrust({ cert: env.DATABASE_CA_CERT, certFile: env.DATABASE_CA_CERT_FILE });
  const maps = createPostgresMapFactory(env.DATABASE_URL);
  return withCleanup(
    async () => {
      const saved = await maps
        .map<StoredSandboxConfiguration>("sandbox_configuration")
        .get(`org:${env.ORG_ID ?? "default-org"}`);
      return loadConfig(env, decodeSandboxConfiguration(saved, env.CONNECTOR_SECRET_KEY), saved?.version ?? null);
    },
    () => maps.pool.close(),
  );
}
