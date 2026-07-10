-- Schedule nightly SP-API existence check for non-US repricer assignments.
-- Verifies each non-US listing still exists in Seller Central; flips
-- intl_listing_status='NOT_FOUND' on 404 so the UI hides ghost rows in
-- CA/MX/BR/EU tabs without affecting US.
SELECT cron.schedule(
  'verify-intl-listings-existence-daily',
  '30 3 * * *',
  $$
  SELECT net.http_post(
    url:='https://mstibdszibcheodvnprm.supabase.co/functions/v1/verify-intl-listings-existence',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body:=jsonb_build_object('mode','sweep','limit',500),
    timeout_milliseconds:=300000
  );
  $$
);
