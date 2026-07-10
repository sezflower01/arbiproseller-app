-- Ensure Product Analyzer and extension cost saves can use ON CONFLICT (user_id, asin)
-- safely for every ASIN-backed row, regardless of barcode value.

-- Remove any remaining duplicate ASIN-backed rows per user, keeping the newest row.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, asin
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM public.mobile_scan_cost_memory
  WHERE asin IS NOT NULL
)
DELETE FROM public.mobile_scan_cost_memory m
USING ranked r
WHERE m.id = r.id
  AND r.rn > 1;

-- Add a real unique index that matches upsert onConflict: "user_id,asin".
-- PostgreSQL still allows multiple rows where asin is NULL, so barcode-only rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS mobile_scan_cost_memory_user_asin_full_uniq
ON public.mobile_scan_cost_memory (user_id, asin);

-- Keep lookup fast for ASIN cost retrieval.
CREATE INDEX IF NOT EXISTS mobile_scan_cost_memory_user_asin_updated_idx
ON public.mobile_scan_cost_memory (user_id, asin, updated_at DESC)
WHERE asin IS NOT NULL;