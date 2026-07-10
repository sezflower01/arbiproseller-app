
-- Auto-disable repricer assignments when inventory available drops to 0
-- and auto re-enable when stock returns
CREATE OR REPLACE FUNCTION public.fn_auto_disable_zero_stock_assignments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- When available drops to 0 (or NULL), disable matching repricer assignments
  IF (COALESCE(NEW.available, 0) = 0) AND (COALESCE(OLD.available, 0) > 0) THEN
    UPDATE public.repricer_assignments
    SET is_enabled = false
    WHERE user_id = NEW.user_id
      AND asin = NEW.asin
      AND is_enabled = true;
  END IF;

  -- When available goes from 0 to >0, re-enable matching assignments
  IF (COALESCE(NEW.available, 0) > 0) AND (COALESCE(OLD.available, 0) = 0) THEN
    UPDATE public.repricer_assignments
    SET is_enabled = true
    WHERE user_id = NEW.user_id
      AND asin = NEW.asin
      AND is_enabled = false;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_disable_zero_stock
AFTER UPDATE OF available ON public.inventory
FOR EACH ROW
EXECUTE FUNCTION public.fn_auto_disable_zero_stock_assignments();
