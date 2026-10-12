export interface SandboxStartup {
  environment: NodeJS.ProcessEnv;
  overrides: Record<string, string>;
  version: string | null;
}

interface SandboxField {
  name: string;
  type: "string" | "number" | "boolean";
  secret: boolean;
  editable: boolean;
}

function fields(
  type: SandboxField["type"],
  names: string[],
  options: Partial<Pick<SandboxField, "secret" | "editable">> = {},
): SandboxField[] {
  return names.map((name) => ({ name, type, secret: false, editable: true, ...options }));
}

export const SANDBOX_FIELDS: readonly SandboxField[] = [
  ...fields("string", [
    "AGENT37_API_BASE_URL",
    "AGENT37_EGRESS_PROXY_URL",
    "AGENT37_NAME_PREFIX",
    "AGENT37_TEMPLATE",
    "AWS_SANDBOX_EGRESS_CONNECTORS",
    "AWS_SANDBOX_EXEC_ROLE_ARN",
    "AWS_SANDBOX_IMAGE",
    "AWS_SANDBOX_IMAGE_VERSION",
    "AWS_SANDBOX_INGRESS_CONNECTORS",
    "AWS_SANDBOX_PROFILE",
    "AWS_SANDBOX_REGION",
    "AWS_SANDBOX_S3_BUCKET",
    "AWS_SANDBOX_S3_PREFIX",
    "E2B_EGRESS_PROXY_URL",
    "E2B_NAME_PREFIX",
    "E2B_SNAPSHOT_S3_BUCKET",
    "E2B_TEMPLATE_ID",
    "LOCAL_SANDBOX_IMAGE",
    "MODAL_APP_NAME",
    "MODAL_EGRESS_PROXY_URL",
    "MODAL_ENVIRONMENT",
    "MODAL_IMAGE",
    "MODAL_NAME_PREFIX",
    "MODAL_REGIONS",
    "MODAL_SNAPSHOT_S3_BUCKET",
    "PORTER_DEPLOY_URL",
    "PORTER_SANDBOX_BASE_URL",
    "PORTER_SANDBOX_EGRESS_PROXY_URL",
    "PORTER_SANDBOX_HOME",
    "PORTER_SANDBOX_IMAGE",
    "PORTER_SANDBOX_NAME_PREFIX",
    "SANDBOX_BACKEND",
    "SANDBOX_CAPABILITY_TTL_HOURS",
    "SMOLMACHINES_BASE_URL",
    "SMOLMACHINES_EGRESS_PROXY_URL",
    "SMOLMACHINES_IMAGE",
    "SMOLMACHINES_NAME_PREFIX",
    "SMOLMACHINES_SNAPSHOT_S3_BUCKET",
    "SPRITES_BASE_URL",
    "SPRITES_EGRESS_PROXY_ADDITIONAL_URLS",
    "SPRITES_EGRESS_PROXY_URL",
    "SPRITES_NAME_PREFIX",
    "SPRITES_SNAPSHOT_S3_BUCKET",
    "SUPERSERVE_BASE_URL",
    "SUPERSERVE_EGRESS_ALLOW",
    "SUPERSERVE_EGRESS_DENY",
    "SUPERSERVE_HOME_DIR",
    "SUPERSERVE_NAME_PREFIX",
    "SUPERSERVE_TEMPLATE",
  ]),
  ...fields(
    "string",
    [
      "AGENT37_API_KEY",
      "E2B_API_KEY",
      "E2B_PROXY",
      "MODAL_TOKEN_ID",
      "MODAL_TOKEN_SECRET",
      "PORTER_DEPLOY_API_TOKEN",
      "SMOLMACHINES_TOKEN",
      "SPRITES_TOKEN",
      "SUPERSERVE_API_KEY",
    ],
    { secret: true },
  ),
  ...fields("number", [
    "AGENT37_CPUS",
    "AGENT37_DISK_GB",
    "AGENT37_MEMORY_GB",
    "AWS_SANDBOX_AGENT_PORT",
    "AWS_SANDBOX_CPUS",
    "AWS_SANDBOX_DISK_GB",
    "AWS_SANDBOX_MAX_DURATION_SEC",
    "AWS_SANDBOX_MAX_IDLE_SEC",
    "AWS_SANDBOX_MEMORY_MB",
    "AWS_SANDBOX_ROTATE_AFTER_SEC",
    "AWS_SANDBOX_SNAPSHOT_INTERVAL_MS",
    "AWS_SANDBOX_SUSPENDED_SEC",
    "BACKGROUND_JOB_TTL_MAX_SEC",
    "BACKGROUND_JOB_TTL_SEC",
    "DEEP_IDLE_MACHINE_MS",
    "DEV_IDLE_MACHINE_MS",
    "E2B_MAX_LIFETIME_SEC",
    "E2B_NATIVE_SNAPSHOT_INTERVAL_SEC",
    "E2B_SANDBOX_TTL_SEC",
    "E2B_SNAPSHOT_INTERVAL_SEC",
    "EXEC_TIMEOUT_DEFAULT_SEC",
    "EXEC_TIMEOUT_MAX_SEC",
    "LOCAL_SANDBOX_CPUS",
    "LOCAL_SANDBOX_MEMORY_MB",
    "MODAL_CPUS",
    "MODAL_MEMORY_MB",
    "MODAL_NATIVE_SNAPSHOT_INTERVAL_SEC",
    "MODAL_REAP_IDLE_SEC",
    "MODAL_ROTATE_AFTER_SEC",
    "MODAL_SANDBOX_TIMEOUT_SEC",
    "MODAL_SNAPSHOT_INTERVAL_SEC",
    "MODAL_SNAPSHOT_RETENTION_SEC",
    "PORTER_DEPLOY_CLUSTER_ID",
    "PORTER_DEPLOY_PROJECT_ID",
    "PORTER_SANDBOX_TTL_SEC",
    "SANDBOX_TIMEOUT_SEC",
    "SMOLMACHINES_AUTOSTOP_SEC",
    "SMOLMACHINES_CPUS",
    "SMOLMACHINES_DISK_GB",
    "SMOLMACHINES_MEMORY_MB",
    "SMOLMACHINES_SNAPSHOT_INTERVAL_SEC",
    "SPRITES_MEMORY_MB",
    "SUPERSERVE_IDLE_PAUSE_SEC",
    "SUPERSERVE_RETENTION_SEC",
  ]),
  ...fields("string", ["AWS_DEFAULT_REGION", "AWS_REGION", "LOCAL_SANDBOX_DOCKER_BIN", "QM_CORE_CONTAINER"], {
    editable: false,
  }),
  ...fields("boolean", ["EAGER_PROVISION", "EXECUTE_SCRATCH", "MODAL_NATIVE_SNAPSHOTS_ENABLED", "REACH_EXEC"]),
  ...fields("number", ["SUPERSERVE_CONFIG_GENERATION"], { editable: false }),
];

