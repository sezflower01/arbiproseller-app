
# FEC Promo Extraction — Design Only (No Code, No Deploy)

## Goal
Populate `sales_orders.promotion_discount*` on rows settled via the Financial Events (FEC) path, so promo attribution works on the 70% of confirmed orders that currently have no promo signal.

## Additive/Non-destructive Guarantee — Requested Review

**Short answer: it is NOT purely additive at the calculation layer. It writes a new column, but that column IS consumed downstream. Deploying without a guard would double-count promotions and reduce reported revenue.** This section is the whole reason this needs a design pass first.

### What's currently wired up
- FEC path writes: `sold_price`, `total_sale_amount`, fees, `price_source='financial_events'`.
- FEC path does NOT write: `promotion_discount*`. Those columns stay NULL on all financial_events rows.
- **Downstream consumers of `promotion_discount` on `sales_orders`:**
  - `supabase/functions/_shared/live-sales-core.ts:922, 996` — subtracts `promotion_discount` from revenue.
  - `src/lib/sales/periodSnapshot.ts:178` — subtracts from period revenue totals.
  - `src/lib/sales/promotionDeductions.ts:114-120` — reads USD-safe rows and applies as a deduction in the P&L feed.
- **P&L already has a separate settlement-level promo signal:** `fetch-profit-loss/index.ts` reads `promotional_rebates` from `financial_events_cache` (settlement rollup), independent of `sales_orders`. That's the InventoryLab-parity path.

### Where the collision would happen
For FEC-settled rows, the same promo dollar would be:
- Subtracted once from Live Sales revenue via `sales_orders.promotion_discount` (new — introduced by this patch).
- Subtracted again from P&L revenue via `financial_events_cache.promotional_rebates` (existing).

The ~1.4% ArbiProSeller/InventoryLab agreement you established would shift downward on any FEC row with a real promo. Not "quietly perturb" — visibly perturb, by exactly the promo amount, twice.

### The additive claim, phrased honestly
- **Schema-level:** additive. Adds no columns, only populates existing NULLs.
- **Storage-level:** additive. `sold_price`, `total_sale_amount`, fees — untouched by this patch.
- **Calculation-level: NOT additive** on the Live Sales / P&L snapshot paths. Requires either (a) a source-aware guard in the consumers, or (b) not writing on FEC rows at all.

## Two design options — pick one

### Option A — Write promo, guard the consumers (recommended)
1. In FEC parser (sync-sales-orders lines ~8360-8460), extract from each `ShipmentItem`:
   - `PromotionList[].PromotionAmount.CurrencyAmount` — sum absolute values into `itemPromo`.
   - Also inspect `ItemChargeAdjustmentList` for negative adjustments tagged `PromotionalRebates` (defensive; some settlements route through adjustments).
2. On settle-update / settle-insert (lines 8650-8811), add:
   - `promotion_discount_native = itemPromoTotal`
   - `promotion_discount = itemPromoTotal * fxRate` (USD)
   - `promotion_discount_currency = currencyCode`
   - `promotion_discount_source = 'financial_events'`
   - `promotion_discount_captured_at = now()`
3. **Guard downstream** so we don't double-deduct against `financial_events_cache.promotional_rebates`:
   - `live-sales-core.ts`: skip `promotion_discount` subtraction when `price_source='financial_events'` AND a settlement-level promo already exists for the same order. Simpler variant: skip whenever `promotion_discount_source='financial_events'`, since the settlement rollup already handles it.
   - `periodSnapshot.ts` and `promotionDeductions.ts`: same guard, keyed on `promotion_discount_source`.
4. Diagnostic value delivered: promo attribution now visible per-order in the DB, without changing any total.

### Option B — Don't write on FEC rows at all
1. Add `PromotionList` extraction to the FEC parser but only **log** it (`console.log('SETTLED_PROMO ...')`).
2. Leave `sales_orders.promotion_discount` NULL on FEC rows.
3. Rely entirely on `financial_events_cache.promotional_rebates` (already wired to P&L).
4. Cheapest, safest, zero downstream risk. Cost: still can't do per-order promo attribution from `sales_orders` alone — you'd have to join to `financial_events_cache` every time.

**Recommendation:** Option A. Diagnostic value is the whole reason we're doing this. But the guard MUST land in the same PR, not "after."

## Rollout guardrails (whichever option ships)
- Deno unit test with a synthetic FEC response containing `PromotionList` + non-promo control, asserting extraction and downstream-guard behavior.
- Reconciliation delta report: run once against last 60 days of settled US rows before and after the patch. If any non-zero delta appears in Live Sales revenue or P&L revenue for pre-existing rows, block deploy.
- Backfill of historical FEC rows is a separate, later approval — same shape as the 73-row backfill: dry-run first, sample review, real run after sign-off.

## Out of scope for this patch
- Non-US currency contract fixes.
- Business-customer / price-lock buyer-shown-price gap.
- The 73-row Tier-A/B/C backfill.
- Wiring `promotion_discount_captured_at` into any UI badges.

## Files that would change (Option A)
- `supabase/functions/sync-sales-orders/index.ts` — FEC parser + settle update/insert.
- `supabase/functions/_shared/live-sales-core.ts` — source-aware subtraction guard.
- `src/lib/sales/periodSnapshot.ts` — same guard.
- `src/lib/sales/promotionDeductions.ts` — same guard.
- New test: `supabase/functions/sync-sales-orders/fec-promo-extraction_test.ts`.

## What I need from you before writing any code
- Approve Option A or Option B.
- Explicitly confirm you accept that Option A requires touching the four consumer files above — not just the FEC writer — because the "additive" property lives in the guards, not in the writer alone.
