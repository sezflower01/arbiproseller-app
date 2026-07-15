-- Seller feedback rating (from Keepa's /seller response, already fetched
-- by resolveSellerNames() for names/isAmazon — no extra Keepa cost to also
-- store rating here). current_rating is 0-100 (% positive); current_rating_count
-- is the seller's lifetime rating count.
ALTER TABLE public.keepa_seller_name_cache
  ADD COLUMN IF NOT EXISTS current_rating INTEGER,
  ADD COLUMN IF NOT EXISTS current_rating_count INTEGER;
