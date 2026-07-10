
-- Fix bigint overflow in evaluate_health_alerts + add pg_cron history >250MB warning
CREATE OR REPLACE FUNCTION public.evaluate_health_alerts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron'
AS $function$
DECLARE
  v_db_bytes BIGINT; v_queue_backlog BIGINT := 0; v_failed_recent BIGINT := 0;
  v_setting public.database_maintenance_settings%ROWTYPE;
  v_dead BIGINT; v_live BIGINT; v_size BIGINT;
  v_pgcron_bytes BIGINT;
BEGIN
  SELECT pg_database_size(current_database()) INTO v_db_bytes;
  IF v_db_bytes > (6::bigint * 1024 * 1024 * 1024) THEN
    PERFORM public._raise_maintenance_alert('critical', 'db_size_critical',
      format('Database size is %s (>6 GB). Run cleanup or VACUUM FULL.', pg_size_pretty(v_db_bytes)),
      jsonb_build_object('bytes', v_db_bytes));
  ELSIF v_db_bytes > (4::bigint * 1024 * 1024 * 1024) THEN
    PERFORM public._raise_maintenance_alert('warn', 'db_size_warn',
      format('Database size is %s (>4 GB).', pg_size_pretty(v_db_bytes)),
      jsonb_build_object('bytes', v_db_bytes));
  END IF;

  -- pg_cron history specific warning
  BEGIN
    SELECT pg_total_relation_size('cron.job_run_details'::regclass) INTO v_pgcron_bytes;
    IF v_pgcron_bytes > (250::bigint * 1024 * 1024) THEN
      PERFORM public._raise_maintenance_alert('warn', 'pg_cron_history_large',
        format('cron.job_run_details is %s (>250 MB). Consider lowering retention.', pg_size_pretty(v_pgcron_bytes)),
        jsonb_build_object('bytes', v_pgcron_bytes));
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

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
END; $function$;

-- Growth stats: per-table size delta vs. snapshot from N hours ago, projected
CREATE TABLE IF NOT EXISTS public.database_size_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_db_bytes BIGINT NOT NULL,
  per_table JSONB NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE public.database_size_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins read snapshots" ON public.database_size_snapshots;
CREATE POLICY "admins read snapshots" ON public.database_size_snapshots
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE INDEX IF NOT EXISTS idx_db_size_snapshots_captured_at ON public.database_size_snapshots(captured_at DESC);

CREATE OR REPLACE FUNCTION public.capture_database_size_snapshot()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_total BIGINT; v_per JSONB;
BEGIN
  SELECT pg_database_size(current_database()) INTO v_total;
  SELECT jsonb_agg(jsonb_build_object(
    'schema', schemaname, 'table', relname,
    'bytes', pg_total_relation_size(format('%I.%I', schemaname, relname)::regclass)
  ))
  INTO v_per
  FROM pg_stat_all_tables
  WHERE schemaname IN ('public','cron')
    AND pg_total_relation_size(format('%I.%I', schemaname, relname)::regclass) > 1024*1024;
  INSERT INTO public.database_size_snapshots(total_db_bytes, per_table)
    VALUES (v_total, COALESCE(v_per, '[]'::jsonb));
  -- Keep ~30 days of snapshots
  DELETE FROM public.database_size_snapshots WHERE captured_at < now() - interval '30 days';
END; $$;

CREATE OR REPLACE FUNCTION public.get_db_growth_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_now BIGINT; v_then_total BIGINT; v_hours NUMERIC;
  v_then_per JSONB; v_top JSONB;
  v_then RECORD;
BEGIN
  SELECT pg_database_size(current_database()) INTO v_now;
  SELECT total_db_bytes, per_table, EXTRACT(EPOCH FROM (now() - captured_at))/3600
    INTO v_then_total, v_then_per, v_hours
  FROM public.database_size_snapshots
  WHERE captured_at < now() - interval '6 hours'
  ORDER BY captured_at DESC LIMIT 1;

  IF v_then_total IS NULL OR v_hours IS NULL OR v_hours = 0 THEN
    RETURN jsonb_build_object('available', false, 'current_bytes', v_now,
      'note', 'Need at least 6h of snapshots before growth is computed.');
  END IF;

  -- top growers
  WITH cur AS (
    SELECT (e->>'schema')||'.'||(e->>'table') AS tk, (e->>'bytes')::bigint AS b
    FROM (SELECT jsonb_array_elements(
      (SELECT per_table FROM public.database_size_snapshots ORDER BY captured_at DESC LIMIT 1)
    ) e) x
  ), prev AS (
    SELECT (e->>'schema')||'.'||(e->>'table') AS tk, (e->>'bytes')::bigint AS b
    FROM (SELECT jsonb_array_elements(v_then_per) e) y
  )
  SELECT jsonb_agg(jsonb_build_object('table', cur.tk,
                                      'delta_bytes', cur.b - COALESCE(prev.b,0),
                                      'current_bytes', cur.b)
                   ORDER BY (cur.b - COALESCE(prev.b,0)) DESC)
    INTO v_top
  FROM cur LEFT JOIN prev USING (tk)
  WHERE (cur.b - COALESCE(prev.b,0)) > 0
  LIMIT 5;

  RETURN jsonb_build_object(
    'available', true,
    'current_bytes', v_now,
    'reference_bytes', v_then_total,
    'reference_hours_ago', round(v_hours::numeric, 1),
    'bytes_per_day', round(((v_now - v_then_total)::numeric / GREATEST(v_hours,1)) * 24),
    'projected_30d_bytes', v_now + round(((v_now - v_then_total)::numeric / GREATEST(v_hours,1)) * 24 * 30)::bigint,
    'top_growers', COALESCE(v_top, '[]'::jsonb)
  );
END; $$;

-- Recommended retentions (heuristic)
CREATE OR REPLACE FUNCTION public.get_recommended_retentions()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_object_agg(table_key, recommended) FROM (
    SELECT 'pg_cron_history'::text AS table_key, 3 AS recommended
    UNION ALL SELECT 'repricer_price_actions', 14
    UNION ALL SELECT 'repricer_competitor_snapshots', 7
    UNION ALL SELECT 'repricer_dispatch_metrics', 7
    UNION ALL SELECT 'repricer_ai_decisions', 14
    UNION ALL SELECT 'repricer_simulation_items', 7
    UNION ALL SELECT 'repricer_suggestion_log', 7
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.get_db_growth_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_recommended_retentions() TO authenticated;
