
-- 1) Add freshness column to inventory
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS last_summaries_at timestamptz;

-- Backfill from existing last_inventory_sync_at so first write isn't blocked unfairly
UPDATE public.inventory
   SET last_summaries_at = last_inventory_sync_at
 WHERE last_summaries_at IS NULL
   AND last_inventory_sync_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_last_summaries_at
  ON public.inventory (user_id, last_summaries_at);

-- 2) DB-level freshness guard.
-- Any UPDATE that touches available/reserved/inbound and provides
-- last_summaries_at must be NEWER than the current row's last_summaries_at.
-- Writers that don't set last_summaries_at (legacy paths) are allowed but
-- should be migrated. Writes from source='force_relist' or 'manual_override'
-- always pass.
CREATE OR REPLACE FUNCTION public.fn_inventory_freshness_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only enforce when stock fields actually change
  IF (NEW.available IS NOT DISTINCT FROM OLD.available)
     AND (NEW.reserved IS NOT DISTINCT FROM OLD.reserved)
     AND (NEW.inbound IS NOT DISTINCT FROM OLD.inbound) THEN
    RETURN NEW;
  END IF;

  -- Allow explicit overrides
  IF NEW.source IN ('force_relist', 'manual_override', 'amazon_sync_accept') THEN
    RETURN NEW;
  END IF;

  -- If caller didn't bump last_summaries_at, allow but don't advance the watermark
  IF NEW.last_summaries_at IS NULL OR NEW.last_summaries_at IS NOT DISTINCT FROM OLD.last_summaries_at THEN
    RETURN NEW;
  END IF;

  -- Block stale overwrites: reject if incoming watermark is OLDER than what's stored
  IF OLD.last_summaries_at IS NOT NULL
     AND NEW.last_summaries_at < OLD.last_summaries_at THEN
    RAISE LOG '[FRESHNESS_GUARD] Blocked stale write asin=% sku=% src=% old_ts=% new_ts=%',
      OLD.asin, OLD.sku, NEW.source, OLD.last_summaries_at, NEW.last_summaries_at;
    -- Keep old stock values, but allow other harmless field updates to pass through
    NEW.available := OLD.available;
    NEW.reserved := OLD.reserved;
    NEW.inbound := OLD.inbound;
    NEW.last_summaries_at := OLD.last_summaries_at;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_freshness_guard ON public.inventory;
CREATE TRIGGER trg_inventory_freshness_guard
  BEFORE UPDATE ON public.inventory
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_inventory_freshness_guard();
