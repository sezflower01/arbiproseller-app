
do $$
begin
  perform cron.unschedule('verify-intl-listings-existence-daily');
exception when others then null;
end $$;

select cron.schedule(
  'verify-intl-listings-existence-daily',
  '30 3 * * *',
  $$
  select net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/verify-intl-listings-existence',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := jsonb_build_object('mode','sweep','limit',500),
    timeout_milliseconds := 300000
  ) as request_id;
  $$
);
