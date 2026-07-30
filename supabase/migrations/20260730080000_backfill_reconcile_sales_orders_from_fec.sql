-- One-off backfill: reconcile all historical sales_orders rows against
-- authoritative financial_events_cache settlement data, applying the same
-- logic just added to sync-historical-settled's Step 3 (see
-- supabase/functions/sync-historical-settled/index.ts). Fixes fees/revenue/
-- roi for any order where financial_events_cache has the real settled
-- amounts but sales_orders was still carrying an estimate (learned_history
-- fee fallback, stale Orders-API price, etc) — as confirmed live on order
-- 702-9421851-6838639 (CA), where fees were understated ~7% and roi was
-- badly stale (-34.8% vs the corrected +41.1%).
--
-- Scoped to the account this investigation covered
-- (020dd71f-78ce-4bc2-9117-dc997c533ab9), not applied across all sellers.
--
-- Excludes REFUND synthetic rows and replacement orders (intentionally
-- zero-revenue; a shipment fee event existing for them must not overwrite
-- that with FEC's dollar sales figure).

with fec_agg as (
  select
    amazon_order_id as order_id,
    sum(abs(sales)) as sales_usd,
    sum(abs(referral_fees)) as referral_usd,
    sum(abs(fba_fees)) as fba_usd,
    sum(
      case when abs(variable_closing_fees) > 0
        then abs(variable_closing_fees)
        else abs(fixed_closing_fees)
      end
    ) as closing_usd
  from financial_events_cache
  where user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
    and event_type = 'shipment'
    and amazon_order_id is not null
    and amazon_order_id <> ''
  group by amazon_order_id
  having sum(abs(sales)) > 0
),
so_qty as (
  select order_id, sum(greatest(1, coalesce(quantity, 1))) as total_qty
  from sales_orders
  where user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
    and order_id not like '%-REFUND'
    and coalesce(is_replacement, false) = false
  group by order_id
),
so_target as (
  select
    so.id,
    so.unit_cost,
    greatest(1, coalesce(so.quantity, 1)) as qty,
    fa.sales_usd,
    fa.referral_usd,
    fa.fba_usd,
    fa.closing_usd,
    (fa.referral_usd + fa.fba_usd + fa.closing_usd) as total_fees_usd,
    (greatest(1, coalesce(so.quantity, 1))::numeric / q.total_qty) as share
  from sales_orders so
  join fec_agg fa on fa.order_id = so.order_id
  join so_qty q on q.order_id = so.order_id
  where so.user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
    and so.order_id not like '%-REFUND'
    and coalesce(so.is_replacement, false) = false
)
update sales_orders so
set
  sold_price = round((st.sales_usd * st.share / st.qty)::numeric, 2),
  item_price = round((st.sales_usd * st.share / st.qty)::numeric, 2),
  total_sale_amount = round((st.sales_usd * st.share)::numeric, 2),
  referral_fee = round((st.referral_usd * st.share)::numeric, 2),
  fba_fee = round((st.fba_usd * st.share)::numeric, 2),
  closing_fee = round((st.closing_usd * st.share)::numeric, 2),
  total_fees = round((st.total_fees_usd * st.share)::numeric, 2),
  roi = case
    when coalesce(st.unit_cost, 0) > 0 then
      round(
        (
          ((st.sales_usd * st.share) - (st.total_fees_usd * st.share) - (st.unit_cost * st.qty))
          / (st.unit_cost * st.qty) * 1000
        )::numeric
      ) / 10
    else null
  end,
  price_source = 'reconciled_fec',
  fees_source = 'financial_events',
  price_confidence = 'CONFIRMED',
  status = 'settled',
  updated_at = now()
from so_target st
where so.id = st.id;
