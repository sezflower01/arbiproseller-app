DROP FUNCTION IF EXISTS public.get_authoritative_period_totals(text, text);

CREATE OR REPLACE FUNCTION public.get_authoritative_period_totals(start_ts text, end_ts text)
RETURNS TABLE (
  sales numeric, refunds numeric, total_fees numeric, unique_orders bigint,
  refund_count bigint, row_count bigint, total_units bigint, cogs numeric,
  promotional_rebates_total numeric, shipping_credits_total numeric,
  gift_wrap_credits_total numeric,
  -- Individual fee components
  referral_fees_total numeric, fba_fees_total numeric,
  variable_closing_fees_total numeric, fixed_closing_fees_total numeric,
  storage_fees_total numeric, removal_fees_total numeric,
  disposal_fees_total numeric, long_term_storage_fees_total numeric,
  customer_return_fees_total numeric, other_fees_total numeric,
  digital_services_fee_total numeric, inbound_fees_total numeric,
  inbound_convenience_fee_total numeric,
  -- Sellerboard-granular
  compensated_clawback_total numeric, hrr_non_apparel_total numeric,
  re_commerce_grading_total numeric, liquidations_total numeric,
  liquidations_brokerage_total numeric,
  warehouse_damage_total numeric, warehouse_lost_total numeric,
  reversal_reimbursement_total numeric, other_income_total numeric,
  free_replacement_total numeric,
  shipping_credit_refunds_total numeric, gift_wrap_credit_refunds_total numeric,
  promotional_rebate_refunds_total numeric,
  marketplace_tax_total numeric, marketplace_tax_refunds_total numeric
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
    SELECT NULLIF(asin, '') AS raw_asin, COUNT(*)::bigint AS units
    FROM base WHERE event_type = 'shipment' GROUP BY 1
  ),
  sku_to_asin AS (
    SELECT DISTINCT ON (sku) sku, asin
    FROM public.inventory
    WHERE user_id = auth.uid() AND sku IS NOT NULL AND sku != '' AND asin IS NOT NULL AND asin != ''
    ORDER BY sku, updated_at DESC
  ),
  resolved_shipments AS (
    SELECT sc.raw_asin, sc.units,
      COALESCE(
        CASE WHEN sc.raw_asin ~ '^[A-Z0-9]{10}$' AND sc.raw_asin ~ '[A-Z]' THEN sc.raw_asin ELSE NULL END,
        sta.asin, sc.raw_asin
      ) AS resolved_asin
    FROM shipment_counts sc LEFT JOIN sku_to_asin sta ON sta.sku = sc.raw_asin
  ),
  latest_unit_cost AS (
    SELECT DISTINCT ON (asin) asin,
      CASE WHEN COALESCE(cost,0) > 0 AND COALESCE(units,0) > 0 THEN cost/units
           WHEN COALESCE(amount,0) > 0 AND amount < 500 THEN amount
           WHEN COALESCE(cost,0) > 0 AND cost < 500 THEN cost ELSE 0 END AS unit_cost
    FROM public.created_listings WHERE user_id = auth.uid() AND asin IS NOT NULL AND asin <> ''
    ORDER BY asin, updated_at DESC
  ),
  sales_orders_cost AS (
    SELECT DISTINCT ON (asin) asin, COALESCE(unit_cost,0) AS unit_cost
    FROM public.sales_orders WHERE user_id = auth.uid() AND asin IS NOT NULL AND asin <> '' AND unit_cost > 0
    ORDER BY asin, updated_at DESC
  ),
  authoritative_cost AS (
    SELECT rs.resolved_asin, rs.units,
      COALESCE(NULLIF(luc.unit_cost,0), soc.unit_cost, 0) AS unit_cost
    FROM resolved_shipments rs
    LEFT JOIN latest_unit_cost luc ON luc.asin = rs.resolved_asin
    LEFT JOIN sales_orders_cost soc ON soc.asin = rs.resolved_asin
  )
  SELECT
    COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.sales,0)) ELSE 0 END),0) AS sales,
    COALESCE(SUM(CASE WHEN event_type='refund' THEN ABS(COALESCE(b.refunds,0)) ELSE 0 END),0) AS refunds,
    COALESCE(SUM(ABS(COALESCE(b.referral_fees,0))+ABS(COALESCE(b.fba_fees,0))+ABS(COALESCE(b.variable_closing_fees,0))+ABS(COALESCE(b.fixed_closing_fees,0))+ABS(COALESCE(b.fba_inbound_fees,0))+ABS(COALESCE(b.fba_storage_fees,0))+ABS(COALESCE(b.fba_removal_fees,0))+ABS(COALESCE(b.fba_disposal_fees,0))+ABS(COALESCE(b.fba_long_term_storage_fees,0))+ABS(COALESCE(b.fba_customer_return_fees,0))+ABS(COALESCE(b.other_fees,0))),0) AS total_fees,
    COALESCE(COUNT(DISTINCT NULLIF(b.amazon_order_id,'')) FILTER (WHERE b.amazon_order_id NOT LIKE '%-REFUND%'),0) AS unique_orders,
    COALESCE(COUNT(*) FILTER (WHERE b.event_type='refund'),0) AS refund_count,
    COALESCE(COUNT(*),0) AS row_count,
    COALESCE((SELECT SUM(units) FROM resolved_shipments),0) AS total_units,
    COALESCE((SELECT SUM(ac.units*ac.unit_cost) FROM authoritative_cost ac),0) AS cogs,
    -- Net sales breakdown
    COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.promotional_rebates,0)) ELSE 0 END),0) AS promotional_rebates_total,
    COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.shipping_credits,0)) ELSE 0 END),0) AS shipping_credits_total,
    COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.gift_wrap_credits,0)) ELSE 0 END),0) AS gift_wrap_credits_total,
    -- Individual fee components
    COALESCE(SUM(ABS(COALESCE(b.referral_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.fba_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.variable_closing_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.fixed_closing_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.fba_storage_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.fba_removal_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.fba_disposal_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.fba_long_term_storage_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.fba_customer_return_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.other_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.digital_services_fee,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.fba_inbound_fees,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.fba_inbound_convenience_fee,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.compensated_clawback,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.hrr_non_apparel,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.re_commerce_grading_charge,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.liquidations,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.liquidations_brokerage_fee,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.warehouse_damage,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.warehouse_lost,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.reversal_reimbursement,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.other_income,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.free_replacement_refund_items,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.shipping_credit_refunds,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.gift_wrap_credit_refunds,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.promotional_rebate_refunds,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax,0))),0),
    COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax_refunds,0))),0)
  FROM base b;
$$;