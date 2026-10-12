import { errMessage } from "../util/errors.ts";
import { randomUUID } from "node:crypto";
import { loadSandboxConfig, type Config } from "../config.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { SANDBOX_FIELDS, SANDBOX_DEPLOYMENT_CONTROLS, type SandboxStartup } from "./config-fields.ts";
import { parseProviderBaseUrl } from "../model/provider-endpoints.ts";

export interface StoredSandboxConfiguration {
  version: string;
  overridesEnc: string;
  updatedAt: number;
  updatedBy: string;
}

export class SandboxConfigurationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const fieldsByName = new Map(SANDBOX_FIELDS.map((field) => [field.name, field]));

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateValue(name: string, value: unknown): asserts value is string {
  const field = fieldsByName.get(name);
  if (!field?.editable) throw new SandboxConfigurationError(`Unknown or deployment-owned sandbox setting: ${name}`);
  if (typeof value !== "string" || value.length > 16_384 || value.includes("\0"))
    throw new SandboxConfigurationError(`${name} requires a string of at most 16384 characters without NUL`);
  if (field.type === "number" && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0))
    throw new SandboxConfigurationError(`${name} requires a nonnegative finite number`);
  if (
    field.type === "boolean" &&
    !["", "true", "false", "1", "0", "yes", "no", "on", "off"].includes(value.toLowerCase())
  )
    throw new SandboxConfigurationError(`${name} requires a boolean string`);
  if (!field.secret && name.endsWith("_URL") && value) {
    try {
      parseProviderBaseUrl(name, value);
    } catch {
      throw new SandboxConfigurationError(`${name} requires an HTTP(S) URL without credentials, query or fragment`);
    }
  }
}

export function decodeSandboxConfiguration(
  saved: StoredSandboxConfiguration | null,
  keyMaterial?: string,
): Record<string, string> {
  if (!saved) return {};
  if (!keyMaterial) throw new Error("CONNECTOR_SECRET_KEY is required to read saved sandbox configuration");
  const values: unknown = JSON.parse(
    decryptSecret(saved.overridesEnc, deriveConnectorKey(keyMaterial, "sandbox-configuration")),
  );
  if (!object(values)) throw new Error("Invalid stored sandbox configuration");
  for (const [name, value] of Object.entries(values)) validateValue(name, value);
  return values as Record<string, string>;
}

function publicConfig(config: unknown): unknown {
  if (!object(config)) return config;
  return Object.fromEntries(
    Object.entries(config).map(([name, value]) => {
      if (["token", "tokenId", "tokenSecret", "apiKey", "proxy"].includes(name))
        return [name, { configured: Boolean(value) }];
      return [name, publicConfig(value)];
    }),
  );
}

function sameOverrides(a: Record<string, string>, b: Record<string, string>): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([name, value]) => b[name] === value)
  );
}

