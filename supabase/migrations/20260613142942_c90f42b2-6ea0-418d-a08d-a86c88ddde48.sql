
CREATE OR REPLACE FUNCTION public.repair_sales_orders_asin_for_user(p_user_id uuid, p_days int DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fixed int := 0;
  v_deleted int := 0;
  v_scanned int := 0;
  r record;
  v_correct_asin text;
  v_correct_title text;
  v_correct_image text;
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

    -- Pull canonical title/image for the correct ASIN from this user's inventory
    SELECT inv.title, inv.image_url
      INTO v_correct_title, v_correct_image
    FROM public.inventory inv
    WHERE inv.user_id = r.user_id AND inv.asin = v_correct_asin
    ORDER BY inv.updated_at DESC NULLS LAST
    LIMIT 1;

    BEGIN
      UPDATE public.sales_orders
      SET asin      = v_correct_asin,
          title     = COALESCE(v_correct_title, title),
          image_url = COALESCE(v_correct_image, image_url)
      WHERE id = r.id;
      v_fixed := v_fixed + 1;
    EXCEPTION WHEN unique_violation THEN
      -- A sibling row with the correct ASIN already exists for this order — drop the ghost
      DELETE FROM public.sales_orders WHERE id = r.id;
      v_deleted := v_deleted + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('scanned', v_scanned, 'fixed', v_fixed, 'deleted', v_deleted);
END
$$;

GRANT EXECUTE ON FUNCTION public.repair_sales_orders_asin_for_user(uuid, int) TO authenticated, service_role;
