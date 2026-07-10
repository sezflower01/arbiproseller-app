-- Fix stale FBA fee for B0CTJ4J3JJ (was $4.89, now $2.91 per Amazon API)
UPDATE asin_fee_cache 
SET fba_fee_fixed = 2.91, 
    referral_rate = 0.14989939637826963,
    updated_at = now()
WHERE asin = 'B0CTJ4J3JJ' AND marketplace = 'US';

-- Recalculate fees for pending orders of this ASIN
-- Order 114-4662205-9373852: qty=2, sold_price=$9.94
-- FBA: 2.91 * 2 = 5.82, Referral: 9.94 * 0.15 * 2 = 2.98, Total = 8.80
UPDATE sales_orders 
SET fba_fee = 5.82,
    referral_fee = 2.98,
    total_fees = 8.80,
    fees_source = 'learned_history'
WHERE asin = 'B0CTJ4J3JJ' 
  AND order_status = 'Pending';
