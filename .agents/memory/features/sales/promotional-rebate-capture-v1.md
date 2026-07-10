---
name: Promotional Rebate Capture & Profit Math
description: PromotionDiscount captured per-order on sales_orders so Live Sales + Sales Report subtract Amazon-deducted coupon/lightning-deal rebates from profit (all marketplaces). Fixes overstated MX/CA/BR profit.
type: feature
---

# Promotional Rebate Accuracy (Phase 1)

**Why**: Amazon deducts PromotionDiscount (coupons, lightning deals, automatic rebates) from payouts even when the seller did not create the promo. Previously this was only captured on the FEC settlement side; the live Orders-API path stored `sold_price` = gross ItemPrice and Live Sales used `promoRebates: 0`, inflating profit on every marketplace, especially MX/CA/BR.

## Storage — `sales_orders`
- `promotion_discount` — promo amount in same unit as `sold_price` (native today)
- `promotion_discount_native` — native local currency amount
- `promotion_discount_currency` — currency code
- `promotion_discount_source` — `orders_itemprice` | `orders_pending` | `fec_settlement` | `backfill`
- `promotion_discount_captured_at` — timestamp

NULL = never checked. Zero = checked, no promo on this order.

## Writers
- `sync-sales-orders` enrichment path (Orders API → orders_itemprice): sums `PromotionDiscount.Amount` across ALL items on the order.
- `sync-sales-orders` CA/MX/BR pending OrderItems path: same, source `orders_pending`.
- `backfill-promotional-discount` edge fn: NA marketplaces, last 90 days, settled rows missing promo. Stamps zero when none found.

## Readers
- `live-sales-core.ts` (Deno): subtracts USD-converted promo from confirmed + fallback revenue → flows into profit automatically.
- `get_smart_fallback_daily_totals` RPC: returns `so_promo_rebates` per day.
- `PeriodStatsBlocks.tsx` Smart per-day aggregator: adds `d.so_promo_rebates` into `agg.promoRebates` for SO-routed days. FEC-routed days already added `fec_promo_rebates`.
- Popup audit display already conditional on `promoRebates > 0` (Gross → Net breakdown).

## Invariants
- NEVER overwrite `sold_price` / `total_sale_amount` to subtract promo — those remain gross ItemPrice per existing contracts.
- Repricer logic was NOT touched.
