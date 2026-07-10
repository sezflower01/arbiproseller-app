-- Phase 3A: enforce audit contract on is_enabled true->false transitions.
-- Blocks any silent disable; permits manual pauses and audited auto-suspensions
-- (new contract: auto_suspended_reason; legacy: last_disabled_reason).

CREATE OR REPLACE FUNCTION public.fn_enforce_assignment_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only care about TRUE -> FALSE transitions on is_enabled.
  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.is_enabled, true) = true
     AND COALESCE(NEW.is_enabled, true) = false
  THEN
    -- Allow manual user pause
    IF COALESCE(NEW.manual_paused, false) = true THEN
      RETURN NEW;
    END IF;

    -- Allow new-contract auto-suspension (Phase 1 fields stamped)
    IF NEW.auto_suspended_reason IS NOT NULL
       AND length(btrim(NEW.auto_suspended_reason)) > 0
       AND NEW.auto_suspended_at IS NOT NULL
    THEN
      RETURN NEW;
    END IF;

    -- Allow legacy-contract audit (writers not yet migrated to Phase 1 fields)
    IF NEW.last_disabled_reason IS NOT NULL
       AND length(btrim(NEW.last_disabled_reason)) > 0
       AND NEW.last_disabled_at IS NOT NULL
    THEN
      RETURN NEW;
    END IF;

    -- Otherwise: block the silent disable.
    RAISE EXCEPTION
      'Silent is_enabled=false rejected on assignment % (asin=%, marketplace=%): missing auto_suspended_reason or last_disabled_reason. Phase 3A audit contract.',
      NEW.id, NEW.asin, NEW.marketplace
      USING ERRCODE = 'check_violation',
            HINT = 'Stamp auto_suspended_reason/at/by (preferred) or last_disabled_reason/at, or set manual_paused=true.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_assignment_audit ON public.repricer_assignments;
CREATE TRIGGER trg_enforce_assignment_audit
BEFORE UPDATE OF is_enabled ON public.repricer_assignments
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_assignment_audit();

COMMENT ON FUNCTION public.fn_enforce_assignment_audit() IS
  'Phase 3A: rejects true->false is_enabled flips lacking manual_paused, auto_suspended_reason, or last_disabled_reason audit. Allows legacy false rows to persist.';