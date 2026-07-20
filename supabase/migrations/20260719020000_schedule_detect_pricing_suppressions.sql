-- detect-pricing-suppressions-all is a purpose-built fan-out wrapper for
-- exactly this job (its own header comment calls it a "nightly per-user
-- pricing-suppression detector"), but nothing ever scheduled it -- no
-- cron.job entry, no config.toml section, no GitHub Action. The only
-- caller in the whole codebase was the frontend's "Check now" button, and
-- even that requires TWO separate clicks with a clean read each time to
-- actually clear a resolved suppression (see the two-strike logic in
-- detect-pricing-suppressions/index.ts). Net effect: a listing the user
-- fixed on Amazon stayed stuck showing "Suppressed" in the Repricer UI
-- indefinitely unless someone manually clicked Check Now twice.
--
-- Scheduling it nightly (per the code's own stated intent) so both strikes
-- of the clear can happen automatically over two nights without any manual
-- action, on top of the same-file fixes to the re-check query (suppressed
-- rows are now re-checked regardless of enabled/rule_id) and to
-- verify-listing-pricing (the Reactivate button's live check now also
-- feeds the two-strike clear instead of being purely informational).
SELECT cron.schedule(
  'detect-pricing-suppressions-nightly',
  '30 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/detect-pricing-suppressions-all',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-nightly-pricing-suppressions', 'time', now()::text),
    timeout_milliseconds := 300000
  );
  $cron$
);
