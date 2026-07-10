-- 1) Dedupe existing rows: for each (run_id, url_key) keep only the best row.
--    Priority: matched_asin not null first, then most recent created_at.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY run_id, url_key
           ORDER BY (CASE WHEN matched_asin IS NOT NULL THEN 0 ELSE 1 END),
                    created_at DESC
         ) AS rn
  FROM public.store_scan_items
  WHERE url_key IS NOT NULL
)
DELETE FROM public.store_scan_items
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2) Dedupe by (run_id, source_url) for rows where url_key is null (fallback path).
WITH ranked2 AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY run_id, source_url
           ORDER BY (CASE WHEN matched_asin IS NOT NULL THEN 0 ELSE 1 END),
                    created_at DESC
         ) AS rn
  FROM public.store_scan_items
  WHERE url_key IS NULL AND source_url IS NOT NULL
)
DELETE FROM public.store_scan_items
WHERE id IN (SELECT id FROM ranked2 WHERE rn > 1);

-- 3) Add partial unique indexes so future inserts can use ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_scan_items_run_urlkey
  ON public.store_scan_items (run_id, url_key)
  WHERE url_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_store_scan_items_run_sourceurl
  ON public.store_scan_items (run_id, source_url)
  WHERE url_key IS NULL AND source_url IS NOT NULL;