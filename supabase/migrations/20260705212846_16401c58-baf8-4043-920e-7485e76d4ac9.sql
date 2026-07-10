
-- 1. Table
CREATE TABLE public.pl_month_summary (
  user_id uuid NOT NULL,
  month_key date NOT NULL,

  -- Income-side sums
  sales numeric NOT NULL DEFAULT 0,
  refunds numeric NOT NULL DEFAULT 0,
  shipping_credits numeric NOT NULL DEFAULT 0,
  shipping_credit_refunds numeric NOT NULL DEFAULT 0,
  gift_wrap_credits numeric NOT NULL DEFAULT 0,
  gift_wrap_credit_refunds numeric NOT NULL DEFAULT 0,
  promotional_rebates numeric NOT NULL DEFAULT 0,
  promotional_rebate_refunds numeric NOT NULL DEFAULT 0,
  other_income numeric NOT NULL DEFAULT 0,
  reimbursements_raw numeric NOT NULL DEFAULT 0,
  liquidations numeric NOT NULL DEFAULT 0,

  -- Expense-side sums
  referral_fees numeric NOT NULL DEFAULT 0,
  fba_fees numeric NOT NULL DEFAULT 0,
  variable_closing_fees numeric NOT NULL DEFAULT 0,
  fixed_closing_fees numeric NOT NULL DEFAULT 0,
  fba_inbound_fees numeric NOT NULL DEFAULT 0,
  fba_storage_fees numeric NOT NULL DEFAULT 0,
  fba_removal_fees numeric NOT NULL DEFAULT 0,
  fba_disposal_fees numeric NOT NULL DEFAULT 0,
  fba_long_term_storage_fees numeric NOT NULL DEFAULT 0,
  fba_customer_return_fees numeric NOT NULL DEFAULT 0,
  other_fees numeric NOT NULL DEFAULT 0,

  -- Tax sums
  sales_tax_collected numeric NOT NULL DEFAULT 0,
  marketplace_facilitator_tax numeric NOT NULL DEFAULT 0,
  sales_tax_refunds numeric NOT NULL DEFAULT 0,
  marketplace_facilitator_tax_refunds numeric NOT NULL DEFAULT 0,

  -- Granular columns
  compensated_clawback numeric NOT NULL DEFAULT 0,
  hrr_non_apparel numeric NOT NULL DEFAULT 0,
  digital_services_fee numeric NOT NULL DEFAULT 0,
  warehouse_lost numeric NOT NULL DEFAULT 0,
  warehouse_damage numeric NOT NULL DEFAULT 0,
  reversal_reimbursement numeric NOT NULL DEFAULT 0,
  free_replacement_refund_items numeric NOT NULL DEFAULT 0,
  fba_inbound_convenience_fee numeric NOT NULL DEFAULT 0,
  liquidations_brokerage_fee numeric NOT NULL DEFAULT 0,
  re_commerce_grading_charge numeric NOT NULL DEFAULT 0,
  shipping_chargeback numeric NOT NULL DEFAULT 0,
  shipping_chargeback_refund numeric NOT NULL DEFAULT 0,

  -- Meta
  event_count integer NOT NULL DEFAULT 0,
  refund_count integer NOT NULL DEFAULT 0,
  shipment_count integer NOT NULL DEFAULT 0,
  service_fee_count integer NOT NULL DEFAULT 0,

  computed_at timestamptz,
  stale_at timestamptz,
  source text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, month_key)
);

-- 2. Grants
GRANT SELECT ON public.pl_month_summary TO authenticated;
GRANT ALL ON public.pl_month_summary TO service_role;

-- 3. RLS
ALTER TABLE public.pl_month_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own pl_month_summary"
ON public.pl_month_summary
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- 4. Index for stale-month scan (used by lazy recompute + future cron)
CREATE INDEX idx_pl_month_summary_stale ON public.pl_month_summary (stale_at) WHERE stale_at IS NOT NULL;

