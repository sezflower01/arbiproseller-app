SELECT cron.unschedule('repricer-intelligence-build-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repricer-intelligence-build-daily');
SELECT cron.unschedule('repricer-business-advisor-weekly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repricer-business-advisor-weekly');

SELECT cron.schedule(
  'repricer-intelligence-build-daily',
  '40 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-intelligence-build',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('all_users', true),
    timeout_milliseconds := 300000
  );
  $$
);

SELECT cron.schedule(
  'repricer-business-advisor-weekly',
  '10 4 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-business-advisor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('all_users', true),
    timeout_milliseconds := 300000
  );
  $$
);