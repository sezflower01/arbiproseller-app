-- Amazon-side price at detection time, for ROI.
--
-- Cents, as Keepa reports them -- no float rounding on the way in, and the
-- caller decides the display currency. NULL means "not captured", which is
-- different from "free", and the UI must not treat it as zero.
ALTER TABLE public.seller_watch_new_listings
  ADD COLUMN IF NOT EXISTS amazon_price_cents integer,
  ADD COLUMN IF NOT EXISTS new_price_cents integer,
  ADD COLUMN IF NOT EXISTS price_captured_at timestamptz;

COMMENT ON COLUMN public.seller_watch_new_listings.amazon_price_cents IS
  'Keepa stats.current[0] -- Amazon''s own offer. NULL when Amazon does not sell it.';
COMMENT ON COLUMN public.seller_watch_new_listings.new_price_cents IS
  'Keepa stats.current[1] -- lowest New offer. The ROI proxy; NOT the buy-box price.';
COMMENT ON COLUMN public.seller_watch_new_listings.price_captured_at IS
  'When the price was read. A price is a point-in-time fact and goes stale; ROI computed from an old capture must say so.';
