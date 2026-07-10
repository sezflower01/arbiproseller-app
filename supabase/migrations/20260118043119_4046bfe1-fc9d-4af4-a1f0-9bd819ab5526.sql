-- Make fee columns nullable to support NULL for unavailable fees
ALTER TABLE public.sales_orders 
  ALTER COLUMN referral_fee DROP NOT NULL,
  ALTER COLUMN fba_fee DROP NOT NULL,
  ALTER COLUMN closing_fee DROP NOT NULL,
  ALTER COLUMN total_fees DROP NOT NULL;

-- Set default to NULL instead of 0
ALTER TABLE public.sales_orders 
  ALTER COLUMN referral_fee SET DEFAULT NULL,
  ALTER COLUMN fba_fee SET DEFAULT NULL,
  ALTER COLUMN closing_fee SET DEFAULT NULL,
  ALTER COLUMN total_fees SET DEFAULT NULL;