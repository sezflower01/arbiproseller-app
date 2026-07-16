-- auto-assign-bulk stamps consecutive_failures=1 + last_error_type/message
-- when it can't finish auto-activating a newly-detected inbound ASIN
-- (missing cost / no live price / bounds unavailable / no default rule).
-- Those fields were only ever cleared back to 0/null by a SUBSEQUENT
-- auto-assign-bulk pass for that same row finding the gate now clear.
-- Any other path that re-enables the row (sync-intl-marketplace, the
-- cleanup job, a manual toggle) left them stamped forever, so
-- deriveAssignmentStatus (which treats is_enabled=true as unconditionally
-- "Active") showed a healthy-looking Active row still carrying a stale
-- "1 fail" badge in the Actions column.
--
-- Fix at the data layer instead of chasing every write path: whenever a
-- row transitions into is_enabled=true (from false or null), clear the
-- failure stamp as part of that same update. last_disabled_by/reason/at
-- are left untouched — they're historical audit trail, not consulted
-- once is_enabled=true, so clearing them isn't needed for this bug and
-- would just discard useful "why was this last disabled" history.
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
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_repricer_failure_stamp_on_enable ON public.repricer_assignments;
CREATE TRIGGER trg_clear_repricer_failure_stamp_on_enable
BEFORE UPDATE ON public.repricer_assignments
FOR EACH ROW
EXECUTE FUNCTION public.clear_repricer_failure_stamp_on_enable();

-- Deliberately NO backfill here. Rows already showing "1 fail" today were
-- checked during investigation: last_evaluated_at is null on all of them,
-- meaning most still genuinely lack the cost data the stamp says they're
-- missing — the badge is real signal, not staleness, until that's fixed.
-- Blindly zeroing consecutive_failures for every currently-enabled+flagged
-- row would hide that real problem instead of just fixing the mechanism
-- that let it go stale. Existing rows will self-clear once whatever
-- actually re-enables them next (after the real gate is resolved) passes
-- through this trigger.
