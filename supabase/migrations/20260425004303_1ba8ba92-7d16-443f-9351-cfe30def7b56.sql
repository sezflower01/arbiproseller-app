CREATE OR REPLACE FUNCTION public.get_shipment_accounting_period(p_start date, p_end date)
 RETURNS TABLE(shipment_id text, shipment_name text, shipment_status text, shipment_date date, units_shipped bigint, units_received bigint, cogs numeric, amazon_inbound_fee numeric, manual_cost numeric, total_cost numeric, estimated_revenue numeric, estimated_profit numeric, revenue_confidence text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH fee_min_date AS (
    SELECT shipment_id, MIN(posted_date) AS first_posted
    FROM public.fba_inbound_fees
    WHERE user_id = auth.uid()
    GROUP BY shipment_id
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
    LEFT JOIN fee_min_date fmd ON fmd.shipment_id = sh.shipment_id
    WHERE sh.user_id = auth.uid()
  ),
  s_filtered AS (
    SELECT * FROM shipments_with_date
    WHERE shipment_date >= p_start
      AND shipment_date <  p_end
  ),
  ship_asin_units AS (
    SELECT
      i.shipment_id,
      i.asin,
      sf.shipment_date AS window_start,
      SUM(COALESCE(i.quantity_shipped, 0))::numeric AS units
    FROM public.fba_shipment_items i
    JOIN s_filtered sf ON sf.shipment_id = i.shipment_id
    WHERE i.user_id = auth.uid()
      AND i.asin IS NOT NULL AND i.asin <> ''
    GROUP BY i.shipment_id, i.asin, sf.shipment_date
  ),
  asins_in_scope AS (
    SELECT DISTINCT asin FROM ship_asin_units
  ),
  all_ship_asin AS (
    SELECT DISTINCT
      i.asin,
      swd.shipment_date AS ship_date
    FROM public.fba_shipment_items i
    JOIN shipments_with_date swd ON swd.shipment_id = i.shipment_id
    JOIN asins_in_scope a ON a.asin = i.asin
    WHERE i.user_id = auth.uid()
      AND swd.shipment_date IS NOT NULL
  ),
  asin_window AS (
    SELECT
      sa.shipment_id,
      sa.asin,
      sa.window_start,
      sa.units,
      LEAST(
        COALESCE(
          (
            SELECT MIN(asa.ship_date)
            FROM all_ship_asin asa
            WHERE asa.asin = sa.asin
              AND asa.ship_date > sa.window_start
          ),
          sa.window_start + INTERVAL '180 days'
        )::date,
        (sa.window_start + INTERVAL '180 days')::date
      ) AS window_end
    FROM ship_asin_units sa
  ),
  fec_bounds AS (
    SELECT
      MIN(window_start) AS min_d,
      MAX(window_end)   AS max_d
    FROM asin_window
  ),
  fec_per_asin_day AS (
    SELECT
      so.asin AS real_asin,
      f.event_date,
      SUM(ABS(COALESCE(f.sales, 0))) AS sales_sum
    FROM public.financial_events_cache f
    JOIN public.sales_orders so
      ON so.order_id = f.amazon_order_id
     AND so.user_id = f.user_id
    JOIN fec_bounds b ON TRUE
    WHERE f.user_id = auth.uid()
      AND f.event_type = 'shipment'
      AND so.asin IS NOT NULL AND so.asin <> ''
      AND f.event_date >= b.min_d
      AND f.event_date <  b.max_d
      AND so.asin IN (SELECT asin FROM asins_in_scope)
    GROUP BY so.asin, f.event_date
  ),
  asin_window_revenue AS (
    SELECT
      aw.shipment_id,
      aw.asin,
      aw.units,
      aw.window_start,
      aw.window_end,
      COALESCE(SUM(fr.sales_sum), 0) AS total_window_revenue
    FROM asin_window aw
    LEFT JOIN fec_per_asin_day fr
      ON fr.real_asin = aw.asin
     AND fr.event_date >= aw.window_start
     AND fr.event_date <  aw.window_end
    GROUP BY aw.shipment_id, aw.asin, aw.units, aw.window_start, aw.window_end
  ),
  asin_window_unit_totals AS (
    SELECT
      asin,
      window_start,
      window_end,
      SUM(units) AS group_units
    FROM asin_window_revenue
    GROUP BY asin, window_start, window_end
  ),
  asin_revenue AS (
    SELECT
      awr.shipment_id,
      awr.asin,
      CASE
        WHEN COALESCE(awt.group_units, 0) > 0
          THEN awr.total_window_revenue * (awr.units / awt.group_units)
        ELSE 0
      END AS revenue
    FROM asin_window_revenue awr
    LEFT JOIN asin_window_unit_totals awt
      ON awt.asin = awr.asin
     AND awt.window_start = awr.window_start
     AND awt.window_end   = awr.window_end
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
  cl_unit_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      CASE
        WHEN COALESCE(amount, -1) >= 0 THEN amount
        WHEN COALESCE(cost, 0) > 0 AND COALESCE(units, 0) > 0 THEN (cost / units)
        ELSE NULL
      END AS unit_cost
    FROM public.created_listings
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL AND asin <> ''
    ORDER BY asin, updated_at DESC
  ),
  so_unit_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      unit_cost
    FROM public.sales_orders
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL AND asin <> ''
      AND COALESCE(unit_cost, 0) > 0
    ORDER BY asin, order_date DESC
  ),
  items AS (
    SELECT
      i.shipment_id,
      SUM(COALESCE(i.quantity_shipped, 0))::bigint  AS units_shipped,
      SUM(COALESCE(i.quantity_received, 0))::bigint AS units_received,
      SUM(
        COALESCE(i.quantity_shipped, 0) *
        COALESCE(cl.unit_cost, so.unit_cost, 0)
      )::numeric AS cogs
    FROM public.fba_shipment_items i
    LEFT JOIN cl_unit_cost cl ON cl.asin = i.asin
    LEFT JOIN so_unit_cost so ON so.asin = i.asin
    WHERE i.user_id = auth.uid()
      AND i.shipment_id IN (SELECT shipment_id FROM s_filtered)
    GROUP BY i.shipment_id
  ),
  fees AS (
    SELECT
      f.shipment_id,
      SUM(ABS(COALESCE(f.fee_amount, 0)))::numeric AS amazon_inbound_fee
    FROM public.fba_inbound_fees f
    WHERE f.user_id = auth.uid()
      AND f.shipment_id IN (SELECT shipment_id FROM s_filtered)
    GROUP BY f.shipment_id
  ),
  manual AS (
    SELECT
      c.shipment_id,
      SUM(COALESCE(c.amount, 0))::numeric AS manual_cost
    FROM public.shipment_costs c
    WHERE c.user_id = auth.uid()
      AND c.shipment_id IN (SELECT shipment_id FROM s_filtered)
    GROUP BY c.shipment_id
  )
  SELECT
    s_filtered.shipment_id,
    s_filtered.shipment_name,
    s_filtered.shipment_status,
    s_filtered.shipment_date,
    COALESCE(items.units_shipped, 0)             AS units_shipped,
    COALESCE(items.units_received, 0)            AS units_received,
    COALESCE(items.cogs, 0)                      AS cogs,
    COALESCE(fees.amazon_inbound_fee, 0)         AS amazon_inbound_fee,
    COALESCE(manual.manual_cost, 0)              AS manual_cost,
    (COALESCE(items.cogs,0) + COALESCE(fees.amazon_inbound_fee,0) + COALESCE(manual.manual_cost,0))::numeric AS total_cost,
    CASE
      WHEN COALESCE(sr.asin_matched, 0) = 0 THEN NULL
      ELSE sr.revenue_sum
    END AS estimated_revenue,
    CASE
      WHEN COALESCE(sr.asin_matched, 0) = 0 THEN NULL
      ELSE sr.revenue_sum - (COALESCE(items.cogs,0) + COALESCE(fees.amazon_inbound_fee,0) + COALESCE(manual.manual_cost,0))
    END AS estimated_profit,
    CASE
      WHEN COALESCE(sr.asin_count, 0) = 0 THEN 'No revenue match'
      WHEN COALESCE(sr.asin_matched, 0) = 0 THEN 'No revenue match'
      -- Downgrade to Estimated if shipment has 0 received units (revenue may not be from this stock)
      WHEN COALESCE(items.units_received, 0) = 0 THEN 'Estimated'
      WHEN sr.asin_matched = sr.asin_count THEN 'Matched'
      ELSE 'Estimated'
    END AS revenue_confidence
  FROM s_filtered
  LEFT JOIN items  ON items.shipment_id  = s_filtered.shipment_id
  LEFT JOIN fees   ON fees.shipment_id   = s_filtered.shipment_id
  LEFT JOIN manual ON manual.shipment_id = s_filtered.shipment_id
  LEFT JOIN shipment_revenue sr ON sr.shipment_id = s_filtered.shipment_id
  ORDER BY s_filtered.shipment_date DESC, s_filtered.shipment_id;
$function$;