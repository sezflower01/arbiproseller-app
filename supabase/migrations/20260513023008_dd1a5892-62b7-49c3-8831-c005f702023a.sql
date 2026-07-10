SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname = 'repricer-executive-summary-daily';

SELECT cron.schedule(
  'repricer-executive-summary-daily',
  '30 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-executive-summary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('all_users', true),
    timeout_milliseconds := 300000
  );
  $$
);