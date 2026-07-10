
CREATE OR REPLACE FUNCTION public.repair_sales_orders_asin_for_user(p_user_id uuid, p_days int DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fixed int := 0;
  v_skipped_multiitem int := 0;
  v_scanned int := 0;
  r record;
  v_correct_asin text;
  v_sibling_exists boolean;
BEGIN
  FOR r IN
    SELECT so.id, so.order_id, so.asin, so.sku, so.user_id
    FROM public.sales_orders so
    WHERE so.user_id = p_user_id
      AND so.order_date >= (now() - make_interval(days => p_days))::date
      AND so.sku IS NOT NULL AND so.sku <> ''
      AND so.asin ~ '^[A-Z0-9]{10}$'
  LOOP
    v_scanned := v_scanned + 1;

    SELECT fm.asin INTO v_correct_asin
    FROM public.fnsku_map fm
    JOIN public.user_spapi_credentials c ON c.seller_id = fm.seller_id
    WHERE c.user_id = r.user_id
      AND fm.seller_sku = r.sku
    LIMIT 1;

    IF v_correct_asin IS NULL OR v_correct_asin = r.asin OR v_correct_asin !~ '^[A-Z0-9]{10}$' THEN
      CONTINUE;
    END IF;

    -- Multi-item-safe: if a sibling row already exists for the same order with the
    -- candidate ASIN, both rows are legitimate line items — leave them alone.
    SELECT EXISTS (
      SELECT 1 FROM public.sales_orders sib
      WHERE sib.user_id = r.user_id
        AND sib.order_id = r.order_id
        AND sib.asin = v_correct_asin
        AND sib.id <> r.id
    ) INTO v_sibling_exists;

    IF v_sibling_exists THEN
      v_skipped_multiitem := v_skipped_multiitem + 1;
      CONTINUE;
    END IF;

    BEGIN
      UPDATE public.sales_orders
      SET asin = v_correct_asin
      WHERE id = r.id;
      v_fixed := v_fixed + 1;
    EXCEPTION WHEN unique_violation THEN
      -- Defensive: should not happen given the sibling check above
      v_skipped_multiitem := v_skipped_multiitem + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'scanned', v_scanned,
    'fixed', v_fixed,
    'skipped_multiitem', v_skipped_multiitem
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.repair_sales_orders_asin_for_user(uuid, int) TO authenticated, service_role;
