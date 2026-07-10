
-- ============================================================
-- Database Maintenance: jobs table + admin RPCs
-- ============================================================

-- 1. Maintenance jobs log
CREATE TABLE IF NOT EXISTS public.database_maintenance_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'completed', -- pending | running | completed | failed
  triggered_by UUID,
  triggered_by_email TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  rows_affected BIGINT,
  before_total_bytes BIGINT,
  after_total_bytes BIGINT,
  before_stats JSONB,
  after_stats JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dmj_created_at ON public.database_maintenance_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dmj_action ON public.database_maintenance_jobs(action, created_at DESC);

ALTER TABLE public.database_maintenance_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read maintenance jobs" ON public.database_maintenance_jobs;
CREATE POLICY "Admins read maintenance jobs"
ON public.database_maintenance_jobs
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- No INSERT/UPDATE/DELETE policy — only SECURITY DEFINER functions write.

-- 2. Database health snapshot
CREATE OR REPLACE FUNCTION public.get_database_health()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_total_bytes BIGINT;
  v_tables JSONB;
  v_last_cleanup JSONB;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  SELECT pg_database_size(current_database()) INTO v_total_bytes;

  WITH watched AS (
    SELECT * FROM (VALUES
      ('public','repricer_price_actions'),
      ('public','repricer_ai_decisions'),
      ('public','repricer_competitor_snapshots'),
      ('public','repricer_dispatch_metrics'),
      ('public','fba_inbound_fees'),
      ('public','financial_events_cache'),
      ('cron','job_run_details')
    ) AS t(schemaname, tablename)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', w.schemaname,
    'table', w.tablename,
    'total_bytes', COALESCE(pg_total_relation_size(format('%I.%I', w.schemaname, w.tablename)::regclass), 0),
    'live_rows', COALESCE(s.n_live_tup, 0),
    'dead_rows', COALESCE(s.n_dead_tup, 0),
    'last_vacuum', s.last_vacuum,
    'last_autovacuum', s.last_autovacuum,
    'last_analyze', s.last_analyze,
    'last_autoanalyze', s.last_autoanalyze
  ) ORDER BY pg_total_relation_size(format('%I.%I', w.schemaname, w.tablename)::regclass) DESC NULLS LAST), '[]'::jsonb)
  INTO v_tables
  FROM watched w
  LEFT JOIN pg_stat_all_tables s
    ON s.schemaname = w.schemaname AND s.relname = w.tablename;

  SELECT jsonb_build_object(
    'action', action,
    'status', status,
    'finished_at', finished_at,
    'rows_affected', rows_affected
  )
  INTO v_last_cleanup
  FROM public.database_maintenance_jobs
  WHERE action LIKE 'cleanup_%'
  ORDER BY created_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'total_db_bytes', v_total_bytes,
    'tables', v_tables,
    'last_cleanup', v_last_cleanup,
    'generated_at', now()
  );
END;
$$;

