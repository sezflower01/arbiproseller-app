-- inventory_missing_review previously only got populated by a manual
-- "Scan Now" click on the admin-only /tools/inventory-review page. In
-- practice that meant it was run once (2026-07-04) and never again -- 33
-- flagged rows sat unreviewed for over two weeks, and other suspicious
-- SKUs (e.g. persistently-unconfirmed inbound quantities) were never
-- caught at all since nobody re-ran the scan. inventory-review-scan is
-- read-only (never touches the inventory table itself), so running it
-- automatically on a schedule carries no risk of corrupting stock data --
-- it only keeps the review queue current.
SELECT cron.schedule(
  'inventory-review-scan-6h',
  '20 */6 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/inventory-review-scan-all',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-6h', 'time', now()::text),
    timeout_milliseconds := 300000
  );
  $cron$
);
