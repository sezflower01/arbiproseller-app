# Profit-Loss page — open items

## OPEN BUG (hidden, not fixed): Total Income discrepancy inside legacy Accounting View

**Symptom**: On the same page render, same period, same summary object, two different Total Income figures appear inside the legacy "🧾 Accounting View" block:

- **Top KPI summary card** shows `$417,525.82`
  - Source: `src/pages/tools/ProfitLoss.tsx` line 2579
  - Formula: `incomeView = summary.totalIncome + dIncome + reclassified`
  - Where `reclassified = refunds + promotionalRebates + shippingCreditRefunds + giftWrapCreditRefunds`
- **"Net Profit Formula" box directly below** shows `$398,498.93`
  - Source: `src/pages/tools/ProfitLoss.tsx` line 2696
  - Formula: `summary.totalIncome + (includeEst ? dIncome : 0)` — WITHOUT `reclassified`

Delta = `$417,525.82 - $398,498.93 = $19,026.89`, which matches the sum of refunds + promo rebates + shipping-credit refunds + gift-wrap-credit refunds for the period.

**Diagnosis (unconfirmed)**: The KPI card intentionally shows income *before* refund reclassification (Amazon's raw Sales credits), while the Formula box shows income *after* reclassifying refunds/rebates back to the expense side. Both roll up to the same NET PROFIT (the reclassified amount is added to both income and expenses, cancelling out). But the two boxes present themselves as "Total Income" with no label distinguishing gross vs net-of-refunds — reading either one out of context gives a wrong number.

**Status**: As of the P&L cleanup, the entire legacy Accounting View is gated behind a "Show legacy Accounting View" toggle (off by default) in `src/pages/tools/ProfitLoss.tsx` around line 2563 (`showLegacyAccountingView` state at line 315). Normal users never see the discrepancy, so this dropped from user-visible to hidden legacy debt.

**Why not fixed yet**: See the memory rule about not destroying evidence — before deciding which of the two "Total Income" figures is canonical (gross vs net-of-refunds), we need to confirm that the Reconciled summary at the top of the page and every downstream consumer (tax reports, exports, InventoryLab-style Monthly Breakdown) agree on one definition. Picking the wrong one silently corrupts everything else.

**When to fix**:
- Before removing the "Show legacy Accounting View" toggle for good
- Before anyone starts trusting or exporting numbers from the legacy view
- Before reconciling against an Amazon disbursement report (the reason we kept the settled-only view alive)

**Fix outline** (do NOT execute yet — needs product decision first):
1. Confirm which definition matches Amazon's own "Sales" line in the Payments/Statement report: gross principal (before refund netting) or net (post-refund).
2. Unify both boxes to that definition. Label the other view explicitly (e.g. "Sales (gross, before refunds)" vs "Net Sales").
3. Add a guard test in `_tests/` that asserts every "Total Income" label on the P&L page renders the same underlying computation, so future refactors can't reintroduce the drift.

## Related pattern in this codebase

We've hit near-identical drift before — see the refund `+=` bug, the FX misconversion in BR sales, and the ghost-ASIN resurrection. All three had the shape "two code paths computing the same quantity, one drifts, users see the wrong number." This one is the same shape, just currently hidden. Do not let "hidden" become "fine."

---

## OPEN FEATURE (deferred): On-screen estimated add-on in MonthlyPLBreakdown

**Symptom**: The P&L page had a "Live" / "Accounting" toggle (`plMode` state, `"estimated"` vs `"reconciled"`) that implied it switched the on-screen totals between an accrual view (including unsettled `sales_orders`) and a settled-only FEC view. In reality, the on-screen Sales/Income/COGS/Net Profit rows in `src/components/profitloss/MonthlyPLBreakdown.tsx` were FEC-only in **both** states — the `mode` prop was only used at line 1511 to show/hide the "Tax Information" and "Memo / Informational Items" sections below Net Profit. Switching to "Live" produced identical numbers because no different data path was ever wired up for the on-screen table.

The estimated add-on logic (pull `sales_orders` not present in `financial_events_cache` for the period, bucket by `order_date`, add deltas to income/expenses/cogs) DOES exist — but only in the **Excel export** code path in `src/pages/tools/ProfitLoss.tsx` around line 1683 (`isEstimatedExport = plMode === "estimated"`).

**Interim fix shipped** (safe, zero calculation change): the toggle was relabeled from "P&L Mode: Live / Accounting" to "Tax & Memo Sections: Show / Hide" to accurately describe what it actually does on-screen. The internal state names (`"estimated"` / `"reconciled"`) and the Excel export behavior were left untouched to preserve today's InventoryLab reconciliation and the export add-on.

**Real fix (not started)**: Wire the estimated add-on into `MonthlyPLBreakdown` so an on-screen "Live" mode genuinely pulls unsettled `sales_orders` into Sales/Income/COGS the same way the Excel export does today. Once that lands, the toggle can be restored to a real "Live / Accounting" data-mode switch.

**Why not fixed same-day**:
1. `MonthlyPLBreakdown`'s data loader was already touched heavily today (panel consolidation, transport-overhead fix, summary-table wiring). Stacking another change on top of it before an InventoryLab re-reconciliation is exactly the anti-pattern this project keeps flagging.
2. Any change that adds unsettled `sales_orders` into the on-screen totals must be re-verified against InventoryLab within the same ~1.4% tolerance we achieved today, or it silently corrupts the reconciliation.
3. Needs a fresh session with dedicated reconciliation time afterward, not a tail-end patch.

**Fix outline** (do NOT execute without a scheduled reconciliation slot):
1. Port the export-side add-on math (ProfitLoss.tsx ~L1683–L1770) into `MonthlyPLBreakdown`'s data loader as an optional monthly delta driven by the `mode` prop.
2. Ensure de-dup against `financial_events_cache` uses the same `amazon_order_id` set logic as the export path.
3. Re-run the InventoryLab comparison in both modes; confirm the reconciled mode still matches within ≤1.4% and the estimated mode produces a documented, explainable delta above it (equal to unsettled sales_orders sum for the period).
4. Only after that verification, restore the toggle label to "P&L Mode: Live / Accounting" and reintroduce the informative titles.

**Related tracked items** (same file above): $417K/$398K legacy Accounting View discrepancy, S4 delta sync, Option B custom-range refactor.
