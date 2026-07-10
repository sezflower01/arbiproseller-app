
-- ─────────────────────────────────────────────────────────────────────
-- get_pl_live_summary with optional marketplace filter
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_pl_live_summary(
  start_ts text,
  end_ts text,
  p_marketplace text
)
RETURNS TABLE(sales numeric, refunds numeric, reimbursements numeric, shipping_credits numeric, shipping_credit_refunds numeric, gift_wrap_credits numeric, gift_wrap_credit_refunds numeric, promotional_rebates numeric, promotional_rebate_refunds numeric, other_income numeric, liquidations numeric, referral_fees numeric, fba_fees numeric, variable_closing_fees numeric, fixed_closing_fees numeric, fba_inbound_fees numeric, fba_inbound_convenience_fee numeric, fba_storage_fees numeric, fba_removal_fees numeric, fba_disposal_fees numeric, fba_long_term_storage_fees numeric, fba_customer_return_fees numeric, digital_services_fee numeric, other_fees numeric, liquidations_brokerage_fee numeric, re_commerce_grading_charge numeric, compensated_clawback numeric, hrr_non_apparel numeric, warehouse_lost numeric, warehouse_damage numeric, reversal_reimbursement numeric, free_replacement_refund_items numeric, sales_tax_collected numeric, marketplace_facilitator_tax numeric, sales_tax_refunds numeric, marketplace_facilitator_tax_refunds numeric, total_income numeric, total_expenses numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT start_ts::date AS start_d, end_ts::date AS end_d,
           NULLIF(UPPER(COALESCE(p_marketplace,'')),'') AS mp
  ),
  base AS (
    SELECT f.*
    FROM public.financial_events_cache f
    CROSS JOIN bounds b
    WHERE f.user_id = auth.uid()
      AND f.event_date::date >= b.start_d
      AND f.event_date::date <= b.end_d
      AND (
        b.mp IS NULL OR b.mp = 'ALL'
        OR (b.mp = 'US' AND (f.marketplace IS NULL OR UPPER(f.marketplace) IN ('US','UNKNOWN')))
        OR (b.mp <> 'US' AND UPPER(COALESCE(f.marketplace,'')) = b.mp)
      )
  ),
  agg AS (
    SELECT
      COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.sales,0)) ELSE 0 END),0) AS sales,
      COALESCE(SUM(CASE WHEN event_type='refund'   THEN ABS(COALESCE(b.refunds,0)) ELSE 0 END),0) AS refunds,
      COALESCE(SUM(
        COALESCE(b.reimbursements,0)
        + ABS(COALESCE(b.reversal_reimbursement,0))
        + ABS(COALESCE(b.free_replacement_refund_items,0))
      ),0) AS reimbursements,
      COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.shipping_credits,0)) ELSE 0 END),0) AS shipping_credits,
      COALESCE(SUM(ABS(COALESCE(b.shipping_credit_refunds,0))),0) AS shipping_credit_refunds,
      COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.gift_wrap_credits,0)) ELSE 0 END),0) AS gift_wrap_credits,
      COALESCE(SUM(ABS(COALESCE(b.gift_wrap_credit_refunds,0))),0) AS gift_wrap_credit_refunds,
      COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.promotional_rebates,0)) ELSE 0 END),0) AS promotional_rebates,
      COALESCE(SUM(ABS(COALESCE(b.promotional_rebate_refunds,0))),0) AS promotional_rebate_refunds,
      COALESCE(SUM(COALESCE(b.other_income,0)),0) AS other_income,
      COALESCE(SUM(ABS(COALESCE(b.liquidations,0))),0) AS liquidations,
      COALESCE(SUM(ABS(COALESCE(b.referral_fees,0))),0) AS referral_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_fees,0))),0) AS fba_fees,
      COALESCE(SUM(ABS(COALESCE(b.variable_closing_fees,0))),0) AS variable_closing_fees,
      COALESCE(SUM(ABS(COALESCE(b.fixed_closing_fees,0))),0) AS fixed_closing_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_inbound_fees,0))),0) AS fba_inbound_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_inbound_convenience_fee,0))),0) AS fba_inbound_convenience_fee,
      COALESCE(SUM(ABS(COALESCE(b.fba_storage_fees,0))),0) AS fba_storage_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_removal_fees,0))),0) AS fba_removal_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_disposal_fees,0))),0) AS fba_disposal_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_long_term_storage_fees,0))),0) AS fba_long_term_storage_fees,
      COALESCE(SUM(ABS(COALESCE(b.fba_customer_return_fees,0))),0) AS fba_customer_return_fees,
      COALESCE(SUM(ABS(COALESCE(b.digital_services_fee,0))),0) AS digital_services_fee,
      COALESCE(SUM(COALESCE(b.other_fees,0)),0) AS other_fees,
      COALESCE(SUM(ABS(COALESCE(b.liquidations_brokerage_fee,0))),0) AS liquidations_brokerage_fee,
      COALESCE(SUM(ABS(COALESCE(b.re_commerce_grading_charge,0))),0) AS re_commerce_grading_charge,
      COALESCE(SUM(ABS(COALESCE(b.compensated_clawback,0))),0) AS compensated_clawback,
      COALESCE(SUM(ABS(COALESCE(b.hrr_non_apparel,0))),0) AS hrr_non_apparel,
      COALESCE(SUM(ABS(COALESCE(b.warehouse_lost,0))),0) AS warehouse_lost,
      COALESCE(SUM(ABS(COALESCE(b.warehouse_damage,0))),0) AS warehouse_damage,
      COALESCE(SUM(ABS(COALESCE(b.reversal_reimbursement,0))),0) AS reversal_reimbursement,
      COALESCE(SUM(ABS(COALESCE(b.free_replacement_refund_items,0))),0) AS free_replacement_refund_items,
      COALESCE(SUM(ABS(COALESCE(b.sales_tax_collected,0))),0) AS sales_tax_collected,
      COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax,0))),0) AS marketplace_facilitator_tax,
      COALESCE(SUM(ABS(COALESCE(b.sales_tax_refunds,0))),0) AS sales_tax_refunds,
      COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax_refunds,0))),0) AS marketplace_facilitator_tax_refunds
    FROM base b
  )
  SELECT
    a.sales, a.refunds, a.reimbursements,
    a.shipping_credits, a.shipping_credit_refunds,
    a.gift_wrap_credits, a.gift_wrap_credit_refunds,
    a.promotional_rebates, a.promotional_rebate_refunds,
    a.other_income, a.liquidations,
    a.referral_fees, a.fba_fees,
    a.variable_closing_fees, a.fixed_closing_fees,
    a.fba_inbound_fees, a.fba_inbound_convenience_fee,
    a.fba_storage_fees, a.fba_removal_fees, a.fba_disposal_fees,
    a.fba_long_term_storage_fees, a.fba_customer_return_fees,
    a.digital_services_fee, a.other_fees,
    a.liquidations_brokerage_fee, a.re_commerce_grading_charge,
    a.compensated_clawback, a.hrr_non_apparel,
    a.warehouse_lost, a.warehouse_damage,
    a.reversal_reimbursement, a.free_replacement_refund_items,
    a.sales_tax_collected, a.marketplace_facilitator_tax,
    a.sales_tax_refunds, a.marketplace_facilitator_tax_refunds,
    (a.sales + a.reimbursements + a.shipping_credits + a.gift_wrap_credits
     + a.other_income + a.liquidations) AS total_income,
    (a.referral_fees + a.fba_fees
     + a.variable_closing_fees + a.fixed_closing_fees
     + a.fba_inbound_fees + a.fba_inbound_convenience_fee
     + a.fba_storage_fees + a.fba_removal_fees + a.fba_disposal_fees
     + a.fba_long_term_storage_fees + a.fba_customer_return_fees
     + a.digital_services_fee + a.other_fees
     + a.liquidations_brokerage_fee + a.re_commerce_grading_charge
     + a.compensated_clawback + a.hrr_non_apparel) AS total_expenses
  FROM agg a;
