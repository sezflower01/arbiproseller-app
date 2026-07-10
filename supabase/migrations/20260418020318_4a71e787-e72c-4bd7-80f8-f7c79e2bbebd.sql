-- Add detection metadata to scan_categories (admin-curated)
ALTER TABLE public.scan_categories
  ADD COLUMN IF NOT EXISTS detected_from_url text,
  ADD COLUMN IF NOT EXISTS detection_confidence text CHECK (detection_confidence IN ('high','medium','low')),
  ADD COLUMN IF NOT EXISTS detection_source text CHECK (detection_source IN ('breadcrumb','json_ld','url_path','ai','manual')),
  ADD COLUMN IF NOT EXISTS detection_path text;

-- Add per-product inferred category metadata
ALTER TABLE public.category_products
  ADD COLUMN IF NOT EXISTS inferred_category_name text,
  ADD COLUMN IF NOT EXISTS inferred_category_path text,
  ADD COLUMN IF NOT EXISTS inferred_category_url text,
  ADD COLUMN IF NOT EXISTS category_confidence text CHECK (category_confidence IN ('high','medium','low')),
  ADD COLUMN IF NOT EXISTS category_source text CHECK (category_source IN ('breadcrumb','json_ld','url_path','ai','manual'));

CREATE INDEX IF NOT EXISTS idx_category_products_inferred_category
  ON public.category_products (inferred_category_name)
  WHERE inferred_category_name IS NOT NULL;