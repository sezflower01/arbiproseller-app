-- Fix: the "auto-sync-sales-every-10-minutes" cron job (the only thing that
-- keeps sales_orders fresh in the background, independent of a user opening
-- the app) has been calling sync-sales-orders with a STALE, no-longer-valid
-- anon key baked into its net.http_post() call at creation time.
--
-- pg_cron's cron.job_run_details only reflects whether the net.http_post()
-- SQL call itself queued successfully — NOT whether the target endpoint
-- actually accepted the request. Every invocation of this job has in fact
-- been failing with 401 Unauthorized ("UNAUTHORIZED_LEGACY_JWT") at the
-- Supabase gateway, before sync-sales-orders' own code ever runs — real
-- HTTP outcomes are only visible in net._http_response, which is not
-- surfaced anywhere in the app.
--
-- Confirmed: of 74 currently-scheduled cron jobs, this was the ONLY one
-- still using the stale key (iat 1735581662) — every other job already
-- uses the current valid anon key (iat 1743810755, matching
-- src/integrations/supabase/client.ts's SUPABASE_PUBLISHABLE_KEY).
--
-- Net effect: the automated background sales sync has been silently
-- non-functional. The only path that ever refreshed sales_orders was a
-- user directly opening the app (which authenticates with a live user
-- session, not this stale key) — matching the reported symptom exactly
-- ("Live Sales only updates when I check it").
--
-- cron.unschedule('auto-sync-sales-every-10-minutes') cannot remove the
-- old job: it's owned by the `supabase_read_only_user` Postgres role, and
-- pg_cron's unschedule()/schedule() functions both enforce
-- `username = current_user` internally — neither a direct-connection
-- superuser-style role nor the SQL Editor session (both run as `postgres`)
-- can touch a job owned by a different role, and direct writes to
-- cron.job are separately blocked by table-level permissions. This is a
-- hard privilege boundary, not a bug, and was left as-is: the old job
-- keeps firing every 10 minutes and 401ing harmlessly (it never reaches
-- sync-sales-orders' code, so there's no double-processing risk).
--
-- Applied 2026-08-05 via the Supabase SQL Editor (jobid 152, owned by
-- `postgres` this time, so it's manageable going forward). Reproduced here
-- verbatim for the historical record — running this file again is a no-op
-- if the job already exists under this name (cron.schedule updates rather
-- than duplicates), and harmless if it doesn't.

SELECT cron.schedule(
  'auto-sync-sales-every-10-minutes-v2',
  '*/10 * * * *',
  $$
  SELECT
    net.http_post(
      url:='https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-sales-orders',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc"}'::jsonb,
      body:='{"sync_all_users": true}'::jsonb,
      timeout_milliseconds:=120000
    ) AS request_id;
  $$
);
