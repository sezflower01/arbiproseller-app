-- smart-engine-evaluate-outcomes classifies applied tuning recommendations
-- (3-14 days old) as improved/worse/neutral/inconclusive by comparing their
-- pre/post outcome snapshots. It existed but was never scheduled -- nothing
-- has ever populated outcome_direction, so the graduation mechanism added to
-- SmartEngineLearning.tsx (auto-approving proven recommendation types) could
-- never actually trigger. Runs daily, 30 minutes after the snapshot job
-- (smart-engine-outcome-snapshot-daily, 2:00 AM UTC) so that day's snapshots
-- are already written.

DO $$
BEGIN
  PERFORM cron.unschedule('smart-engine-evaluate-outcomes-daily');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'smart-engine-evaluate-outcomes-daily',
  '30 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/smart-engine-evaluate-outcomes',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := jsonb_build_object('source', 'cron_daily', 'triggered_at', now())
  );
  $$
);
