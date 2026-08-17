-- Amazon fees at detection time, so ROI is instant client-side arithmetic.
--
-- Stored rather than computed on demand. Fees come from the SP-API Fees API,
-- which needs the SELL PRICE as an input -- so it cannot be derived in the
-- browser from cached data, and computing it when the Done tab opens would
-- burst one API call per visible row every time someone looks at the page.
-- Captured once, overnight, bounded by qualified volume (~4% of detections).
--
-- fees_api is a DIFFERENT bucket from the contended pricing_api: measured
-- 2026-08-17, capacity 2 / refill 1 per second, versus pricing_api at
-- capacity 1 / refill 0.5 shared with the repricer's uncoordinated limiter.
-- That separation is the whole reason this is affordable.
ALTER TABLE public.seller_watch_new_listings
  ADD COLUMN IF NOT EXISTS referral_fee_cents integer,
  ADD COLUMN IF NOT EXISTS fba_fee_cents integer,
  ADD COLUMN IF NOT EXISTS total_fees_cents integer,
  ADD COLUMN IF NOT EXISTS fees_captured_at timestamptz;

COMMENT ON COLUMN public.seller_watch_new_listings.total_fees_cents IS
  'SP-API Fees API TotalFeesEstimate, priced against new_price_cents. NULL means fees were never obtained -- ROI must show unavailable, never assume a rate.';
COMMENT ON COLUMN public.seller_watch_new_listings.fees_captured_at IS
  'Fees are priced against a specific sell price; if that price moves the fees are stale. Paired with price_captured_at.';
