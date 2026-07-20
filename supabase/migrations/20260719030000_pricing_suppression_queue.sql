-- Queue-based pricing-suppression detection, mirroring inventory_refresh_queue's
-- proven pattern. The nightly detect-pricing-suppressions-nightly cron (added in
-- 20260719020000) calls detect-pricing-suppressions-all directly, which loops a
-- user's ENTIRE catalog in one edge function invocation -- confirmed live this
-- hits WORKER_RESOURCE_LIMIT for an account with 1,723 SKUs eligible for
-- suppression re-check across marketplaces. Replacing the direct bulk call with
-- enqueue (cheap, SQL-only) + a 1-minute worker that drains small batches, so a
-- large catalog completes over many small runs instead of one that can crash
-- partway through and leave the remaining SKUs unchecked.

-- 1. Queue table
CREATE TABLE public.pricing_suppression_check_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text,
  sku text NOT NULL,
  marketplace text NOT NULL DEFAULT 'US',
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  priority int NOT NULL DEFAULT 100,
  locked_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pricing_suppression_check_queue_pending_uniq
  ON public.pricing_suppression_check_queue (user_id, sku, marketplace)
  WHERE status IN ('pending','running');

CREATE INDEX pricing_suppression_check_queue_drain_idx
  ON public.pricing_suppression_check_queue (priority, created_at)
  WHERE status = 'pending';

CREATE INDEX pricing_suppression_check_queue_user_idx
  ON public.pricing_suppression_check_queue (user_id, status);

ALTER TABLE public.pricing_suppression_check_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view suppression queue"
  ON public.pricing_suppression_check_queue FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can view their own suppression queue rows"
  ON public.pricing_suppression_check_queue FOR SELECT
  USING (auth.uid() = user_id);

CREATE TRIGGER set_pricing_suppression_check_queue_updated_at
  BEFORE UPDATE ON public.pricing_suppression_check_queue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Enqueue for one user. Same eligibility rule as detect-pricing-suppressions'
-- re-check query: normally-repriced SKUs (enabled + rule assigned), UNION
-- already-suppressed rows regardless of enabled/rule_id (so a suppressed row
-- that got disabled can still self-clear). Suppressed rows get a higher
-- priority (lower number = drained first) since clearing a fixed listing is
-- the more time-sensitive case.
CREATE OR REPLACE FUNCTION public.enqueue_pricing_suppression_check(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH src AS (
    SELECT ra.user_id, ra.asin, ra.sku, ra.marketplace, ra.is_pricing_suppression
    FROM public.repricer_assignments ra
    WHERE ra.user_id = p_user_id
      AND ra.sku IS NOT NULL
      AND ((ra.is_enabled = true AND ra.rule_id IS NOT NULL) OR ra.is_pricing_suppression = true)
  ),
  ins AS (
    INSERT INTO public.pricing_suppression_check_queue (user_id, asin, sku, marketplace, status, priority)
    SELECT s.user_id, s.asin, s.sku, s.marketplace, 'pending',
      CASE WHEN s.is_pricing_suppression THEN 10 ELSE 100 END
    FROM src s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.pricing_suppression_check_queue q
      WHERE q.user_id = s.user_id
        AND q.sku = s.sku
        AND q.marketplace = s.marketplace
        AND q.status IN ('pending','running')
    )
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN jsonb_build_object('user_id', p_user_id, 'enqueued', v_count, 'enqueued_at', now());
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_pricing_suppression_check_all_users()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_total_users int := 0;
  v_total_enqueued int := 0;
  v_result jsonb;
BEGIN
  FOR v_user IN (
    SELECT DISTINCT user_id FROM repricer_assignments WHERE is_enabled = true AND user_id IS NOT NULL
  ) LOOP
    BEGIN
      v_result := public.enqueue_pricing_suppression_check(v_user);
      v_total_users := v_total_users + 1;
      v_total_enqueued := v_total_enqueued + COALESCE((v_result->>'enqueued')::int, 0);
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG '[enqueue_pricing_suppression_check_all_users] user=% error=%', v_user, SQLERRM;
    END;
  END LOOP;
  RETURN jsonb_build_object('users', v_total_users, 'enqueued', v_total_enqueued, 'at', now());
END;
$$;

-- 3. Atomic dequeue (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.dequeue_pricing_suppression_check(p_limit int DEFAULT 30)
RETURNS TABLE (id uuid, user_id uuid, asin text, sku text, marketplace text, attempts int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT q.id
    FROM public.pricing_suppression_check_queue q
    WHERE q.status = 'pending'
       OR (q.status = 'running' AND q.locked_at < now() - interval '5 minutes')
    ORDER BY q.priority ASC, q.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.pricing_suppression_check_queue q
  SET status = 'running',
      locked_at = now(),
      attempts = q.attempts + 1
  FROM picked p
  WHERE q.id = p.id
  RETURNING q.id, q.user_id, q.asin, q.sku, q.marketplace, q.attempts;
END;
$$;

-- 4. Mark success / error
CREATE OR REPLACE FUNCTION public.mark_pricing_suppression_check_success(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.pricing_suppression_check_queue
  SET status = 'success', processed_at = now(), last_error = NULL, locked_at = NULL
  WHERE id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.mark_pricing_suppression_check_error(p_id uuid, p_error text, p_max_attempts int DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.pricing_suppression_check_queue
  SET status = CASE WHEN attempts >= p_max_attempts THEN 'error' ELSE 'pending' END,
      last_error = p_error,
      locked_at = NULL,
      processed_at = CASE WHEN attempts >= p_max_attempts THEN now() ELSE processed_at END
  WHERE id = p_id;
END;
$$;

-- 5. Cleanup
CREATE OR REPLACE FUNCTION public.cleanup_pricing_suppression_check_queue()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE c bigint;
BEGIN
  DELETE FROM public.pricing_suppression_check_queue
  WHERE status = 'success' AND processed_at < now() - interval '24 hours';
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN c;
END;
$$;

-- 6. Reschedule the nightly job (added in 20260719020000) to enqueue instead of
-- calling detect-pricing-suppressions-all directly. Enqueue is cheap SQL, no
-- HTTP/SP-API calls, so it can't hit a resource limit.
SELECT cron.unschedule('detect-pricing-suppressions-nightly');
SELECT cron.schedule(
  'pricing-suppression-enqueue-nightly',
  '30 8 * * *',
  $$ SELECT public.enqueue_pricing_suppression_check_all_users(); $$
);

-- 7. Worker cron -- drains the queue every minute, same cadence as
-- inventory-refresh-worker-1m.
SELECT cron.schedule(
  'pricing-suppression-worker-1m',
  '*/1 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/pricing-suppression-worker',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('batch_size', 30),
    timeout_milliseconds := 90000
  );
  $cron$
);
