
-- 1) Resolve stale alerts inside evaluate_health_alerts before raising new ones.
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

  -- Auto-acknowledge DB-size alerts when no longer applicable
  IF v_db_bytes <= (6::bigint * 1024 * 1024 * 1024) THEN
    UPDATE public.database_maintenance_alerts
       SET acknowledged_at = now()
     WHERE kind = 'db_size_critical' AND acknowledged_at IS NULL;
  END IF;
  IF v_db_bytes <= (4::bigint * 1024 * 1024 * 1024) THEN
    UPDATE public.database_maintenance_alerts
       SET acknowledged_at = now()
     WHERE kind = 'db_size_warn' AND acknowledged_at IS NULL;
  END IF;

  IF v_db_bytes > (6::bigint * 1024 * 1024 * 1024) THEN
    PERFORM public._raise_maintenance_alert('critical', 'db_size_critical',
      format('Database size is %s (>6 GB). Run cleanup or VACUUM FULL.', pg_size_pretty(v_db_bytes)),
      jsonb_build_object('bytes', v_db_bytes));
  ELSIF v_db_bytes > (4::bigint * 1024 * 1024 * 1024) THEN
    PERFORM public._raise_maintenance_alert('warn', 'db_size_warn',
      format('Database size is %s (>4 GB).', pg_size_pretty(v_db_bytes)),
      jsonb_build_object('bytes', v_db_bytes));
  END IF;

  -- pg_cron history specific warning + auto-ack
  BEGIN
    SELECT pg_total_relation_size('cron.job_run_details'::regclass) INTO v_pgcron_bytes;
    IF v_pgcron_bytes <= (250::bigint * 1024 * 1024) THEN
      UPDATE public.database_maintenance_alerts
         SET acknowledged_at = now()
       WHERE kind = 'pg_cron_history_large' AND acknowledged_at IS NULL;
    ELSE
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
      ELSE
        UPDATE public.database_maintenance_alerts
           SET acknowledged_at = now()
         WHERE kind = 'table_bloat_' || v_setting.table_key AND acknowledged_at IS NULL;
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
    ELSE
      UPDATE public.database_maintenance_alerts
         SET acknowledged_at = now()
       WHERE kind = 'refresh_queue_backlog' AND acknowledged_at IS NULL;
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
    ELSE
      UPDATE public.database_maintenance_alerts
         SET acknowledged_at = now()
       WHERE kind = 'cron_failures' AND acknowledged_at IS NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('db_bytes', v_db_bytes, 'queue_backlog', v_queue_backlog,
    'failed_cron_24h', v_failed_recent, 'evaluated_at', now());
END; $function$;

-- 2) Growth stats: clamp negatives, ignore baseline taken before a recent shrink event
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
  v_last_shrink TIMESTAMPTZ;
  v_bytes_per_day NUMERIC; v_projected BIGINT;
BEGIN
  SELECT pg_database_size(current_database()) INTO v_now;

  -- Find most recent significant shrink event (VACUUM FULL completed OR nightly cleanup that freed >100MB).
  SELECT MAX(finished_at) INTO v_last_shrink
    FROM public.database_maintenance_jobs
   WHERE status = 'completed'
     AND finished_at > now() - interval '30 days'
     AND (
       action LIKE 'vacuum_full:%'
       OR (before_total_bytes IS NOT NULL AND after_total_bytes IS NOT NULL
           AND (before_total_bytes - after_total_bytes) > (100::bigint * 1024 * 1024))
     );

  SELECT total_db_bytes, per_table, EXTRACT(EPOCH FROM (now() - captured_at))/3600
    INTO v_then_total, v_then_per, v_hours
  FROM public.database_size_snapshots
  WHERE captured_at < now() - interval '6 hours'
    AND (v_last_shrink IS NULL OR captured_at > v_last_shrink)
  ORDER BY captured_at DESC LIMIT 1;

  IF v_then_total IS NULL OR v_hours IS NULL OR v_hours = 0 THEN
    RETURN jsonb_build_object('available', false, 'current_bytes', v_now,
      'note', CASE
                WHEN v_last_shrink IS NOT NULL
                  THEN 'Re-baselining after recent cleanup/VACUUM FULL. Growth resumes once 6h of new snapshots accrue.'
                ELSE 'Need at least 6h of snapshots before growth is computed.'
              END,
      'baseline_reset_at', v_last_shrink);
  END IF;

  -- top growers (clamp to non-negative deltas)
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

  v_bytes_per_day := GREATEST(0, round(((v_now - v_then_total)::numeric / GREATEST(v_hours,1)) * 24));
  v_projected := v_now + (v_bytes_per_day * 30)::bigint;

  RETURN jsonb_build_object(
    'available', true,
    'current_bytes', v_now,
    'reference_bytes', v_then_total,
    'reference_hours_ago', round(v_hours::numeric, 1),
    'bytes_per_day', v_bytes_per_day,
    'projected_30d_bytes', v_projected,
    'baseline_reset_at', v_last_shrink,
    'top_growers', COALESCE(v_top, '[]'::jsonb)
  );
END; $$;

