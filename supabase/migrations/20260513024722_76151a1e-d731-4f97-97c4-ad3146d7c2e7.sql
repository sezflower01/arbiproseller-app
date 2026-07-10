SELECT cron.unschedule('repricer-outcome-validate-2h') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repricer-outcome-validate-2h');

SELECT cron.schedule(
  'repricer-outcome-validate-2h',
  '23 */2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-outcome-validate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('all_users', true),
    timeout_milliseconds := 300000
  );
  $$
);