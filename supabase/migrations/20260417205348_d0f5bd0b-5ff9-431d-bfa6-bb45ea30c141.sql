-- Add freshness tracking to scan_categories
ALTER TABLE public.scan_categories
  ADD COLUMN IF NOT EXISTS last_scanned_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_successful_scan_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_scan_categories_last_scanned_at
  ON public.scan_categories (last_scanned_at DESC NULLS LAST);

-- Backfill from store_scan_runs (most recent run per category)
UPDATE public.scan_categories sc
SET last_scanned_at = sub.max_started,
    last_successful_scan_at = sub.max_completed
FROM (
  SELECT category_id,
         MAX(created_at) AS max_started,
         MAX(CASE WHEN status = 'completed' THEN COALESCE(completed_at, created_at) END) AS max_completed
  FROM public.store_scan_runs
  WHERE category_id IS NOT NULL
  GROUP BY category_id
) sub
WHERE sc.id = sub.category_id;

-- Trigger: keep last_scanned_at fresh as runs progress
CREATE OR REPLACE FUNCTION public.fn_update_scan_category_freshness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.category_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.scan_categories
  SET last_scanned_at = GREATEST(COALESCE(last_scanned_at, NEW.created_at), NEW.created_at),
      last_successful_scan_at = CASE
        WHEN NEW.status = 'completed'
          THEN GREATEST(COALESCE(last_successful_scan_at, COALESCE(NEW.completed_at, NEW.created_at)),
                        COALESCE(NEW.completed_at, NEW.created_at))
        ELSE last_successful_scan_at
      END,
      updated_at = now()
  WHERE id = NEW.category_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_store_scan_runs_update_category_freshness ON public.store_scan_runs;
CREATE TRIGGER trg_store_scan_runs_update_category_freshness
AFTER INSERT OR UPDATE OF status, completed_at ON public.store_scan_runs
FOR EACH ROW
EXECUTE FUNCTION public.fn_update_scan_category_freshness();