export function createSandboxConfiguration(input: { backing: DurableMap<StoredSandboxConfiguration>; config: Config }) {
  const { config, backing } = input;
  const startup: SandboxStartup = config.sandboxStartup ?? { environment: {}, overrides: {}, version: null };
  const keyMaterial = config.connectorSecretKey;
  const durable = Boolean(config.databaseUrl && keyMaterial);
  const org = `org:${config.orgId}`;
  const decode = (saved: StoredSandboxConfiguration | null) => decodeSandboxConfiguration(saved, keyMaterial);
  const active = loadSandboxConfig({ ...startup.environment, ...startup.overrides });
  const activeView = Object.fromEntries(Object.keys(active).map((name) => [name, config[name as keyof Config]]));

  const state = async () => {
    const saved = await backing.get(org);
    const overrides = decode(saved);
    return {
      overrides,
      summary: {
        version: saved?.version ?? null,
        appliedVersion: startup.version,
        appliesOn: "process_restart",
        activeAppliesTo: "this_process",
        restartRequired: !sameOverrides(startup.overrides, overrides),
        durable,
        ...(saved ? { updatedAt: saved.updatedAt, updatedBy: saved.updatedBy } : {}),
        detailsPath: "/v1/admin/sandbox-configuration",
      },
    };
  };

  return {
    async summary() {
      return (await state()).summary;
    },
    async read() {
      const { overrides, summary } = await state();
      const desired = { ...startup.environment, ...overrides };
      return {
        ...summary,
        active: publicConfig(activeView),
        nextStartup: publicConfig(loadSandboxConfig(desired)),
        fields: SANDBOX_FIELDS.map((field) => {
          let source = "default_or_provider";
          if (startup.environment[field.name] !== undefined) source = "startup_environment";
          if (Object.hasOwn(overrides, field.name)) source = "saved_override";
          return {
            ...field,
            source,
            value: field.secret ? { configured: Boolean(desired[field.name]) } : (desired[field.name] ?? null),
            override: field.secret ? { configured: Boolean(overrides[field.name]) } : (overrides[field.name] ?? null),
          };
        }),
        deploymentControls: SANDBOX_DEPLOYMENT_CONTROLS,
        relatedControls: {
          connectionPool: "sandbox-settings.connectionPoolMax",
          perScopeComputers: "sandbox tool",
          turnWallClock: "turn-wall-clock",
        },
        effects:
          "Restart applies provider and execution settings to each process. Existing machines may be reused, reconfigured or replaced on their next operation; template or network changes can replace a Superserve computer and local image changes recreate its container. Changing snapshot destinations does not copy recovery data. Credential acceptance and remote capacity are not verified by saving.",
      };
    },
    async write(body: unknown, actor: string) {
      if (!durable)
        throw new SandboxConfigurationError(
          "Sandbox configuration writes require PostgreSQL and CONNECTOR_SECRET_KEY",
          503,
        );
      if (!object(body) || Object.keys(body).some((key) => !["expectedVersion", "set", "reset"].includes(key)))
        throw new SandboxConfigurationError("Use { expectedVersion, set: { SETTING: string }, reset: [SETTING] }");
      if (!(body.expectedVersion === null || typeof body.expectedVersion === "string"))
        throw new SandboxConfigurationError("expectedVersion is required; read the current configuration first");
      const set = body.set ?? {};
      const reset = body.reset ?? [];
      if (!object(set) || !Array.isArray(reset) || reset.some((name) => typeof name !== "string"))
        throw new SandboxConfigurationError("set must be an object and reset an array of setting names");
      for (const [name, value] of Object.entries(set)) validateValue(name, value);
      for (const name of reset) {
        if (!fieldsByName.get(name)?.editable || Object.hasOwn(set, name))
          throw new SandboxConfigurationError("Reset names must be editable settings omitted from set");
      }
      await backing.mutateMany([
        {
          id: org,
          apply: (saved) => {
            if ((saved?.version ?? null) !== body.expectedVersion)
              throw new SandboxConfigurationError("Sandbox configuration changed; read it again before saving", 409);
            const previous = decode(saved);
            const overrides = { ...previous, ...set } as Record<string, string>;
            for (const name of reset) delete overrides[name];
            try {
              try {
                loadSandboxConfig({ ...startup.environment, ...overrides });
              } catch (error) {
                throw new SandboxConfigurationError(errMessage(error));
              }
            } catch (error) {
              throw new SandboxConfigurationError(errMessage(error));
            }
            if (saved && sameOverrides(previous, overrides)) return saved;
            return {
              version: randomUUID(),
              overridesEnc: encryptSecret(
                JSON.stringify(overrides),
                deriveConnectorKey(keyMaterial!, "sandbox-configuration"),
              ),
              updatedAt: Date.now(),
              updatedBy: actor,
            };
          },
        },
      ]);
    },
  };
}

export type SandboxConfiguration = ReturnType<typeof createSandboxConfiguration>;
