-- enrich-missing-titles already fetched real product images/titles from
-- Amazon's Catalog API, but had two gaps: (1) its default scan only matched
-- missing/placeholder TITLES, so an ASIN with a fine title but a null
-- image_url was invisible to it entirely (confirmed: 1,127 inventory rows
-- account-wide had image_url IS NULL, none of them caught by title-only
-- filtering); (2) nothing ever called it proactively -- a page had to load
-- and trigger a one-off client-side scan for whatever was on screen at that
-- moment, which is neither reliable nor complete. Now scheduled every 10
-- minutes via the fan-out wrapper, small per-user batches (30 items) so a
-- large backlog can't hit a compute-time limit in one invocation.
SELECT cron.schedule(
  'enrich-missing-titles-10m',
  '*/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/enrich-missing-titles-all',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-10m', 'time', now()::text),
    timeout_milliseconds := 120000
  );
  $cron$
);
