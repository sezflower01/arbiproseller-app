-- Track when primary_marketplace was last auto-detected, so the UI can show
-- "auto-detected on <date> from sales volume" instead of a manual dropdown.
ALTER TABLE public.repricer_settings
  ADD COLUMN IF NOT EXISTS primary_marketplace_detected_at timestamptz;

-- Weekly fan-out: recompute each seller's primary marketplace from trailing
-- 90-day sales volume (converted to USD) rather than relying on a manual
-- setting that's easy to leave wrong and materially changes repricer
-- dispatch behavior. Monday 08:00 UTC.
--
-- NOTE: deliberately uses the x-internal-secret + vault pattern (confirmed
-- live to actually work), not 'Bearer ' || current_setting('app.settings.
-- service_role_key', true) — that setting is unconfigured on this database
-- (returns NULL), so every existing cron job using it has been silently
-- getting a 401 on every run. Flagged separately; not fixed here to keep
-- this migration scoped to its own feature.
SELECT cron.schedule(
  'repricer-detect-primary-marketplace-weekly',
  '0 8 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/repricer-detect-primary-marketplace',
    headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text) FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
    body := jsonb_build_object('all_users', true),
    timeout_milliseconds := 300000
  );
  $$
);
