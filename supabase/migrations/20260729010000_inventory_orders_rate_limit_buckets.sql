-- Extends the shared api_rate_limits token-bucket (already used for
-- fees_api/order_items_api) to the two highest-traffic ungated SP-API
-- operations found in an ecosystem-wide audit: FBA Inventory's
-- getInventorySummaries (rescue-inventory-asin, driven by a 1-minute cron)
-- and Orders API's getOrders (fetch-live-orders' main polling call).
-- Rates match Amazon's published defaults.

-- FBA Inventory API getInventorySummaries: default ~2 req/sec, burst 2.
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('inventory_api', 2, 2, 2.0)
ON CONFLICT (bucket) DO NOTHING;

-- Orders API getOrders: default ~0.0167 req/sec (1/min), burst 20.
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('orders_api', 20, 20, 0.0167)
ON CONFLICT (bucket) DO NOTHING;
