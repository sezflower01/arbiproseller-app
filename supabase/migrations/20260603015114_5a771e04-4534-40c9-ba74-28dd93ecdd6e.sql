UPDATE public.sales_orders
SET
  referral_fee = ROUND((referral_fee * quantity)::numeric, 2),
  fba_fee      = ROUND((fba_fee      * quantity)::numeric, 2),
  closing_fee  = ROUND((closing_fee  * quantity)::numeric, 2),
  total_fees   = ROUND(((referral_fee + fba_fee + closing_fee) * quantity)::numeric, 2),
  roi = CASE
    WHEN total_cost > 0 THEN
      ROUND((((COALESCE(estimated_price,0) * quantity)
              - ((referral_fee + fba_fee + closing_fee) * quantity)
              - total_cost) / total_cost * 1000)::numeric) / 10
    ELSE roi
  END,
  updated_at = now()
WHERE order_id = '111-6532175-4583458'
  AND asin = 'B08BYX3C46'
  AND quantity = 4
  AND fba_fee = 3.39
  AND referral_fee = 1.09;