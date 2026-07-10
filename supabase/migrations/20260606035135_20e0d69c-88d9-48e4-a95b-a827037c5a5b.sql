
CREATE OR REPLACE FUNCTION public.reconcile_pending_revenue_review()
RETURNS TABLE(open_before integer, resolved integer, repaired integer, open_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open_before  integer := 0;
  v_resolved     integer := 0;
  v_repaired     integer := 0;
  v_open_after   integer := 0;
  r              record;
  v_expected     numeric;
  v_delta        numeric;
BEGIN
  SELECT count(*) INTO v_open_before
  FROM sales_correction_history h
  WHERE h.correction_type = 'pending_revenue_review_needed'
    AND NOT EXISTS (
      SELECT 1 FROM sales_correction_history h2
      WHERE h2.order_id = h.order_id
        AND h2.user_id  = h.user_id
        AND h2.correction_type IN (
          'pending_revenue_review_resolved',
          'pending_revenue_review_repaired_by_settlement'
        )
        AND h2.created_at >= h.created_at
    );

  FOR r IN
    SELECT DISTINCT ON (h.user_id, h.order_id)
           h.id AS audit_id, h.user_id, h.order_id, h.asin, h.sku, h.marketplace,
           h.created_at AS flagged_at,
           so.id AS so_id, so.quantity, so.sold_price, so.total_sale_amount,
           so.price_source, so.price_confidence, so.referral_fee, so.fba_fee,
           so.total_fees, so.unit_cost, so.shipping_price
    FROM sales_correction_history h
    JOIN sales_orders so
      ON so.order_id = h.order_id
     AND so.user_id  = h.user_id
    WHERE h.correction_type = 'pending_revenue_review_needed'
      AND NOT EXISTS (
        SELECT 1 FROM sales_correction_history h2
        WHERE h2.order_id = h.order_id
          AND h2.user_id  = h.user_id
          AND h2.correction_type IN (
            'pending_revenue_review_resolved',
            'pending_revenue_review_repaired_by_settlement'
          )
          AND h2.created_at >= h.created_at
      )
      AND (
        so.price_confidence = 'CONFIRMED'
        OR so.price_source IN ('financial_events','orders_itemprice','sold_price_intl','settlement')
      )
    ORDER BY h.user_id, h.order_id, h.created_at DESC
  LOOP
    v_expected := COALESCE(r.sold_price, 0) * COALESCE(r.quantity, 1);
    v_delta    := COALESCE(r.total_sale_amount, 0) - v_expected;

    IF r.quantity > 1
       AND r.sold_price > 0
       AND COALESCE(r.total_sale_amount, 0) < v_expected * 0.9 THEN

      UPDATE sales_orders
         SET total_sale_amount = v_expected,
             roi = CASE
                     WHEN COALESCE(unit_cost, 0) > 0 THEN
                       ((v_expected - COALESCE(total_fees,0) - (COALESCE(unit_cost,0) * r.quantity))
                         / NULLIF(COALESCE(unit_cost,0) * r.quantity, 0)) * 100
                     ELSE roi
                   END,
             updated_at = now()
       WHERE id = r.so_id;

      INSERT INTO sales_correction_history(
        user_id, order_id, asin, sku, marketplace,
        correction_type,
        previous_price_source, new_price_source,
        previous_unit_price,  new_unit_price,
        revenue_delta,
        corrected_at
      ) VALUES (
        r.user_id, r.order_id, r.asin, r.sku, r.marketplace,
        'pending_revenue_review_repaired_by_settlement',
        r.price_source, r.price_source,
        r.sold_price, r.sold_price,
        v_expected - COALESCE(r.total_sale_amount, 0),
        now()
      );
      v_repaired := v_repaired + 1;
    ELSE
      INSERT INTO sales_correction_history(
        user_id, order_id, asin, sku, marketplace,
        correction_type,
        previous_price_source, new_price_source,
        previous_unit_price,  new_unit_price,
        revenue_delta,
        corrected_at
      ) VALUES (
        r.user_id, r.order_id, r.asin, r.sku, r.marketplace,
        'pending_revenue_review_resolved',
        r.price_source, r.price_source,
        r.sold_price, r.sold_price,
        v_delta,
        now()
      );
      v_resolved := v_resolved + 1;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_open_after
  FROM sales_correction_history h
  WHERE h.correction_type = 'pending_revenue_review_needed'
    AND NOT EXISTS (
      SELECT 1 FROM sales_correction_history h2
      WHERE h2.order_id = h.order_id
        AND h2.user_id  = h.user_id
        AND h2.correction_type IN (
          'pending_revenue_review_resolved',
          'pending_revenue_review_repaired_by_settlement'
        )
        AND h2.created_at >= h.created_at
    );

  RETURN QUERY SELECT v_open_before, v_resolved, v_repaired, v_open_after;
END;
$$;
