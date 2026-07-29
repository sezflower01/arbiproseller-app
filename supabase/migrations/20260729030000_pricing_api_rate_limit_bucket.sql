-- Third installment of the SP-API rate-limit rollout, covering the
-- on-demand-only Product Pricing API v0 callers (getItemOffers,
-- getCompetitivePricing) outside the repricer, which already has its own
-- dedicated sp_api_rate_limit_state cadence tracker for this same API
-- family and is intentionally left untouched.

-- Product Pricing API v0 getItemOffers/getCompetitivePricing: Amazon's
-- documented default rate for both operations is 0.5 req/sec, burst 1.
-- Unlocks: fetch-live-orders, sync-sales-orders, personalhour-product-data,
-- mobile-scan-price-history, admin-process-asin-batch,
-- analyzer-product-snapshot, calculate-roi, check-amazon-price,
-- fetch-listing-prices, fetch-product-price, repair-pending-prices,
-- sync-fnsku-report.
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('pricing_api', 1, 1, 0.5)
ON CONFLICT (bucket) DO NOTHING;