$function$;

GRANT EXECUTE ON FUNCTION public.get_pl_live_summary(text, text, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- get_monthly_pl_breakdown with optional marketplace filter
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_monthly_pl_breakdown(
  p_year integer,
  p_marketplace text
)
RETURNS TABLE(month_num integer, sales numeric, refunds numeric, reimbursements numeric, shipping_credits numeric, shipping_credit_refunds numeric, gift_wrap_credits numeric, gift_wrap_credit_refunds numeric, promotional_rebates numeric, promotional_rebate_refunds numeric, other_income numeric, liquidations numeric, intl_markets numeric, referral_fees numeric, fba_fees numeric, variable_closing_fees numeric, fixed_closing_fees numeric, fba_inbound_fees numeric, fba_storage_fees numeric, fba_removal_fees numeric, fba_disposal_fees numeric, fba_long_term_storage_fees numeric, fba_customer_return_fees numeric, digital_services_fee numeric, fba_inbound_convenience_fee numeric, other_fees numeric, liquidations_brokerage_fee numeric, re_commerce_grading_charge numeric, compensated_clawback numeric, hrr_non_apparel numeric, warehouse_lost numeric, warehouse_damage numeric, reversal_reimbursement numeric, free_replacement_refund_items numeric, sales_tax_collected numeric, marketplace_facilitator_tax numeric, sales_tax_refunds numeric, marketplace_facilitator_tax_refunds numeric, shipping_chargeback numeric, shipping_chargeback_refund numeric, restocking_fee numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH mp AS (
    SELECT NULLIF(UPPER(COALESCE(p_marketplace,'')),'') AS m
  ),
  base AS (
    SELECT
      f.*,
      EXTRACT(MONTH FROM f.event_date::date)::int AS event_month
    FROM public.financial_events_cache f
    CROSS JOIN mp
    WHERE f.user_id = auth.uid()
      AND f.event_date::date >= make_date(p_year, 1, 1)
      AND f.event_date::date <  make_date(p_year + 1, 1, 1)
      AND (
        mp.m IS NULL OR mp.m = 'ALL'
        OR (mp.m = 'US' AND (f.marketplace IS NULL OR UPPER(f.marketplace) IN ('US','UNKNOWN')))
        OR (mp.m <> 'US' AND UPPER(COALESCE(f.marketplace,'')) = mp.m)
      )
  ),
  months AS (SELECT generate_series(1, 12) AS m)
  SELECT
    months.m AS month_num,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.sales, 0)) ELSE 0 END), 0) AS sales,
    COALESCE(SUM(CASE WHEN b.event_type = 'refund' THEN ABS(COALESCE(b.refunds, 0)) ELSE 0 END), 0) AS refunds,
    COALESCE(SUM(
      COALESCE(b.reimbursements, 0)
      + ABS(COALESCE(b.reversal_reimbursement, 0))
      + ABS(COALESCE(b.free_replacement_refund_items, 0))
    ), 0) AS reimbursements,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.shipping_credits, 0)) ELSE 0 END), 0) AS shipping_credits,
    COALESCE(SUM(ABS(COALESCE(b.shipping_credit_refunds, 0))), 0) AS shipping_credit_refunds,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.gift_wrap_credits, 0)) ELSE 0 END), 0) AS gift_wrap_credits,
    COALESCE(SUM(ABS(COALESCE(b.gift_wrap_credit_refunds, 0))), 0) AS gift_wrap_credit_refunds,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.promotional_rebates, 0)) ELSE 0 END), 0) AS promotional_rebates,
    COALESCE(SUM(ABS(COALESCE(b.promotional_rebate_refunds, 0))), 0) AS promotional_rebate_refunds,
    COALESCE(SUM(COALESCE(b.other_income, 0)), 0) AS other_income,
    COALESCE(SUM(ABS(COALESCE(b.liquidations, 0))), 0) AS liquidations,
    COALESCE(SUM(CASE WHEN COALESCE(b.marketplace,'US') <> 'US' AND b.event_type = 'shipment' THEN ABS(COALESCE(b.sales, 0)) ELSE 0 END), 0) AS intl_markets,
    COALESCE(SUM(ABS(COALESCE(b.referral_fees, 0))), 0) AS referral_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_fees, 0))), 0) AS fba_fees,
    COALESCE(SUM(ABS(COALESCE(b.variable_closing_fees, 0))), 0) AS variable_closing_fees,
    COALESCE(SUM(ABS(COALESCE(b.fixed_closing_fees, 0))), 0) AS fixed_closing_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_inbound_fees, 0))), 0) AS fba_inbound_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_storage_fees, 0))), 0) AS fba_storage_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_removal_fees, 0))), 0) AS fba_removal_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_disposal_fees, 0))), 0) AS fba_disposal_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_long_term_storage_fees, 0))), 0) AS fba_long_term_storage_fees,
    COALESCE(SUM(ABS(COALESCE(b.fba_customer_return_fees, 0))), 0) AS fba_customer_return_fees,
    COALESCE(SUM(ABS(COALESCE(b.digital_services_fee, 0))), 0) AS digital_services_fee,
    COALESCE(SUM(ABS(COALESCE(b.fba_inbound_convenience_fee, 0))), 0) AS fba_inbound_convenience_fee,
    COALESCE(SUM(COALESCE(b.other_fees, 0)), 0) AS other_fees,
    COALESCE(SUM(ABS(COALESCE(b.liquidations_brokerage_fee, 0))), 0) AS liquidations_brokerage_fee,
    COALESCE(SUM(ABS(COALESCE(b.re_commerce_grading_charge, 0))), 0) AS re_commerce_grading_charge,
    COALESCE(SUM(ABS(COALESCE(b.compensated_clawback, 0))), 0) AS compensated_clawback,
    COALESCE(SUM(ABS(COALESCE(b.hrr_non_apparel, 0))), 0) AS hrr_non_apparel,
    COALESCE(SUM(ABS(COALESCE(b.warehouse_lost, 0))), 0) AS warehouse_lost,
    COALESCE(SUM(ABS(COALESCE(b.warehouse_damage, 0))), 0) AS warehouse_damage,
    COALESCE(SUM(ABS(COALESCE(b.reversal_reimbursement, 0))), 0) AS reversal_reimbursement,
    COALESCE(SUM(ABS(COALESCE(b.free_replacement_refund_items, 0))), 0) AS free_replacement_refund_items,
    COALESCE(SUM(ABS(COALESCE(b.sales_tax_collected, 0))), 0) AS sales_tax_collected,
    COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax, 0))), 0) AS marketplace_facilitator_tax,
    COALESCE(SUM(ABS(COALESCE(b.sales_tax_refunds, 0))), 0) AS sales_tax_refunds,
    COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax_refunds, 0))), 0) AS marketplace_facilitator_tax_refunds,
    COALESCE(SUM(ABS(COALESCE(b.shipping_chargeback, 0))), 0) AS shipping_chargeback,
    COALESCE(SUM(ABS(COALESCE(b.shipping_chargeback_refund, 0))), 0) AS shipping_chargeback_refund,
    COALESCE(SUM(ABS(COALESCE(b.restocking_fee, 0))), 0) AS restocking_fee
  FROM months
  LEFT JOIN base b ON b.event_month = months.m
  GROUP BY months.m
  ORDER BY months.m;
