
-- Seed schedule rows for all existing inventory users
INSERT INTO public.live_verify_schedule (user_id, next_run_at)
SELECT DISTINCT user_id, now()
FROM public.inventory
ON CONFLICT (user_id) DO NOTHING;

-- Create the cron job to trigger scheduled-live-verify every 4 hours
SELECT cron.schedule(
  'scheduled-live-verify',
  '0 */4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/scheduled-live-verify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := jsonb_build_object('time', now()::text)
  ) AS request_id;
  $$
);
