
-- 1. Settings table
CREATE TABLE IF NOT EXISTS public.database_maintenance_settings (
  table_key TEXT PRIMARY KEY,
  schema_name TEXT NOT NULL DEFAULT 'public',
  table_name TEXT NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days >= 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cleanup_rpc TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);
ALTER TABLE public.database_maintenance_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins read maintenance settings" ON public.database_maintenance_settings;
CREATE POLICY "Admins read maintenance settings" ON public.database_maintenance_settings
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.database_maintenance_settings (table_key, schema_name, table_name, retention_days, cleanup_rpc, description) VALUES
  ('pg_cron_history',           'cron',   'job_run_details',                7,  'cleanup_pg_cron_history',                'pg_cron history (cron.job_run_details)'),
  ('repricer_price_actions',    'public', 'repricer_price_actions',         30, 'cleanup_repricer_price_actions',         'Repricer price action history'),
  ('repricer_ai_decisions',     'public', 'repricer_ai_decisions',          30, 'cleanup_repricer_ai_decisions',          'Repricer AI decision logs'),
  ('repricer_competitor_snapshots','public','repricer_competitor_snapshots', 7, 'cleanup_repricer_competitor_snapshots',  'Competitor pricing snapshots'),
  ('repricer_dispatch_metrics', 'public', 'repricer_dispatch_metrics',      14, 'cleanup_repricer_dispatch_metrics',      'Repricer dispatch metrics'),
  ('repricer_simulation_items', 'public', 'repricer_simulation_items',      14, 'cleanup_repricer_simulation_items',      'Repricer simulation items'),
  ('repricer_suggestion_log',   'public', 'repricer_suggestion_log',        14, 'cleanup_repricer_suggestion_log',        'Repricer suggestion log')
ON CONFLICT (table_key) DO NOTHING;

