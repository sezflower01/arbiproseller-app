
CREATE OR REPLACE FUNCTION public.repair_sales_orders_asin_for_user(
  p_user_id uuid,
  p_days int DEFAULT 30
)
RETURNS TABLE (
  repaired_count int,
  deleted_duplicate_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  v_caller_uid  uuid := auth.uid();
  v_seller_id   text;
  v_repaired    int := 0;
  v_deleted     int := 0;
  r record;
BEGIN
  -- ── Tenant-isolation guard ─────────────────────────────────────────────
  -- service_role (edge functions / cron) may repair any user's rows.
  -- Every other caller may ONLY repair their own rows.
  IF v_caller_role IS DISTINCT FROM 'service_role' THEN
    IF v_caller_uid IS NULL THEN
      RAISE EXCEPTION 'repair_sales_orders_asin_for_user: authentication required'
        USING ERRCODE = '42501';
    END IF;
    IF p_user_id <> v_caller_uid THEN
      RAISE EXCEPTION 'repair_sales_orders_asin_for_user: cannot repair another user''s orders'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Clamp p_days to a sane range (defence-in-depth).
  IF p_days IS NULL OR p_days <= 0 THEN
    p_days := 30;
  ELSIF p_days > 365 THEN
    p_days := 365;
  END IF;

  -- Resolve the user's Amazon seller_id.
  -- Prefer the credentials row's last_test_seller_id; fall back to newest fnsku_sync_history.
  SELECT c.last_test_seller_id INTO v_seller_id
  FROM public.user_spapi_credentials c
  WHERE c.user_id = p_user_id
  LIMIT 1;

  IF v_seller_id IS NULL THEN
    SELECT h.seller_id INTO v_seller_id
    FROM public.fnsku_sync_history h
    WHERE h.user_id = p_user_id
      AND h.seller_id IS NOT NULL
    ORDER BY h.created_at DESC
    LIMIT 1;
  END IF;

  IF v_seller_id IS NULL THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  FOR r IN
    SELECT
      so.id,
      so.order_id,
      so.asin        AS current_asin,
      so.sku         AS current_sku,
      so.marketplace,
      fm.asin        AS true_asin,
      fm.seller_sku  AS mapped_sku,
      inv.title      AS inv_title,
      inv.image_url  AS inv_image
    FROM public.sales_orders so
    JOIN public.fnsku_map fm
      ON fm.seller_id = v_seller_id
     AND (
          (so.sku  IS NOT NULL AND fm.seller_sku = so.sku)
       OR (so.asin IS NOT NULL AND fm.seller_sku = so.asin)
     )
    LEFT JOIN public.inventory inv
      ON inv.user_id = p_user_id
     AND inv.asin = fm.asin
    WHERE so.user_id = p_user_id
      AND so.order_date >= (CURRENT_DATE - (p_days || ' days')::interval)
      -- fnsku_map must hold a real ASIN shape (B0-prefix OR ISBN-10 for books)
      AND fm.asin ~ '^(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$'
      AND (
           so.asin IS DISTINCT FROM fm.asin
        OR so.asin IS NULL
        OR so.asin !~ '^(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$'
      )
  LOOP
    BEGIN
      UPDATE public.sales_orders so
      SET
        asin        = r.true_asin,
        sku         = COALESCE(so.sku, r.mapped_sku),
        title       = COALESCE(r.inv_title, so.title),
        image_url   = COALESCE(r.inv_image, so.image_url),
        asin_source = 'fnsku_map_repair',
        updated_at  = now()
      WHERE so.id = r.id
        AND so.user_id = p_user_id;

      v_repaired := v_repaired + 1;
    EXCEPTION
      WHEN unique_violation THEN
        DELETE FROM public.sales_orders
        WHERE id = r.id AND user_id = p_user_id;
        v_deleted := v_deleted + 1;
    END;
  END LOOP;

  RETURN QUERY SELECT v_repaired, v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.repair_sales_orders_asin_for_user(uuid, int) FROM public;
GRANT EXECUTE ON FUNCTION public.repair_sales_orders_asin_for_user(uuid, int) TO authenticated, service_role;
