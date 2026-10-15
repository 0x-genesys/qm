const ITEM_KINDS = [
  "UserMessage",
  "SteeringMessage",
  "AgentMessage",
  "Reasoning",
  "ToolCall",
  "ToolResult",
  "Elicitation",
  "ElicitationResponse",
  "Wake",
  "Error",
  "ContextCompaction",
  "Retraction",
  "Stop",
  "RuntimeChange",
] as const;

type ItemKind = (typeof ITEM_KINDS)[number];

const WAKE_CAUSES = ["cron", "webhook", "child_done", "system"] as const;

const USER_ITEM_KINDS: readonly ItemKind[] = ["UserMessage", "SteeringMessage"];
const DELIVER_TOOL = "deliver";

const sqlList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(", ");

const USER_KINDS_SQL = `(${sqlList(USER_ITEM_KINDS)})`;

export const ITEMS_TABLES_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS qm_tenant(id UUID PRIMARY KEY)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS qm_tenant_singleton ON qm_tenant((true))`,
  `INSERT INTO qm_tenant(id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM qm_tenant)`,
  `CREATE TABLE IF NOT EXISTS qm_settings(
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `DO $item_kind$ BEGIN
     CREATE TYPE item_kind AS ENUM (${sqlList(ITEM_KINDS)});
   EXCEPTION WHEN duplicate_object THEN NULL; END $item_kind$`,
  `DO $wake_cause$ BEGIN
     CREATE TYPE wake_cause AS ENUM (${sqlList(WAKE_CAUSES)});
   EXCEPTION WHEN duplicate_object THEN NULL; END $wake_cause$`,
  `CREATE TABLE IF NOT EXISTS items(
     tenant_id UUID NOT NULL,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     seq BIGINT NOT NULL CHECK (seq >= 0),
     turn_id UUID,
     kind item_kind NOT NULL,
     author TEXT CHECK (author <> ''),
     call_id TEXT CHECK (call_id <> ''),
     elicit_id TEXT CHECK (elicit_id <> ''),
     wake_cause wake_cause,
     error_code TEXT CHECK (error_code <> ''),
     body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object' AND NOT body ? 'type'),
     created_at TIMESTAMPTZ NOT NULL,
     PRIMARY KEY (tenant_id, session_id, seq),
     CONSTRAINT items_call_id_kind CHECK ((call_id IS NOT NULL) = (kind IN ('ToolCall', 'ToolResult'))),
     CONSTRAINT items_elicit_id_kind CHECK ((elicit_id IS NOT NULL) = (kind IN ('Elicitation', 'ElicitationResponse'))),
     CONSTRAINT items_wake_cause_kind CHECK ((wake_cause IS NOT NULL) = (kind = 'Wake')),
     CONSTRAINT items_error_code_kind CHECK ((error_code IS NOT NULL) = (kind = 'Error')),
     CONSTRAINT items_author_kind CHECK (author IS NULL OR kind IN ('UserMessage', 'SteeringMessage', 'ElicitationResponse'))
   )`,
  `CREATE TABLE IF NOT EXISTS blobs(
     tenant_id UUID NOT NULL,
     sha256 BYTEA NOT NULL CHECK (length(sha256) = 32),
     size BIGINT NOT NULL CHECK (size >= 0),
     mime TEXT,
     storage_key TEXT NOT NULL CHECK (storage_key <> ''),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ,
     PRIMARY KEY (tenant_id, sha256)
   )`,
];

export interface ItemIndex {
  name: string;
  unique?: boolean;
  on: string;
}

export const ITEM_INDEXES: readonly ItemIndex[] = [
  {
    name: "items_one_call_per_kind",
    unique: true,
    on: `items(tenant_id, session_id, kind, call_id) WHERE call_id IS NOT NULL`,
  },
  { name: "items_by_turn", on: `items(tenant_id, turn_id, seq) WHERE turn_id IS NOT NULL` },
  { name: "items_by_elicit", on: `items(tenant_id, session_id, elicit_id) WHERE elicit_id IS NOT NULL` },
  { name: "items_session_created", on: `items(tenant_id, session_id, created_at)` },
  {
    name: "items_user_activity",
    on: `items(tenant_id, session_id, created_at DESC) WHERE kind IN ${USER_KINDS_SQL}`,
  },
  {
    name: "items_user_attributed",
    on: `items(tenant_id, session_id, created_at, seq)
           WHERE kind IN ${USER_KINDS_SQL} AND NOT (body @> '{"overheard":true}')`,
  },
  {
    name: "items_agent_reply",
    on: `items(tenant_id, session_id, created_at DESC)
           WHERE kind = 'AgentMessage' OR (kind = 'ToolCall' AND body ->> 'tool' = '${DELIVER_TOOL}')`,
  },
];

export function itemIndexSql(index: ItemIndex, opts: { concurrently?: boolean } = {}): string {
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${opts.concurrently ? "CONCURRENTLY " : ""}IF NOT EXISTS ${index.name} ON ${index.on}`;
}
