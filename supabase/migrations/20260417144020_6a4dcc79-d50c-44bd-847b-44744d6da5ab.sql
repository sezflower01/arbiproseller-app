ALTER TABLE public.store_scan_items
  ADD COLUMN IF NOT EXISTS amz_candidates jsonb,
  ADD COLUMN IF NOT EXISTS match_confidence text,
  ADD COLUMN IF NOT EXISTS normalized_query text;