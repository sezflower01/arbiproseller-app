
CREATE OR REPLACE FUNCTION public.get_authoritative_period_totals(start_ts text, end_ts text)
RETURNS TABLE(
  sales numeric, refunds numeric, total_fees numeric,
  unique_orders bigint, refund_count bigint, row_count bigint, total_units bigint,
  cogs numeric,
  promotional_rebates_total numeric, shipping_credits_total numeric, gift_wrap_credits_total numeric,
  referral_fees_total numeric, fba_fees_total numeric,
  variable_closing_fees_total numeric, fixed_closing_fees_total numeric,
  storage_fees_total numeric, removal_fees_total numeric, disposal_fees_total numeric,
  long_term_storage_fees_total numeric, customer_return_fees_total numeric,
  other_fees_total numeric, digital_services_fee_total numeric,
  inbound_fees_total numeric, inbound_convenience_fee_total numeric,
  compensated_clawback_total numeric, hrr_non_apparel_total numeric,
  re_commerce_grading_total numeric,
  liquidations_total numeric, liquidations_brokerage_total numeric,
  warehouse_damage_total numeric, warehouse_lost_total numeric,
  reversal_reimbursement_total numeric, other_income_total numeric,
  free_replacement_total numeric,
  shipping_credit_refunds_total numeric, gift_wrap_credit_refunds_total numeric,
  promotional_rebate_refunds_total numeric,
  marketplace_tax_total numeric, marketplace_tax_refunds_total numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  -- Collect distinct shipment order IDs to look up COGS from sales_orders
  shipment_order_ids AS (
    SELECT DISTINCT amazon_order_id
    FROM base
    WHERE event_type = 'shipment'
      AND amazon_order_id IS NOT NULL AND amazon_order_id != ''
  ),
  -- Get COGS directly from sales_orders (authoritative source with unit_cost already resolved)
  order_cogs AS (
    SELECT COALESCE(SUM(so.unit_cost * so.quantity), 0) AS total_cogs
    FROM public.sales_orders so
    INNER JOIN shipment_order_ids soi ON soi.amazon_order_id = so.order_id
    WHERE so.user_id = auth.uid()
      AND so.unit_cost > 0
      AND so.status != 'Cancelled'
  )
  SELECT
    COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.sales,0)) ELSE 0 END),0) AS sales,
    COALESCE(SUM(CASE WHEN event_type='refund' THEN ABS(COALESCE(b.refunds,0)) ELSE 0 END),0) AS refunds,
    COALESCE(SUM(
      ABS(COALESCE(b.referral_fees,0))+ABS(COALESCE(b.fba_fees,0))+
      ABS(COALESCE(b.variable_closing_fees,0))+ABS(COALESCE(b.fixed_closing_fees,0))+
      ABS(COALESCE(b.fba_inbound_fees,0))+ABS(COALESCE(b.fba_storage_fees,0))+
      ABS(COALESCE(b.fba_removal_fees,0))+ABS(COALESCE(b.fba_disposal_fees,0))+
      ABS(COALESCE(b.fba_long_term_storage_fees,0))+ABS(COALESCE(b.fba_customer_return_fees,0))+
      ABS(COALESCE(b.other_fees,0))
    ),0) AS total_fees,
    COALESCE(COUNT(DISTINCT NULLIF(b.amazon_order_id,'')) FILTER (WHERE b.amazon_order_id NOT LIKE '%-REFUND%'),0) AS unique_orders,
    COALESCE(COUNT(*) FILTER (WHERE b.event_type='refund'),0) AS refund_count,
    COALESCE(COUNT(*),0) AS row_count,
    COALESCE(SUM(CASE WHEN b.event_type='shipment' THEN 1 ELSE 0 END),0) AS total_units,
    (SELECT total_cogs FROM order_cogs) AS cogs,
    -- Net sales breakdown
    COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.promotional_rebates,0)) ELSE 0 END),0) AS promotional_rebates_total,
    COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.shipping_credits,0)) ELSE 0 END),0) AS shipping_credits_total,
    COALESCE(SUM(CASE WHEN event_type='shipment' THEN ABS(COALESCE(b.gift_wrap_credits,0)) ELSE 0 END),0) AS gift_wrap_credits_total,
    -- Individual fee components
    COALESCE(SUM(ABS(COALESCE(b.referral_fees,0))),0) AS referral_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.fba_fees,0))),0) AS fba_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.variable_closing_fees,0))),0) AS variable_closing_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.fixed_closing_fees,0))),0) AS fixed_closing_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.fba_storage_fees,0))),0) AS storage_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.fba_removal_fees,0))),0) AS removal_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.fba_disposal_fees,0))),0) AS disposal_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.fba_long_term_storage_fees,0))),0) AS long_term_storage_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.fba_customer_return_fees,0))),0) AS customer_return_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.other_fees,0))),0) AS other_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.digital_services_fee,0))),0) AS digital_services_fee_total,
    COALESCE(SUM(ABS(COALESCE(b.fba_inbound_fees,0))),0) AS inbound_fees_total,
    COALESCE(SUM(ABS(COALESCE(b.fba_inbound_convenience_fee,0))),0) AS inbound_convenience_fee_total,
    COALESCE(SUM(ABS(COALESCE(b.compensated_clawback,0))),0) AS compensated_clawback_total,
    COALESCE(SUM(ABS(COALESCE(b.hrr_non_apparel,0))),0) AS hrr_non_apparel_total,
    COALESCE(SUM(ABS(COALESCE(b.re_commerce_grading_charge,0))),0) AS re_commerce_grading_total,
    COALESCE(SUM(ABS(COALESCE(b.liquidations,0))),0) AS liquidations_total,
    COALESCE(SUM(ABS(COALESCE(b.liquidations_brokerage_fee,0))),0) AS liquidations_brokerage_total,
    COALESCE(SUM(ABS(COALESCE(b.warehouse_damage,0))),0) AS warehouse_damage_total,
    COALESCE(SUM(ABS(COALESCE(b.warehouse_lost,0))),0) AS warehouse_lost_total,
    COALESCE(SUM(ABS(COALESCE(b.reversal_reimbursement,0))),0) AS reversal_reimbursement_total,
    COALESCE(SUM(ABS(COALESCE(b.other_income,0))),0) AS other_income_total,
    COALESCE(SUM(ABS(COALESCE(b.free_replacement_refund_items,0))),0) AS free_replacement_total,
    -- Refund-specific credits
    COALESCE(SUM(ABS(COALESCE(b.shipping_credit_refunds,0))),0) AS shipping_credit_refunds_total,
    COALESCE(SUM(ABS(COALESCE(b.gift_wrap_credit_refunds,0))),0) AS gift_wrap_credit_refunds_total,
    COALESCE(SUM(ABS(COALESCE(b.promotional_rebate_refunds,0))),0) AS promotional_rebate_refunds_total,
    COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax,0))),0) AS marketplace_tax_total,
    COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax_refunds,0))),0) AS marketplace_tax_refunds_total
  FROM base b;
$function$;