-- 3. Helper: log a maintenance job
CREATE OR REPLACE FUNCTION public._log_maintenance_job(
  _action TEXT,
  _params JSONB,
  _status TEXT,
  _started_at TIMESTAMPTZ,
  _rows_affected BIGINT,
  _before_bytes BIGINT,
  _after_bytes BIGINT,
  _error TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_email TEXT;
BEGIN
  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
  INSERT INTO public.database_maintenance_jobs(
    action, params, status, triggered_by, triggered_by_email,
    started_at, finished_at, duration_ms, rows_affected,
    before_total_bytes, after_total_bytes, error_message
  ) VALUES (
    _action, COALESCE(_params,'{}'::jsonb), _status, auth.uid(), v_email,
    _started_at, now(), GREATEST(0, EXTRACT(MILLISECONDS FROM (now() - _started_at))::int),
    _rows_affected, _before_bytes, _after_bytes, _error
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 4. Cleanup RPCs (one per table — DELETE only, no VACUUM)
CREATE OR REPLACE FUNCTION public.cleanup_pg_cron_history(_keep_days INT DEFAULT 7)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, cron AS $$
DECLARE v_started TIMESTAMPTZ := now(); v_before BIGINT; v_after BIGINT; v_deleted BIGINT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT pg_total_relation_size('cron.job_run_details'::regclass) INTO v_before;
  DELETE FROM cron.job_run_details WHERE end_time < now() - make_interval(days => _keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT pg_total_relation_size('cron.job_run_details'::regclass) INTO v_after;
  PERFORM public._log_maintenance_job('cleanup_pg_cron_history', jsonb_build_object('keep_days',_keep_days),
    'completed', v_started, v_deleted, v_before, v_after, NULL);
  RETURN jsonb_build_object('rows_deleted', v_deleted, 'before_bytes', v_before, 'after_bytes', v_after);
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_repricer_price_actions(_keep_days INT DEFAULT 30)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_started TIMESTAMPTZ := now(); v_before BIGINT; v_after BIGINT; v_deleted BIGINT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT pg_total_relation_size('public.repricer_price_actions'::regclass) INTO v_before;
  DELETE FROM public.repricer_price_actions WHERE created_at < now() - make_interval(days => _keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT pg_total_relation_size('public.repricer_price_actions'::regclass) INTO v_after;
  PERFORM public._log_maintenance_job('cleanup_repricer_price_actions', jsonb_build_object('keep_days',_keep_days),
    'completed', v_started, v_deleted, v_before, v_after, NULL);
  RETURN jsonb_build_object('rows_deleted', v_deleted, 'before_bytes', v_before, 'after_bytes', v_after);
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_repricer_ai_decisions(_keep_days INT DEFAULT 30)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_started TIMESTAMPTZ := now(); v_before BIGINT; v_after BIGINT; v_deleted BIGINT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT pg_total_relation_size('public.repricer_ai_decisions'::regclass) INTO v_before;
  DELETE FROM public.repricer_ai_decisions WHERE created_at < now() - make_interval(days => _keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT pg_total_relation_size('public.repricer_ai_decisions'::regclass) INTO v_after;
  PERFORM public._log_maintenance_job('cleanup_repricer_ai_decisions', jsonb_build_object('keep_days',_keep_days),
    'completed', v_started, v_deleted, v_before, v_after, NULL);
  RETURN jsonb_build_object('rows_deleted', v_deleted, 'before_bytes', v_before, 'after_bytes', v_after);
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_repricer_competitor_snapshots(_keep_days INT DEFAULT 7)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_started TIMESTAMPTZ := now(); v_before BIGINT; v_after BIGINT; v_deleted BIGINT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT pg_total_relation_size('public.repricer_competitor_snapshots'::regclass) INTO v_before;
  DELETE FROM public.repricer_competitor_snapshots WHERE created_at < now() - make_interval(days => _keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT pg_total_relation_size('public.repricer_competitor_snapshots'::regclass) INTO v_after;
  PERFORM public._log_maintenance_job('cleanup_repricer_competitor_snapshots', jsonb_build_object('keep_days',_keep_days),
    'completed', v_started, v_deleted, v_before, v_after, NULL);
  RETURN jsonb_build_object('rows_deleted', v_deleted, 'before_bytes', v_before, 'after_bytes', v_after);
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_repricer_dispatch_metrics(_keep_days INT DEFAULT 14)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_started TIMESTAMPTZ := now(); v_before BIGINT; v_after BIGINT; v_deleted BIGINT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT pg_total_relation_size('public.repricer_dispatch_metrics'::regclass) INTO v_before;
  DELETE FROM public.repricer_dispatch_metrics WHERE created_at < now() - make_interval(days => _keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT pg_total_relation_size('public.repricer_dispatch_metrics'::regclass) INTO v_after;
  PERFORM public._log_maintenance_job('cleanup_repricer_dispatch_metrics', jsonb_build_object('keep_days',_keep_days),
    'completed', v_started, v_deleted, v_before, v_after, NULL);
  RETURN jsonb_build_object('rows_deleted', v_deleted, 'before_bytes', v_before, 'after_bytes', v_after);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_database_health() TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_pg_cron_history(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_repricer_price_actions(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_repricer_ai_decisions(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_repricer_competitor_snapshots(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_repricer_dispatch_metrics(INT) TO authenticated;
