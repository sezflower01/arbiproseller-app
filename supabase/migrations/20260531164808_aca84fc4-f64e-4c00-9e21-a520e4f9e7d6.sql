-- =====================================================================
-- CRON SAFETY INFRASTRUCTURE (Part 2 of the traffic-lights plan)
-- Adds locks, run-tracking, load snapshots, and token dedupe storage.
-- Nothing here changes business logic. Pure plumbing.
-- =====================================================================

-- ---------- 1. cron_locks ---------------------------------------------
CREATE TABLE IF NOT EXISTS public.cron_locks (
  lock_key     text PRIMARY KEY,
  holder       text NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

GRANT SELECT ON public.cron_locks TO authenticated;
GRANT ALL    ON public.cron_locks TO service_role;
ALTER TABLE public.cron_locks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cron_locks admin read"
  ON public.cron_locks FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Atomic try-acquire: returns true if caller now owns the lock.
CREATE OR REPLACE FUNCTION public.try_acquire_cron_lock(
  p_key text, p_holder text, p_ttl_seconds int DEFAULT 600
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now  timestamptz := now();
  v_exp  timestamptz := now() + make_interval(secs => p_ttl_seconds);
BEGIN
  INSERT INTO public.cron_locks(lock_key, holder, acquired_at, expires_at)
  VALUES (p_key, p_holder, v_now, v_exp)
  ON CONFLICT (lock_key) DO UPDATE
    SET holder = EXCLUDED.holder,
        acquired_at = EXCLUDED.acquired_at,
        expires_at = EXCLUDED.expires_at
    WHERE public.cron_locks.expires_at < v_now;   -- only steal if expired

  RETURN (SELECT holder = p_holder AND acquired_at = v_now
          FROM public.cron_locks WHERE lock_key = p_key);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_cron_lock(
  p_key text, p_holder text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.cron_locks
   WHERE lock_key = p_key AND holder = p_holder;
$$;

-- ---------- 2. cron_job_runs (self-overlap guard + observability) -----
CREATE TABLE IF NOT EXISTS public.cron_job_runs (
  id              bigserial PRIMARY KEY,
  job_name        text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','done','skipped','failed')),
  rows_processed  int,
  notes           text
);

CREATE INDEX IF NOT EXISTS idx_cron_job_runs_job_started
  ON public.cron_job_runs (job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_job_runs_running
  ON public.cron_job_runs (job_name) WHERE status = 'running';

GRANT SELECT ON public.cron_job_runs TO authenticated;
GRANT ALL    ON public.cron_job_runs TO service_role;
ALTER TABLE public.cron_job_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cron_job_runs admin read"
  ON public.cron_job_runs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Record a run start. Returns the new id, or NULL if a recent run
-- for the same job is still 'running' (caller should skip).
CREATE OR REPLACE FUNCTION public.record_cron_run_start(
  p_job text, p_overlap_window_minutes int DEFAULT 15
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_running bigint;
  v_id      bigint;
BEGIN
  SELECT id INTO v_running
    FROM public.cron_job_runs
   WHERE job_name = p_job
     AND status = 'running'
     AND started_at > now() - make_interval(mins => p_overlap_window_minutes)
   LIMIT 1;

  IF v_running IS NOT NULL THEN
    INSERT INTO public.cron_job_runs(job_name, status, finished_at, notes)
    VALUES (p_job, 'skipped', now(), 'overlap with run #' || v_running);
    RETURN NULL;
  END IF;

  INSERT INTO public.cron_job_runs(job_name) VALUES (p_job)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_cron_run_finish(
  p_id bigint, p_status text DEFAULT 'done',
  p_rows int DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.cron_job_runs
     SET finished_at = now(),
         status = p_status,
         rows_processed = p_rows,
         notes = p_notes
   WHERE id = p_id;
$$;

-- ---------- 3. system_load_snapshot + adaptive throttle --------------
CREATE TABLE IF NOT EXISTS public.system_load_snapshot (
  id                 bigserial PRIMARY KEY,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  active_connections int NOT NULL,
  waiting_queries    int NOT NULL,
  avg_query_ms_5m    numeric
);
CREATE INDEX IF NOT EXISTS idx_sls_captured_at
  ON public.system_load_snapshot (captured_at DESC);

GRANT SELECT ON public.system_load_snapshot TO authenticated;
GRANT ALL    ON public.system_load_snapshot TO service_role;
ALTER TABLE public.system_load_snapshot ENABLE ROW LEVEL SECURITY;

CREATE POLICY "system_load_snapshot admin read"
  ON public.system_load_snapshot FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.capture_system_load()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_active int;
  v_wait   int;
  v_avg    numeric;
BEGIN
  SELECT count(*) FILTER (WHERE state = 'active'),
         count(*) FILTER (WHERE wait_event IS NOT NULL)
    INTO v_active, v_wait
    FROM pg_stat_activity
   WHERE datname = current_database();

  BEGIN
    SELECT round(avg(mean_exec_time)::numeric, 2)
      INTO v_avg
      FROM pg_stat_statements
     WHERE calls > 0;
  EXCEPTION WHEN OTHERS THEN
    v_avg := NULL;
  END;

  INSERT INTO public.system_load_snapshot(active_connections, waiting_queries, avg_query_ms_5m)
  VALUES (v_active, v_wait, v_avg);

  -- Trim older than 7 days
  DELETE FROM public.system_load_snapshot WHERE captured_at < now() - interval '7 days';
END;
$$;

-- Returns: 'ok' | 'throttle' | 'skip'
CREATE OR REPLACE FUNCTION public.should_throttle_now()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active int;
  v_avg    numeric;
BEGIN
  SELECT active_connections, avg_query_ms_5m
    INTO v_active, v_avg
    FROM public.system_load_snapshot
   ORDER BY captured_at DESC
   LIMIT 1;

  IF v_active IS NULL THEN RETURN 'ok'; END IF;
  IF v_active > 40 OR (v_avg IS NOT NULL AND v_avg > 2000) THEN RETURN 'skip'; END IF;
  IF v_active > 25 THEN RETURN 'throttle'; END IF;
  RETURN 'ok';
END;
$$;

-- ---------- 4. api_token_recent_consumption (dedupe storage) ---------
CREATE TABLE IF NOT EXISTS public.api_token_recent_consumption (
  user_id       uuid NOT NULL,
  feature       text NOT NULL,
  window_start  timestamptz NOT NULL,    -- truncated to 10s
  count         int NOT NULL DEFAULT 0,
  flushed       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, feature, window_start)
);
CREATE INDEX IF NOT EXISTS idx_atrc_unflushed
  ON public.api_token_recent_consumption (window_start)
  WHERE flushed = false;

GRANT SELECT ON public.api_token_recent_consumption TO authenticated;
GRANT ALL    ON public.api_token_recent_consumption TO service_role;
ALTER TABLE public.api_token_recent_consumption ENABLE ROW LEVEL SECURITY;

CREATE POLICY "atrc admin read"
  ON public.api_token_recent_consumption FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ---------- 5. Schedule the load snapshot (every minute) -------------
-- This is the ONE new schedule. Cheap query, writes ~1 row/min.
DO $$
DECLARE jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'capture-system-load-1m';
  IF jid IS NOT NULL THEN PERFORM cron.unschedule(jid); END IF;

  PERFORM cron.schedule(
    'capture-system-load-1m',
    '* * * * *',
    $cron$ SELECT public.capture_system_load(); $cron$
  );
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'capture-system-load-1m not scheduled (insufficient privilege)';
END $$;

-- ---------- 6. Missing index for the slow timeout query --------------
CREATE INDEX IF NOT EXISTS idx_rpa_action_type_created_at
  ON public.repricer_price_actions (action_type, created_at DESC);