-- A controlled list of retailers to search for sources, replacing open-web search.
--
-- WHY: find-source-candidates searched the entire web minus a six-site
-- blocklist, so it returned whatever Google surfaced -- a Costa Rican
-- cross-border reseller, Instacart storefronts, aggregator pages. Every one of
-- those still consumed the full verification chain (a Gemini text verdict, a
-- vision compare) before being discarded or shown as a useless candidate.
-- Constraining the search is cheaper AND better: fewer wasted verifications,
-- and results a person can actually buy from.
--
-- It also fixes price coverage indirectly. Price extraction is unreliable
-- against arbitrary pages, but a fixed set of ~11 retailers can be measured
-- and tuned per domain -- which is what price_success/price_attempts below are
-- for. A retailer that never yields a price is visible rather than assumed.
--
-- NOT reusing the existing `retailers` table: that is {id, name} only, has no
-- domain column, is admin-managed and global, and belongs to the leads/ASIN
-- uploader. Overloading it would couple two unrelated features.

CREATE TABLE IF NOT EXISTS public.source_retailers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Bare registrable domain, no scheme or www. Matching is done on the
  -- candidate URL's hostname suffix, so "walmart.com" also covers
  -- "www.walmart.com" and regional subdomains.
  domain text NOT NULL,
  label text,
  enabled boolean NOT NULL DEFAULT true,
  -- Per-domain outcome counters. The point of a curated list is being able to
  -- drop what does not earn its place, which requires evidence rather than
  -- impressions.
  search_hits integer NOT NULL DEFAULT 0,
  price_attempts integer NOT NULL DEFAULT 0,
  price_success integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, domain)
);

ALTER TABLE public.source_retailers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "source_retailers own" ON public.source_retailers;
CREATE POLICY "source_retailers own" ON public.source_retailers
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "source_retailers service" ON public.source_retailers;
CREATE POLICY "source_retailers service" ON public.source_retailers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_source_retailers_enabled
  ON public.source_retailers (user_id) WHERE enabled;

-- Whether to fall back to open-web search when the allowlist yields nothing.
-- Default TRUE: an empty result is worse than an imperfect one, and turning
-- the allowlist into a hard wall on day one would silently reduce coverage
-- before anyone has seen how well the eleven seeds perform.
ALTER TABLE public.auto_source_config
  ADD COLUMN IF NOT EXISTS allow_open_web_fallback boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.auto_source_config.allow_open_web_fallback IS
  'When true, a search that finds nothing at the allowlisted retailers retries across the open web. Turn off for allowlist-only.';

-- Seed the eleven major US general-merchandise retailers for every existing
-- user. Idempotent, so re-running cannot duplicate or resurrect a domain the
-- user has since disabled -- ON CONFLICT DO NOTHING deliberately does not
-- touch `enabled`.
INSERT INTO public.source_retailers (user_id, domain, label)
SELECT u.id, d.domain, d.label
FROM auth.users u
CROSS JOIN (VALUES
  ('walmart.com',   'Walmart'),
  ('target.com',    'Target'),
  ('bestbuy.com',   'Best Buy'),
  ('homedepot.com', 'Home Depot'),
  ('lowes.com',     'Lowe''s'),
  ('costco.com',    'Costco'),
  ('samsclub.com',  'Sam''s Club'),
  ('kohls.com',     'Kohl''s'),
  ('macys.com',     'Macy''s'),
  ('wayfair.com',   'Wayfair'),
  -- Overstock rebranded: overstock.com now 301s to bedbathandbeyond.com. Both
  -- are seeded because a `site:overstock.com` restriction would otherwise match
  -- almost nothing while still looking like an active retailer in the UI.
  ('overstock.com', 'Overstock'),
  ('bedbathandbeyond.com', 'Bed Bath & Beyond'),
  -- Both are supplier_scan_profiles domains with real extraction history in
  -- store_scan_items (GameStop 47 products, Culinary Depot 8), so they are
  -- known-scrapable rather than assumed-scrapable.
  ('gamestop.com', 'GameStop'),
  ('culinarydepotinc.com', 'Culinary Depot')
) AS d(domain, label)
ON CONFLICT (user_id, domain) DO NOTHING;

-- New users get the same starting set, otherwise their first searches would
-- silently run unconstrained -- the exact behaviour this table exists to stop.
CREATE OR REPLACE FUNCTION public.seed_default_source_retailers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.source_retailers (user_id, domain, label)
  SELECT NEW.id, d.domain, d.label
  FROM (VALUES
    ('walmart.com',   'Walmart'),
    ('target.com',    'Target'),
    ('bestbuy.com',   'Best Buy'),
    ('homedepot.com', 'Home Depot'),
    ('lowes.com',     'Lowe''s'),
    ('costco.com',    'Costco'),
    ('samsclub.com',  'Sam''s Club'),
    ('kohls.com',     'Kohl''s'),
    ('macys.com',     'Macy''s'),
    ('wayfair.com',   'Wayfair'),
    ('overstock.com', 'Overstock'),
    ('bedbathandbeyond.com', 'Bed Bath & Beyond'),
  -- Both are supplier_scan_profiles domains with real extraction history in
  -- store_scan_items (GameStop 47 products, Culinary Depot 8), so they are
  -- known-scrapable rather than assumed-scrapable.
  ('gamestop.com', 'GameStop'),
  ('culinarydepotinc.com', 'Culinary Depot')
  ) AS d(domain, label)
  ON CONFLICT (user_id, domain) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Record per-domain outcomes in one round trip.
--
-- The counters only mean anything if they are cheap enough to always write, so
-- the worker sends one call per search carrying every domain it touched rather
-- than an UPDATE per candidate.
--
-- Matches on the exact canonical domain, which the caller has already resolved
-- while post-filtering -- NOT on the candidate URL's hostname. Suffix matching
-- in SQL would be slow and would have to duplicate logic the function already
-- ran. Rows are never created here: an open-web fallback result is not on the
-- allowlist and must not silently add itself to it.
CREATE OR REPLACE FUNCTION public.bump_source_retailer_stats(
  p_user_id uuid,
  p_stats jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.source_retailers r
  SET search_hits    = r.search_hits    + COALESCE(s.hits, 0),
      price_attempts = r.price_attempts + COALESCE(s.price_attempts, 0),
      price_success  = r.price_success  + COALESCE(s.price_success, 0),
      updated_at     = now()
  FROM jsonb_to_recordset(p_stats)
    AS s(domain text, hits int, price_attempts int, price_success int)
  WHERE r.user_id = p_user_id
    AND r.domain = s.domain;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_source_retailer_stats(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.bump_source_retailer_stats(uuid, jsonb) TO service_role;

DROP TRIGGER IF EXISTS trg_seed_source_retailers ON auth.users;
CREATE TRIGGER trg_seed_source_retailers
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.seed_default_source_retailers();
