
-- Smarter health score: ignore tiny tables for bloat, count only unresolved cron failures
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

  -- Worst bloat — only meaningful tables (>= 1 MB and >= 1000 rows)
  SELECT COALESCE(MAX(CASE WHEN (n_live_tup + n_dead_tup) > 0
                            THEN n_dead_tup::numeric / (n_live_tup + n_dead_tup) * 100
                            ELSE 0 END), 0)
    INTO v_max_bloat
    FROM pg_stat_all_tables s
   WHERE s.schemaname IN ('public','cron')
     AND (s.n_live_tup + s.n_dead_tup) >= 1000
     AND pg_total_relation_size(format('%I.%I', s.schemaname, s.relname)::regclass) >= (1::bigint * 1024 * 1024);

  BEGIN
    EXECUTE 'SELECT count(*) FROM public.inventory_refresh_queue WHERE status = ''pending''' INTO v_queue;
  EXCEPTION WHEN OTHERS THEN v_queue := 0; END;

  -- Currently-broken jobs only: failed in last 24h with NO successful run since the last failure
  BEGIN
    SELECT count(*) INTO v_failed FROM (
      SELECT jobid,
             MAX(end_time) FILTER (WHERE status = 'failed')    AS last_fail,
             MAX(end_time) FILTER (WHERE status = 'succeeded') AS last_ok
        FROM cron.job_run_details
       WHERE end_time > now() - interval '24 hours'
       GROUP BY jobid
    ) t
    WHERE last_fail IS NOT NULL
      AND (last_ok IS NULL OR last_ok < last_fail);
  EXCEPTION WHEN OTHERS THEN v_failed := 0; END;

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
  IF v_failed > 5 THEN v_score := v_score - 10; END IF;

  v_score := GREATEST(0, LEAST(100, v_score));

  v_label := CASE
    WHEN v_score >= 90 THEN 'Excellent'
    WHEN v_score >= 75 THEN 'Healthy'
    WHEN v_score >= 50 THEN 'Warning'
    ELSE 'Critical'
  END;

  RETURN jsonb_build_object(
    'score', v_score, 'label', v_label, 'db_bytes', v_db_bytes,
    'open_critical', v_critical, 'open_warn', v_warn,
    'max_bloat_pct', round(v_max_bloat, 1),
    'queue_backlog', v_queue,
    'failed_cron_24h', v_failed
  );
END; $$;

-- Apply same "currently-broken" logic to the cron_failures alert
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

  IF v_db_bytes <= (6::bigint * 1024 * 1024 * 1024) THEN
    UPDATE public.database_maintenance_alerts SET acknowledged_at = now()
     WHERE kind = 'db_size_critical' AND acknowledged_at IS NULL;
  END IF;
  IF v_db_bytes <= (4::bigint * 1024 * 1024 * 1024) THEN
    UPDATE public.database_maintenance_alerts SET acknowledged_at = now()
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

  BEGIN
    SELECT pg_total_relation_size('cron.job_run_details'::regclass) INTO v_pgcron_bytes;
    IF v_pgcron_bytes <= (250::bigint * 1024 * 1024) THEN
      UPDATE public.database_maintenance_alerts SET acknowledged_at = now()
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
        UPDATE public.database_maintenance_alerts SET acknowledged_at = now()
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
      UPDATE public.database_maintenance_alerts SET acknowledged_at = now()
       WHERE kind = 'refresh_queue_backlog' AND acknowledged_at IS NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Only count *currently* broken jobs: failed and no successful run since
  BEGIN
    SELECT count(*) INTO v_failed_recent FROM (
      SELECT jobid,
             MAX(end_time) FILTER (WHERE status = 'failed')    AS last_fail,
             MAX(end_time) FILTER (WHERE status = 'succeeded') AS last_ok
        FROM cron.job_run_details
       WHERE end_time > now() - interval '24 hours'
       GROUP BY jobid
    ) t
    WHERE last_fail IS NOT NULL AND (last_ok IS NULL OR last_ok < last_fail);

    IF v_failed_recent > 5 THEN
      PERFORM public._raise_maintenance_alert('warn', 'cron_failures',
        format('%s cron jobs are currently broken (failed without recovery).', v_failed_recent),
        jsonb_build_object('count', v_failed_recent));
    ELSE
      UPDATE public.database_maintenance_alerts SET acknowledged_at = now()
       WHERE kind = 'cron_failures' AND acknowledged_at IS NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('db_bytes', v_db_bytes, 'queue_backlog', v_queue_backlog,
    'failed_cron_24h', v_failed_recent, 'evaluated_at', now());
END; $function$;
