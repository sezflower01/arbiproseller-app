-- Fix: repricer_eval_acks_autofill_business_reason() has been referencing
-- NEW.marketplace_id since 2026-05-13, but repricer_eval_acks has no such
-- column (it uses `marketplace`, a short code like 'US'/'CA'/'MX'/'BR').
-- Every INSERT/UPDATE OF reason on this table has been throwing
-- "record 'new' has no field 'marketplace_id'" (42703) ever since -- silently,
-- because every caller upserts fire-and-forget without awaiting/logging the
-- error. Confirmed live: the last successful write was 2026-05-13T01:16:10,
-- 20 seconds before this trigger was replaced with the buggy version at
-- 01:16:30. repricer_price_actions kept getting written fine throughout
-- (separate insert, unaffected), which is why real repricing never stopped
-- even though this table, and everything that reads it (duplicate-eval
-- suppression + hourly rate-cap logic in repricer-unified-dispatch, and the
-- Automation Status "0 writes/0 evals" display) has been blind for 2+ months.
CREATE OR REPLACE FUNCTION public.repricer_eval_acks_autofill_business_reason()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.reason_business IS NULL AND NEW.reason IS NOT NULL THEN
    NEW.reason_business := public.repricer_translate_reason(NEW.reason);
  END IF;

  IF NEW.strategy_state IS NULL AND NEW.user_id IS NOT NULL AND NEW.asin IS NOT NULL THEN
    NEW.strategy_state := public.get_active_strategy_state(
      NEW.user_id,
      NEW.asin,
      COALESCE(NEW.marketplace, 'ATVPDKIKX0DER')
    );
  END IF;

  RETURN NEW;
END;
$$;
