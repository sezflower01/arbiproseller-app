-- Add per-table timestamp column for nightly cleanup
ALTER TABLE public.database_maintenance_settings
  ADD COLUMN IF NOT EXISTS timestamp_column TEXT NOT NULL DEFAULT 'created_at';

UPDATE public.database_maintenance_settings
SET timestamp_column = 'cycle_started_at'
WHERE table_key = 'repricer_dispatch_metrics';

UPDATE public.database_maintenance_settings
SET timestamp_column = 'end_time'
WHERE table_key = 'pg_cron_history';

-- Rebuild orchestrator to use configurable timestamp column
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
    EXCEPTION WHEN OTHERS THEN
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