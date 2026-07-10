-- BACKFILL: Fix rows where total_sale_amount = sold_price but quantity > 1
-- These are incorrectly stored as unit values instead of line totals

UPDATE public.sales_orders
SET
  total_sale_amount = COALESCE(sold_price, 0) * COALESCE(quantity, 1),
  referral_fee      = COALESCE(referral_fee, 0) * COALESCE(quantity, 1),
  fba_fee           = COALESCE(fba_fee, 0) * COALESCE(quantity, 1),
  closing_fee       = COALESCE(closing_fee, 0) * COALESCE(quantity, 1),
  total_fees        = COALESCE(total_fees, 0) * COALESCE(quantity, 1)
WHERE
  COALESCE(quantity, 1) > 1
  AND COALESCE(sold_price, 0) > 0
  AND ABS(COALESCE(total_sale_amount, 0) - COALESCE(sold_price, 0)) < 0.02;