-- 5. Recompute function: reads financial_events_cache for one (user, month) and upserts summary row.
CREATE OR REPLACE FUNCTION public.recompute_pl_month_summary(
  p_user_id uuid,
  p_month_key date,
  p_source text DEFAULT 'recompute'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month_start date := date_trunc('month', p_month_key)::date;
  v_month_end date := (date_trunc('month', p_month_key) + interval '1 month')::date;
BEGIN
  INSERT INTO public.pl_month_summary AS s (
    user_id, month_key,
    sales, refunds, shipping_credits, shipping_credit_refunds,
    gift_wrap_credits, gift_wrap_credit_refunds,
    promotional_rebates, promotional_rebate_refunds,
    other_income, reimbursements_raw, liquidations,
    referral_fees, fba_fees, variable_closing_fees, fixed_closing_fees,
    fba_inbound_fees, fba_storage_fees, fba_removal_fees, fba_disposal_fees,
    fba_long_term_storage_fees, fba_customer_return_fees, other_fees,
    sales_tax_collected, marketplace_facilitator_tax,
    sales_tax_refunds, marketplace_facilitator_tax_refunds,
    compensated_clawback, hrr_non_apparel, digital_services_fee,
    warehouse_lost, warehouse_damage, reversal_reimbursement,
    free_replacement_refund_items, fba_inbound_convenience_fee,
    liquidations_brokerage_fee, re_commerce_grading_charge,
    shipping_chargeback, shipping_chargeback_refund,
    event_count, refund_count, shipment_count, service_fee_count,
    computed_at, stale_at, source, updated_at
  )
  SELECT
    p_user_id,
    v_month_start,
    COALESCE(SUM(sales), 0),
    COALESCE(SUM(refunds), 0),
    COALESCE(SUM(shipping_credits), 0),
    COALESCE(SUM(shipping_credit_refunds), 0),
    COALESCE(SUM(gift_wrap_credits), 0),
    COALESCE(SUM(gift_wrap_credit_refunds), 0),
    COALESCE(SUM(promotional_rebates), 0),
    COALESCE(SUM(promotional_rebate_refunds), 0),
    COALESCE(SUM(other_income), 0),
    COALESCE(SUM(reimbursements), 0),
    COALESCE(SUM(liquidations), 0),
    COALESCE(SUM(referral_fees), 0),
    COALESCE(SUM(fba_fees), 0),
    COALESCE(SUM(variable_closing_fees), 0),
    COALESCE(SUM(fixed_closing_fees), 0),
    COALESCE(SUM(fba_inbound_fees), 0),
    COALESCE(SUM(fba_storage_fees), 0),
    COALESCE(SUM(fba_removal_fees), 0),
    COALESCE(SUM(fba_disposal_fees), 0),
    COALESCE(SUM(fba_long_term_storage_fees), 0),
    COALESCE(SUM(fba_customer_return_fees), 0),
    COALESCE(SUM(other_fees), 0),
    COALESCE(SUM(sales_tax_collected), 0),
    COALESCE(SUM(marketplace_facilitator_tax), 0),
    COALESCE(SUM(sales_tax_refunds), 0),
    COALESCE(SUM(marketplace_facilitator_tax_refunds), 0),
    COALESCE(SUM(compensated_clawback), 0),
    COALESCE(SUM(hrr_non_apparel), 0),
    COALESCE(SUM(digital_services_fee), 0),
    COALESCE(SUM(warehouse_lost), 0),
    COALESCE(SUM(warehouse_damage), 0),
    COALESCE(SUM(reversal_reimbursement), 0),
    COALESCE(SUM(free_replacement_refund_items), 0),
    COALESCE(SUM(fba_inbound_convenience_fee), 0),
    COALESCE(SUM(liquidations_brokerage_fee), 0),
    COALESCE(SUM(re_commerce_grading_charge), 0),
    COALESCE(SUM(shipping_chargeback), 0),
    COALESCE(SUM(shipping_chargeback_refund), 0),
    COUNT(*),
    COUNT(*) FILTER (WHERE event_type = 'refund' AND COALESCE(refunds, 0) > 0),
    COUNT(*) FILTER (WHERE event_type = 'shipment'),
    COUNT(*) FILTER (WHERE event_type = 'service_fee'),
    now(),
    NULL,
    p_source,
    now()
  FROM public.financial_events_cache
  WHERE user_id = p_user_id
    AND event_date >= v_month_start
    AND event_date < v_month_end
  ON CONFLICT (user_id, month_key) DO UPDATE SET
    sales = EXCLUDED.sales,
    refunds = EXCLUDED.refunds,
    shipping_credits = EXCLUDED.shipping_credits,
    shipping_credit_refunds = EXCLUDED.shipping_credit_refunds,
    gift_wrap_credits = EXCLUDED.gift_wrap_credits,
    gift_wrap_credit_refunds = EXCLUDED.gift_wrap_credit_refunds,
    promotional_rebates = EXCLUDED.promotional_rebates,
    promotional_rebate_refunds = EXCLUDED.promotional_rebate_refunds,
    other_income = EXCLUDED.other_income,
    reimbursements_raw = EXCLUDED.reimbursements_raw,
    liquidations = EXCLUDED.liquidations,
    referral_fees = EXCLUDED.referral_fees,
    fba_fees = EXCLUDED.fba_fees,
    variable_closing_fees = EXCLUDED.variable_closing_fees,
    fixed_closing_fees = EXCLUDED.fixed_closing_fees,
    fba_inbound_fees = EXCLUDED.fba_inbound_fees,
    fba_storage_fees = EXCLUDED.fba_storage_fees,
    fba_removal_fees = EXCLUDED.fba_removal_fees,
    fba_disposal_fees = EXCLUDED.fba_disposal_fees,
    fba_long_term_storage_fees = EXCLUDED.fba_long_term_storage_fees,
    fba_customer_return_fees = EXCLUDED.fba_customer_return_fees,
    other_fees = EXCLUDED.other_fees,
    sales_tax_collected = EXCLUDED.sales_tax_collected,
    marketplace_facilitator_tax = EXCLUDED.marketplace_facilitator_tax,
    sales_tax_refunds = EXCLUDED.sales_tax_refunds,
    marketplace_facilitator_tax_refunds = EXCLUDED.marketplace_facilitator_tax_refunds,
    compensated_clawback = EXCLUDED.compensated_clawback,
    hrr_non_apparel = EXCLUDED.hrr_non_apparel,
    digital_services_fee = EXCLUDED.digital_services_fee,
    warehouse_lost = EXCLUDED.warehouse_lost,
    warehouse_damage = EXCLUDED.warehouse_damage,
    reversal_reimbursement = EXCLUDED.reversal_reimbursement,
    free_replacement_refund_items = EXCLUDED.free_replacement_refund_items,
    fba_inbound_convenience_fee = EXCLUDED.fba_inbound_convenience_fee,
    liquidations_brokerage_fee = EXCLUDED.liquidations_brokerage_fee,
    re_commerce_grading_charge = EXCLUDED.re_commerce_grading_charge,
    shipping_chargeback = EXCLUDED.shipping_chargeback,
    shipping_chargeback_refund = EXCLUDED.shipping_chargeback_refund,
    event_count = EXCLUDED.event_count,
    refund_count = EXCLUDED.refund_count,
    shipment_count = EXCLUDED.shipment_count,
    service_fee_count = EXCLUDED.service_fee_count,
    computed_at = EXCLUDED.computed_at,
    stale_at = NULL,
    source = EXCLUDED.source,
    updated_at = now();
END;
$$;

-- 6. Trigger: on any change to financial_events_cache, mark affected month as stale.
-- Cheap: single upsert with no aggregation. Actual recompute is lazy (reader) or cron.
CREATE OR REPLACE FUNCTION public.mark_pl_month_stale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_event_date date;
  v_month date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_event_date := OLD.event_date;
  ELSE
    v_user_id := NEW.user_id;
    v_event_date := NEW.event_date;
  END IF;

  IF v_user_id IS NULL OR v_event_date IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_month := date_trunc('month', v_event_date)::date;

  INSERT INTO public.pl_month_summary (user_id, month_key, stale_at, source)
  VALUES (v_user_id, v_month, now(), 'trigger_stale')
  ON CONFLICT (user_id, month_key) DO UPDATE SET
    stale_at = now(),
    updated_at = now();

  -- If update crossed months, also mark old month
  IF TG_OP = 'UPDATE' AND OLD.event_date IS NOT NULL
     AND date_trunc('month', OLD.event_date) <> date_trunc('month', NEW.event_date) THEN
    INSERT INTO public.pl_month_summary (user_id, month_key, stale_at, source)
    VALUES (OLD.user_id, date_trunc('month', OLD.event_date)::date, now(), 'trigger_stale')
    ON CONFLICT (user_id, month_key) DO UPDATE SET
      stale_at = now(),
      updated_at = now();
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_fec_mark_pl_month_stale ON public.financial_events_cache;
CREATE TRIGGER trg_fec_mark_pl_month_stale
AFTER INSERT OR UPDATE OR DELETE ON public.financial_events_cache
FOR EACH ROW
EXECUTE FUNCTION public.mark_pl_month_stale();

-- 7. Backfill: recompute every existing (user, month) so the table is populated
-- before code starts reading it. Runs inline; O(distinct months) not O(rows).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT user_id, date_trunc('month', event_date)::date AS month_key
    FROM public.financial_events_cache
    WHERE user_id IS NOT NULL AND event_date IS NOT NULL
  LOOP
    PERFORM public.recompute_pl_month_summary(r.user_id, r.month_key, 'backfill');
  END LOOP;
END $$;
