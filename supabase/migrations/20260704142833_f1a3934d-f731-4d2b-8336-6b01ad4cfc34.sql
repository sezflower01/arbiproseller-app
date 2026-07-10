
SELECT cron.unschedule('full-inventory-refresh-2h');

SELECT cron.schedule(
  'full-inventory-refresh-2h',
  '15 */2 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/full-inventory-refresh-all',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object(
      'triggered_by', 'cron-2h-per-user',
      'user_id',      u.user_id::text,
      'time',         now()::text
    ),
    timeout_milliseconds := 300000
  )
  FROM (
    SELECT c.user_id
    FROM public.user_spapi_credentials c
    WHERE c.refresh_token_enc IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.repricer_assignments a
        WHERE a.user_id = c.user_id
          AND a.rule_id IS NOT NULL
          AND a.is_enabled = true
      )
  ) u;
  $cron$
);
