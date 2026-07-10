-- 1) Fix capture_system_load: idle ClientRead connections were being counted as "waiting"
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
      FROM pg_stat_statements
     WHERE calls > 0;
  EXCEPTION WHEN OTHERS THEN
    v_avg := NULL;
  END;

  INSERT INTO public.system_load_snapshot(active_connections, waiting_queries, avg_query_ms_5m)
  VALUES (v_active, v_wait, v_avg);

  DELETE FROM public.system_load_snapshot WHERE captured_at < now() - interval '7 days';
END;
$function$;

-- 2) Refresh statistics on hot tables (cheap, safe; no table rewrite)
ANALYZE public.sales_orders;
ANALYZE public.inventory;
ANALYZE public.repricer_assignments;
ANALYZE public.cron_run_history;
ANALYZE public.repricer_price_actions;

-- 3) Retention plan for repricer_price_actions (1.3 GB and growing)
--    Strategy: keep raw rows for 60 days, before delete roll up into a daily summary.

CREATE TABLE IF NOT EXISTS public.repricer_price_actions_daily (
  day            date         NOT NULL,
  user_id        uuid         NOT NULL,
  marketplace    text         NOT NULL DEFAULT 'US',
  action_type    text         NOT NULL,
  actions_count  integer      NOT NULL DEFAULT 0,
  asins_touched  integer      NOT NULL DEFAULT 0,
  avg_old_price  numeric,
  avg_new_price  numeric,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (day, user_id, marketplace, action_type)
);

GRANT SELECT ON public.repricer_price_actions_daily TO authenticated;
GRANT ALL    ON public.repricer_price_actions_daily TO service_role;

ALTER TABLE public.repricer_price_actions_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own daily action rollups"
  ON public.repricer_price_actions_daily FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service role full access daily rollups"
  ON public.repricer_price_actions_daily FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Roll-up + prune function. Caller (cron) passes keep_days; default 60.
CREATE OR REPLACE FUNCTION public.prune_repricer_price_actions(p_keep_days int DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_cutoff   timestamptz := now() - make_interval(days => p_keep_days);
  v_rolled   bigint := 0;
  v_deleted  bigint := 0;
BEGIN
  -- 1. Roll-up missing days into the daily summary (idempotent via ON CONFLICT)
  WITH agg AS (
    SELECT
      (created_at AT TIME ZONE 'UTC')::date         AS day,
      user_id,
      COALESCE(marketplace, 'US')                   AS marketplace,
      COALESCE(action_type, 'unknown')              AS action_type,
      COUNT(*)::int                                 AS actions_count,
      COUNT(DISTINCT asin)::int                     AS asins_touched,
      AVG(old_price)                                AS avg_old_price,
      AVG(new_price)                                AS avg_new_price
    FROM public.repricer_price_actions
    WHERE created_at < v_cutoff
    GROUP BY 1,2,3,4
  )
  INSERT INTO public.repricer_price_actions_daily
        (day, user_id, marketplace, action_type, actions_count, asins_touched, avg_old_price, avg_new_price)
  SELECT day, user_id, marketplace, action_type, actions_count, asins_touched, avg_old_price, avg_new_price
    FROM agg
  ON CONFLICT (day, user_id, marketplace, action_type) DO UPDATE
    SET actions_count = GREATEST(public.repricer_price_actions_daily.actions_count, EXCLUDED.actions_count),
        asins_touched = GREATEST(public.repricer_price_actions_daily.asins_touched, EXCLUDED.asins_touched),
        avg_old_price = EXCLUDED.avg_old_price,
        avg_new_price = EXCLUDED.avg_new_price;
  GET DIAGNOSTICS v_rolled = ROW_COUNT;

  -- 2. Delete in chunks of 50k to keep the txn short and bloat-friendly
  WITH del AS (
    DELETE FROM public.repricer_price_actions
     WHERE ctid IN (
       SELECT ctid FROM public.repricer_price_actions
        WHERE created_at < v_cutoff
        LIMIT 50000
     )
     RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  RETURN jsonb_build_object(
    'cutoff', v_cutoff,
    'rolled_up_rows', v_rolled,
    'deleted_rows', v_deleted,
    'remaining_old', (SELECT count(*) FROM public.repricer_price_actions WHERE created_at < v_cutoff)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.prune_repricer_price_actions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_repricer_price_actions(int) TO service_role;

-- 4) consume_api_token: 10-second-bucket dedupe so the per-row UPDATE storm collapses
--    to ~6 writes/min/bucket instead of ~1000/min/bucket.
--    First call in a 10s window → real refill/consume.
--    Subsequent calls in same window → just bump the aggregate counter, fast-allow.
CREATE OR REPLACE FUNCTION public.consume_api_token(p_bucket text, p_count numeric DEFAULT 1)
 RETURNS TABLE(allowed boolean, wait_ms integer, tokens_left numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_row        public.api_rate_limits%ROWTYPE;
  v_now        timestamptz := now();
  v_window     timestamptz := date_trunc('minute', v_now)
                              + (floor(extract(second FROM v_now)::int / 10) * interval '10 seconds');
  v_sentinel   uuid := '00000000-0000-0000-0000-000000000000';
  v_was_insert boolean;
  v_elapsed    numeric;
  v_new_tokens numeric;
BEGIN
  -- Aggregate first; xmax=0 means our INSERT created the row (i.e. first call in window).
  INSERT INTO public.api_token_recent_consumption(user_id, feature, window_start, count, flushed)
  VALUES (v_sentinel, p_bucket, v_window, p_count::int, false)
  ON CONFLICT (user_id, feature, window_start) DO UPDATE
    SET count = api_token_recent_consumption.count + EXCLUDED.count
  RETURNING (xmax = 0) INTO v_was_insert;

  IF NOT v_was_insert THEN
    -- Same 10s window → cached fast-path. Caller is allowed without touching api_rate_limits.
    RETURN QUERY SELECT true, 0, NULL::numeric;
    RETURN;
  END IF;

  -- First call in this 10s window for this bucket → do the real refill/consume.
  SELECT * INTO v_row FROM public.api_rate_limits WHERE bucket = p_bucket FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT true, 0, 0::numeric;
    RETURN;
  END IF;

  v_elapsed := EXTRACT(EPOCH FROM (v_now - v_row.last_refill_at));
  v_new_tokens := LEAST(v_row.capacity, v_row.tokens_available + v_elapsed * v_row.refill_per_sec);

  IF v_new_tokens >= p_count THEN
    UPDATE public.api_rate_limits
       SET tokens_available = v_new_tokens - p_count,
           last_refill_at   = v_now,
           updated_at       = v_now
     WHERE bucket = p_bucket;
    RETURN QUERY SELECT true, 0, (v_new_tokens - p_count);
  ELSE
    UPDATE public.api_rate_limits
       SET tokens_available = v_new_tokens,
           last_refill_at   = v_now,
           updated_at       = v_now
     WHERE bucket = p_bucket;
    RETURN QUERY SELECT
      false,
      GREATEST(50, CEIL(((p_count - v_new_tokens) / v_row.refill_per_sec) * 1000))::integer,
      v_new_tokens;
  END IF;
END;
$function$;

-- 5) Cleanup function for the dedupe table (keep last 30 min for diagnostics)
CREATE OR REPLACE FUNCTION public.flush_api_token_recent_consumption()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_deleted int;
BEGIN
  WITH del AS (
    DELETE FROM public.api_token_recent_consumption
     WHERE window_start < now() - interval '30 minutes'
     RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.flush_api_token_recent_consumption() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.flush_api_token_recent_consumption() TO service_role;