SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname IN (
  'repricer-opportunity-score-30m',
  'repricer-commercial-adapt-hourly',
  'repricer-strategy-memory-daily'
);

SELECT cron.schedule(
  'repricer-opportunity-score-30m',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-opportunity-score',
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
  'repricer-commercial-adapt-hourly',
  '17 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-commercial-adapt',
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
  'repricer-strategy-memory-daily',
  '30 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-strategy-memory-build',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('all_users', true),
    timeout_milliseconds := 300000
  );
  $$
);