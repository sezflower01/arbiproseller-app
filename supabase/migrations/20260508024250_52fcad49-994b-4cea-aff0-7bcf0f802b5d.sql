-- Add a column to flag SKU mismatches detected at submit time
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS sku_validation_status text,
  ADD COLUMN IF NOT EXISTS sku_validation_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS sku_validation_message text;

-- One-off data fix for B0FK2YGWR2 (user 020dd71f-78ce-4bc2-9117-dc997c533ab9)
DO $$
DECLARE
  v_user uuid := '020dd71f-78ce-4bc2-9117-dc997c533ab9';
  v_asin text := 'B0FK2YGWR2';
  v_real_sku text := '4V-B0CA-7USP';
  v_keeper uuid;
BEGIN
  -- Pick the most-recently-updated assignment as keeper
  SELECT id INTO v_keeper
  FROM public.repricer_assignments
  WHERE user_id = v_user AND asin = v_asin AND marketplace = 'US'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_keeper IS NOT NULL THEN
    -- Delete duplicates first to free the unique slot
    DELETE FROM public.repricer_assignments
    WHERE user_id = v_user AND asin = v_asin AND marketplace = 'US' AND id <> v_keeper;

    -- Rewrite the keeper to the real Amazon SKU + correct fulfillment
    UPDATE public.repricer_assignments
    SET sku = v_real_sku,
        fulfillment_type = 'FBM',
        sku_validation_status = 'reconciled_manual',
        sku_validation_checked_at = now(),
        sku_validation_message = 'Manually reconciled to live Amazon SKU 4V-B0CA-7USP',
        updated_at = now()
    WHERE id = v_keeper;
  END IF;

  -- Update created_listings to reflect the real SKU (both synthetic rows -> real)
  UPDATE public.created_listings
  SET sku = v_real_sku,
      updated_at = now()
  WHERE user_id = v_user AND asin = v_asin AND sku <> v_real_sku;
END$$;