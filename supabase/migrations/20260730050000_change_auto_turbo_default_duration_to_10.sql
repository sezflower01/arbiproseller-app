-- Default batch duration for Auto-Turbo Rotation was 30 minutes. Given the
-- real per-ASIN eval ceiling in repricer-unified-dispatch (HOT items cap at
-- 6-8 evals/hour, i.e. roughly once every 7-10 minutes), 30 minutes was far
-- more dwell time than needed for a batch to get a real evaluation, while
-- cycling through the alert pool much slower than necessary. 10 minutes
-- reliably gives a batch at least one real evaluation before rotating,
-- without sitting on it needlessly long.
ALTER TABLE public.repricer_settings
  ALTER COLUMN auto_turbo_duration_minutes SET DEFAULT 10;

-- Backfill only accounts still sitting on the untouched old default (30) --
-- anyone who deliberately picked a different value is left alone.
UPDATE public.repricer_settings
SET auto_turbo_duration_minutes = 10
WHERE auto_turbo_duration_minutes = 30;
