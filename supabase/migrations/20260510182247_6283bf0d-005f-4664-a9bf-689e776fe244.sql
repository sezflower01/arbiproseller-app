
-- 1. Queue table
CREATE TABLE public.inventory_refresh_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
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

CREATE UNIQUE INDEX inventory_refresh_queue_pending_uniq
  ON public.inventory_refresh_queue (user_id, asin, sku, marketplace)
  WHERE status IN ('pending','running');

CREATE INDEX inventory_refresh_queue_drain_idx
  ON public.inventory_refresh_queue (priority, created_at)
  WHERE status = 'pending';

CREATE INDEX inventory_refresh_queue_user_idx
  ON public.inventory_refresh_queue (user_id, status);

ALTER TABLE public.inventory_refresh_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view queue"
  ON public.inventory_refresh_queue FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can view their own queue rows"
  ON public.inventory_refresh_queue FOR SELECT
  USING (auth.uid() = user_id);

CREATE TRIGGER set_inventory_refresh_queue_updated_at
  BEFORE UPDATE ON public.inventory_refresh_queue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Replace enqueue function: insert queue rows instead of firing 4k HTTP calls
CREATE OR REPLACE FUNCTION public.enqueue_full_inventory_refresh(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH src AS (
    SELECT DISTINCT ON (i.asin, i.sku)
      i.user_id, i.asin, i.sku, COALESCE(i.marketplace, 'US') AS marketplace
    FROM public.inventory i
    WHERE i.user_id = p_user_id
      AND i.asin IS NOT NULL
      AND i.sku IS NOT NULL
      AND COALESCE(i.source, '') <> 'created_listing'
      AND COALESCE(UPPER(i.listing_status), '') <> 'DELETED'
  ),
  ins AS (
    INSERT INTO public.inventory_refresh_queue (user_id, asin, sku, marketplace, status, priority)
    SELECT s.user_id, s.asin, s.sku, s.marketplace, 'pending', 100
    FROM src s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.inventory_refresh_queue q
      WHERE q.user_id = s.user_id
        AND q.asin = s.asin
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

-- 3. Atomic dequeue (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.dequeue_inventory_refresh(p_limit int DEFAULT 25)
RETURNS TABLE (id uuid, user_id uuid, asin text, sku text, marketplace text, attempts int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT q.id
    FROM public.inventory_refresh_queue q
    WHERE q.status = 'pending'
       OR (q.status = 'running' AND q.locked_at < now() - interval '5 minutes')
    ORDER BY q.priority ASC, q.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.inventory_refresh_queue q
  SET status = 'running',
      locked_at = now(),
      attempts = q.attempts + 1
  FROM picked p
  WHERE q.id = p.id
  RETURNING q.id, q.user_id, q.asin, q.sku, q.marketplace, q.attempts;
END;
$$;

-- 4. Mark success / error
CREATE OR REPLACE FUNCTION public.mark_inventory_refresh_success(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.inventory_refresh_queue
  SET status = 'success', processed_at = now(), last_error = NULL, locked_at = NULL
  WHERE id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.mark_inventory_refresh_error(p_id uuid, p_error text, p_max_attempts int DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.inventory_refresh_queue
  SET status = CASE WHEN attempts >= p_max_attempts THEN 'error' ELSE 'pending' END,
      last_error = p_error,
      locked_at = NULL,
      processed_at = CASE WHEN attempts >= p_max_attempts THEN now() ELSE processed_at END
  WHERE id = p_id;
END;
$$;

-- 5. Cleanup
CREATE OR REPLACE FUNCTION public.cleanup_inventory_refresh_queue()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE c bigint;
BEGIN
  DELETE FROM public.inventory_refresh_queue
  WHERE status = 'success' AND processed_at < now() - interval '24 hours';
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN c;
END;
$$;
