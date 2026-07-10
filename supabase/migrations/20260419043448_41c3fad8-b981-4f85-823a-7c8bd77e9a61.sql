-- 1. Helper function: map raw availability text → normalized enum
CREATE OR REPLACE FUNCTION public.normalize_availability_text(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  s text;
BEGIN
  IF raw IS NULL THEN
    RETURN 'unknown';
  END IF;

  s := lower(trim(raw));
  IF s = '' THEN
    RETURN 'unknown';
  END IF;

  -- Strip schema.org URL prefixes
  s := replace(s, 'https://schema.org/', '');
  s := replace(s, 'http://schema.org/', '');
  s := trim(s);

  -- Out of stock signals (check first — strongest negative signal)
  IF s ~ '(out[\s_-]?of[\s_-]?stock|outofstock|sold[\s_-]?out|soldout|unavailable|discontinued|notify[\s_-]?me|currently[\s_-]?unavailable|no[\s_-]?longer[\s_-]?available)' THEN
    RETURN 'out_of_stock';
  END IF;

  -- Preorder signals
  IF s ~ '(pre[\s_-]?order|preorder|coming[\s_-]?soon|releases?[\s_-]?on|available[\s_-]?(soon|on))' THEN
    RETURN 'preorder';
  END IF;

  -- Backorder signals
  IF s ~ '(back[\s_-]?order|backorder|on[\s_-]?back[\s_-]?order)' THEN
    RETURN 'backorder';
  END IF;

  -- In-stock signals (positive — checked after negatives)
  IF s ~ '(in[\s_-]?stock|instock|available|add[\s_-]?to[\s_-]?(cart|bag|basket)|buy[\s_-]?now|ship[s]?[\s_-]?(today|now)|limitedavailability|limited[\s_-]?stock|only[\s]+\d+[\s]+left)' THEN
    RETURN 'in_stock';
  END IF;

  RETURN 'unknown';
END;
$$;

-- 2. store_scan_items: add normalized column
ALTER TABLE public.store_scan_items
  ADD COLUMN IF NOT EXISTS source_availability_status text NOT NULL DEFAULT 'unknown';

-- 3. extracted_product_data: add normalized column
ALTER TABLE public.extracted_product_data
  ADD COLUMN IF NOT EXISTS availability_status text NOT NULL DEFAULT 'unknown';

-- 4. category_products: add normalized column
ALTER TABLE public.category_products
  ADD COLUMN IF NOT EXISTS availability_status text NOT NULL DEFAULT 'unknown';

-- 5. Backfill existing rows from raw text
UPDATE public.store_scan_items
SET source_availability_status = public.normalize_availability_text(source_availability)
WHERE source_availability IS NOT NULL;

UPDATE public.extracted_product_data
SET availability_status = public.normalize_availability_text(availability)
WHERE availability IS NOT NULL;

UPDATE public.category_products
SET availability_status = public.normalize_availability_text(availability)
WHERE availability IS NOT NULL;

-- 6. Indexes for fast filtering
CREATE INDEX IF NOT EXISTS idx_store_scan_items_avail_status
  ON public.store_scan_items (source_availability_status);

CREATE INDEX IF NOT EXISTS idx_extracted_product_data_avail_status
  ON public.extracted_product_data (availability_status);

CREATE INDEX IF NOT EXISTS idx_category_products_avail_status
  ON public.category_products (availability_status);