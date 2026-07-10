SELECT cron.schedule(
  'detect-abuse-patterns-6h',
  '17 */6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/detect-abuse-patterns',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || current_setting('app.settings.service_role_key', true)),
    body := jsonb_build_object('windowDays', 90),
    timeout_milliseconds := 300000
  );
  $$
);