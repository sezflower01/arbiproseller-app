-- Title keyword/phrase exclusions.
--
-- Reuses source_excluded_terms with a third `kind` rather than a new table:
-- the shape, the RLS policy and the UI are identical to brands, and the only
-- difference is the matching rule, which lives in code
-- (_shared/title-exclusions.ts), not in the schema.
--
-- The MATCHING RULE IS DIFFERENT, which is why 'title_keyword' is a distinct
-- kind and not just more 'brand' rows:
--   brand          exact match on the whole brand field
--   title_keyword  word-boundary match inside a sentence-length title
-- Mixing them would silently apply one rule where the user expected the other.
-- The UI shows them as two separate lists for the same reason.
--
-- NOT SEEDED. Unlike categories and brands, there is no prior hardcoded list to
-- preserve, and -- as with brands -- the contents are the user's own research.
-- Nothing here should ever be auto-populated from Amazon restriction data.

ALTER TABLE public.source_excluded_terms
  DROP CONSTRAINT IF EXISTS source_excluded_terms_kind_check;

ALTER TABLE public.source_excluded_terms
  ADD CONSTRAINT source_excluded_terms_kind_check
  CHECK (kind IN ('category', 'brand', 'title_keyword'));
