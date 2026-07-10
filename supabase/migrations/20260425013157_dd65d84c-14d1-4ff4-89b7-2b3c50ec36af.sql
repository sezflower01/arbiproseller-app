-- Weekly catch-up: re-sync trailing 13 months of FBA shipments for all users.
-- Runs every Monday at 06:00 UTC. Reads anon key + internal secret from vault
-- so no user-specific data is embedded in the cron command.
DO $$
BEGIN
  -- Drop pre-existing job if present (idempotent)
  PERFORM cron.unschedule('catchup-fba-shipments-weekly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'catchup-fba-shipments-weekly');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'catchup-fba-shipments-weekly',
  '0 6 * * 1',  -- every Monday 06:00 UTC
  $cmd$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL' LIMIT 1)
           || '/functions/v1/catchup-fba-shipments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_ANON_KEY' LIMIT 1), ''),
      'x-internal-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1), '')
    ),
    body := jsonb_build_object('triggered_by', 'cron', 'time', now()::text)
  ) AS request_id;
  $cmd$
);