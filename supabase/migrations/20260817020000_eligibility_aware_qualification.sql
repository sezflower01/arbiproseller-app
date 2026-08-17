-- Exclude restricted ASINs from auto-search, and let the user decide about
-- gated ones.
--
-- A restricted ASIN cannot be sold at any price, so researching a source for
-- it is pure waste -- and expensive waste: a search costs a CSE query, up to
-- three Gemini text verdicts, three vision compares and a scrape. Checking
-- eligibility first costs one listings_api call, a quota running at 5 req/s
-- with far more headroom than the chain it avoids.
--
-- Gated ('approval_required') items are a different case: they are often worth
-- sourcing BEFORE applying for approval, so they stay searchable by default
-- and the user can opt out.
--
-- No new eligibility store is introduced. check-product-eligibility already
-- persists every verdict to user_approved_products, UNIQUE (user_id, asin,
-- marketplace) with a lowercase approval_status -- the same rows that feed the
-- EligibilityBadge in the UI. The worker reads that table, so badge and filter
-- can never disagree about a product.

ALTER TABLE public.auto_source_config
  ADD COLUMN IF NOT EXISTS search_needs_approval boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.auto_source_config.search_needs_approval IS
  'When true (default) gated ASINs are auto-searched. Restricted ASINs are ALWAYS excluded and are not affected by this setting.';

-- The worker looks up verdicts by (user, marketplace, asin) for a batch of
-- ASINs at a time. The existing indexes are on user_id and asin separately,
-- which does not serve that shape.
CREATE INDEX IF NOT EXISTS idx_user_approved_lookup
  ON public.user_approved_products (user_id, marketplace, asin);
