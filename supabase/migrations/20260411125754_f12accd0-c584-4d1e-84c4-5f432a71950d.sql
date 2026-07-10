
-- Add restock re-entry flag to assignments
ALTER TABLE public.repricer_assignments
ADD COLUMN IF NOT EXISTS restock_reentry_at TIMESTAMPTZ NULL;

-- Update the auto-disable trigger to also handle restock re-entry flagging
CREATE OR REPLACE FUNCTION public.fn_auto_disable_zero_stock_assignments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- SKIP during inventory sync operations (sync handles assignment logic itself)
  IF NEW.last_inventory_sync_at IS DISTINCT FROM OLD.last_inventory_sync_at THEN
    RETURN NEW;
  END IF;

  -- When total sellable stock (available + reserved) drops to 0 AND no inbound, disable matching assignments
  -- Inbound protection: if units are on the way, keep the assignment active
  IF (COALESCE(NEW.available, 0) + COALESCE(NEW.reserved, 0) = 0)
     AND COALESCE(NEW.inbound, 0) = 0
     AND (COALESCE(OLD.available, 0) + COALESCE(OLD.reserved, 0) > 0) THEN
    UPDATE public.repricer_assignments
    SET is_enabled = false
    WHERE user_id = NEW.user_id
      AND asin = NEW.asin
      AND is_enabled = true;
  END IF;

  -- When total sellable stock goes from 0 to >0, re-enable matching assignments
  -- AND set restock re-entry flag + HOT lane priority for fast competitive snap-back
  IF (COALESCE(NEW.available, 0) + COALESCE(NEW.reserved, 0) > 0)
     AND (COALESCE(OLD.available, 0) + COALESCE(OLD.reserved, 0) = 0) THEN
    UPDATE public.repricer_assignments
    SET is_enabled = true,
        -- Set restock flag only if not already set (idempotency)
        restock_reentry_at = CASE
          WHEN restock_reentry_at IS NULL THEN now()
          ELSE restock_reentry_at
        END,
        -- Trigger HOT lane priority for ~2 min fast pickup
        last_price_change_at = now()
    WHERE user_id = NEW.user_id
      AND asin = NEW.asin
      AND is_enabled = false;
  END IF;

  RETURN NEW;
END;
$$;
