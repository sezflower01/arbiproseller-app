-- 1. Add fees_invalid flag for runtime ROI safety
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS fees_invalid boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sales_orders_fees_invalid
  ON public.sales_orders(user_id, fees_invalid)
  WHERE fees_invalid = true;

-- 2. Clear corrupt asin_fee_cache rows where median fee is implausibly high
--    Heuristic: fba_fee_fixed > $7 AND learned from old/sparse history
DELETE FROM public.asin_fee_cache
WHERE asin = 'B004AGM25Q'
  AND fba_fee_fixed > 7
  AND fee_source IN ('learned_history', 'learned_history_old');

-- 3. Reset stale fee snapshots on pending B004AGM25Q orders so next enrich recomputes
UPDATE public.sales_orders
SET total_fees = NULL,
    fba_fee = NULL,
    referral_fee = NULL,
    closing_fee = NULL,
    fees_source = 'pending_recompute',
    fees_missing = true,
    roi = 0,
    fees_invalid = true
WHERE asin = 'B004AGM25Q'
  AND total_fees > 7
  AND (sold_price IS NULL OR sold_price <= 12);

-- 4. Mark any other order across the system where fees > 70% of sold_price as invalid
--    so ROI display can hide it until reconciled
UPDATE public.sales_orders
SET fees_invalid = true,
    roi = 0
WHERE sold_price > 0
  AND total_fees IS NOT NULL
  AND total_fees > sold_price * 0.7
  AND order_status NOT IN ('Cancelled', 'Canceled')
  AND is_cancelled = false;