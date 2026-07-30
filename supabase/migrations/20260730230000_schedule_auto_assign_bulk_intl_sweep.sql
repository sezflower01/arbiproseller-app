-- Automates discovery of new non-US (CA/MX/BR) repricer assignments, which
-- previously only happened when an admin manually clicked "Verify {marketplace}
-- listings" in the Repricer UI (its Step 1 calls auto-assign-bulk for the
-- current user only). verify-intl-listings-existence-6h already automates
-- re-checking EXISTING assignments every 6h, but nothing automated the
-- discovery of brand-new ones — confirmed via a live cron.job query
-- (2026-07-30) that no cron job referenced auto-assign-bulk at all.
--
-- Scheduled 15 minutes before verify-intl-listings-existence-6h (:20) so
-- newly-discovered assignments are included in that same verification pass.
--
-- Uses the x-internal-secret + vault.decrypted_secrets pattern (confirmed
-- working in 20260728184500_auto_detect_primary_marketplace.sql), NOT the
-- 'Bearer ' || current_setting('app.settings.service_role_key') pattern used
-- by older cron jobs in this file's history — that setting is unconfigured
-- on this database and silently 401s. auto-assign-bulk-intl-sweep uses
-- requireInternalCall, which needs exactly this header.
SELECT cron.schedule(
  'auto-assign-bulk-intl-sweep-6h',
  '5 */6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/auto-assign-bulk-intl-sweep',
    headers := (SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret',decrypted_secret::text) FROM vault.decrypted_secrets WHERE name='INTERNAL_SYNC_SECRET' LIMIT 1),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
