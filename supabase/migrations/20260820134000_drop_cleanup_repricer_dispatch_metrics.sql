-- Drop cleanup_repricer_dispatch_metrics(integer). Dead and broken.
--
-- BROKEN: it deletes WHERE created_at < now() - make_interval(days => _keep_days),
-- but repricer_dispatch_metrics has no created_at column -- only cycle_started_at
-- and cycle_ended_at. `supabase db lint --level error` reports it as
-- 42703 column "created_at" does not exist. It could never have deleted a row.
--
-- DEAD: verified against the live database on 2026-08-20, not just the repo --
--   called_by_functions 0   (every non-internal function body scanned)
--   cron_jobs           0
--   triggers            0
--   views               0
-- and in the repo it appears only in the generated types file. Nothing invokes it.
--
-- Deleted rather than repaired because a function nothing calls has no correct
-- behaviour to restore; guessing which timestamp column the retention was meant
-- to use would just re-add dead code with a new assumption baked in. If metric
-- retention is wanted later, it should be written deliberately against the
-- columns that actually exist.
--
-- Recoverable from git history if that judgement turns out wrong.

DROP FUNCTION IF EXISTS public.cleanup_repricer_dispatch_metrics(integer);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'cleanup_repricer_dispatch_metrics'
  ) THEN
    RAISE EXCEPTION 'cleanup_repricer_dispatch_metrics still present -- another overload exists';
  END IF;
  RAISE NOTICE 'cleanup_repricer_dispatch_metrics dropped';
END $$;
