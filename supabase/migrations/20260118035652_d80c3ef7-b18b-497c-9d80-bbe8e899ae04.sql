-- Create trigger to enforce NULL fees when fees_source='unavailable'
-- This prevents any code path from accidentally storing 0 instead of NULL

CREATE OR REPLACE FUNCTION public.enforce_null_fees_when_unavailable()
RETURNS TRIGGER AS $$
BEGIN
  -- If fees_source is 'unavailable', enforce NULL for all fee columns
  IF NEW.fees_source = 'unavailable' THEN
    NEW.referral_fee = NULL;
    NEW.fba_fee = NULL;
    NEW.closing_fee = NULL;
    NEW.total_fees = NULL;
    NEW.fees_missing = TRUE;
  END IF;
  
  -- If any fee is explicitly 0 but fees_source is NOT 'fees_api' or 'from_cache' or 'actual',
  -- and sold_price > 0, mark as unavailable (legitimate pending orders)
  IF NEW.fees_source IS NULL AND NEW.sold_price > 0 AND 
     (NEW.referral_fee = 0 OR NEW.referral_fee IS NULL) AND 
     (NEW.fba_fee = 0 OR NEW.fba_fee IS NULL) THEN
    NEW.fees_source = 'unavailable';
    NEW.fees_missing = TRUE;
    NEW.referral_fee = NULL;
    NEW.fba_fee = NULL;
    NEW.closing_fee = NULL;
    NEW.total_fees = NULL;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS enforce_null_fees_trigger ON public.sales_orders;

-- Create trigger on INSERT and UPDATE
CREATE TRIGGER enforce_null_fees_trigger
  BEFORE INSERT OR UPDATE ON public.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_null_fees_when_unavailable();