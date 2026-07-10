ALTER TABLE public.category_scan_jobs
  ADD COLUMN IF NOT EXISTS miss_pass_skipped boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS miss_pass_skip_reason text,
  ADD COLUMN IF NOT EXISTS extracted_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS previous_extracted_count integer;