-- Fix the two MX orders for ASIN B0CLLR8K8Q that have broken fx_recalc prices of $0.79
UPDATE public.sales_orders
SET 
  sold_price = estimated_price,
  total_sale_amount = estimated_price,
  price_source = 'manual_fix',
  referral_fee = estimated_price * 0.15,
  fba_fee = 5.04,
  total_fees = (estimated_price * 0.15) + 5.04,
  fees_source = 'manual_fix',
  updated_at = now()
WHERE order_id IN ('701-1687603-6495446', '702-9888112-5445817')
  AND asin = 'B0CLLR8K8Q'
  AND marketplace = 'MX'
  AND price_source = 'fx_recalc'
  AND sold_price < 1;