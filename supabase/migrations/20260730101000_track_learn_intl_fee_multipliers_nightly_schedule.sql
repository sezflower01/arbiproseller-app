-- learn-intl-fee-multipliers-nightly (jobid 97) was already scheduled and
-- active in the live database at '10 6 * * *' (6:10 AM UTC daily), but had
-- no corresponding migration in this repo -- pure config drift, likely set
-- up directly against the database at some point. This migration exists
-- purely to bring that existing schedule under version control so a
-- rebuild-from-migrations wouldn't silently lose it; it is NOT a new
-- schedule and does not change timing or behavior.
--
-- Verified no conflict at this time slot: nothing else is scheduled at
-- 6:10 AM. Nearest neighbors are refresh-fx-rates-daily / clean-ghost-
-- listings-12h at 6:00 (10 min before) and reconcile-pending-revenue-
-- review-daily / inventory-review-scan-6h / verify-intl-listings-
-- existence-6h at 6:20 (10 min after) -- all lightweight, none doing heavy
-- inventory refresh or settlement sync work that this job's read-only
-- DB queries + upserts would meaningfully contend with.

DO $$
DECLARE v_jobid INT;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'learn-intl-fee-multipliers-nightly';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule(
  'learn-intl-fee-multipliers-nightly',
  '10 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/learn-intl-fee-multipliers',
    headers := '{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc"}'::jsonb,
    body := jsonb_build_object('source', 'cron', 'scheduled_at', now()),
    timeout_milliseconds := 300000
  );
  $$
);
