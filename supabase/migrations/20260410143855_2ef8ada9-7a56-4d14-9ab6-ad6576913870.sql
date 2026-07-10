
-- 1. Re-enable the 10 wrongly disabled US assignments
UPDATE public.repricer_assignments
SET is_enabled = true
WHERE id IN (
  'a63f68f4-430a-4bea-ae65-6cd0258192b4',  -- B08JQQR7L4
  'e238ec43-02c8-4dba-80cb-8e1b1c468ef2',  -- B01F2Q8YTA
  '95f96770-fcff-4aac-bf27-f332b3fe12e7',  -- B00NBOE3XC
  '418b0d23-0d23-43fb-be4e-da154cc6c15e',  -- B0GT62JDVT
  '73f40cb2-c5a7-4cdb-9262-986aa931de7f',  -- B00D79EODK
  '9bc0ec0f-bb91-4a26-a254-e4e6fcb01803',  -- B09YDMDMDP
  'a69161bb-e0a5-4535-9495-9bab9f6d038f',  -- B01LIHK620
  '70f7c3bf-96d4-45fd-a8f9-4ee2554d89d7',  -- B01K0TYZZG
  'b6f64476-703c-41bc-9bb2-0524331a206a',  -- B00FAIUBKG
  'fc436afc-8183-4333-8e90-b0355166d174'   -- B004QC1TTY
);

-- 2. Update trigger to include inbound protection
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
