import type { EntryType, ScopeId, SessionEntry } from "../types.ts";
import { isObj } from "../util/objects.ts";
import { DELIVER_TOOL, type ItemKind, WAKE_CAUSES } from "./items-schema.ts";

type WakeCause = (typeof WAKE_CAUSES)[number];

export interface ItemRow {
  kind: ItemKind;
  turnId: string | null;
  author: string | null;
  callId: string | null;
  elicitId: string | null;
  wakeCause: WakeCause | null;
  errorCode: string | null;
  body: Record<string, unknown>;
}

export interface ItemContext {
  turnId?: string | null;
  author?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function itemTurnId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

function bodyOf(payload: unknown): Record<string, unknown> {
  if (isObj(payload) && !Array.isArray(payload)) return payload;
  if (typeof payload === "string") return { text: payload };
  return payload === null || payload === undefined ? {} : { value: payload };
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

const ESCAPED_KEY = /^\$*type$|^\$+blobs$/;
const UNESCAPED_KEY = /^\$+type$|^\$\$+blobs$/;

function escapeKeys(body: Record<string, unknown>): Record<string, unknown> {
  if (!Object.keys(body).some((key) => ESCAPED_KEY.test(key))) return body;
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [ESCAPED_KEY.test(key) ? `$${key}` : key, value]),
  );
}

function unescapeKeys(body: Record<string, unknown>): Record<string, unknown> {
  if (!Object.keys(body).some((key) => UNESCAPED_KEY.test(key))) return body;
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [UNESCAPED_KEY.test(key) ? key.slice(1) : key, value]),
  );
}

const AUTHORED_KINDS: ReadonlySet<ItemKind> = new Set(["UserMessage", "SteeringMessage", "ElicitationResponse"]);

function systemKind(body: Record<string, unknown>): Pick<ItemRow, "kind" | "wakeCause" | "errorCode"> {
  const none = { wakeCause: null, errorCode: null };
  switch (body.kind) {
    case "context_summary":
      return { kind: "ContextCompaction", ...none };
    case "turn_failure":
      return { kind: "Error", wakeCause: null, errorCode: "turn_failure" };
    case "message_revision":
      return { kind: "Retraction", ...none };
    case "wake": {
      if (body.cause === undefined) return { kind: "Wake", wakeCause: "system", errorCode: null };
      const cause = WAKE_CAUSES.find((value) => value === body.cause);
      if (cause) return { kind: "Wake", wakeCause: cause, errorCode: null };
      throw new Error(`items: wake cause ${String(body.cause)} is not a wake_cause`);
    }
    case "goal_cancelled":
      return { kind: "Wake", wakeCause: "system", errorCode: null };
    default:
      throw new Error(`items: system entry kind ${String(body.kind)} has no item kind`);
  }
}

function required(type: EntryType, key: string, value: unknown): string {
  if (typeof value === "string" && value) return value;
  throw new Error(`items: ${type} entry has no ${key}`);
}

export function itemFromEntry(type: EntryType, payload: unknown, context: ItemContext = {}): ItemRow {
  const raw = bodyOf(payload);
  const body = escapeKeys(raw);
  const row = (kind: ItemKind, extra: Partial<ItemRow> = {}): ItemRow => ({
    kind,
    turnId: itemTurnId(context.turnId) ?? itemTurnId(raw.runId),
    author: AUTHORED_KINDS.has(kind) ? str(context.author) : null,
    callId: null,
    elicitId: null,
    wakeCause: null,
    errorCode: null,
    body,
    ...extra,
  });
  switch (type) {
    case "user":
      return row(raw.steered === true ? "SteeringMessage" : "UserMessage");
    case "assistant":
      return row("AgentMessage");
    case "text":
      return row("AgentMessage", { body: { ...body, variant: "narration" } });
    case "thinking":
      return row("Reasoning");
    case "tool_call":
      return row("ToolCall", { callId: required(type, "callId", raw.callId) });
    case "tool_result":
      return row("ToolResult", { callId: required(type, "callId", raw.callId) });
    case "approval_request":
      return row("Elicitation", { elicitId: required(type, "requestId", raw.requestId) });
    case "approval_resolved":
      return row("ElicitationResponse", { elicitId: required(type, "requestId", raw.requestId) });
    case "system":
      return row("Wake", systemKind(raw));
    default:
      throw new Error(`items: entry type ${type} is not stored`);
  }
}

const AGENT_VARIANT_TYPES: Record<string, EntryType> = { narration: "text", files_delivered: "delivery" };

function entryType(kind: ItemKind, body: Record<string, unknown>): EntryType {
  switch (kind) {
    case "UserMessage":
    case "SteeringMessage":
      return "user";
    case "AgentMessage":
      return typeof body.variant === "string" ? (AGENT_VARIANT_TYPES[body.variant] ?? "assistant") : "assistant";
    case "Reasoning":
      return "thinking";
    case "ToolCall":
      return "tool_call";
    case "ToolResult":
      return "tool_result";
    case "Elicitation":
      return "approval_request";
    case "ElicitationResponse":
      return "approval_resolved";
    default:
      return "system";
  }
}

export function entryFromItem(row: {
  sessionId: string;
  seq: number;
  kind: ItemKind;
  body: Record<string, unknown>;
  scopeLabel: ScopeId;
  createdAt: number;
}): SessionEntry {
  const type = entryType(row.kind, row.body);
  let payload: Record<string, unknown> = unescapeKeys(row.body);
  if (row.kind === "AgentMessage" && "variant" in payload) {
    const { variant: _variant, ...rest } = payload;
    payload = rest;
  }
  return {
    sessionId: row.sessionId,
    seq: row.seq,
    parentSeq: row.seq === 0 ? null : row.seq - 1,
    type,
    payload,
    scopeLabel: row.scopeLabel,
    createdAt: row.createdAt,
  };
}

export function isDeliveryEntry(entry: Pick<SessionEntry, "type" | "payload">): boolean {
  return (
    (entry.type === "tool_call" || entry.type === "tool_result") &&
    (entry.payload as { tool?: unknown } | null)?.tool === DELIVER_TOOL
  );
}

export function isDeliveryCall(entry: Pick<SessionEntry, "type" | "payload">): boolean {
  return entry.type === "tool_call" && isDeliveryEntry(entry);
}

export const USER_KINDS = "('UserMessage', 'SteeringMessage')";
const DELIVERY_ITEM = (col: string): string =>
  `(${col}.kind = 'ToolCall' AND ${col}.body ->> 'tool' = '${DELIVER_TOOL}')`;
export const AGENT_REPLY_ITEM = (col: string): string => `(${col}.kind = 'AgentMessage' OR ${DELIVERY_ITEM(col)})`;
export const SEARCHABLE_ITEM = (col: string): string =>
  `(${col}.kind IN ('UserMessage', 'SteeringMessage') OR (${col}.kind = 'AgentMessage' AND ${col}.body ->> 'variant' IS DISTINCT FROM 'files_delivered') OR ${DELIVERY_ITEM(col)}) AND jsonb_typeof(${col}.body -> 'text') = 'string'`;
export const searchTypeExpr = (col: string): string =>
  `CASE WHEN ${col}.kind IN ${USER_KINDS} THEN 'user' WHEN ${col}.body ->> 'variant' = 'narration' THEN 'text' ELSE 'assistant' END`;

export const msOf = (col: string): string => `(EXTRACT(EPOCH FROM ${col}) * 1000)::bigint`;