export const SANDBOX_DEPLOYMENT_CONTROLS = [
  {
    names: [
      "DATABASE_URL",
      "DATABASE_POOL_URL",
      "DATABASE_CA_CERT",
      "DATABASE_CA_CERT_FILE",
      "DATABASE_POOL_CA_CERT",
      "DATABASE_POOL_MAX",
      "DATABASE_DIRECT_POOL_MAX",
    ],
    reason: "Database location, trust, and other pool owners; needed before stored sandbox overrides can be read.",
  },
  {
    names: ["CONNECTOR_SECRET_KEY"],
    reason: "Encryption root; cannot replace through data encrypted by itself. Expose configured/source only.",
  },
  {
    names: ["ORG_ID"],
    reason: "Identity/key for durable org settings. Deployment identity, not a provider override.",
  },
  {
    names: ["CORE_SIGNING_SECRET", "CAPABILITY_SECRET", "PORTAL_IDENTITY_SECRET"],
    reason: "Shared signing authorities; rotate through deployment/secret owner. Expose configured/source only.",
  },
  {
    names: ["PUBLIC_API_URL", "AGENT_API_URL"],
    reason:
      "Core endpoint embedded in sandbox capability/control-plane operations and used by unrelated core services.",
  },
  {
    names: ["DATA_DIR", "SNAPSHOT_STORE", "TRANSFER_STORE", "S3_BUCKET", "S3_REGION", "S3_PREFIX"],
    reason:
      "Shared core workspace, files, uploads, blob transfer, and deployment archive storage. Changing requires infrastructure/storage migration, not provider-only restart.",
  },
  {
    names: ["SECRETS_BACKEND", "SECRETS_PREFIX"],
    reason:
      "Global connector/credential-broker secret source; not the sandbox provider credential configuration owner.",
  },
  {
    names: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"],
    reason:
      "Ambient AWS credential chain affects AWS provider, portable snapshot S3 clients, and other services. Show protected metadata; retain infrastructure/credential owner.",
  },
  {
    names: ["EGRESS_TOKENLESS", "AUTHZ_PORT", "CORE_API_URL"],
    reason:
      "Separate egress-authz process config; changing core provider settings does not change the proxy enforcement service.",
  },
  {
    names: ["PORTER_CLUSTER_ID", "KUBERNETES_SERVICE_HOST"],
    reason:
      "Ambient Porter SDK locator fallback outside loadConfig; deployment/pod identity. Prefer explicit sandbox base URL in provider override.",
  },
  {
    names: ["PORTER_DEPLOY_RUNNER_IMAGE", "DEPLOY_PROVIDER"],
    reason: "Deployment-only owners. Do not overlay when parsing saved sandbox input.",
  },
  {
    names: ["PORTER_SANDBOX_API_KEY", "PORTER_SANDBOX_BASE_URL", "PORTER_CLUSTER_ID", "KUBERNETES_SERVICE_HOST"],
    reason:
      "SDK process.env fallbacks when explicit apiKey/baseUrl absent. Wrapper at src/sandbox/porter-client.ts:106 only passes truthy options. Disclose them; clearing saved override restores environment/fallback and must not be described as revoking ambient credentials. PORTER_SANDBOX_API_KEY alone does not satisfy current selected-backend core secret validation.",
  },
  {
    names: ["E2B_DOMAIN", "E2B_API_URL", "E2B_DEBUG"],
    reason:
      "SDK deployment/runtime controls not represented in current Config. Explicit client option plumbing would be separate narrow follow-up; no process.env mutation in resolver.",
  },
  {
    names: ["MODAL_SERVER_URL"],
    reason:
      "SDK reads deployment environment/profile defaults; current QM client does not expose server URL. Show deployment control metadata.",
  },
  {
    names: ["SPRITES_CLIENT_SIGNALS"],
    reason:
      "SDK diagnostics/attribution control cached process-wide at first request; outside provider machine config.",
  },
] as const;

const contextNames = [
  "NODE_ENV",
  "DATABASE_URL",
  "SANDBOX_SCOPE_BACKENDS",
  "SANDBOX_SECONDARY_BACKEND",
  "PORTER_CLUSTER_ID",
  "KUBERNETES_SERVICE_HOST",
];

export function sandboxEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [...SANDBOX_FIELDS.map((field) => field.name), ...contextNames].map((name) => [name, env[name]]),
  );
}
