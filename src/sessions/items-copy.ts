export const ITEMS_COPY_DEFAULT_BUCKETS = 32;

export interface ItemsCopyOptions {
  delta?: boolean;
}
const itemsBucketPredicate = (col: string): string =>
  `((hashtextextended(${col}, 0) % $2::bigint) + $2::bigint) % $2::bigint = $1::bigint`;

const TENANT = `(SELECT id FROM qm_tenant)`;
const escapedKey = (key: string): string =>
  `(ltrim(${key}, '$') = 'type' OR (${key} LIKE '$%' AND ltrim(${key}, '$') = 'blobs'))`;
const NO_KEYS = `ARRAY[]::text[]`;

const PARSE = String.raw`  CROSS JOIN LATERAL (SELECT pg_input_is_valid(e.payload, 'jsonb') IS TRUE AS valid OFFSET 0) checked
  CROSS JOIN LATERAL (
    SELECT CASE WHEN NOT checked.valid THEN regexp_replace(e.payload, '(?<!\\)((?:\\\\)*)\\u0000', '\1', 'g') END AS denul
    OFFSET 0
  ) cleaned
  CROSS JOIN LATERAL (
    SELECT CASE WHEN NOT checked.valid AND NOT pg_input_is_valid(cleaned.denul, 'jsonb')
                THEN regexp_replace(regexp_replace(cleaned.denul, '(?<!\\)((?:\\\\)*)\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})', '\1\\ufffd', 'g'),
                                    '(?<!\\)((?:\\\\)*)(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}', '\1\\ufffd', 'g') END AS desurrogated
    OFFSET 0
  ) repaired
  CROSS JOIN LATERAL (
    SELECT CASE WHEN checked.valid THEN e.payload::jsonb
                WHEN e.payload IS NULL THEN NULL
                WHEN pg_input_is_valid(cleaned.denul, 'jsonb') THEN cleaned.denul::jsonb
                WHEN pg_input_is_valid(repaired.desurrogated, 'jsonb') THEN repaired.desurrogated::jsonb
                ELSE to_jsonb(e.payload)
           END AS j
    OFFSET 0
  ) parsed
  CROSS JOIN LATERAL (
    SELECT CASE WHEN parsed.j IS NULL OR jsonb_typeof(parsed.j) = 'null' THEN '{}'::jsonb
                WHEN jsonb_typeof(parsed.j) = 'object' THEN parsed.j
                WHEN jsonb_typeof(parsed.j) = 'string' THEN jsonb_build_object('text', parsed.j)
                ELSE jsonb_build_object('value', parsed.j)
           END AS body
    OFFSET 0
  ) n
`;

const MAP = `  CROSS JOIN LATERAL (
    SELECT (CASE e.type
              WHEN 'user' THEN CASE WHEN n.body @> '{"steered":true}' THEN 'SteeringMessage' ELSE 'UserMessage' END
              WHEN 'assistant' THEN 'AgentMessage'
              WHEN 'text' THEN 'AgentMessage'
              WHEN 'delivery' THEN 'AgentMessage'
              WHEN 'thinking' THEN 'Reasoning'
              WHEN 'tool_call' THEN 'ToolCall'
              WHEN 'tool_result' THEN 'ToolResult'
              WHEN 'approval_request' THEN 'Elicitation'
              WHEN 'approval_resolved' THEN 'ElicitationResponse'
              WHEN 'soul' THEN NULL
              WHEN 'text_start' THEN NULL
              WHEN 'system' THEN
                CASE n.body ->> 'kind'
                  WHEN 'context_summary' THEN 'ContextCompaction'
                  WHEN 'turn_failure' THEN 'Error'
                  WHEN 'wake' THEN 'Wake'
                  WHEN 'message_revision' THEN 'Retraction'
                  WHEN 'goal' THEN NULL
                  WHEN 'memory_context' THEN NULL
                  WHEN 'file_event' THEN NULL
                  ELSE 'unmapped system entry kind=' || COALESCE(n.body ->> 'kind', '(none)') || ' at '
                       || e.session_id || '/' || e.seq
                END
              ELSE 'unmapped entry type=' || e.type || ' at ' || e.session_id || '/' || e.seq
            END)::item_kind AS kind
    OFFSET 0
  ) k
  LEFT JOIN legacy_tape_steps l ON l.session_id = e.session_id AND l.seq = e.seq
  CROSS JOIN LATERAL (
    SELECT n.body
             - 'securityTainted'
             - CASE WHEN e.type = 'assistant' OR k.kind = 'Error' THEN ARRAY['deliveryKey'] ELSE ${NO_KEYS} END
             - CASE WHEN e.type = 'tool_result' AND jsonb_typeof(n.body -> 'result') = 'string'
                    THEN ARRAY(SELECT f FROM unnest(ARRAY['stdout', 'stderr']) f
                                WHERE jsonb_typeof(n.body -> f) = 'string'
                                  AND strpos(n.body ->> 'result', n.body ->> f) > 0)
                    ELSE ${NO_KEYS} END
             || CASE e.type WHEN 'text' THEN '{"variant":"narration"}'::jsonb
                            WHEN 'delivery' THEN '{"variant":"files_delivered"}'::jsonb
                            ELSE '{}'::jsonb END
             || CASE WHEN l.step IS NOT NULL AND NOT n.body ? 'step' THEN jsonb_build_object('step', l.step)
                     ELSE '{}'::jsonb END
             || CASE WHEN l.wire IS NOT NULL AND NOT n.body ? 'wire' THEN jsonb_build_object('wire', l.wire)
                     ELSE '{}'::jsonb END AS body
  ) x
`;

