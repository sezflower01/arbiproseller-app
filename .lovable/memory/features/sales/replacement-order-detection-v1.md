---
name: Replacement / Free-Shipment Order Detection v1
description: Amazon $0-revenue replacements + free shipments tracked with is_replacement flag so COGS still hits profit; revenue locked at 0 in shared calc.
type: feature
---

## Problem
Amazon ships our FBA inventory to a customer at $0 sale price (replacement, exchange, promo). Revenue = $0 but a unit was consumed → real COGS. Previously these rows either showed "missing price" or got an estimated/inventory-price fallback, both wrong.

## Detection (writer side)
`sales_orders` columns:
- `is_replacement boolean` (the single source of truth)
- `replacement_reason text` — `orders_api_replacement` | `fec_zero_principal_shipped` | `manual_fix_replacement`
- `related_order_id text`

Writers:
- `fetch-live-orders`: sets flag on new orders + on conversion of existing rows; inserts row into `replacement_detection_audit`.
- `sync-sales-orders` `fix_replacement` endpoint: sets flag + `replacement_reason='manual_fix_replacement'`.
- Backfill: migration tagged every existing row with `order_type IN ('Replacement','Exchange','SourcingOnDemandOrder')`.

Detection rules (same as legacy):
1. `OrderType` contains `Replacement` / `Exchange` / `SourcingOnDemandOrder`
2. Status `Shipped`/`Unshipped` with `OrderTotal = 0`

## Profit contract (reader side)
Single helper: `src/lib/sales/replacementOrder.ts` (`isReplacementRow`, `computeReplacementProfit`, `REPLACEMENT_TOOLTIP`).

`src/lib/salesCalculations.ts` `getGrossSalesForOrder()` short-circuits when `is_replacement` (or legacy order_type) is true → `{ totalSale: 0, source: 'actual', priceMissing: false }`. NO snapshot / estimated / inventory fallback.

COGS flows through normally (unit_cost × quantity) so profit goes negative by the cost amount. ROI should be hidden in UI.

UI badge: `src/components/sales/ReplacementBadge.tsx` — amber outline `Replacement` / `Free Shipment` chip with tooltip. Drop wherever a row is shown.

## Audit table
`replacement_detection_audit` (user_id, order_id, asin, detection_source, prior_*, cogs_impact, details jsonb). RLS: owner SELECT only.

## NOT done yet (next phases)
- Per-period "Replacement / Free Shipments" collapsible block (count + COGS impact) in `PeriodStatsBlocks`.
- P&L "Replacement COGS" line.
- Backfill edge function for historical zero-price AFN `StandardOrder` rows that need Orders-API re-pull.
- Nightly `tag-replacement-orders-nightly` cron.
- Wire `<ReplacementBadge>` into the grouped Live Sales / Sales table rows.
