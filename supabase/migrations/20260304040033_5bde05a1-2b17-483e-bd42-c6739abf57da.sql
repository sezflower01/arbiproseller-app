CREATE OR REPLACE FUNCTION public.get_authoritative_period_totals(start_ts text, end_ts text)
RETURNS TABLE (
  sales numeric, refunds numeric, total_fees numeric, unique_orders bigint,
  refund_count bigint, row_count bigint, total_units bigint, cogs numeric,
  promotional_rebates_total numeric, shipping_credits_total numeric,
  gift_wrap_credits_total numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d
  ),
  base AS (
    SELECT *
    FROM public.financial_events_cache f
    CROSS JOIN bounds b
    WHERE f.user_id = auth.uid()
      AND f.event_date::date >= b.start_d
      AND f.event_date::date <  b.end_d
  ),
  shipment_counts AS (
    SELECT
      NULLIF(asin, '') AS raw_asin,
      COUNT(*)::bigint AS units
    FROM base
    WHERE event_type = 'shipment'
    GROUP BY 1
  ),
  -- Resolve SKU-in-ASIN-column to real ASIN via inventory table
  sku_to_asin AS (
    SELECT DISTINCT ON (sku) sku, asin
    FROM public.inventory
    WHERE user_id = auth.uid()
      AND sku IS NOT NULL AND sku != ''
      AND asin IS NOT NULL AND asin != ''
    ORDER BY sku, updated_at DESC
  ),
  -- Map each raw_asin to a resolved ASIN
  resolved_shipments AS (
    SELECT
      sc.raw_asin,
      sc.units,
      COALESCE(
        -- If raw_asin looks like a real ASIN (starts with B0 or is 10-char alphanumeric with letters), keep it
        CASE WHEN sc.raw_asin ~ '^[A-Z0-9]{10}$' AND sc.raw_asin ~ '[A-Z]' THEN sc.raw_asin ELSE NULL END,
        -- Otherwise treat raw_asin as SKU and resolve via inventory
        sta.asin,
        -- Last resort: keep raw_asin as-is
        sc.raw_asin
      ) AS resolved_asin
    FROM shipment_counts sc
    LEFT JOIN sku_to_asin sta ON sta.sku = sc.raw_asin
  ),
  latest_unit_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      CASE
        WHEN COALESCE(cost, 0) > 0 AND COALESCE(units, 0) > 0 THEN (cost / units)
        WHEN COALESCE(amount, 0) > 0 AND COALESCE(amount, 0) < 500 THEN amount
        WHEN COALESCE(cost, 0) > 0 AND COALESCE(cost, 0) < 500 THEN cost
        ELSE 0
      END AS unit_cost
    FROM public.created_listings
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL AND asin <> ''
    ORDER BY asin, updated_at DESC
  ),
  sales_orders_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      COALESCE(unit_cost, 0) AS unit_cost
    FROM public.sales_orders
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL AND asin <> ''
      AND unit_cost IS NOT NULL AND unit_cost > 0
    ORDER BY asin, updated_at DESC
  ),
  authoritative_cost AS (
    SELECT
      rs.resolved_asin,
      rs.units,
      COALESCE(
        NULLIF(luc.unit_cost, 0),
        soc.unit_cost,
        0
      ) AS unit_cost
    FROM resolved_shipments rs
    LEFT JOIN latest_unit_cost luc ON luc.asin = rs.resolved_asin
    LEFT JOIN sales_orders_cost soc ON soc.asin = rs.resolved_asin
  )
  SELECT
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(sales, 0)) ELSE 0 END), 0) AS sales,
    COALESCE(SUM(CASE WHEN event_type = 'refund' THEN ABS(COALESCE(refunds, 0)) ELSE 0 END), 0) AS refunds,
    COALESCE(
      SUM(
        ABS(COALESCE(referral_fees, 0))
        + ABS(COALESCE(fba_fees, 0))
        + ABS(COALESCE(variable_closing_fees, 0))
        + ABS(COALESCE(fixed_closing_fees, 0))
        + ABS(COALESCE(fba_inbound_fees, 0))
        + ABS(COALESCE(fba_storage_fees, 0))
        + ABS(COALESCE(fba_removal_fees, 0))
        + ABS(COALESCE(fba_disposal_fees, 0))
        + ABS(COALESCE(fba_long_term_storage_fees, 0))
        + ABS(COALESCE(fba_customer_return_fees, 0))
        + ABS(COALESCE(other_fees, 0))
      ), 0
    ) AS total_fees,
    COALESCE(COUNT(DISTINCT NULLIF(amazon_order_id, '')) FILTER (WHERE amazon_order_id NOT LIKE '%-REFUND%'), 0) AS unique_orders,
    COALESCE(COUNT(*) FILTER (WHERE event_type = 'refund'), 0) AS refund_count,
    COALESCE(COUNT(*), 0) AS row_count,
    COALESCE((SELECT SUM(units) FROM resolved_shipments), 0) AS total_units,
    COALESCE((SELECT SUM(ac.units * ac.unit_cost) FROM authoritative_cost ac), 0) AS cogs,
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(promotional_rebates, 0)) ELSE 0 END), 0) AS promotional_rebates_total,
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(shipping_credits, 0)) ELSE 0 END), 0) AS shipping_credits_total,
    COALESCE(SUM(CASE WHEN event_type = 'shipment' THEN ABS(COALESCE(gift_wrap_credits, 0)) ELSE 0 END), 0) AS gift_wrap_credits_total
  FROM base;
$$;