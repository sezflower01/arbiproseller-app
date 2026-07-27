-- Follow-up to 20260727020000. The previous fix used
-- `PERFORM set_config('statement_timeout', '1800000', true)` inside the
-- function body, expecting it to apply for the whole call. Live-tested via
-- a one-off cron run: 6 of 7 tables succeeded (2.77M rows deleted, where
-- before it was zero -- confirming the query_canceled catch works and
-- isolates one table's failure from rolling back the rest). But
-- repricer_ai_decisions still failed with "canceling statement due to
-- statement timeout" -- and the whole run completed in ~7.5 minutes total,
-- nowhere near the 30-minute budget that was supposedly set. That means
-- the in-body set_config call was not reliably taking effect for that
-- statement.
--
-- Fix: use a function-level SET clause instead (SET statement_timeout TO
-- '30min' as part of CREATE FUNCTION, alongside the existing SET
-- search_path clause). This is the Postgres-documented pattern for a
-- setting that's guaranteed to apply for the function's entire execution
-- and revert automatically afterward -- more reliable than calling
-- set_config() from inside the function body.
--
-- Confirmed via EXPLAIN and pg_stat_activity that repricer_ai_decisions'
-- retention DELETE uses its index correctly and isn't blocked by any
-- concurrent session -- it's simply a large, genuinely slow delete (likely
-- due to sizeable JSONB/text payloads per row), so it just needs the time
-- budget to actually apply.

CREATE OR REPLACE FUNCTION public.run_nightly_maintenance()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron'
 SET statement_timeout TO '30min'
AS $function$
DECLARE
  v_started TIMESTAMPTZ := now();
  v_setting public.database_maintenance_settings%ROWTYPE;
  v_total_deleted BIGINT := 0;
  v_results JSONB := '[]'::jsonb;
  v_one JSONB; v_sql TEXT;
  v_before BIGINT; v_after BIGINT; v_deleted BIGINT; v_err TEXT;
  v_ts_col TEXT;
BEGIN
  FOR v_setting IN SELECT * FROM public.database_maintenance_settings WHERE enabled = TRUE ORDER BY table_key LOOP
    BEGIN
      v_ts_col := COALESCE(NULLIF(v_setting.timestamp_column, ''), 'created_at');
      SELECT pg_total_relation_size(format('%I.%I', v_setting.schema_name, v_setting.table_name)::regclass) INTO v_before;
      v_sql := format('DELETE FROM %I.%I WHERE %I < now() - make_interval(days => %s)',
                      v_setting.schema_name, v_setting.table_name, v_ts_col, v_setting.retention_days);
      EXECUTE v_sql;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
      SELECT pg_total_relation_size(format('%I.%I', v_setting.schema_name, v_setting.table_name)::regclass) INTO v_after;
      INSERT INTO public.database_maintenance_jobs(
        action, params, status, triggered_by_email, started_at, finished_at, duration_ms,
        rows_affected, before_total_bytes, after_total_bytes
      ) VALUES (
        'nightly_cleanup_' || v_setting.table_key,
        jsonb_build_object('keep_days', v_setting.retention_days, 'ts_col', v_ts_col, 'source', 'nightly_cron'),
        'completed', 'cron@system', v_started, now(),
        GREATEST(0, EXTRACT(MILLISECONDS FROM (now() - v_started))::int),
        v_deleted, v_before, v_after
      );
      v_total_deleted := v_total_deleted + COALESCE(v_deleted, 0);
      v_one := jsonb_build_object('table', v_setting.table_key, 'rows_deleted', v_deleted, 'status', 'ok');
    EXCEPTION
      WHEN query_canceled THEN
        v_err := SQLERRM;
        INSERT INTO public.database_maintenance_jobs(action, params, status, triggered_by_email, started_at, finished_at, error_message)
        VALUES ('nightly_cleanup_' || v_setting.table_key,
                jsonb_build_object('keep_days', v_setting.retention_days, 'ts_col', v_ts_col, 'source', 'nightly_cron'),
                'failed', 'cron@system', v_started, now(), v_err);
        PERFORM public._raise_maintenance_alert('critical', 'nightly_cleanup_failed',
          format('Nightly cleanup failed for %s: %s', v_setting.table_key, v_err),
          jsonb_build_object('table_key', v_setting.table_key, 'error', v_err));
        v_one := jsonb_build_object('table', v_setting.table_key, 'status', 'failed', 'error', v_err);
      WHEN OTHERS THEN
        v_err := SQLERRM;
        INSERT INTO public.database_maintenance_jobs(action, params, status, triggered_by_email, started_at, finished_at, error_message)
        VALUES ('nightly_cleanup_' || v_setting.table_key,
                jsonb_build_object('keep_days', v_setting.retention_days, 'ts_col', v_ts_col, 'source', 'nightly_cron'),
                'failed', 'cron@system', v_started, now(), v_err);
        PERFORM public._raise_maintenance_alert('critical', 'nightly_cleanup_failed',
          format('Nightly cleanup failed for %s: %s', v_setting.table_key, v_err),
          jsonb_build_object('table_key', v_setting.table_key, 'error', v_err));
        v_one := jsonb_build_object('table', v_setting.table_key, 'status', 'failed', 'error', v_err);
    END;
    v_results := v_results || jsonb_build_array(v_one);
  END LOOP;

  INSERT INTO public.database_maintenance_jobs(action, params, status, triggered_by_email, started_at, finished_at, duration_ms, rows_affected)
  VALUES ('nightly_maintenance', jsonb_build_object('results', v_results), 'completed', 'cron@system', v_started, now(),
          GREATEST(0, EXTRACT(MILLISECONDS FROM (now() - v_started))::int), v_total_deleted);

  PERFORM public.evaluate_health_alerts();
  RETURN jsonb_build_object('total_deleted', v_total_deleted, 'results', v_results);
END; $function$;
