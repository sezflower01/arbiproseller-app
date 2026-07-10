-- Add column for FBA Customer Return Per Unit Fee
ALTER TABLE public.financial_events_cache 
ADD COLUMN IF NOT EXISTS fba_customer_return_fees NUMERIC DEFAULT 0;