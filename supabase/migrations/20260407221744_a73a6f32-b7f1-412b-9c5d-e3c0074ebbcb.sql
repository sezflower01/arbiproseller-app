
-- 1. One-time cleanup: disable all enabled assignments with zero sellable stock
UPDATE public.repricer_assignments a
SET is_enabled = false
WHERE a.is_enabled = true
  AND NOT EXISTS (
    SELECT 1 FROM public.inventory i
    WHERE i.asin = a.asin
      AND i.user_id = a.user_id
      AND (COALESCE(i.available, 0) > 0 OR COALESCE(i.reserved, 0) > 0)
  );

-- 2. Update trigger: remove MISMATCH/STRANDED bypass so they get auto-disabled too
CREATE OR REPLACE FUNCTION public.fn_auto_disable_zero_stock_assignments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- SKIP during inventory sync operations (sync handles assignment logic itself)
  IF NEW.last_inventory_sync_at IS DISTINCT FROM OLD.last_inventory_sync_at THEN
    RETURN NEW;
  END IF;

  -- When total sellable stock (available + reserved) drops to 0, disable matching assignments
  -- This now applies to ALL statuses including MISMATCH and STRANDED
  IF (COALESCE(NEW.available, 0) + COALESCE(NEW.reserved, 0) = 0)
     AND (COALESCE(OLD.available, 0) + COALESCE(OLD.reserved, 0) > 0) THEN
    UPDATE public.repricer_assignments
    SET is_enabled = false
    WHERE user_id = NEW.user_id
      AND asin = NEW.asin
      AND is_enabled = true;
  END IF;

  -- When total sellable stock goes from 0 to >0, re-enable matching assignments
  IF (COALESCE(NEW.available, 0) + COALESCE(NEW.reserved, 0) > 0)
     AND (COALESCE(OLD.available, 0) + COALESCE(OLD.reserved, 0) = 0) THEN
    UPDATE public.repricer_assignments
    SET is_enabled = true
    WHERE user_id = NEW.user_id
      AND asin = NEW.asin
      AND is_enabled = false;
  END IF;

  RETURN NEW;
END;
$function$;
