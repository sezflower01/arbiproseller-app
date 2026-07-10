-- Per-day SO vs FEC totals for true day-level Smart Fallback in the Sales Report.
-- Returns one row per day in [start_ts, end_ts) with both data-source totals
-- so the client can pick SO or FEC per day and sum.
CREATE OR REPLACE FUNCTION public.get_smart_fallback_daily_totals(
  start_ts text,
  end_ts text
)
RETURNS TABLE(
  day date,
  so_orders bigint,
  so_units numeric,
  so_sales numeric,
  so_refunds numeric,
  so_fees numeric,
  so_cogs numeric,
  fec_orders bigint,
  fec_units bigint,
  fec_sales numeric,
  fec_refunds numeric,
  fec_fees numeric,
  fec_promo_rebates numeric,
  fec_shipping_credits numeric,
  fec_gift_wrap_credits numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d
  ),
  days AS (
    SELECT generate_series(b.start_d, b.end_d - INTERVAL '1 day', INTERVAL '1 day')::date AS day
    FROM bounds b
  ),
  -- Latest unit cost per ASIN (Contract A: amount = unit cost; cost = batch total)
  latest_unit_cost AS (
    SELECT DISTINCT ON (asin)
      asin,
      CASE
        WHEN COALESCE(amount, -1) >= 0 THEN amount
        WHEN COALESCE(cost, 0) > 0 AND COALESCE(units, 0) > 0 THEN (cost / units)
        ELSE 0
      END AS unit_cost
    FROM public.created_listings
    WHERE user_id = auth.uid()
      AND asin IS NOT NULL AND asin <> ''
    ORDER BY asin, updated_at DESC
  ),
  so_per_day AS (
    SELECT
      s.order_date::date AS day,
      COUNT(DISTINCT NULLIF(s.order_id, '')) AS so_orders,
      COALESCE(SUM(COALESCE(s.quantity, 1)), 0) AS so_units,
      COALESCE(SUM(
        CASE WHEN COALESCE(s.total_sale_amount, 0) > 0 THEN s.total_sale_amount
             WHEN COALESCE(NULLIF(s.sold_price, 0), s.estimated_price, 0) > 0
               THEN COALESCE(NULLIF(s.sold_price, 0), s.estimated_price, 0) * COALESCE(s.quantity, 1)
             ELSE 0
        END
      ), 0) AS so_sales,
      COALESCE(SUM(COALESCE(s.refund_amount, 0)), 0) AS so_refunds,
      COALESCE(SUM(COALESCE(s.total_fees, 0)), 0) AS so_fees,
      COALESCE(SUM(COALESCE(luc.unit_cost, 0) * COALESCE(s.quantity, 1)), 0) AS so_cogs
    FROM public.sales_orders s
    CROSS JOIN bounds b
    LEFT JOIN latest_unit_cost luc ON luc.asin = s.asin
    WHERE s.user_id = auth.uid()
      AND s.order_date >= b.start_d
      AND s.order_date <  b.end_d
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
      AND s.order_id NOT LIKE '%-REFUND'
    GROUP BY 1
  ),
  fec_per_day AS (
    SELECT
      f.event_date::date AS day,
      COUNT(DISTINCT NULLIF(f.amazon_order_id, ''))
        FILTER (WHERE f.event_type = 'shipment'
                  AND f.amazon_order_id NOT LIKE '%-REFUND%') AS fec_orders,
      COUNT(*) FILTER (WHERE f.event_type = 'shipment')::bigint AS fec_units,
      COALESCE(SUM(CASE WHEN f.event_type = 'shipment'
                        THEN ABS(COALESCE(f.sales, 0)) ELSE 0 END), 0) AS fec_sales,
      COALESCE(SUM(CASE WHEN f.event_type = 'refund'
                        THEN ABS(COALESCE(f.refunds, 0)) ELSE 0 END), 0) AS fec_refunds,
      COALESCE(SUM(
        ABS(COALESCE(f.referral_fees, 0)) + ABS(COALESCE(f.fba_fees, 0)) +
        ABS(COALESCE(f.variable_closing_fees, 0)) + ABS(COALESCE(f.fixed_closing_fees, 0)) +
        ABS(COALESCE(f.fba_inbound_fees, 0)) + ABS(COALESCE(f.fba_storage_fees, 0)) +
        ABS(COALESCE(f.fba_removal_fees, 0)) + ABS(COALESCE(f.fba_disposal_fees, 0)) +
        ABS(COALESCE(f.fba_long_term_storage_fees, 0)) + ABS(COALESCE(f.fba_customer_return_fees, 0)) +
        ABS(COALESCE(f.other_fees, 0))
      ), 0) AS fec_fees,
      COALESCE(SUM(CASE WHEN f.event_type = 'shipment'
                        THEN ABS(COALESCE(f.promotional_rebates, 0)) ELSE 0 END), 0) AS fec_promo_rebates,
      COALESCE(SUM(CASE WHEN f.event_type = 'shipment'
                        THEN ABS(COALESCE(f.shipping_credits, 0)) ELSE 0 END), 0) AS fec_shipping_credits,
      COALESCE(SUM(CASE WHEN f.event_type = 'shipment'
                        THEN ABS(COALESCE(f.gift_wrap_credits, 0)) ELSE 0 END), 0) AS fec_gift_wrap_credits
    FROM public.financial_events_cache f
    CROSS JOIN bounds b
    WHERE f.user_id = auth.uid()
      AND f.event_date >= b.start_d
      AND f.event_date <  b.end_d
    GROUP BY 1
  )
  SELECT
    d.day,
    COALESCE(s.so_orders, 0)        AS so_orders,
    COALESCE(s.so_units, 0)         AS so_units,
    COALESCE(s.so_sales, 0)         AS so_sales,
    COALESCE(s.so_refunds, 0)       AS so_refunds,
    COALESCE(s.so_fees, 0)          AS so_fees,
    COALESCE(s.so_cogs, 0)          AS so_cogs,
    COALESCE(fc.fec_orders, 0)      AS fec_orders,
    COALESCE(fc.fec_units, 0)       AS fec_units,
    COALESCE(fc.fec_sales, 0)       AS fec_sales,
    COALESCE(fc.fec_refunds, 0)     AS fec_refunds,
    COALESCE(fc.fec_fees, 0)        AS fec_fees,
    COALESCE(fc.fec_promo_rebates, 0)        AS fec_promo_rebates,
    COALESCE(fc.fec_shipping_credits, 0)     AS fec_shipping_credits,
    COALESCE(fc.fec_gift_wrap_credits, 0)    AS fec_gift_wrap_credits
  FROM days d
  LEFT JOIN so_per_day s   ON s.day  = d.day
  LEFT JOIN fec_per_day fc ON fc.day = d.day
  ORDER BY d.day;
$function$;