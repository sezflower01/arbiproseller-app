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
      COALESCE(NEW.marketplace_id, 'ATVPDKIKX0DER')
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_eval_acks_autofill_business ON public.repricer_eval_acks;
CREATE TRIGGER trg_eval_acks_autofill_business
  BEFORE INSERT OR UPDATE OF reason ON public.repricer_eval_acks
  FOR EACH ROW
  EXECUTE FUNCTION public.repricer_eval_acks_autofill_business_reason();