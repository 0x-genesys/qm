export const retireLegacyParticipantActivity = [
  `DROP TRIGGER IF EXISTS participant_activity_entry_v3 ON public.session_entries`,
  `DROP FUNCTION IF EXISTS public.participant_activity_on_entry_v3()`,
];

export const payloadJsonbMigration = {
  id: "sessions/store/0033-payload-jsonb",
  statements: [
    `SET LOCAL lock_timeout = '3s'`,
    String.raw`CREATE OR REPLACE FUNCTION entry_payload_repair(t text) RETURNS jsonb
             LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $entry_payload_repair$
             DECLARE r text;
             BEGIN
               IF t IS NULL OR pg_input_is_valid(t, 'jsonb') THEN RETURN t::jsonb; END IF;
               r := regexp_replace(t, '(?<!\\)((?:\\\\)*)\\u0000', '\1', 'g');
               IF NOT pg_input_is_valid(r, 'jsonb') THEN
                 r := regexp_replace(regexp_replace(r,
                   '(?<!\\)((?:\\\\)*)\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})', '\1\\ufffd', 'g'),
                   '(?<!\\)((?:\\\\)*)(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}', '\1\\ufffd', 'g');
               END IF;
               RETURN r::jsonb;
             END $entry_payload_repair$`,
    `CREATE OR REPLACE FUNCTION entry_search_text(payload jsonb) RETURNS text
             LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $entry_search_text$
             SELECT CASE WHEN jsonb_typeof(payload -> 'text') = 'string' THEN payload ->> 'text'
                         WHEN jsonb_typeof(payload) = 'string' THEN payload #>> '{}' END
             $entry_search_text$`,
    `CREATE OR REPLACE FUNCTION sync_session_entry_search() RETURNS trigger
           LANGUAGE plpgsql AS $sync_session_entry_search$
           DECLARE body text;
           BEGIN
             IF TG_OP = 'DELETE' THEN
               DELETE FROM session_entry_search WHERE session_id = OLD.session_id AND seq = OLD.seq;
               RETURN OLD;
             END IF;
             IF TG_OP = 'UPDATE' AND (OLD.session_id, OLD.seq) IS DISTINCT FROM (NEW.session_id, NEW.seq) THEN
               DELETE FROM session_entry_search WHERE session_id = OLD.session_id AND seq = OLD.seq;
             END IF;
             IF NEW.type IN ('user', 'assistant', 'text') THEN
               body := entry_search_text(NEW.payload);
             END IF;
             IF body IS NULL OR btrim(body) = '' THEN
               DELETE FROM session_entry_search WHERE session_id = NEW.session_id AND seq = NEW.seq;
             ELSE
               INSERT INTO session_entry_search(session_id, seq, type, author, text, created_at)
               VALUES (NEW.session_id, NEW.seq, NEW.type,
                       CASE WHEN NEW.type = 'user' AND jsonb_typeof(NEW.payload -> 'name') = 'string'
                            THEN NEW.payload ->> 'name' END,
                       body, NEW.created_at)
               ON CONFLICT (session_id, seq) DO UPDATE
                 SET type = EXCLUDED.type, author = EXCLUDED.author, text = EXCLUDED.text,
                     created_at = EXCLUDED.created_at;
             END IF;
             RETURN NEW;
           END $sync_session_entry_search$`,
    `DO $payload_jsonb$
           BEGIN
             IF (SELECT atttypid FROM pg_attribute WHERE attrelid = 'session_entries'::regclass AND attname = 'payload')
                = 'jsonb'::regtype THEN
               RETURN;
             END IF;
             DROP TRIGGER IF EXISTS session_entries_search_write_through ON session_entries;
             DROP INDEX IF EXISTS session_entries_user_attributed;
             ALTER TABLE session_entries DROP COLUMN IF EXISTS search_tsv;
             ALTER TABLE session_entries ALTER COLUMN payload TYPE jsonb USING entry_payload_repair(payload);
             CREATE TRIGGER session_entries_search_write_through
               AFTER INSERT OR UPDATE OF payload, type, created_at, session_id, seq OR DELETE ON session_entries
               FOR EACH ROW EXECUTE FUNCTION sync_session_entry_search();
           END $payload_jsonb$`,
    ...retireLegacyParticipantActivity,
    `DROP FUNCTION IF EXISTS entry_search_text(text)`,
    `DROP FUNCTION IF EXISTS safe_json(text)`,
    `DROP FUNCTION IF EXISTS entry_payload_repair(text)`,
    `CREATE INDEX IF NOT EXISTS session_entries_user_attributed
             ON session_entries(session_id, created_at, seq)
             WHERE type = 'user' AND (payload IS NULL OR NOT payload @> '{"overheard":true}')`,
    `CREATE INDEX IF NOT EXISTS session_entries_context_markers
             ON session_entries(session_id, seq DESC)
             WHERE type = 'system' AND payload ->> 'kind' IN ('context_summary', 'memory_context')`,
  ],
};
