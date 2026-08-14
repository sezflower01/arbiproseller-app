-- ─────────────────────────────────────────────────────────────────────
-- Fix double FX conversion in get_pl_live_summary / get_monthly_pl_breakdown
--
-- 20260728210000_pl_fx_conversion.sql divided every financial_events_cache
-- column by the marketplace's FX rate before summing, on the premise that
-- FEC stored native-marketplace-currency amounts. That premise was wrong:
-- confirmed by full audit that the ONLY writer of financial_events_cache
-- (supabase/functions/fetch-profit-loss/index.ts) runs every amount through
-- convertToUSD(amount, currency) before insert/upsert (~18 call sites,
-- covering shipment sales, refunds, fees, promotions, liquidations,
-- adjustments -- every column this function reads). FEC has been storing
-- USD the whole time; the July 28 migration introduced a second, erroneous
-- conversion on top of that, shrinking non-US marketplace amounts by their
-- FX rate a second time (US was unaffected only because its rate is 1).
-- Confirmed live on real 2026 data: MX sales reported ~17x too low (MXN
-- rate ~17.06), BR ~5x too low (BRL rate ~5.16), CA ~1.4x too low (CAD
-- rate ~1.39) -- which is what made international COGS/sales ratios look
-- absurd (690% for MX, 193% for BR) and made "add international
-- marketplaces" look like it increased the net loss. Undoing this fix
-- flips international contribution from roughly -$3,800 to roughly
-- +$4,145 on the same real data (see chat record for the full audit).
--
-- Fix: read financial_events_cache columns directly, no division. The
-- marketplace_to_currency() function and the fx.rate LEFT JOIN are no
-- longer needed by either function and are dropped from both (the
-- function itself is left defined -- it has no other callers -- in case
-- a genuinely-native-currency source needs it later).
--
-- get_monthly_cogs / get_cogs_for_range are untouched, as before: unit_cost
-- is the seller's own USD cost basis, not an Amazon-reported per-
-- marketplace amount, and was never divided by anything.
--
-- Also fixes get_monthly_pl_breakdown's `intl_markets` memo column, which
-- used a different, inconsistent "is this row international" test
-- (`COALESCE(b.marketplace,'US') <> 'US'`, raw and case-sensitive) than
-- every other US/international split in this function
-- (`UPPER(...) IN ('US','UNKNOWN')`) -- confirmed live: calling this RPC
-- with p_marketplace='US' still returned a non-zero intl_markets value,
-- because UNKNOWN-marketplace rows were being counted as "international"
-- even inside the US-only bucket. intl_markets remains purely
-- informational (see MonthlyPLBreakdown.tsx's `informational: true` flag,
-- which excludes it from every total) -- this fix only corrects what the
-- memo displays, it never touched Net Profit.
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
    SELECT
      f.event_type,
      f.sales,
      f.refunds,
      f.reimbursements,
      f.reversal_reimbursement,
      f.free_replacement_refund_items,
      f.shipping_credits,
      f.shipping_credit_refunds,
      f.gift_wrap_credits,
      f.gift_wrap_credit_refunds,
      f.promotional_rebates,
      f.promotional_rebate_refunds,
      f.other_income,
      f.liquidations,
      f.referral_fees,
      f.fba_fees,
      f.variable_closing_fees,
      f.fixed_closing_fees,
      f.fba_inbound_fees,
      f.fba_inbound_convenience_fee,
      f.fba_storage_fees,
      f.fba_removal_fees,
      f.fba_disposal_fees,
      f.fba_long_term_storage_fees,
      f.fba_customer_return_fees,
      f.digital_services_fee,
      f.other_fees,
      f.liquidations_brokerage_fee,
      f.re_commerce_grading_charge,
      f.compensated_clawback,
      f.hrr_non_apparel,
      f.warehouse_lost,
      f.warehouse_damage,
      f.sales_tax_collected,
      f.marketplace_facilitator_tax,
      f.sales_tax_refunds,
      f.marketplace_facilitator_tax_refunds
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
      f.event_type,
      f.marketplace,
      EXTRACT(MONTH FROM f.event_date::date)::int AS event_month,
      f.sales,
      f.refunds,
      f.reimbursements,
      f.reversal_reimbursement,
      f.free_replacement_refund_items,
      f.shipping_credits,
      f.shipping_credit_refunds,
      f.gift_wrap_credits,
      f.gift_wrap_credit_refunds,
      f.promotional_rebates,
      f.promotional_rebate_refunds,
      f.other_income,
      f.liquidations,
      f.referral_fees,
      f.fba_fees,
      f.variable_closing_fees,
      f.fixed_closing_fees,
      f.fba_inbound_fees,
      f.fba_storage_fees,
      f.fba_removal_fees,
      f.fba_disposal_fees,
      f.fba_long_term_storage_fees,
      f.fba_customer_return_fees,
      f.digital_services_fee,
      f.fba_inbound_convenience_fee,
      f.other_fees,
      f.liquidations_brokerage_fee,
      f.re_commerce_grading_charge,
      f.compensated_clawback,
      f.hrr_non_apparel,
      f.warehouse_lost,
      f.warehouse_damage,
      f.sales_tax_collected,
      f.marketplace_facilitator_tax,
      f.sales_tax_refunds,
      f.marketplace_facilitator_tax_refunds,
      f.shipping_chargeback,
      f.shipping_chargeback_refund,
      f.restocking_fee
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
    -- intl_markets: informational only (see MonthlyPLBreakdown.tsx
    -- `informational: true`), never added to totals. Fixed to use the same
    -- normalized US/international test as the row-inclusion filter above,
    -- instead of a raw case-sensitive `<> 'US'` that miscounted UNKNOWN-
    -- marketplace rows as "international" even in a US-only report.
    COALESCE(SUM(CASE WHEN NOT (COALESCE(UPPER(b.marketplace),'US') IN ('US','UNKNOWN')) AND b.event_type = 'shipment' THEN ABS(COALESCE(b.sales, 0)) ELSE 0 END), 0) AS intl_markets,
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
