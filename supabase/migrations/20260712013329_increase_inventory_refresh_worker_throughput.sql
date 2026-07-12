-- Option A (see .lovable/inventory-refresh-cron-vs-button-report.md): raise
-- inventory-refresh-worker-1m's drain rate. Live batch_size was patched down
-- to 5 by migration 20260531162907; DEFAULT_BATCH in source is a fallback
-- that this cron never hits because it always sends batch_size explicitly.
-- Bumping schedule to every minute + batch_size 5 -> 60 = 60 SKUs/min.
DO $$
DECLARE
  v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'inventory-refresh-worker-1m';
  IF v_cmd IS NOT NULL THEN
    v_cmd := regexp_replace(v_cmd, '''batch_size'',\s*5\b', '''batch_size'', 60', 'g');
    PERFORM cron.unschedule('inventory-refresh-worker-1m');
    PERFORM cron.schedule('inventory-refresh-worker-1m', '*/1 * * * *', v_cmd);
  END IF;
END $$;
