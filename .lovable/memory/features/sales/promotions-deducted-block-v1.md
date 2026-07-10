---
name: Promotions Deducted shared block
description: Single shared collapsible "Promotions Deducted" block + helper used by Sales Report + Live Sales (desktop & mobile); displayed value is identical to the amount subtracted from net profit
type: feature
---

# Shared Promotions Deducted block (v1)

## What
One collapsible block — `<PromotionsDeductedSection />` — rendered in:
- `src/pages/tools/LiveSales.tsx` (powers Sales Report via `Sales.tsx` passthrough AND desktop Live Sales)
- `src/pages/tools/MobileLiveSales.tsx`

All three call the SAME helper: `fetchPromotionDeductions()` in
`src/lib/sales/promotionDeductions.ts`.

## Source-of-truth contract
The block shows EXACTLY the USD amount that net-profit math subtracts.
- Net-profit path in `PeriodStatsBlocks.fetchSellerboardModeStat` previously hardcoded
  `promotionalRebates = 0` (lines ~1756 + ~2065). Both now call
  `fetchPromotionDeductions({ userId, range, marketplace: 'ALL' })` so the deduction
  the user sees in the block is the deduction applied to grossProfit + netSalesBreakdown.
- Do NOT add a separate promo calc anywhere. Always import the helper.

## Data sources (merged, no de-dup)
1. `financial_events_cache.promotional_rebates` — USD, negative-signed, abs'd.
   Authoritative for non-US Amazon-funded promos (MX/CA/BR lightning deals, coupons)
   and settled US promos. Also captures `promotional_rebate_refunds` as a negative
   amount (rebate refund REDUCES the deduction).
2. `sales_orders.promotion_discount` — only USD-safe rows
   (`marketplace='US'` OR `promotion_discount_currency='USD'`). Mirrors
   `getOrderPromoUsd()` in `src/lib/salesCalculations.ts`.

The two are summed (matches `get_smart_fallback_daily_totals`'s
`so_promo_rebates + fec_promo_rebates`). Do NOT de-dup by order_id — that
would silently drop the FEC settlement row when SO also has a pending capture.

## Marketplace filter
Helper accepts `marketplace?: string` (`"ALL" | "US" | "CA" | "MX" | "BR" | ...`).
US filter includes `marketplace IS NULL` (legacy rows). Both pages pass their
active filter state (`selectedMarketplace` / `marketplaceFilter`) into the block.

## UI contract
- Header chip shows `−$X.XX` total
- Marketplace breakdown chips (per-mp totals)
- Per-row table: date, clickable order_id → Seller Central, ASIN, marketplace,
  source badge (`FEC / settlement` vs `sales_orders`), source field name, USD amount
- Footer line: "This amount is subtracted from net profit in both Sales Report
  and Live Sales totals."

## Why
User reported that Seller Central showed promo deductions but Sales Report /
Live Sales did not surface them clearly nor always subtract them from profit
(two hardcoded zeros in `fetchSellerboardModeStat`). Single shared block +
single shared helper eliminates the divergence and makes the deduction auditable.
