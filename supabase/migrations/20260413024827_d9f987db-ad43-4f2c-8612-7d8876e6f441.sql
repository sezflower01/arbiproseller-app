
-- Auto-disable international assignments when eligibility degrades
CREATE OR REPLACE FUNCTION public.fn_auto_disable_ineligible_intl()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_bad_statuses text[] := ARRAY['UNKNOWN', 'NOT_FOUND', 'INACTIVE', '[]', ''];
  v_normalized text;
BEGIN
  -- Only act on non-US marketplaces
  IF NEW.marketplace = 'US' THEN
    RETURN NEW;
  END IF;

  -- Only act when intl_listing_status actually changed
  IF NEW.intl_listing_status IS NOT DISTINCT FROM OLD.intl_listing_status THEN
    RETURN NEW;
  END IF;

  -- Normalize the status for comparison
  v_normalized := UPPER(TRIM(COALESCE(NEW.intl_listing_status, '')));

  -- Check if the new status is ineligible
  IF v_normalized = ANY(ARRAY['UNKNOWN', 'NOT_FOUND', 'INACTIVE', '[]', ''])
     OR v_normalized = ''
     OR v_normalized IS NULL THEN
    -- Auto-disable this specific marketplace assignment
    IF NEW.is_enabled = true THEN
      NEW.is_enabled := false;
      RAISE LOG '[INTL_ELIGIBILITY_GUARD] Auto-disabled assignment % (asin=%, sku=%, marketplace=%) — intl_listing_status changed from % to %',
        NEW.id, NEW.asin, NEW.sku, NEW.marketplace, OLD.intl_listing_status, NEW.intl_listing_status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Attach BEFORE UPDATE so it modifies the row before it's written
CREATE TRIGGER trg_auto_disable_ineligible_intl
BEFORE UPDATE ON public.repricer_assignments
FOR EACH ROW
EXECUTE FUNCTION public.fn_auto_disable_ineligible_intl();
