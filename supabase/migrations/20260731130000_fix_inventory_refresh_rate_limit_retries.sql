-- Live evidence: 748 inventory_refresh_queue rows were permanently marked
-- 'error' after exhausting all 3 attempts, but every single failure was
-- "Rate limit exceeded for trace <id>. Retry after Xms" -- the platform's
-- per-execution outbound-call quota (same root cause discovered and fixed
-- in full-inventory-refresh-all earlier today), not a real problem with
-- the item itself. inventory-refresh-worker processes 60 items/tick at
-- concurrency 4; when the quota trips mid-batch, whichever items land in
-- the back half get instant rejections on all 3 attempts in a row and
-- burn through their retry budget for a reason that has nothing to do
-- with them.
--
-- Fix: this specific error class never counts toward p_max_attempts --
-- always retry it, regardless of attempt count.
CREATE OR REPLACE FUNCTION public.mark_inventory_refresh_error(p_id uuid, p_error text, p_max_attempts int DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_platform_throttle boolean := p_error ILIKE '%Rate limit exceeded for trace%';
BEGIN
  UPDATE public.inventory_refresh_queue
  SET status = CASE
                 WHEN v_is_platform_throttle THEN 'pending'
                 WHEN attempts >= p_max_attempts THEN 'error'
                 ELSE 'pending'
               END,
      last_error = p_error,
      locked_at = NULL,
      processed_at = CASE
                       WHEN NOT v_is_platform_throttle AND attempts >= p_max_attempts THEN now()
                       ELSE processed_at
                     END
  WHERE id = p_id;
END;
$$;

-- One-time cleanup: give the rows stuck in 'error' purely from this
-- platform-throttle timing issue a fair retry under the fixed logic above.
-- Skip any row whose (user_id, asin, sku, marketplace) already has a
-- pending/running row -- it's since been re-enqueued naturally (the
-- enqueue function's own dedup only excludes pending/running, not error),
-- so flipping this old row too would collide with the unique index.
-- Also cap at one row per key (duplicates can exist among non-pending/
-- running rows) so two 'error' rows for the same item don't collide with
-- each other when both flip to 'pending' in the same statement.
WITH candidates AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY user_id, asin, sku, marketplace ORDER BY created_at DESC
  ) AS rn
  FROM public.inventory_refresh_queue q
  WHERE q.status = 'error'
    AND q.last_error ILIKE '%Rate limit exceeded for trace%'
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_refresh_queue q2
      WHERE q2.user_id = q.user_id
        AND q2.asin = q.asin
        AND q2.sku = q.sku
        AND q2.marketplace = q.marketplace
        AND q2.status IN ('pending', 'running')
    )
)
UPDATE public.inventory_refresh_queue
SET status = 'pending', attempts = 0, locked_at = NULL
WHERE id IN (SELECT id FROM candidates WHERE rn = 1);
