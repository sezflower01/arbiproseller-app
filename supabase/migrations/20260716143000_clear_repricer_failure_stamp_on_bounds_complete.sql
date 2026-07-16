-- Follow-up to 20260716140000. Investigation of the 132 currently-flagged
-- "1 fail" (activation_needs_cost) rows found two groups:
--
--   28 rows already have BOTH min_price_override and max_price_override set,
--   with real roi_at_min_percent/roi_at_max_percent/last_applied_price —
--   undeniable proof cost was available and bounds were computed
--   successfully. That happens through the client-side auto-assign-min/max
--   flow (AssignmentsTable.tsx, "Auto-fill min/max after rule assignment"),
--   which — unlike auto-assign-bulk's own payload — never touches
--   consecutive_failures/last_error_type, so the stamp survives forever
--   even though activation plainly succeeded.
--
--   104 rows still have null bounds; those will self-heal once whatever
--   actually computes their bounds runs (this migration's trigger now
--   covers that transition too), so no backfill needed for them.
--
-- Extend the trigger: also clear the failure stamp when a row transitions
-- to having BOTH bounds set (previously missing at least one) — complete
-- bounds are direct evidence the activation gate is satisfied, regardless
-- of which code path set them.
CREATE OR REPLACE FUNCTION public.clear_repricer_failure_stamp_on_enable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_enabled = true AND (OLD.is_enabled IS DISTINCT FROM true) THEN
    NEW.consecutive_failures := 0;
    NEW.last_error_type := NULL;
    NEW.last_error_message := NULL;
  ELSIF NEW.min_price_override IS NOT NULL AND NEW.max_price_override IS NOT NULL
        AND (OLD.min_price_override IS NULL OR OLD.max_price_override IS NULL) THEN
    NEW.consecutive_failures := 0;
    NEW.last_error_type := NULL;
    NEW.last_error_message := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- One-time targeted backfill: clear the stamp ONLY where both bounds are
-- ALREADY set right now — direct proof of resolution, not an assumption.
-- Rows with still-missing bounds are deliberately left alone (previous
-- migration's reasoning still applies to them).
UPDATE public.repricer_assignments
SET consecutive_failures = 0,
    last_error_type = NULL,
    last_error_message = NULL
WHERE consecutive_failures > 0
  AND min_price_override IS NOT NULL
  AND max_price_override IS NOT NULL;
