CREATE INDEX IF NOT EXISTS idx_fba_items_user_shipment_asin_sku
ON public.fba_shipment_items(user_id, shipment_id, asin, seller_sku);

CREATE INDEX IF NOT EXISTS idx_created_listings_user_sku_updated
ON public.created_listings(user_id, sku, updated_at DESC)
WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_user_order_asin
ON public.sales_orders(user_id, order_id, asin);

CREATE INDEX IF NOT EXISTS idx_sales_orders_user_asin_order_date_cost
ON public.sales_orders(user_id, asin, order_date DESC)
WHERE COALESCE(unit_cost, 0) > 0;

CREATE INDEX IF NOT EXISTS idx_sales_orders_user_seller_sku_order_date_cost
ON public.sales_orders(user_id, seller_sku, order_date DESC)
WHERE seller_sku IS NOT NULL AND COALESCE(unit_cost, 0) > 0;

CREATE INDEX IF NOT EXISTS idx_sales_orders_user_sku_order_date_cost
ON public.sales_orders(user_id, sku, order_date DESC)
WHERE sku IS NOT NULL AND COALESCE(unit_cost, 0) > 0;

CREATE OR REPLACE FUNCTION public.get_shipment_accounting_period(p_start date, p_end date)
RETURNS TABLE(
  shipment_id text,
  shipment_name text,
  shipment_status text,
  shipment_date date,
  units_shipped bigint,
  units_received bigint,
  cogs numeric,
  amazon_inbound_fee numeric,
  manual_cost numeric,
  total_cost numeric,
  estimated_revenue numeric,
  estimated_profit numeric,
  revenue_confidence text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH ctx AS (
    SELECT auth.uid() AS uid
  ),
  fee_min_date AS (
    SELECT f.shipment_id, MIN(f.posted_date) AS first_posted
    FROM public.fba_inbound_fees f
    JOIN ctx ON ctx.uid = f.user_id
    GROUP BY f.shipment_id
  ),
  shipments_with_date AS (
    SELECT
      sh.shipment_id,
      sh.shipment_name,
      sh.shipment_status,
      COALESCE(
        to_date((regexp_match(sh.shipment_name, E'\\(([0-9]{1,2}/[0-9]{1,2}/[0-9]{4})'))[1], 'MM/DD/YYYY'),
        sh.confirmed_need_by_date,
        fmd.first_posted,
        sh.created_at::date
      ) AS shipment_date
    FROM public.fba_shipments sh
    JOIN ctx ON ctx.uid = sh.user_id
    LEFT JOIN fee_min_date fmd ON fmd.shipment_id = sh.shipment_id
  ),
  s_filtered AS (
    SELECT *
    FROM shipments_with_date
    WHERE shipment_date >= p_start
      AND shipment_date < p_end
  ),
  item_rows AS (
    SELECT
      i.id,
      i.shipment_id,
      NULLIF(i.asin, '') AS asin,
      NULLIF(i.seller_sku, '') AS seller_sku,
      COALESCE(i.quantity_shipped, 0) AS quantity_shipped,
      COALESCE(i.quantity_received, 0) AS quantity_received
    FROM public.fba_shipment_items i
    JOIN ctx ON ctx.uid = i.user_id
    JOIN s_filtered sf ON sf.shipment_id = i.shipment_id
  ),
  item_keys AS (
    SELECT DISTINCT asin, seller_sku FROM item_rows
  ),
  cost_candidates AS (
    SELECT
      k.asin,
      k.seller_sku,
      CASE
        WHEN COALESCE(cl.amount, -1) >= 0 THEN cl.amount
        WHEN COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0 THEN (cl.cost / cl.units)
        ELSE NULL
      END AS unit_cost,
      1 AS source_priority,
      cl.updated_at AS source_at
    FROM item_keys k
    JOIN public.created_listings cl
      ON cl.user_id = (SELECT uid FROM ctx)
     AND (
       (k.asin IS NOT NULL AND cl.asin = k.asin)
       OR (k.seller_sku IS NOT NULL AND cl.sku = k.seller_sku)
     )
    WHERE COALESCE(cl.amount, -1) >= 0
       OR (COALESCE(cl.cost, 0) > 0 AND COALESCE(cl.units, 0) > 0)

    UNION ALL

    SELECT
      k.asin,
      k.seller_sku,
      so.unit_cost,
      2 AS source_priority,
      COALESCE(so.order_date::timestamp with time zone, so.updated_at) AS source_at
    FROM item_keys k
    JOIN public.sales_orders so
      ON so.user_id = (SELECT uid FROM ctx)
     AND COALESCE(so.unit_cost, 0) > 0
     AND (
       (k.asin IS NOT NULL AND so.asin = k.asin)
       OR (k.seller_sku IS NOT NULL AND (so.seller_sku = k.seller_sku OR so.sku = k.seller_sku))
     )
  ),
  unit_cost_by_key AS (
    SELECT DISTINCT ON (asin, seller_sku)
      asin, seller_sku, unit_cost
    FROM cost_candidates
    WHERE unit_cost IS NOT NULL
    ORDER BY asin, seller_sku, source_priority, source_at DESC NULLS LAST
  ),
  items AS (
    SELECT
      ir.shipment_id,
      SUM(ir.quantity_shipped)::bigint AS units_shipped,
      SUM(ir.quantity_received)::bigint AS units_received,
      SUM(ir.quantity_shipped * COALESCE(uc.unit_cost, 0))::numeric AS cogs
    FROM item_rows ir
    LEFT JOIN unit_cost_by_key uc
      ON uc.asin IS NOT DISTINCT FROM ir.asin
     AND uc.seller_sku IS NOT DISTINCT FROM ir.seller_sku
    GROUP BY ir.shipment_id
  ),
  ship_asin_units AS (
    SELECT
      ir.shipment_id,
      ir.asin,
      sf.shipment_date AS window_start,
      SUM(ir.quantity_shipped)::numeric AS units
    FROM item_rows ir
    JOIN s_filtered sf ON sf.shipment_id = ir.shipment_id
    WHERE ir.asin IS NOT NULL
    GROUP BY ir.shipment_id, ir.asin, sf.shipment_date
  ),
  asins_in_scope AS (SELECT DISTINCT asin FROM ship_asin_units),
  ship_asin_dates AS (
    SELECT DISTINCT
      i.shipment_id,
      NULLIF(i.asin, '') AS asin,
      swd.shipment_date
    FROM public.fba_shipment_items i
    JOIN ctx ON ctx.uid = i.user_id
    JOIN shipments_with_date swd ON swd.shipment_id = i.shipment_id
    JOIN asins_in_scope ais ON ais.asin = NULLIF(i.asin, '')
    WHERE swd.shipment_date IS NOT NULL
  ),
  ship_asin_dates_with_next AS (
    SELECT
      sad.*,
      LEAD(sad.shipment_date) OVER (PARTITION BY sad.asin ORDER BY sad.shipment_date, sad.shipment_id) AS next_ship_date
    FROM ship_asin_dates sad
  ),
  asin_window AS (
    SELECT
      sau.shipment_id,
      sau.asin,
      sau.window_start,
      sau.units,
      LEAST(
        COALESCE(sadn.next_ship_date, (sau.window_start + INTERVAL '180 days')::date),
        (sau.window_start + INTERVAL '180 days')::date
      ) AS window_end
    FROM ship_asin_units sau
    LEFT JOIN ship_asin_dates_with_next sadn
      ON sadn.shipment_id = sau.shipment_id
     AND sadn.asin = sau.asin
  ),
  fec_bounds AS (
    SELECT MIN(window_start) AS min_d, MAX(window_end) AS max_d FROM asin_window
  ),
  fec_per_asin_day AS (
    SELECT
      so.asin AS real_asin,
      f.event_date::date AS event_date,
      SUM(ABS(COALESCE(f.sales, 0))) AS sales_sum
    FROM public.financial_events_cache f
    JOIN ctx ON ctx.uid = f.user_id
    JOIN fec_bounds b ON b.min_d IS NOT NULL
    JOIN public.sales_orders so
      ON so.user_id = f.user_id
     AND so.order_id = f.amazon_order_id
    WHERE f.event_type = 'shipment'
      AND f.event_date >= b.min_d
      AND f.event_date < b.max_d
      AND so.asin IN (SELECT asin FROM asins_in_scope)
    GROUP BY so.asin, f.event_date::date
  ),
  asin_window_revenue AS (
    SELECT
      aw.shipment_id, aw.asin, aw.units, aw.window_start, aw.window_end,
      COALESCE(SUM(fr.sales_sum), 0) AS total_window_revenue
    FROM asin_window aw
    LEFT JOIN fec_per_asin_day fr
      ON fr.real_asin = aw.asin
     AND fr.event_date >= aw.window_start
     AND fr.event_date < aw.window_end
    GROUP BY aw.shipment_id, aw.asin, aw.units, aw.window_start, aw.window_end
  ),
  asin_window_unit_totals AS (
    SELECT asin, window_start, window_end, SUM(units) AS group_units
    FROM asin_window_revenue
    GROUP BY asin, window_start, window_end
  ),
  asin_revenue AS (
    SELECT
      awr.shipment_id,
      awr.asin,
      CASE WHEN COALESCE(awt.group_units, 0) > 0
        THEN awr.total_window_revenue * (awr.units / awt.group_units)
        ELSE 0
      END AS revenue
    FROM asin_window_revenue awr
    LEFT JOIN asin_window_unit_totals awt
      ON awt.asin = awr.asin
     AND awt.window_start = awr.window_start
     AND awt.window_end = awr.window_end
  ),
  shipment_revenue AS (
    SELECT
      shipment_id,
      SUM(revenue) AS revenue_sum,
      COUNT(*) AS asin_count,
      COUNT(*) FILTER (WHERE revenue > 0) AS asin_matched
    FROM asin_revenue
    GROUP BY shipment_id
  ),
  fees AS (
    SELECT
      f.shipment_id,
      SUM(ABS(COALESCE(f.fee_amount, 0)))::numeric AS amazon_inbound_fee
    FROM public.fba_inbound_fees f
    JOIN ctx ON ctx.uid = f.user_id
    JOIN s_filtered sf ON sf.shipment_id = f.shipment_id
    GROUP BY f.shipment_id
  ),
  manual AS (
    SELECT
      c.shipment_id,
      SUM(COALESCE(c.amount, 0))::numeric AS manual_cost
    FROM public.shipment_costs c
    JOIN ctx ON ctx.uid = c.user_id
    JOIN s_filtered sf ON sf.shipment_id = c.shipment_id
    GROUP BY c.shipment_id
  )
  SELECT
    sf.shipment_id,
    sf.shipment_name,
    sf.shipment_status,
    sf.shipment_date,
    COALESCE(items.units_shipped, 0) AS units_shipped,
    COALESCE(items.units_received, 0) AS units_received,
    COALESCE(items.cogs, 0) AS cogs,
    COALESCE(fees.amazon_inbound_fee, 0) AS amazon_inbound_fee,
    COALESCE(manual.manual_cost, 0) AS manual_cost,
    (COALESCE(items.cogs, 0) + COALESCE(fees.amazon_inbound_fee, 0) + COALESCE(manual.manual_cost, 0))::numeric AS total_cost,
    CASE WHEN COALESCE(sr.asin_matched, 0) = 0 THEN NULL ELSE sr.revenue_sum END AS estimated_revenue,
    CASE WHEN COALESCE(sr.asin_matched, 0) = 0 THEN NULL
      ELSE sr.revenue_sum - (COALESCE(items.cogs, 0) + COALESCE(fees.amazon_inbound_fee, 0) + COALESCE(manual.manual_cost, 0))
    END AS estimated_profit,
    CASE
      WHEN COALESCE(sr.asin_count, 0) = 0 THEN 'No revenue match'
      WHEN COALESCE(sr.asin_matched, 0) = 0 THEN 'No revenue match'
      WHEN COALESCE(items.units_received, 0) = 0 THEN 'Estimated'
      WHEN sr.asin_matched = sr.asin_count THEN 'Matched'
      ELSE 'Estimated'
    END AS revenue_confidence
  FROM s_filtered sf
  LEFT JOIN items ON items.shipment_id = sf.shipment_id
  LEFT JOIN fees ON fees.shipment_id = sf.shipment_id
  LEFT JOIN manual ON manual.shipment_id = sf.shipment_id
  LEFT JOIN shipment_revenue sr ON sr.shipment_id = sf.shipment_id
  ORDER BY sf.shipment_date DESC, sf.shipment_id;
$function$;