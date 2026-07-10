CREATE OR REPLACE FUNCTION public.save_mobile_scan_cost_memory(
  _asin text,
  _barcode text DEFAULT NULL,
  _total_cost numeric DEFAULT NULL,
  _units integer DEFAULT 1,
  _sale_price_override numeric DEFAULT NULL
)
RETURNS public.mobile_scan_cost_memory
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _clean_asin text := NULLIF(upper(trim(_asin)), '');
  _clean_barcode text := NULLIF(trim(_barcode), '');
  _safe_units integer := GREATEST(1, COALESCE(_units, 1));
  _row public.mobile_scan_cost_memory;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF _clean_asin IS NULL THEN
    RAISE EXCEPTION 'ASIN is required';
  END IF;

  -- Do not let empty/zero saves wipe a valid saved cost.
  IF _total_cost IS NOT NULL AND _total_cost <= 0 THEN
    _total_cost := NULL;
  END IF;

  -- ASIN-backed rows should not also occupy the barcode unique key when the
  -- barcode is just the ASIN. This avoids conflicts with historical scan rows.
  IF _clean_barcode = _clean_asin THEN
    _clean_barcode := NULL;
  END IF;

  -- Clean up old duplicates for this user/ASIN before saving.
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC) AS rn
    FROM public.mobile_scan_cost_memory
    WHERE user_id = _user_id
      AND upper(coalesce(asin, '')) = _clean_asin
  )
  DELETE FROM public.mobile_scan_cost_memory m
  USING ranked r
  WHERE m.id = r.id
    AND r.rn > 1;

  SELECT * INTO _row
  FROM public.mobile_scan_cost_memory
  WHERE user_id = _user_id
    AND upper(coalesce(asin, '')) = _clean_asin
  ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
  LIMIT 1;

  IF FOUND THEN
    UPDATE public.mobile_scan_cost_memory
    SET
      asin = _clean_asin,
      barcode = COALESCE(_clean_barcode, barcode),
      total_cost = COALESCE(_total_cost, total_cost),
      units = CASE WHEN _total_cost IS NOT NULL THEN _safe_units ELSE COALESCE(units, _safe_units) END,
      sale_price_override = COALESCE(_sale_price_override, sale_price_override),
      updated_at = now()
    WHERE id = _row.id
    RETURNING * INTO _row;
  ELSE
    INSERT INTO public.mobile_scan_cost_memory (
      user_id, barcode, asin, total_cost, units, sale_price_override, updated_at
    ) VALUES (
      _user_id, _clean_barcode, _clean_asin, _total_cost, _safe_units, _sale_price_override, now()
    )
    RETURNING * INTO _row;
  END IF;

  RETURN _row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_mobile_scan_cost_memory(text, text, numeric, integer, numeric) TO authenticated;