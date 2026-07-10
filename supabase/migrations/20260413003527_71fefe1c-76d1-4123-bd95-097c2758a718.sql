
-- Tombstone guard: prevent ghost ASINs from being resurrected
CREATE OR REPLACE FUNCTION public.fn_protect_ghost_tombstone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only act when listing_status is being changed FROM a terminal state
  IF OLD.listing_status IN ('NOT_IN_CATALOG', 'DELETED')
     AND NEW.listing_status IS DISTINCT FROM OLD.listing_status
     AND NEW.listing_status NOT IN ('NOT_IN_CATALOG', 'DELETED') THEN

    -- Allow explicit force-relist override
    IF NEW.source = 'force_relist' THEN
      RETURN NEW;
    END IF;

    -- Block the resurrection: keep old terminal status, log the attempt
    RAISE LOG '[TOMBSTONE_GUARD] Blocked resurrection of % / % from % to % by source=%',
      OLD.asin, OLD.sku, OLD.listing_status, NEW.listing_status, NEW.source;

    NEW.listing_status := OLD.listing_status;
  END IF;

  RETURN NEW;
END;
$$;

-- Attach as BEFORE UPDATE so it fires before other triggers
CREATE TRIGGER trg_protect_ghost_tombstone
BEFORE UPDATE ON public.inventory
FOR EACH ROW
EXECUTE FUNCTION public.fn_protect_ghost_tombstone();
