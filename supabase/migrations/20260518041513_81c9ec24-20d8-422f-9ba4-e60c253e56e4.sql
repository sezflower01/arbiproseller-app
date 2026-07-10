DO $$
DECLARE v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET';
  PERFORM cron.unschedule(44);
  PERFORM cron.schedule(
    'reconcile-pending-prices-nightly',
    '0 3 * * *',
    format($cron$
      SELECT net.http_post(
        url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/reconcile-pending-prices',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-internal-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 300000
      );
    $cron$)
  );
END $$;