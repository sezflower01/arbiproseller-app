-- Phase: discovery correctness — URL identity + new-listing tracking
-- Adds canonical url_key, supplier product_id, and is_new flag to store_scan_items
-- Adds products_new counter to store_scan_runs
-- Backfills existing rows with a best-effort url_key derived from source_url.

ALTER TABLE public.store_scan_items
  ADD COLUMN IF NOT EXISTS url_key TEXT,
  ADD COLUMN IF NOT EXISTS product_id TEXT,
  ADD COLUMN IF NOT EXISTS is_new BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.store_scan_runs
  ADD COLUMN IF NOT EXISTS products_new INTEGER NOT NULL DEFAULT 0;

-- Backfill url_key for legacy rows so the carry-over join works on next scan.
-- Uses the same normalization rules as the edge function: lowercased host
-- (stripped www), pathname with trailing slashes removed, no fragment, query
-- left intact for legacy rows (the function handles tracking-param stripping
-- on insert going forward).
UPDATE public.store_scan_items
SET url_key = lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(source_url, '#.*$', ''),
        '^https?://(www\.)?', ''
      ),
      '/+$', ''
    )
  )
WHERE url_key IS NULL;

-- Index for fast carry-over lookup. Not unique on legacy data (could have
-- duplicates), but unique going forward via (user_id, url_key) lookup logic
-- in the edge function.
CREATE INDEX IF NOT EXISTS idx_store_scan_items_user_urlkey
  ON public.store_scan_items (user_id, url_key);

CREATE INDEX IF NOT EXISTS idx_store_scan_items_user_productid
  ON public.store_scan_items (user_id, product_id)
  WHERE product_id IS NOT NULL;