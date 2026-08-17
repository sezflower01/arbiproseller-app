-- Per-user "never search these" list for Find Source.
--
-- WHY a user list rather than more hardcoded constants: the domains worth
-- blocking split cleanly in two. Reddit, Wikipedia and YouTube are never a
-- retail product page for anybody -- those stay hardcoded in the edge function
-- as a structural floor, because making them editable only lets someone break
-- their own search. eBay, Etsy, Mercari and Poshmark are a judgement call:
-- resale noise to a wholesale buyer, a legitimate channel to someone doing
-- collectibles arbitrage. Those belong to the user.
--
-- Measured across 530 listings on 2026-08-17, the top domains Find Source was
-- returning included etsy (10), mercari (7) and poshmark (4) -- none of them in
-- any existing exclusion list. eBay was in QUERY_EXCLUSIONS but only as a query
-- hint on the open-web pass, with nothing filtering it afterwards.

CREATE TABLE IF NOT EXISTS public.source_excluded_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Bare registrable domain, no scheme or www. Matched by hostname suffix, so
  -- "ebay.com" also covers "www.ebay.com" and "motors.ebay.com".
  domain text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, domain)
);

-- Deliberately NO `enabled` column, unlike source_retailers. That table has one
-- because disabling preserves a retailer's accumulated hit-rate history; an
-- exclusion accumulates nothing, so remove-and-re-add loses nothing and one
-- fewer state is one fewer thing to reason about.

ALTER TABLE public.source_excluded_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "source_excluded_domains own" ON public.source_excluded_domains;
CREATE POLICY "source_excluded_domains own" ON public.source_excluded_domains
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "source_excluded_domains service" ON public.source_excluded_domains;
CREATE POLICY "source_excluded_domains service" ON public.source_excluded_domains
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_source_excluded_domains_user
  ON public.source_excluded_domains (user_id);

-- Seed. The four the user named, PLUS aliexpress/alibaba/wish -- those three
-- were already in the edge function's hardcoded QUERY_EXCLUSIONS, and moving
-- them into this table without seeding them would silently stop excluding them.
INSERT INTO public.source_excluded_domains (user_id, domain, label)
SELECT u.id, d.domain, d.label
FROM auth.users u
CROSS JOIN (VALUES
  ('ebay.com',       'eBay'),
  ('etsy.com',       'Etsy'),
  ('mercari.com',    'Mercari'),
  ('poshmark.com',   'Poshmark'),
  ('aliexpress.com', 'AliExpress'),
  ('alibaba.com',    'Alibaba'),
  ('wish.com',       'Wish')
) AS d(domain, label)
ON CONFLICT (user_id, domain) DO NOTHING;

CREATE OR REPLACE FUNCTION public.seed_default_excluded_domains()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.source_excluded_domains (user_id, domain, label)
  SELECT NEW.id, d.domain, d.label
  FROM (VALUES
    ('ebay.com',       'eBay'),
    ('etsy.com',       'Etsy'),
    ('mercari.com',    'Mercari'),
    ('poshmark.com',   'Poshmark'),
    ('aliexpress.com', 'AliExpress'),
    ('alibaba.com',    'Alibaba'),
    ('wish.com',       'Wish')
  ) AS d(domain, label)
  ON CONFLICT (user_id, domain) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_excluded_domains ON auth.users;
CREATE TRIGGER trg_seed_excluded_domains
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.seed_default_excluded_domains();

-- Retroactive cleanup: finished listings whose EVERY candidate now comes from
-- an excluded domain.
--
-- Adding an exclusion only changes future searches; rows already stored keep
-- showing the Etsy and Mercari links they were saved with. This is the catch-up
-- pass for them.
--
-- Scoped to 'candidates_found' on purpose. A row the user marked 'sourced' is
-- their own decision and is never deleted here, however its domain is now
-- classified. Rows with no candidates are already covered by the existing
-- delete-by-status action.
--
-- SECURITY INVOKER (the default) so the table's own RLS policy does the
-- scoping -- there is no user_id parameter to get wrong or to spoof.
CREATE OR REPLACE FUNCTION public.purge_excluded_only_listings(p_dry_run boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN 0;
  END IF;

  SELECT array_agg(l.id) INTO v_ids
  FROM public.seller_watch_new_listings l
  WHERE l.user_id = v_uid
    AND l.source_status = 'candidates_found'
    AND jsonb_typeof(l.candidates) = 'array'
    AND jsonb_array_length(l.candidates) > 0
    -- Keep the row if ANY candidate survives the exclusion list. A candidate
    -- with a null/absent domain counts as surviving, so a malformed entry
    -- errs towards keeping data rather than deleting it.
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(l.candidates) AS c
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.source_excluded_domains e
        WHERE e.user_id = v_uid
          AND (
            lower(c->>'domain') = e.domain
            OR lower(c->>'domain') LIKE '%.' || e.domain
          )
      )
    );

  v_count := COALESCE(array_length(v_ids, 1), 0);

  IF NOT p_dry_run AND v_count > 0 THEN
    DELETE FROM public.seller_watch_new_listings WHERE id = ANY(v_ids);
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_excluded_only_listings(boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.purge_excluded_only_listings(boolean) TO authenticated;
