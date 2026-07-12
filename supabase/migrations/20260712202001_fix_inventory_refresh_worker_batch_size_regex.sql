-- Migration 20260712013329 intended to bump inventory-refresh-worker-1m's
-- live batch_size from 5 to 60, but used regexp_replace(..., '\b', ...) --
-- \b is not a reliable word-boundary assertion in PostgreSQL's regex engine
-- (PostgreSQL's own syntax for that is \y), so the substitution silently
-- no-opped. Verified directly: regexp_match against the live command with
-- the old pattern (including \b) returns null; the same pattern without \b
-- matches correctly. Confirmed via cron.job query afterward that only the
-- schedule half of that migration took effect -- batch_size was still 5.
--
-- Fix: skip regex entirely, use a plain literal-substring replace() --
-- no ambiguity possible. Verified against the live command text before
-- applying this migration; produces 'batch_size', 60 as expected.
DO $$
DECLARE
  v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'inventory-refresh-worker-1m';
  IF v_cmd IS NOT NULL THEN
    v_cmd := replace(v_cmd, '''batch_size'', 5', '''batch_size'', 60');
    PERFORM cron.unschedule('inventory-refresh-worker-1m');
    PERFORM cron.schedule('inventory-refresh-worker-1m', '*/1 * * * *', v_cmd);
  END IF;
END $$;
