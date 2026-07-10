-- Update get_shipment_accounting_period to use the REAL shipment timeline
-- (Amazon-posted inbound fee date) instead of the local sync timestamp.
--
-- Priority for shipment_date:
--   1) MIN(fba_inbound_fees.posted_date) for that shipment_id  (authoritative SP-API date)
--   2) fba_shipments.confirmed_need_by_date                    (planned date, if Amazon provided it)
--   3) fba_shipments.created_at::date                          (sync fallback — last resort)
--
-- The period filter is then applied against this resolved date,
-- so shipments land in the month they actually belong to.

CREATE OR REPLACE FUNCTION public.get_shipment_accounting_period(p_start date, p_end date)
RETURNS TABLE (
  shipment_id text,
  shipment_name text,
  shipment_status text,
  shipment_date date,
  units_shipped bigint,
  units_received bigint,
  cogs numeric,
  amazon_inbound_fee numeric,
  manual_cost numeric,
  total_cost numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH fee_min_date AS (
    SELECT shipment_id, MIN(posted_date) AS first_posted
    FROM public.fba_inbound_fees
    WHERE user_id = auth.uid()
    GROUP BY shipment_id
  ),
  s AS (
    SELECT
      sh.shipment_id,
      sh.shipment_name,
      sh.shipment_status,
      COALESCE(
        fmd.first_posted,
        sh.confirmed_need_by_date,
        sh.created_at::date
      ) AS shipment_date
    FROM public.fba_shipments sh
    LEFT JOIN fee_min_date fmd ON fmd.shipment_id = sh.shipment_id
    WHERE sh.user_id = auth.uid()
  ),
  s_filtered AS (
    SELECT * FROM s
    WHERE shipment_date >= p_start
      AND shipment_date <  p_end
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
    COALESCE(items.cogs, 0)
      + COALESCE(fees.amazon_inbound_fee, 0)
      + COALESCE(manual.manual_cost, 0)          AS total_cost
  FROM s_filtered
  LEFT JOIN items  ON items.shipment_id  = s_filtered.shipment_id
  LEFT JOIN fees   ON fees.shipment_id   = s_filtered.shipment_id
  LEFT JOIN manual ON manual.shipment_id = s_filtered.shipment_id
  ORDER BY s_filtered.shipment_date DESC, s_filtered.shipment_id;
$function$;