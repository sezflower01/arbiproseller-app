-- Second installment of the SP-API rate-limit rollout, prioritizing every
-- remaining CRON-DRIVEN function (the ones that fire automatically and can
-- silently collide with anything else, regardless of user action) over
-- on-demand-only call sites. Rates are Amazon's documented per-operation
-- defaults where found via public SP-API docs; inbound_api uses a
-- conservative common default since the specific getInboundEligibility
-- rate wasn't published in the sources checked.

-- Catalog Items API getCatalogItem/searchCatalogItems: ~2 req/sec, burst 2.
-- Unlocks: enrich-missing-titles (*/10min), verify-intl-listings-existence
-- (daily), sync-fba-shipments (weekly), sync-intl-asin (trigger-fired).
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('catalog_api', 2, 2, 2.0)
ON CONFLICT (bucket) DO NOTHING;

-- Listings Items API getListingsItem/putListingsItem/etc: ~5 req/sec, burst 10.
-- Unlocks: fbm-quick-check (*/5min), sync-intl-asin (trigger-fired).
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('listings_api', 10, 10, 5.0)
ON CONFLICT (bucket) DO NOTHING;

-- Reports API createReport: ~0.0167 req/sec (1/min), burst 15 — much
-- tighter than the polling calls (getReport/getReportDocument), so kept as
-- its own bucket rather than lumped with reports_poll_api.
-- Unlocks: sync-fbm-cleanup (every 4h), sync-inventory-report (2-4h).
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('reports_create_api', 15, 15, 0.0167)
ON CONFLICT (bucket) DO NOTHING;

-- Reports API getReport/getReportDocument (status polling): ~2 req/sec, burst 15.
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('reports_poll_api', 15, 15, 2.0)
ON CONFLICT (bucket) DO NOTHING;

-- Finances API listFinancialEvents/EventGroups/ByOrderId: ~0.5 req/sec, burst 30.
-- Unlocks: poll-fbm-label-costs (*/30min).
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('finances_api', 30, 30, 0.5)
ON CONFLICT (bucket) DO NOTHING;

-- Sellers API getMarketplaceParticipations: ~0.016 req/sec, burst 15.
-- Unlocks: monitor-spapi-health (*/15min).
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('marketplace_participations_api', 15, 15, 0.016)
ON CONFLICT (bucket) DO NOTHING;

-- FBA Inbound API (shipments + eligibility): conservative default ~2
-- req/sec, burst 2 (specific published rate not found; kept conservative).
-- Unlocks: sync-fba-shipments (weekly).
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('inbound_api', 2, 2, 2.0)
ON CONFLICT (bucket) DO NOTHING;
