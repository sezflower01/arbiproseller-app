
ALTER TABLE public.store_scan_runs
  ADD COLUMN IF NOT EXISTS products_unmatched integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS products_blocked integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS products_failed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failure_reasons jsonb NOT NULL DEFAULT '{}'::jsonb;
