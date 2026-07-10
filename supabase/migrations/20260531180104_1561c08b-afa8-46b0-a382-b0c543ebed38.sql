-- Best-effort unschedule (ignore "job not found")
DO $$ BEGIN
  PERFORM cron.unschedule('prune-repricer-price-actions-nightly');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  PERFORM cron.unschedule('flush-api-token-dedupe-5m');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'prune-repricer-price-actions-nightly',
  '10 3 * * *',
  $$ SELECT public.prune_repricer_price_actions(60); $$
);

SELECT cron.schedule(
  'flush-api-token-dedupe-5m',
  '*/5 * * * *',
  $$ SELECT public.flush_api_token_recent_consumption(); $$
);