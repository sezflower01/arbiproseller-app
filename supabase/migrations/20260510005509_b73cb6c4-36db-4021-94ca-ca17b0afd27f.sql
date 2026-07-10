
-- Merge duplicates: per (user_id, asin) keep the most recent row, set its barcode=NULL
WITH ranked AS (
  SELECT id, user_id, asin,
    ROW_NUMBER() OVER (PARTITION BY user_id, asin ORDER BY updated_at DESC, id DESC) AS rn
  FROM public.mobile_scan_cost_memory
  WHERE asin IS NOT NULL
)
DELETE FROM public.mobile_scan_cost_memory m
USING ranked r
WHERE m.id = r.id AND r.rn > 1;

-- Normalize remaining rows: clear barcode so the (user_id, asin) partial unique index covers them
UPDATE public.mobile_scan_cost_memory SET barcode = NULL WHERE barcode IS NOT NULL AND asin IS NOT NULL;