-- 2. Alerts table
CREATE TABLE IF NOT EXISTS public.database_maintenance_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID
);
CREATE INDEX IF NOT EXISTS idx_dma_open ON public.database_maintenance_alerts(created_at DESC) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dma_kind ON public.database_maintenance_alerts(kind, created_at DESC);
ALTER TABLE public.database_maintenance_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins read alerts" ON public.database_maintenance_alerts;
CREATE POLICY "Admins read alerts" ON public.database_maintenance_alerts
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- 3. New cleanup RPCs
CREATE OR REPLACE FUNCTION public.cleanup_repricer_simulation_items(_keep_days INT DEFAULT 14)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_started TIMESTAMPTZ := now(); v_before BIGINT; v_after BIGINT; v_deleted BIGINT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT pg_total_relation_size('public.repricer_simulation_items'::regclass) INTO v_before;
  DELETE FROM public.repricer_simulation_items WHERE created_at < now() - make_interval(days => _keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT pg_total_relation_size('public.repricer_simulation_items'::regclass) INTO v_after;
  PERFORM public._log_maintenance_job('cleanup_repricer_simulation_items', jsonb_build_object('keep_days',_keep_days),
    'completed', v_started, v_deleted, v_before, v_after, NULL);
  RETURN jsonb_build_object('rows_deleted', v_deleted, 'before_bytes', v_before, 'after_bytes', v_after);
END; $$;

CREATE OR REPLACE FUNCTION public.cleanup_repricer_suggestion_log(_keep_days INT DEFAULT 14)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_started TIMESTAMPTZ := now(); v_before BIGINT; v_after BIGINT; v_deleted BIGINT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT pg_total_relation_size('public.repricer_suggestion_log'::regclass) INTO v_before;
  DELETE FROM public.repricer_suggestion_log WHERE created_at < now() - make_interval(days => _keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT pg_total_relation_size('public.repricer_suggestion_log'::regclass) INTO v_after;
  PERFORM public._log_maintenance_job('cleanup_repricer_suggestion_log', jsonb_build_object('keep_days',_keep_days),
    'completed', v_started, v_deleted, v_before, v_after, NULL);
  RETURN jsonb_build_object('rows_deleted', v_deleted, 'before_bytes', v_before, 'after_bytes', v_after);
END; $$;

-- 4. Estimate cleanup
CREATE OR REPLACE FUNCTION public.estimate_cleanup(_table_key TEXT, _keep_days INT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, cron AS $$
DECLARE v_setting public.database_maintenance_settings%ROWTYPE; v_cnt BIGINT; v_sql TEXT; v_total_size BIGINT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT * INTO v_setting FROM public.database_maintenance_settings WHERE table_key = _table_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown table_key: %', _table_key; END IF;
  IF v_setting.schema_name = 'cron' AND v_setting.table_name = 'job_run_details' THEN
    v_sql := format('SELECT count(*) FROM cron.job_run_details WHERE end_time < now() - make_interval(days => %s)', _keep_days);
  ELSE
    v_sql := format('SELECT count(*) FROM %I.%I WHERE created_at < now() - make_interval(days => %s)',
                    v_setting.schema_name, v_setting.table_name, _keep_days);
  END IF;
  EXECUTE v_sql INTO v_cnt;
  SELECT pg_total_relation_size(format('%I.%I', v_setting.schema_name, v_setting.table_name)::regclass) INTO v_total_size;
  RETURN jsonb_build_object('estimated_rows', v_cnt, 'current_total_bytes', v_total_size, 'table_key', _table_key);
END; $$;

-- 5. Update setting
CREATE OR REPLACE FUNCTION public.update_maintenance_setting(_table_key TEXT, _retention_days INT, _enabled BOOLEAN)
RETURNS public.database_maintenance_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.database_maintenance_settings%ROWTYPE;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF _retention_days < 1 THEN RAISE EXCEPTION 'retention_days must be >= 1'; END IF;
  UPDATE public.database_maintenance_settings
     SET retention_days = _retention_days, enabled = _enabled, updated_at = now(), updated_by = auth.uid()
   WHERE table_key = _table_key
   RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown table_key: %', _table_key; END IF;
  RETURN v_row;
END; $$;

-- 6. Acknowledge alert
CREATE OR REPLACE FUNCTION public.acknowledge_maintenance_alert(_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  UPDATE public.database_maintenance_alerts SET acknowledged_at = now(), acknowledged_by = auth.uid()
   WHERE id = _id AND acknowledged_at IS NULL;
END; $$;

-- 7. Internal helper to insert dedup-by-kind alert (no nested procedure)
CREATE OR REPLACE FUNCTION public._raise_maintenance_alert(_severity TEXT, _kind TEXT, _msg TEXT, _ctx JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_exists BIGINT;
BEGIN
  SELECT count(*) INTO v_exists FROM public.database_maintenance_alerts
   WHERE kind = _kind AND acknowledged_at IS NULL AND created_at > now() - interval '1 hour';
  IF v_exists = 0 THEN
    INSERT INTO public.database_maintenance_alerts(severity, kind, message, context)
    VALUES (_severity, _kind, _msg, COALESCE(_ctx, '{}'::jsonb));
  END IF;
END; $$;

-- 8. Health alert evaluator
CREATE OR REPLACE FUNCTION public.evaluate_health_alerts()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, cron AS $$
DECLARE
  v_db_bytes BIGINT; v_queue_backlog BIGINT := 0; v_failed_recent BIGINT := 0;
  v_setting public.database_maintenance_settings%ROWTYPE;
  v_dead BIGINT; v_live BIGINT; v_size BIGINT;
BEGIN
  SELECT pg_database_size(current_database()) INTO v_db_bytes;
  IF v_db_bytes > 6 * 1024 * 1024 * 1024 THEN
    PERFORM public._raise_maintenance_alert('critical', 'db_size_critical',
      format('Database size is %s (>6 GB). Run cleanup or VACUUM FULL.', pg_size_pretty(v_db_bytes)),
      jsonb_build_object('bytes', v_db_bytes));
  ELSIF v_db_bytes > 4 * 1024 * 1024 * 1024 THEN
    PERFORM public._raise_maintenance_alert('warn', 'db_size_warn',
      format('Database size is %s (>4 GB).', pg_size_pretty(v_db_bytes)),
      jsonb_build_object('bytes', v_db_bytes));
  END IF;

  FOR v_setting IN SELECT * FROM public.database_maintenance_settings LOOP
    BEGIN
      SELECT s.n_live_tup, s.n_dead_tup,
             pg_total_relation_size(format('%I.%I', v_setting.schema_name, v_setting.table_name)::regclass)
        INTO v_live, v_dead, v_size
        FROM pg_stat_all_tables s
       WHERE s.schemaname = v_setting.schema_name AND s.relname = v_setting.table_name;
      IF v_dead IS NULL THEN CONTINUE; END IF;
      IF v_dead > 100000 OR (v_live > 0 AND v_dead::float / GREATEST(v_live,1) > 0.5) THEN
        PERFORM public._raise_maintenance_alert('warn', 'table_bloat_' || v_setting.table_key,
          format('%s.%s has %s dead rows (size %s).', v_setting.schema_name, v_setting.table_name, v_dead, pg_size_pretty(v_size)),
          jsonb_build_object('table_key', v_setting.table_key, 'dead', v_dead, 'live', v_live, 'size', v_size));
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;

  BEGIN
    EXECUTE 'SELECT count(*) FROM public.inventory_refresh_queue WHERE status = ''pending''' INTO v_queue_backlog;
    IF v_queue_backlog > 5000 THEN
      PERFORM public._raise_maintenance_alert('warn', 'refresh_queue_backlog',
        format('Inventory refresh queue backlog is %s pending items.', v_queue_backlog),
        jsonb_build_object('backlog', v_queue_backlog));
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    SELECT count(*) INTO v_failed_recent FROM cron.job_run_details
     WHERE status = 'failed' AND end_time > now() - interval '24 hours';
    IF v_failed_recent > 10 THEN
      PERFORM public._raise_maintenance_alert('warn', 'cron_failures',
        format('%s failed cron runs in the last 24 hours.', v_failed_recent),
        jsonb_build_object('count', v_failed_recent));
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('db_bytes', v_db_bytes, 'queue_backlog', v_queue_backlog,
    'failed_cron_24h', v_failed_recent, 'evaluated_at', now());
END; $$;

-- 9. Nightly orchestrator
CREATE OR REPLACE FUNCTION public.run_nightly_maintenance()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, cron AS $$
DECLARE
  v_started TIMESTAMPTZ := now();
  v_setting public.database_maintenance_settings%ROWTYPE;
  v_total_deleted BIGINT := 0;
  v_results JSONB := '[]'::jsonb;
  v_one JSONB; v_sql TEXT;
  v_before BIGINT; v_after BIGINT; v_deleted BIGINT; v_err TEXT;
BEGIN
  FOR v_setting IN SELECT * FROM public.database_maintenance_settings WHERE enabled = TRUE ORDER BY table_key LOOP
    BEGIN
      SELECT pg_total_relation_size(format('%I.%I', v_setting.schema_name, v_setting.table_name)::regclass) INTO v_before;
      IF v_setting.schema_name = 'cron' AND v_setting.table_name = 'job_run_details' THEN
        v_sql := format('DELETE FROM cron.job_run_details WHERE end_time < now() - make_interval(days => %s)', v_setting.retention_days);
      ELSE
        v_sql := format('DELETE FROM %I.%I WHERE created_at < now() - make_interval(days => %s)',
                        v_setting.schema_name, v_setting.table_name, v_setting.retention_days);
      END IF;
      EXECUTE v_sql;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
      SELECT pg_total_relation_size(format('%I.%I', v_setting.schema_name, v_setting.table_name)::regclass) INTO v_after;
      INSERT INTO public.database_maintenance_jobs(
        action, params, status, triggered_by_email, started_at, finished_at, duration_ms,
        rows_affected, before_total_bytes, after_total_bytes
      ) VALUES (
        'nightly_cleanup_' || v_setting.table_key,
        jsonb_build_object('keep_days', v_setting.retention_days, 'source', 'nightly_cron'),
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
              jsonb_build_object('keep_days', v_setting.retention_days, 'source', 'nightly_cron'),
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
END; $$;

-- 10. Performance snapshot
CREATE OR REPLACE FUNCTION public.get_db_performance_snapshot()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, cron, pg_catalog AS $$
DECLARE v_connections JSONB; v_long JSONB; v_locks JSONB; v_failed_cron JSONB; v_queue BIGINT := 0; v_open_alerts JSONB;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('state', state, 'count', cnt)), '[]'::jsonb) INTO v_connections
    FROM (SELECT state, count(*) AS cnt FROM pg_stat_activity WHERE datname = current_database() GROUP BY state) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'pid', pid, 'state', state,
    'duration_seconds', EXTRACT(EPOCH FROM (now() - query_start))::int,
    'application_name', application_name, 'query', LEFT(query, 200)
  ) ORDER BY query_start ASC), '[]'::jsonb) INTO v_long
    FROM pg_stat_activity
   WHERE datname = current_database() AND state = 'active' AND query_start IS NOT NULL
     AND now() - query_start > interval '30 seconds' AND pid <> pg_backend_pid();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'blocked_pid', blocked_locks.pid, 'blocking_pid', blocking_locks.pid,
    'blocked_query', LEFT(blocked_activity.query, 200),
    'blocking_query', LEFT(blocking_activity.query, 200)
  )), '[]'::jsonb) INTO v_locks
    FROM pg_catalog.pg_locks blocked_locks
    JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
    JOIN pg_catalog.pg_locks blocking_locks
      ON blocking_locks.locktype = blocked_locks.locktype
     AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
     AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
     AND blocking_locks.pid <> blocked_locks.pid
    JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
   WHERE NOT blocked_locks.granted AND blocking_locks.granted;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'jobid', jobid, 'runid', runid, 'status', status,
    'start_time', start_time, 'end_time', end_time, 'return_message', LEFT(return_message, 200)
  ) ORDER BY end_time DESC), '[]'::jsonb) INTO v_failed_cron
    FROM (SELECT jobid, runid, status, start_time, end_time, return_message
            FROM cron.job_run_details
           WHERE status = 'failed' AND end_time > now() - interval '24 hours'
           ORDER BY end_time DESC LIMIT 5) t;

  BEGIN EXECUTE 'SELECT count(*) FROM public.inventory_refresh_queue WHERE status = ''pending''' INTO v_queue;
  EXCEPTION WHEN OTHERS THEN v_queue := 0; END;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'severity', severity, 'kind', kind, 'message', message, 'created_at', created_at
  ) ORDER BY created_at DESC), '[]'::jsonb) INTO v_open_alerts
    FROM (SELECT * FROM public.database_maintenance_alerts WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 20) a;

  RETURN jsonb_build_object('connections', v_connections, 'long_running_queries', v_long,
    'lock_waiters', v_locks, 'failed_cron_24h', v_failed_cron,
    'refresh_queue_backlog', v_queue, 'open_alerts', v_open_alerts, 'generated_at', now());
END; $$;

-- Grants
GRANT EXECUTE ON FUNCTION public.cleanup_repricer_simulation_items(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_repricer_suggestion_log(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.estimate_cleanup(TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_maintenance_setting(TEXT, INT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_maintenance_alert(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_db_performance_snapshot() TO authenticated;
