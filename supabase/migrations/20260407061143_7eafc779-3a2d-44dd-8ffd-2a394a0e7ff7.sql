CREATE OR REPLACE FUNCTION public.fn_auto_disable_zero_stock_assignments()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- SKIP during inventory sync operations (sync handles assignment logic itself)
  -- Detected by last_inventory_sync_at being updated
  IF NEW.last_inventory_sync_at IS DISTINCT FROM OLD.last_inventory_sync_at THEN
    RETURN NEW;
  END IF;

  -- SKIP auto-disable/re-enable for MISMATCH or STRANDED items.
  IF NEW.listing_status IN ('MISMATCH', 'STRANDED') THEN
    RETURN NEW;
  END IF;

  -- When total sellable stock (available + reserved) drops to 0, disable matching repricer assignments
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