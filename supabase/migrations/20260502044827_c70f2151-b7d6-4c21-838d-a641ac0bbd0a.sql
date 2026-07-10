ALTER TABLE public.mobile_scan_history
  ADD COLUMN IF NOT EXISTS total_cost numeric,
  ADD COLUMN IF NOT EXISTS units integer,
  ADD COLUMN IF NOT EXISTS sale_price_override numeric;