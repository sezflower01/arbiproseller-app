-- Fix 1: Update the auto-disable trigger to skip MISMATCH/STRANDED items
-- These statuses mean Amazon sources failed to report stock but item is believed to exist.
-- Protection is handled by status, not by faking inventory numbers.
CREATE OR REPLACE FUNCTION public.fn_auto_disable_zero_stock_assignments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- SKIP auto-disable/re-enable for MISMATCH or STRANDED items.
  -- These statuses indicate Amazon API sources are unreliable for this SKU.
  -- Repricer protection is handled by status, not by stock values.
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

-- Fix 2: Restore truthful inventory values for items that got the fake available=1
-- Set them back to 0 (the real synced value) since the trigger now protects them
UPDATE public.inventory
SET available = 0
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND listing_status IN ('MISMATCH', 'STRANDED')
  AND available = 1
  AND reserved = 0
  AND inbound = 0;