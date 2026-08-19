-- Price floor for strict mode.
--
-- Not a taste threshold, an arithmetic one. Total FBA fees measured $6.63 on a
-- real captured row, so a $10 item leaves under $3.40 to cover BOTH the source
-- cost and any profit. Items below the floor were never sourceable at any cost,
-- which makes searching for a supplier unconditionally wasted budget.
--
-- Costs no API call: new_price_cents is already captured during detection by
-- the Keepa call check-seller-watchlist makes anyway.
--
-- NULL price passes. That is "capture did not happen", not "cheap" -- failing
-- unknowns closed would let a Keepa outage silently empty the search queue,
-- the same principle as the other strict-mode rules.
ALTER TABLE public.auto_source_config
  ADD COLUMN IF NOT EXISTS strict_min_price_cents integer NOT NULL DEFAULT 1200
    CHECK (strict_min_price_cents >= 0 AND strict_min_price_cents <= 1000000);

COMMENT ON COLUMN public.auto_source_config.strict_min_price_cents IS
  'Minimum Amazon sell price in cents for strict mode to spend a search. Default 1200 ($12): measured FBA fees of $6.63 leave under $3.40 at $10 to cover cost AND profit. Only applies when strict_mode is on.';
