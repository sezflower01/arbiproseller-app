-- Per-user category and brand exclusions for auto-source qualification.
--
-- Both lists were hardcoded in _shared/source-qualification.ts. They are kept
-- as the SEED here rather than deleted, so behaviour is identical the moment
-- this lands and only changes when the user edits it.
--
-- One table with a `kind` discriminator instead of two: the shape, the RLS
-- policy, the seeding trigger and the UI are all identical, and duplicating
-- them twice over is how the two drift apart later.

CREATE TABLE IF NOT EXISTS public.source_excluded_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('category', 'brand')),
  -- Normalised for matching: trimmed, lowercased. `label` keeps what to show.
  value text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, value)
);

ALTER TABLE public.source_excluded_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "source_excluded_terms own" ON public.source_excluded_terms;
CREATE POLICY "source_excluded_terms own" ON public.source_excluded_terms
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "source_excluded_terms service" ON public.source_excluded_terms;
CREATE POLICY "source_excluded_terms service" ON public.source_excluded_terms
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_source_excluded_terms_user_kind
  ON public.source_excluded_terms (user_id, kind);

-- Categories: Amazon's ACTUAL websiteDisplayGroupName strings, which are not
-- what a person would call them -- 'Book' not "Books", 'DVD'/'Video' rather
-- than "Movies & TV". A list written from intuition matches nothing, which is
-- why these are copied verbatim from the probed set rather than retyped.
--
-- Brands: EXACT matches only. Measured 2026-08-17 against live SP-API data,
-- substring matching is unsafe -- "Publisher Unknown" is a real publisher that
-- a LIKE '%unknown%' would wrongly catch. 'Universal' and 'OEM' are
-- deliberately absent for the same reason: Universal Studios and Universal
-- Music are real brands, and OEM is a legitimate label on automotive parts.
--
-- A NULL brand is deliberately NOT seeded as a rule and must never be treated
-- as generic. Of 20 listings stored with brand NULL, SP-API returned a real
-- brand for 20 of 20 -- the nulls were a lookup-coverage artefact, not a
-- statement about the product.
INSERT INTO public.source_excluded_terms (user_id, kind, value, label)
SELECT u.id, t.kind, t.value, t.label
FROM auth.users u
CROSS JOIN (VALUES
  ('category', 'book',          'Book'),
  ('category', 'digital text',  'Digital Text (Kindle)'),
  ('category', 'magazine',      'Magazine'),
  ('category', 'music',         'Music'),
  ('category', 'digital music', 'Digital Music'),
  ('category', 'dvd',           'DVD'),
  ('category', 'video',         'Video'),
  ('category', 'video dvd',     'Video DVD'),
  ('category', 'blu-ray',       'Blu-ray'),
  ('brand',    'generic',       'Generic'),
  ('brand',    'unbranded',     'Unbranded'),
  ('brand',    'no brand',      'No Brand'),
  ('brand',    'nobrand',       'NoBrand'),
  ('brand',    'unknown',       'Unknown')
) AS t(kind, value, label)
ON CONFLICT (user_id, kind, value) DO NOTHING;

CREATE OR REPLACE FUNCTION public.seed_default_excluded_terms()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.source_excluded_terms (user_id, kind, value, label)
  SELECT NEW.id, t.kind, t.value, t.label
  FROM (VALUES
    ('category', 'book',          'Book'),
    ('category', 'digital text',  'Digital Text (Kindle)'),
    ('category', 'magazine',      'Magazine'),
    ('category', 'music',         'Music'),
    ('category', 'digital music', 'Digital Music'),
    ('category', 'dvd',           'DVD'),
    ('category', 'video',         'Video'),
    ('category', 'video dvd',     'Video DVD'),
    ('category', 'blu-ray',       'Blu-ray'),
    ('brand',    'generic',       'Generic'),
    ('brand',    'unbranded',     'Unbranded'),
    ('brand',    'no brand',      'No Brand'),
    ('brand',    'nobrand',       'NoBrand'),
    ('brand',    'unknown',       'Unknown')
  ) AS t(kind, value, label)
  ON CONFLICT (user_id, kind, value) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_excluded_terms ON auth.users;
CREATE TRIGGER trg_seed_excluded_terms
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.seed_default_excluded_terms();

-- What a rule would ACTUALLY affect, counted against the user's own listings.
--
-- This exists because websiteDisplayGroupName is coarse and sometimes plainly
-- wrong: live SP-API on 2026-08-17 returned productGroup 'Apparel' for a LEGO
-- minifigure and 'Shoes' for reading glasses. Excluding a category by name is
-- therefore a guess unless you can see what carries that label in YOUR data.
--
-- Returns every distinct category and brand present with its listing count, so
-- the UI can show the real impact before a rule is saved rather than after.
-- SECURITY INVOKER (default) so RLS scopes it -- no user_id parameter.
CREATE OR REPLACE FUNCTION public.qualification_exclusion_preview()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'categories', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'n')::int DESC)
      FROM (
        SELECT jsonb_build_object(
                 'value', lower(btrim(product_group)),
                 'label', product_group,
                 'n', count(*)
               ) AS x
        FROM public.seller_watch_new_listings
        WHERE product_group IS NOT NULL AND btrim(product_group) <> ''
        GROUP BY lower(btrim(product_group)), product_group
      ) c
    ), '[]'::jsonb),
    'brands', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'n')::int DESC)
      FROM (
        SELECT jsonb_build_object(
                 'value', lower(btrim(brand)),
                 'label', brand,
                 'n', count(*)
               ) AS x
        FROM public.seller_watch_new_listings
        WHERE brand IS NOT NULL AND btrim(brand) <> ''
        GROUP BY lower(btrim(brand)), brand
      ) b
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.qualification_exclusion_preview() FROM public;
GRANT EXECUTE ON FUNCTION public.qualification_exclusion_preview() TO authenticated;