const COLUMNS = `tenant_id, session_id, seq, turn_id, kind, author, call_id, elicit_id, wake_cause, error_code, body, created_at`;

const SELECT = `SELECT ${TENANT}, e.session_id, e.seq,
       CASE WHEN pg_input_is_valid(n.body ->> 'runId', 'uuid') THEN (n.body ->> 'runId')::uuid END,
       k.kind,
       NULL,
       CASE WHEN k.kind IN ('ToolCall', 'ToolResult') THEN
         COALESCE(NULLIF(CASE WHEN jsonb_typeof(n.body -> 'callId') = 'string' THEN n.body ->> 'callId' END, ''),
                  'missing-call:' || e.seq) END,
       CASE WHEN k.kind IN ('Elicitation', 'ElicitationResponse') THEN
         COALESCE(NULLIF(CASE WHEN jsonb_typeof(n.body -> 'requestId') = 'string' THEN n.body ->> 'requestId' END, ''),
                  'missing-elicit:' || e.seq) END,
       CASE WHEN k.kind = 'Wake' THEN
         CASE WHEN n.body ? 'cause' THEN (n.body ->> 'cause')::wake_cause ELSE 'system'::wake_cause END END,
       CASE WHEN k.kind = 'Error' THEN 'turn_failure' END,
       CASE WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(x.body) key WHERE ${escapedKey("key")}) THEN
         (SELECT jsonb_object_agg(CASE WHEN ${escapedKey("f.key")} THEN '$' || f.key ELSE f.key END, f.value)
            FROM jsonb_each(x.body) f)
         ELSE x.body END,
       to_timestamp(e.created_at / 1000.0)`;

export function itemsCopySql(opts: ItemsCopyOptions = {}): string {
  const from = opts.delta
    ? `  FROM sessions s
  CROSS JOIN LATERAL (
    SELECT COALESCE(max(i.seq), -1) AS seq FROM items i WHERE i.tenant_id = ${TENANT} AND i.session_id = s.id
  ) copied
  CROSS JOIN LATERAL (
    SELECT * FROM session_entries d WHERE d.session_id = s.id AND d.seq > copied.seq OFFSET 0
  ) e
`
    : `  FROM session_entries e
`;
  const where = opts.delta ? itemsBucketPredicate("s.id") : itemsBucketPredicate("e.session_id");
  return `INSERT INTO items(${COLUMNS})
${SELECT}
${from}${PARSE}${MAP} WHERE ${where}
   AND k.kind IS NOT NULL`;
}
export const ITEMS_BUCKET_DELETE_SQL = `DELETE FROM items WHERE tenant_id = ${TENANT} AND ${itemsBucketPredicate("session_id")}`;

export function itemsBucketParams(bucket: number, buckets: number): [number, number] {
  if (!Number.isInteger(buckets) || buckets < 1) throw new Error(`items copy: invalid bucket count ${buckets}`);
  if (!Number.isInteger(bucket) || bucket < 0 || bucket >= buckets)
    throw new Error(`items copy: bucket ${bucket} is outside 0..${buckets - 1}`);
  return [bucket, buckets];
}
