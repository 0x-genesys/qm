ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_last_activity bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_last_activity_seq integer;
CREATE OR REPLACE FUNCTION public.safe_jsonb(t text)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
AS $function$
        BEGIN
          RETURN t::jsonb;
        EXCEPTION WHEN others THEN
          BEGIN RETURN regexp_replace(t, '(^|[^\\])(\\\\)*(\\u0000)+', '\1\2', 'g')::jsonb;
          EXCEPTION WHEN others THEN RETURN NULL;
          END;
        END $function$;
CREATE OR REPLACE FUNCTION public.participant_activity_on_entry_v3()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
       BEGIN
         IF NEW.type = 'user' AND NOT COALESCE(safe_jsonb(NEW.payload) @> '{"overheard":true}'::jsonb, FALSE) THEN
           UPDATE sessions
              SET user_last_activity = NEW.created_at, user_last_activity_seq = NEW.seq
            WHERE id = NEW.session_id;
           IF NOT FOUND THEN RAISE EXCEPTION 'session % does not exist', NEW.session_id USING ERRCODE = 'foreign_key_violation'; END IF;
         END IF;
         RETURN NEW;
       END $function$;
CREATE TRIGGER participant_activity_entry_v3 AFTER INSERT ON public.session_entries
 FOR EACH ROW EXECUTE FUNCTION participant_activity_on_entry_v3();
