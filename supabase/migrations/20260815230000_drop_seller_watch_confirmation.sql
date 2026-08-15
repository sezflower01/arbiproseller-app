-- Remove the seller-watch double opt-in machinery.
--
-- It was modelled on price_alerts, where confirmation genuinely matters:
-- there, notify_email can be any address someone types in, so the click-
-- through proves the requester owns the inbox. A seller watch's notify_email
-- is always the caller's OWN already-verified Supabase account email, so
-- there was nothing to prove and the round-trip was pure friction.
--
-- create-seller-watch has inserted rows straight to 'active' for a while, so
-- this is dead-code removal, not a behaviour change. The leftovers were
-- actively misleading: reading the schema suggested watches needed
-- confirming when nothing in the product ever asked for it.
--
-- Removed alongside this migration:
--   * supabase/functions/confirm-seller-watch/  (orphaned; zero callers)
--   * the "seller-watch-confirm" branch + EmailType in send-email
--
-- price_alerts keeps its own confirm_token and pending_confirmation status --
-- untouched here, and still required for the reason above.

-- Any row still parked in pending_confirmation would block the CHECK swap
-- below. Nothing can confirm them any more (the endpoint is gone), and they
-- were created by a user who explicitly asked to watch the seller, so adopt
-- them as active rather than stranding them. known_asin_list stays NULL, so
-- the worker seeds them on first check instead of alerting on the seller's
-- whole back catalogue.
UPDATE public.seller_watchlist
   SET status       = 'active',
       confirmed_at = COALESCE(confirmed_at, now())
 WHERE status = 'pending_confirmation';

ALTER TABLE public.seller_watchlist
  DROP CONSTRAINT IF EXISTS seller_watchlist_status_check;

ALTER TABLE public.seller_watchlist
  ADD CONSTRAINT seller_watchlist_status_check
  CHECK (status IN ('active', 'cancelled'));

-- Default was 'pending_confirmation' from the original migration; anything
-- inserted without an explicit status should now be live immediately.
ALTER TABLE public.seller_watchlist
  ALTER COLUMN status SET DEFAULT 'active';

DROP INDEX IF EXISTS public.idx_seller_watchlist_confirm_token;

ALTER TABLE public.seller_watchlist
  DROP COLUMN IF EXISTS confirm_token;
