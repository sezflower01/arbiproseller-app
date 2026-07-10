ALTER TABLE public.store_scan_items
  ADD COLUMN IF NOT EXISTS last_refresh_status TEXT,
  ADD COLUMN IF NOT EXISTS last_refresh_error TEXT,
  ADD COLUMN IF NOT EXISTS last_refresh_at TIMESTAMPTZ;