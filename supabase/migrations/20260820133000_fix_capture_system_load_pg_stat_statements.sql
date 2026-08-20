-- capture_system_load: schema-qualify pg_stat_statements.
--
-- The extension IS installed, in schema `extensions`. This function runs with
-- SET search_path TO 'public', 'pg_catalog', which does not include it, so the
-- unqualified reference could never resolve.
--
-- It went unnoticed for as long as the job has existed because the failure was
-- swallowed by the inner EXCEPTION handler: v_avg became NULL, the row still
-- inserted, and pg_cron recorded success. 120/120 runs "succeeded" in the two
-- hours before this was written.
--
-- Measured 2026-08-20: of 1,440 snapshots in the previous 24 hours, avg_query_ms_5m
-- was NULL on 1,440 of them. The metric had never once been captured.
--
-- Two changes, and the second matters as much as the first:
--   1. extensions.pg_stat_statements -- resolves regardless of search_path.
--   2. the handler now RAISEs a WARNING instead of failing silently. It still
--      degrades to NULL rather than breaking a per-minute job, but the next
--      person gets a log line instead of a column of nulls and a green tick.
--
-- Everything else is preserved byte-for-byte from the deployed definition.

CREATE OR REPLACE FUNCTION public.capture_system_load()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_active int;
  v_wait   int;
  v_avg    numeric;
BEGIN
  -- "active" = queries actually executing right now
  -- "waiting" = backends BLOCKED on Lock/LWLock/BufferPin/IO (NOT idle pool connections,
  --             NOT Client/Activity/Timeout/Extension which are normal background waits)
  SELECT count(*) FILTER (WHERE state = 'active'),
         count(*) FILTER (
           WHERE state = 'active'
             AND wait_event_type IN ('Lock','LWLock','BufferPin','IO')
         )
    INTO v_active, v_wait
    FROM pg_stat_activity
   WHERE datname = current_database()
     AND pid <> pg_backend_pid();

  BEGIN
    SELECT round(avg(mean_exec_time)::numeric, 2)
      INTO v_avg
      FROM extensions.pg_stat_statements
     WHERE calls > 0;
  EXCEPTION WHEN OTHERS THEN
    v_avg := NULL;
    RAISE WARNING 'capture_system_load: avg_query_ms_5m unavailable (%): %', SQLSTATE, SQLERRM;
  END;

  INSERT INTO public.system_load_snapshot(active_connections, waiting_queries, avg_query_ms_5m)
  VALUES (v_active, v_wait, v_avg);

  DELETE FROM public.system_load_snapshot WHERE captured_at < now() - interval '7 days';
END;
$function$;

-- Prove it resolves now, rather than trusting that it does. A NULL here means
-- the fix did not work and the next 1,440 rows would be null again.
DO $$
DECLARE
  v numeric;
BEGIN
  SELECT round(avg(mean_exec_time)::numeric, 2) INTO v
  FROM extensions.pg_stat_statements WHERE calls > 0;
  IF v IS NULL THEN
    RAISE EXCEPTION 'extensions.pg_stat_statements returned no average -- fix did not take';
  END IF;
  RAISE NOTICE 'capture_system_load fix verified: avg_query_ms_5m resolves to %', v;
END $$;
