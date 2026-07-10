-- 1) Add chargeback columns to financial_events_cache
ALTER TABLE public.financial_events_cache
  ADD COLUMN IF NOT EXISTS shipping_chargeback numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_chargeback_refund numeric DEFAULT 0;

-- 2) Recreate get_monthly_pl_breakdown with the two new columns appended at the end
DROP FUNCTION IF EXISTS public.get_monthly_pl_breakdown(integer);

CREATE OR REPLACE FUNCTION public.get_monthly_pl_breakdown(p_year integer)
RETURNS TABLE(
  month_num integer,
  -- Income
  sales numeric,
  refunds numeric,
  reimbursements numeric,
  shipping_credits numeric,
  shipping_credit_refunds numeric,
  gift_wrap_credits numeric,
  gift_wrap_credit_refunds numeric,
  promotional_rebates numeric,
  promotional_rebate_refunds numeric,
  other_income numeric,
  liquidations numeric,
  intl_markets numeric,
  -- Expenses
  referral_fees numeric,
  fba_fees numeric,
  variable_closing_fees numeric,
  fixed_closing_fees numeric,
  fba_inbound_fees numeric,
  fba_storage_fees numeric,
  fba_removal_fees numeric,
  fba_disposal_fees numeric,
  fba_long_term_storage_fees numeric,
  fba_customer_return_fees numeric,
  digital_services_fee numeric,
  fba_inbound_convenience_fee numeric,
  other_fees numeric,
  liquidations_brokerage_fee numeric,
  re_commerce_grading_charge numeric,
  compensated_clawback numeric,
  hrr_non_apparel numeric,
  warehouse_lost numeric,
  warehouse_damage numeric,
  reversal_reimbursement numeric,
  free_replacement_refund_items numeric,
  -- Tax
  sales_tax_collected numeric,
  marketplace_facilitator_tax numeric,
  sales_tax_refunds numeric,
  marketplace_facilitator_tax_refunds numeric,
  -- Shipping chargebacks (NEW)
  shipping_chargeback numeric,
  shipping_chargeback_refund numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT *
    FROM public.financial_events_cache f
    WHERE f.user_id = auth.uid()
      AND f.event_date >= make_date(p_year, 1, 1)
      AND f.event_date <  make_date(p_year + 1, 1, 1)
  ),
  months AS (SELECT generate_series(1, 12) AS m)
  SELECT
    months.m AS month_num,
    -- Income
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.sales, 0)) ELSE 0 END), 0) AS sales,
    COALESCE(SUM(CASE WHEN b.event_type = 'refund' THEN ABS(COALESCE(b.refunds, 0)) ELSE 0 END), 0) AS refunds,
    COALESCE(SUM(COALESCE(b.reimbursements, 0)), 0) AS reimbursements,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.shipping_credits, 0)) ELSE 0 END), 0) AS shipping_credits,
    COALESCE(SUM(ABS(COALESCE(b.shipping_credit_refunds, 0))), 0) AS shipping_credit_refunds,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.gift_wrap_credits, 0)) ELSE 0 END), 0) AS gift_wrap_credits,
    COALESCE(SUM(ABS(COALESCE(b.gift_wrap_credit_refunds, 0))), 0) AS gift_wrap_credit_refunds,
    COALESCE(SUM(CASE WHEN b.event_type = 'shipment' THEN ABS(COALESCE(b.promotional_rebates, 0)) ELSE 0 END), 0) AS promotional_rebates,
    COALESCE(SUM(ABS(COALESCE(b.promotional_rebate_refunds, 0))), 0) AS promotional_rebate_refunds,
    COALESCE(SUM(COALESCE(b.other_income, 0)), 0) AS other_income,
    COALESCE(SUM(ABS(COALESCE(b.liquidations, 0))), 0) AS liquidations,
    COALESCE(SUM(CASE WHEN COALESCE(b.marketplace,'US') <> 'US' AND b.event_type = 'shipment' THEN ABS(COALESCE(b.sales, 0)) ELSE 0 END), 0) AS intl_markets,
    -- Expenses
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
    COALESCE(SUM(ABS(COALESCE(b.other_fees, 0))), 0) AS other_fees,
    COALESCE(SUM(ABS(COALESCE(b.liquidations_brokerage_fee, 0))), 0) AS liquidations_brokerage_fee,
    COALESCE(SUM(ABS(COALESCE(b.re_commerce_grading_charge, 0))), 0) AS re_commerce_grading_charge,
    COALESCE(SUM(ABS(COALESCE(b.compensated_clawback, 0))), 0) AS compensated_clawback,
    COALESCE(SUM(ABS(COALESCE(b.hrr_non_apparel, 0))), 0) AS hrr_non_apparel,
    COALESCE(SUM(ABS(COALESCE(b.warehouse_lost, 0))), 0) AS warehouse_lost,
    COALESCE(SUM(ABS(COALESCE(b.warehouse_damage, 0))), 0) AS warehouse_damage,
    COALESCE(SUM(ABS(COALESCE(b.reversal_reimbursement, 0))), 0) AS reversal_reimbursement,
    COALESCE(SUM(ABS(COALESCE(b.free_replacement_refund_items, 0))), 0) AS free_replacement_refund_items,
    -- Tax
    COALESCE(SUM(COALESCE(b.sales_tax_collected, 0)), 0) AS sales_tax_collected,
    COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax, 0))), 0) AS marketplace_facilitator_tax,
    COALESCE(SUM(ABS(COALESCE(b.sales_tax_refunds, 0))), 0) AS sales_tax_refunds,
    COALESCE(SUM(ABS(COALESCE(b.marketplace_facilitator_tax_refunds, 0))), 0) AS marketplace_facilitator_tax_refunds,
    -- Shipping chargebacks
    COALESCE(SUM(ABS(COALESCE(b.shipping_chargeback, 0))), 0) AS shipping_chargeback,
    COALESCE(SUM(ABS(COALESCE(b.shipping_chargeback_refund, 0))), 0) AS shipping_chargeback_refund
  FROM months
  LEFT JOIN base b ON EXTRACT(MONTH FROM b.event_date)::int = months.m
  GROUP BY months.m
  ORDER BY months.m;
$function$;