ALTER TABLE public.store_scan_items
  ADD COLUMN IF NOT EXISTS confidence_score integer,
  ADD COLUMN IF NOT EXISTS confidence_band text,
  ADD COLUMN IF NOT EXISTS price_sanity text,
  ADD COLUMN IF NOT EXISTS review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS match_quality_signals jsonb;

CREATE INDEX IF NOT EXISTS idx_store_scan_items_review_required
  ON public.store_scan_items (run_id, review_required)
  WHERE review_required = true;

CREATE INDEX IF NOT EXISTS idx_store_scan_items_confidence_band
  ON public.store_scan_items (run_id, confidence_band);