$function$;

GRANT EXECUTE ON FUNCTION public.get_monthly_pl_breakdown(integer, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- get_monthly_cogs with optional marketplace filter
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_monthly_cogs(
  p_year integer,
  p_marketplace text
)
RETURNS TABLE(month_num integer, cogs numeric, units_sold bigint, units_with_cost bigint, units_missing_cost bigint, orders_missing_cost bigint, asins_missing_cost bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_start date := make_date(p_year, 1, 1);
  v_end   date := make_date(p_year + 1, 1, 1);
  v_mp    text := NULLIF(UPPER(COALESCE(p_marketplace,'')),'');
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      s.order_id,
      s.asin,
      s.sku,
      s.order_date,
      s.unit_cost AS snapshot_cost,
      COALESCE(s.quantity, 1) AS qty,
      EXTRACT(MONTH FROM s.order_date)::int AS m
    FROM public.sales_orders s
    WHERE s.user_id = v_user
      AND s.order_date >= v_start
      AND s.order_date <  v_end
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
      AND (
        v_mp IS NULL OR v_mp = 'ALL'
        OR (v_mp = 'US' AND (s.marketplace IS NULL OR UPPER(s.marketplace) IN ('US','UNKNOWN')))
        OR (v_mp <> 'US' AND UPPER(COALESCE(s.marketplace,'')) = v_mp)
      )
  ),
  resolved AS (
    SELECT
      b.m, b.order_id, b.asin, b.qty,
      r.unit_cost AS effective_unit_cost
    FROM base b
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(v_user, b.asin, b.sku, b.order_date, b.snapshot_cost) r
  ),
  months AS (SELECT generate_series(1, 12) AS m)
  SELECT
    months.m AS month_num,
    COALESCE(SUM(e.effective_unit_cost * e.qty), 0)::numeric                                            AS cogs,
    COALESCE(SUM(e.qty), 0)::bigint                                                                     AS units_sold,
    COALESCE(SUM(CASE WHEN e.effective_unit_cost > 0 THEN e.qty ELSE 0 END), 0)::bigint                 AS units_with_cost,
    COALESCE(SUM(CASE WHEN e.effective_unit_cost > 0 THEN 0 ELSE e.qty END), 0)::bigint                 AS units_missing_cost,
    COALESCE(COUNT(DISTINCT CASE WHEN e.effective_unit_cost > 0 THEN NULL ELSE e.order_id END), 0)::bigint AS orders_missing_cost,
    COALESCE(COUNT(DISTINCT CASE WHEN e.effective_unit_cost > 0 THEN NULL ELSE NULLIF(e.asin, '') END), 0)::bigint AS asins_missing_cost
  FROM months
  LEFT JOIN resolved e ON e.m = months.m
  GROUP BY months.m
  ORDER BY months.m;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_monthly_cogs(integer, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- get_cogs_for_range with optional marketplace filter
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_cogs_for_range(
  p_start date,
  p_end date,
  p_marketplace text
)
RETURNS TABLE(total_cogs numeric, units_sold bigint, orders_with_cost bigint, total_orders bigint, cogs_by_source jsonb, units_by_source jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_mp   text := NULLIF(UPPER(COALESCE(p_marketplace,'')),'');
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      s.asin,
      COALESCE(s.seller_sku, s.sku) AS sku,
      s.order_date,
      CASE
        WHEN s.cost_locked = true AND COALESCE(s.unit_cost_at_sale, 0) > 0 THEN s.unit_cost_at_sale
        WHEN s.cost_locked = true AND COALESCE(s.unit_cost, 0) > 0 THEN s.unit_cost
        ELSE NULL::numeric
      END AS snapshot_cost,
      COALESCE(s.quantity, 1) AS qty
    FROM public.sales_orders s
    WHERE s.user_id = v_user
      AND s.order_date >= p_start
      AND s.order_date <= p_end
      AND s.order_id NOT LIKE '%-REFUND'
      AND COALESCE(s.order_status, '') NOT IN ('Canceled', 'Cancelled')
      AND (s.is_cancelled IS NULL OR s.is_cancelled = false)
      AND (
        v_mp IS NULL OR v_mp = 'ALL'
        OR (v_mp = 'US' AND (s.marketplace IS NULL OR UPPER(s.marketplace) IN ('US','UNKNOWN')))
        OR (v_mp <> 'US' AND UPPER(COALESCE(s.marketplace,'')) = v_mp)
      )
  ),
  resolved AS (
    SELECT b.qty, r.unit_cost, r.source
    FROM base b
    CROSS JOIN LATERAL public.resolve_unit_cost_v1(v_user, b.asin, b.sku, b.order_date, b.snapshot_cost) r
  ),
  by_source AS (
    SELECT
      source,
      SUM(unit_cost * qty)::numeric AS total_per_source,
      SUM(qty)::bigint AS units_per_source,
      COUNT(*) FILTER (WHERE unit_cost > 0)::bigint AS orders_with_source_cost,
      COUNT(*)::bigint AS orders_per_source
    FROM resolved
    GROUP BY source
  )
  SELECT
    COALESCE(SUM(total_per_source), 0)::numeric AS total_cogs,
    COALESCE((SELECT SUM(qty) FROM resolved), 0)::bigint AS units_sold,
    COALESCE(SUM(orders_with_source_cost), 0)::bigint AS orders_with_cost,
    COALESCE(SUM(orders_per_source), 0)::bigint AS total_orders,
    COALESCE(jsonb_object_agg(source, total_per_source), '{}'::jsonb) AS cogs_by_source,
    COALESCE(jsonb_object_agg(source, units_per_source), '{}'::jsonb) AS units_by_source
  FROM by_source;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_cogs_for_range(date, date, text) TO authenticated, service_role;
