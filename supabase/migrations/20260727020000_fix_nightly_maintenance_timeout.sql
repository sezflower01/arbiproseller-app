-- Fixes the nightly maintenance cron (nightly-data-cleanup-0330), which has
-- been failing every night for at least the last several nights (confirmed
-- via cron.job_run_details): "ERROR: canceling statement due to statement
-- timeout" while deleting old rows from repricer_ai_decisions.
--
-- Root cause, confirmed:
--   1. The platform default statement_timeout for this session is 2 minutes.
--   2. repricer_ai_decisions had 1.6M+ rows overdue for its 30-day retention,
--      and repricer_price_actions had 1.7M+ rows overdue for its 14-day
--      retention -- both take longer than 2 minutes to delete in one shot.
--   3. PL/pgSQL's "EXCEPTION WHEN OTHERS" does NOT catch query_canceled
--      (the error class used for statement_timeout) -- this is documented
--      Postgres behavior, not a bug in this specific handler. So the
--      per-table exception block silently failed to catch it, the error
--      propagated out of the whole function, and the ENTIRE transaction
--      rolled back -- including any tables already cleaned earlier in the
--      same run. This is why the admin dashboard showed "Last successful
--      run: never" and "Last 30d: 0 B" reclaimed despite the cron firing
--      correctly every night.
--
-- Fix:
--   1. Extend statement_timeout to 30 minutes for the duration of this one
--      transaction only (SET LOCAL via set_config, resets automatically).
--      This is a background maintenance job with no interactive caller
--      waiting on it, so a longer budget is safe and appropriate -- unlike
--      changing the timeout globally, which stays untouched for every
--      other query/connection.
--   2. Explicitly catch query_canceled (in addition to OTHERS) per table,
--      so that even if some future backlog spike exceeds the new 30-minute
--      budget, only that one table fails gracefully with proper logging
--      and alerting -- not the whole night's progress silently vanishing.
--
-- All affected tables already have indexes on their retention timestamp
-- column and no foreign keys or delete-triggers reference them, so deletes
-- should complete well within the new budget.

CREATE OR REPLACE FUNCTION public.run_nightly_maintenance()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron'
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
  -- This transaction only -- does not affect the default timeout for any
  -- other query, connection, or role.
  PERFORM set_config('statement_timeout', '1800000', true);

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