-- 3) Last VACUUM FULL per table (from job log)
CREATE OR REPLACE FUNCTION public.get_last_vacuum_full_per_table()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(jsonb_object_agg(tbl, last_at), '{}'::jsonb) FROM (
    SELECT split_part(action, ':', 2) AS tbl, MAX(finished_at) AS last_at
      FROM public.database_maintenance_jobs
     WHERE action LIKE 'vacuum_full:%' AND status = 'completed'
     GROUP BY split_part(action, ':', 2)
  ) t;
$$;

-- 4) DB size history (for trend chart)
CREATE OR REPLACE FUNCTION public.get_db_size_history(_days INT DEFAULT 14)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'captured_at', captured_at,
    'total_db_bytes', total_db_bytes
  ) ORDER BY captured_at), '[]'::jsonb)
  FROM public.database_size_snapshots
  WHERE captured_at > now() - make_interval(days => _days);
$$;

-- 5) Health score (Excellent/Healthy/Warning/Critical)
CREATE OR REPLACE FUNCTION public.get_db_health_score()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'cron'
AS $$
DECLARE
  v_db_bytes BIGINT;
  v_critical INT := 0; v_warn INT := 0;
  v_max_bloat NUMERIC := 0;
  v_queue BIGINT := 0; v_failed BIGINT := 0;
  v_score INT := 100; v_label TEXT;
BEGIN
  SELECT pg_database_size(current_database()) INTO v_db_bytes;

  SELECT count(*) FILTER (WHERE severity = 'critical'),
         count(*) FILTER (WHERE severity = 'warn')
    INTO v_critical, v_warn
    FROM public.database_maintenance_alerts
   WHERE acknowledged_at IS NULL;

  -- Worst table bloat
  SELECT COALESCE(MAX(CASE WHEN (n_live_tup + n_dead_tup) > 0
                            THEN n_dead_tup::numeric / (n_live_tup + n_dead_tup) * 100
                            ELSE 0 END), 0)
    INTO v_max_bloat
    FROM pg_stat_all_tables
   WHERE schemaname IN ('public','cron');

  BEGIN
    EXECUTE 'SELECT count(*) FROM public.inventory_refresh_queue WHERE status = ''pending''' INTO v_queue;
  EXCEPTION WHEN OTHERS THEN v_queue := 0; END;

  BEGIN
    SELECT count(*) INTO v_failed FROM cron.job_run_details
     WHERE status = 'failed' AND end_time > now() - interval '24 hours';
  EXCEPTION WHEN OTHERS THEN v_failed := 0; END;

  -- Deductions
  IF v_db_bytes > (6::bigint * 1024 * 1024 * 1024) THEN v_score := v_score - 30;
  ELSIF v_db_bytes > (4::bigint * 1024 * 1024 * 1024) THEN v_score := v_score - 15;
  ELSIF v_db_bytes > (2::bigint * 1024 * 1024 * 1024) THEN v_score := v_score - 5;
  END IF;

  v_score := v_score - LEAST(40, v_critical * 20);
  v_score := v_score - LEAST(20, v_warn * 5);

  IF v_max_bloat > 50 THEN v_score := v_score - 15;
  ELSIF v_max_bloat > 25 THEN v_score := v_score - 5;
  END IF;

  IF v_queue > 5000 THEN v_score := v_score - 10; END IF;
  IF v_failed > 10 THEN v_score := v_score - 10; END IF;

  v_score := GREATEST(0, LEAST(100, v_score));

  v_label := CASE
    WHEN v_score >= 90 THEN 'Excellent'
    WHEN v_score >= 75 THEN 'Healthy'
    WHEN v_score >= 50 THEN 'Warning'
    ELSE 'Critical'
  END;

  RETURN jsonb_build_object(
    'score', v_score,
    'label', v_label,
    'db_bytes', v_db_bytes,
    'open_critical', v_critical,
    'open_warn', v_warn,
    'max_bloat_pct', round(v_max_bloat, 1),
    'queue_backlog', v_queue,
    'failed_cron_24h', v_failed
  );
END; $$;

-- 6) Cleanup savings metrics
CREATE OR REPLACE FUNCTION public.get_cleanup_savings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH per_action AS (
    SELECT
      CASE WHEN action LIKE 'vacuum_full:%' THEN 'vacuum_full' ELSE 'cleanup' END AS bucket,
      GREATEST(0, COALESCE(before_total_bytes,0) - COALESCE(after_total_bytes,0)) AS reclaimed,
      COALESCE(rows_affected, 0) AS rows_deleted,
      finished_at
    FROM public.database_maintenance_jobs
    WHERE status = 'completed'
      AND before_total_bytes IS NOT NULL
      AND after_total_bytes IS NOT NULL
  )
  SELECT jsonb_build_object(
    'total_reclaimed_bytes', COALESCE(SUM(reclaimed), 0),
    'total_rows_deleted', COALESCE(SUM(rows_deleted), 0),
    'reclaimed_last_30d', COALESCE(SUM(reclaimed) FILTER (WHERE finished_at > now() - interval '30 days'), 0),
    'reclaimed_by_vacuum_full', COALESCE(SUM(reclaimed) FILTER (WHERE bucket = 'vacuum_full'), 0),
    'reclaimed_by_cleanup', COALESCE(SUM(reclaimed) FILTER (WHERE bucket = 'cleanup'), 0)
  ) FROM per_action;
$$;

GRANT EXECUTE ON FUNCTION public.get_last_vacuum_full_per_table() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_db_size_history(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_db_health_score() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cleanup_savings() TO authenticated;
