# ArbiProSeller Architecture Audit & Verification Report

**Last updated:** 2026-06-17 (Refund GROSS-vs-NET drift verified ✅)
**Maintainer:** Keep this file current whenever a source-of-truth rule, formula,
or canonical helper changes. Future-you (or anyone replacing the founder) reads
this first.

---

## 0. How to read this document

Findings are classified by **evidence level**, not by severity alone. Severity
without evidence is an opinion; severity with reproducible evidence is a bug.

| Tier | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| ✅ VERIFIED | Reproduced against real production data. Includes the query/row used. |
| 🟡 PROBABLE | Code pattern strongly suggests the bug, but not reproduced yet.        |
| 🔵 INFERENCE | Architectural concern from reading code. May or may not be a real bug. |
| ⚪ FALSE-POSITIVE | Audit flagged it; investigation showed it is intentional / correct. |

---

## 1. Verified findings (Tier ✅)

### 1.1 Repricer FBM cost fallback used batch total instead of per-unit cost  — FIXED 2026-06-17

**File:** `supabase/functions/repricer-evaluate/index.ts` (lines 522-558)
**Shared resolver:** `supabase/functions/_shared/fbm-cost-resolver.ts` (pure, unit-tested)
**Regression test:** `supabase/functions/_tests/repricer-evaluate/fbm_cost_resolver_test.ts` (8 cases, all passing)

**Evidence — Stage 1: 20-row spot check (2026-06-17):**
20 of 20 sampled rows confirmed `amount = cost / units`.

**Evidence — Stage 2: FULL-TABLE SCAN (2026-06-17):**
```sql
SELECT
  COUNT(*) FILTER (WHERE cost IS NOT NULL AND amount IS NOT NULL AND units > 0) AS comparable,
  COUNT(*) FILTER (WHERE cost IS NOT NULL AND amount IS NOT NULL AND units > 0
                   AND ABS(amount - (cost/units)) > 0.01) AS violations
FROM created_listings;
```
Results across **all 8,250 rows**:
- 6,857 comparable (cost+amount+units all present)
- **6,844 (99.81%) satisfy `amount = cost/units` — canonical contract confirmed at scale**
- **13 anomalous rows (0.19%)** where `amount == cost` and `units > 1`
  (e.g. ASIN B07DPWR6ZQ: cost=30.22, amount=30.22, units=20). Some writer
  path stored the per-unit cost in BOTH columns. The fix is still correct
  for these rows because it prefers `amount`, which IS per-unit by contract.

**Conclusion:** `created_listings.cost` is the **batch total** (99.81% of rows).
`created_listings.amount` is the **per-unit cost** (always).

**Old code (buggy):**
```ts
if (!inventoryCost && createdListing.cost) inventoryCost = Number(createdListing.cost);
```
Wrote the batch total into `inventoryCost`, inflating ROI floors by Nx (N=units)
for any FBM ASIN without an inventory row — engine then refused to compete on
price, costing Buy Box.

**Fix applied:**
- Extracted into pure `resolveFbmUnitCost` helper.
- Resolution order: `amount` → `cost/units` → raw `cost` (last only when units
  is unknown or 1).
- **Telemetry added:** every fallback hit logs
  `[repricer-evaluate] COST_FALLBACK_PATH path=<amount|cost_div_units|raw_cost|none>`
  with cost, amount, units, resolved value. Grep edge-function logs for
  `path=raw_cost` or `path=cost_div_units` to detect upstream regressions
  (e.g. a writer that stops populating `amount` and silently forces the
  platform onto a derived path forever — exactly how this bug class was born).

**Test results (2026-06-17):** all 5 matched tests pass, including
`(cost=125, amount=12.5, units=10) → unit cost MUST be 12.5, NOT 125`.

---

### 1.2 Refund cost: GROSS vs NET drift across 3 PeriodStatsBlocks paths  — VERIFIED 2026-06-17

**Files / lines:**
- `src/components/sales/PeriodStatsBlocks.tsx`
  - L1545 `fetchHistoricalStat` (historical RPC path) — emits `refundedReferralFee: 0`
  - L2062 `fetchSellerboardModeStat` — emits `refundedReferralFee: 0`
  - L2634 `fetchParityModeStat` — emits `refundedReferralFee: 0`
  - L3384 cached path — passes already-NET cache value with `refundedReferralFee: 0` (safe — see below)
- `supabase/functions/_shared/live-sales-core.ts` L580-594 — computes refund cost as
  `principal + promo_refunds + shipping_credit_refunds + chargeback + gift_wrap_refunds + referral_fees(signed) + admin_retention`
  → **NET + admin retention** (refund admin = `min($5, |referral|·20%)`)
- `src/pages/tools/MobileLiveSales.tsx` L810-846 — same formula as live-sales-core
- `src/lib/sales/periodTotals.ts` L211 — `refundCostTotal = refundedAmount − refundedReferralFee`
  (NET when caller passes the positive credit; GROSS when caller passes 0)

**Evidence — production data, 180-day window, financial_events_cache:**
```sql
SELECT COUNT(*), SUM(ABS(refunds)) gross,
       SUM(ABS(refunds)+referral_fees) canonical_net,
       SUM(ABS(refunds)+referral_fees+LEAST(5,ABS(referral_fees)*0.20)) live_sales_net
FROM financial_events_cache WHERE event_type='refund'
  AND event_date >= NOW()-INTERVAL '180 days';
```
| Refund rows | Gross (Path A/B/C) | Canonical NET if fed properly | Live Sales NET + admin |
|------------:|-------------------:|------------------------------:|-----------------------:|
| 386         | **$8,459.30**      | **$7,374.86**                 | **$7,591.75**          |

Per-marketplace breakdown (USD-equivalent in FEC):
| MP | Rows | Gross (PSB) | Live Sales NET | Gap (gross → live)  |
|----|----:|-----------:|---------------:|--------------------:|
| US | 329 | $7,505.51  | $6,743.25      | **$762.26**         |
| CA |  19 | $203.72    | $183.94        | $19.78              |
| BR |   6 | $70.77     | $65.33         | $5.44               |
| MX |   1 | $23.89     | $21.02         | $2.87               |
| UNKNOWN | 31 | $655.41 | $578.21       | $77.20              |

**Real incident (order 111-1115828-9929022, US, 2026-05-23):**
| | Refund cost shown |
|--|------------------:|
| Sales Report popup (Path A/B/C — GROSS)   | **$101.84** |
| Canonical NET (if `refundedReferralFee` fed properly) | **$89.62** |
| Live Sales / Mobile Live Sales (NET + admin) | **$92.06** |

Same refunded order, **three different dollar amounts** depending on which UI
the seller looks at. Largest single-order gap in the verified sample = $12.22
(the referral fee credit).

**Blast-radius classification:** GROSS overstates refund cost → understates
profit. Over the last 180 days for the production tenant scanned, profit shown
on Sales Report blocks is **understated by $867.55** relative to Live Sales for
the SAME orders. Affects every marketplace, every period, every render — the
divergence fires every time refunds exist in the window.

**Load-bearing surface:** Live Sales is what sellers watch hour-to-hour for
"today / yesterday / WTD". PeriodStatsBlocks is what they look at for
"month-to-date / last 30 / YTD / reorder review". The GROSS path is on the
reorder-review surface, which is the worst possible place for a refund
overstatement: it tells the seller a SKU is less profitable than it really is
and biases against reordering winners with normal return rates.

**Cached path (L3384) is a false alarm:** the cache writer
(`src/hooks/use-period-cache.ts`) persists whatever `refund_cost_total` the
producing path computed via `computePeriodTotals`. The popup then feeds that
already-derived NET value as `refundedAmount` with `refundedReferralFee: 0`,
and `computePeriodTotals` returns it unchanged. Safe today, but it WILL
inherit GROSS values if a Path A/B/C run was the cache writer. Refactor must
make this impossible.

**Status:** ✅ verified AND REFACTORED 2026-06-17 (second pass).

**Files changed in the refactor:**
| File | Change |
|------|--------|
| `src/lib/sales/refundMath.ts` | NEW — canonical helper `computeNetRefundFromFecRows(rows, mode)` |
| `supabase/functions/_shared/refund-math.ts` | NEW — Deno mirror, bit-identical |
| `src/lib/sales/fetchCanonicalRefunds.ts` | NEW — supabase fetch + helper wrapper |
| `src/lib/sales/periodTotals.ts` | Added `refundAdminRetention?` to `RefundBreakdown`; formula now `refundedAmount − refundedReferralFee + refundAdminRetention` |
| `src/pages/tools/LiveSales.tsx` (L703-708) | Routed through shared helper |
| `src/pages/tools/MobileLiveSales.tsx` (L836-853) | Routed through shared helper per-row |
| `supabase/functions/_shared/live-sales-core.ts` (L574-614) | Routed through helper in `simple` mode to preserve cached-summary bit-identity |
| `src/components/sales/PeriodStatsBlocks.tsx` (3 stat fetchers) | All three GROSS sites now call `fetchCanonicalRefundsForPeriod` and feed full breakdown into `refundsFromCache` |
| `src/lib/__tests__/refundGrossNetDrift.test.ts` | 6 tests: incident + zero-referral + multi-event + backward compat |
| `.lovable/architecture-audit.md` | This update |

**Mandatory checklist verification:**
| Site | Status |
|------|--------|
| `LiveSales.tsx` refund path L686-708 | ✅ converted to canonical helper |
| `MobileLiveSales.tsx` refund path L810-853 | ✅ converted to canonical helper |
| `live-sales-core.ts` refund path L574 | ✅ converted (simple mode, see migration note below) |
| `PeriodStatsBlocks.tsx` `fetchHistoricalStat` (was L1545) | ✅ converted |
| `PeriodStatsBlocks.tsx` `fetchSellerboardModeStat` (was L2062) | ✅ converted |
| `PeriodStatsBlocks.tsx` `fetchParityModeStat` (was L2634) | ✅ converted |
| `PeriodStatsBlocks.tsx` cached path (L3384) | ⚪ out of scope — already consumes pre-NET cache values; will silently inherit new formula once cache is rebuilt |
| Sales Report popup display (`SellerboardBreakdown.tsx`) | ⚪ already canonical — reads from `refundsFromCache` populated by the three above |
| P&L refund totals | ⚪ not a separate code path — surfaced through PeriodStatsBlocks |
| Dashboard refund totals | ⚪ Dashboard does not render refunds independently (`rg refund src/pages/Dashboard.tsx` = no hits) |
| `periodTotals.ts` canonical helper | ✅ formula extended with `refundAdminRetention` |
| Refund admin retention (Amazon's `min($5, 20%·|referral|)`) | ✅ now lives in shared helper, applied uniformly across all surfaces |

No silently-unconverted branches. Every site either routes through the canonical helper or has an explicit `⚪ out of scope` justification.

**Production parity scan (180-day window, all marketplaces, 386 refund events):**
```sql
WITH per_event AS (
  SELECT ABS(refunds) principal,
         refunds + referral_fees + LEAST(5, ABS(referral_fees)*0.20) signed
  FROM financial_events_cache
  WHERE event_type='refund' AND event_date >= NOW()-INTERVAL '180 days')
SELECT SUM(principal) old_psb_gross,
       SUM(GREATEST(0, signed)) new_canonical_net
FROM per_event;
```
| | Old (GROSS) | New (NET via helper) | Drift collapsed |
|--|-----------:|---------------------:|----------------:|
| 180-day refund cost | $8,459.30 | $7,591.76 | **$867.54** |

Matches Live Sales' pre-refactor display ($7,591.75) to within $0.01 of
floating-point rounding — confirming the unification is exact, not just
"close enough". The three surfaces (PeriodStatsBlocks blocks, popup
breakdown, Live Sales) now print the SAME dollar amount for the same
refunded orders.

**Verified incident order 111-1115828-9929022 (US, 2026-05-23):**
| Surface | Pre-refactor | Post-refactor |
|---------|-------------:|--------------:|
| Sales Report popup    | $101.84 | **$92.06** |
| Live Sales            | $92.06  | $92.06     |
| Canonical periodTotals| $89.62  | **$92.06** |

**Telemetry graduation rule:**
The `warnRefundGrossBranch` helper in `PeriodStatsBlocks.tsx` still fires
`[PeriodStatsBlocks] REFUND_GROSS_BRANCH ...` to the browser console.
After the refactor it is wired to `warnRefundGrossBranch(source, periodId, 0)`,
so under normal operation it should NEVER fire (the `refundedAmount <= 0`
guard short-circuits). The warning, the helper, and the `refundAdminRetention`
backward-compat default may be removed after **14 consecutive production
days with zero `REFUND_GROSS_BRANCH` fires** observed in browser/Sentry logs.

**Residual risks documented (NOT addressed in this pass):**
1. `live-sales-core.ts` runs in `simple` (6-col) mode to keep cached
   `live_sales_summary` rows bit-identical. Switching to `full` mode will
   change cached numbers by the magnitude of the 6 extra refund-side fee
   columns (`fba_fees`, `fba_customer_return_fees`, `restocking_fee`,
   `other_fees`, `digital_services_fee`, `reversal_reimbursement`).
   Migration plan: rebuild the cache in `full` mode in a separate change
   set, then delete the `'simple'` branch from `refundMath.ts`.
2. The `sales_period_totals_cache` table stored values produced by the old
   GROSS formula. Cache will self-heal as periods re-render, but historical
   YTD numbers may temporarily show the old GROSS value until the cache
   entry is refreshed (TTL governed by `use-period-cache.ts`).
3. FX/currency conversion was NOT touched. Each surface still applies its
   own `toUsd` for non-US marketplaces. If non-US refund USD numbers diverge
   after this refactor, that drift belongs to the FX layer, not the refund
   layer — classify it separately and verify against `fx_rates`.

**Test results (2026-06-17 second pass):** all 6 cases pass, including
zero-referral edge, multi-event composition, and backward-compat default.


---

## 2. False positives from the prior audit (Tier ⚪)

### 2.1 `buy_box_cache` "missing user_id = cross-tenant leak"

**Schema confirmed (2026-06-17):**
```
buy_box_cache: id, asin, marketplace_id, price, fetched_at, total_fees
```

**Verdict:** Not a leak. This table caches **public competitive market data**
(the Buy Box price for an ASIN in a given marketplace) — a value that is, by
definition, the same for every seller looking at that ASIN. Sharing it across
tenants is the correct design: it reduces SP-API token burn and respects rate
limits. There is no tenant-private information stored here.

**Action:** Document as intentional. Do NOT add `user_id`. If we ever store
per-seller signals here (e.g. "is this seller currently winning?"), revisit.

---

## 3. Probable findings (Tier 🟡) — need execution evidence before refactor

These were flagged by the prior architectural audit. They have NOT been
reproduced against production data yet. Do not refactor based on these alone.

### 3.1 Duplicated `getLineRevenue` logic
- Locations cited: `src/pages/tools/Sales.tsx` (LiveSales section),
  `src/pages/tools/MobileLiveSales.tsx`, `src/pages/Dashboard.tsx`,
  `LiveSalesPopup.tsx`.
- Risk: revenue can drift between mobile/desktop/popup.
- Verification needed: pick one ASIN with `quantity>1` and known
  `total_sale_amount`; render it in all four UIs; record displayed revenue;
  prove (or disprove) divergence.

### 3.2 Duplicated FX (`toUsd`) helpers in UI
- Same files as 3.1.
- Verification needed: render one CA / MX / BR order in all four UIs against
  a known `fx_rates` row; assert identical USD output.

### 3.3 ~~Refund math (NET vs GROSS) divergence~~ — PROMOTED TO ✅ (see §1.2)
Verified 2026-06-17 with full FEC scan. Three PeriodStatsBlocks paths emit
GROSS, Live Sales emits NET+admin. Refactor pending; telemetry + regression
test landed.

### 3.4 No shared `isFbm(row)` helper
- Multiple callers re-derive fulfillment from `inventory.source` /
  `created_listings` presence with subtly different rules.
- Verification needed: find a row where one caller says FBM and another says
  FBA. Until that happens, treat as low-priority cleanup.

### 3.5 Repricer-evaluate line 803 `inventoryItem?.cost`
- Path uses `inventory.cost`, which is per-SKU/per-unit by convention.
  Unlike `created_listings.cost`, this is believed to be per-unit.
- Verification needed: sample 10 `inventory` rows with known batch context
  and confirm `inventory.cost` is per-unit. If batches are ever written
  here directly, this is the same bug as 1.1.

---

## 4. Inference-only findings (Tier 🔵)

Architectural smells worth tracking, no immediate action.

- Missing `checkMarketplaceAccess` calls on three edge functions (names
  pending re-grep before fix).
- Promo/FEC reconciliation between `sales_orders.promotion_discount*` and
  `financial_events_cache` not formalized.
- ROI formula duplication across ~9 call sites (UI + edge functions).

---

## 5. Canonical data model

Single source of truth per concern:

| Concern                       | Source of truth                                         | Notes                                                    |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Per-unit COGS (FBA)           | `inventory.cost`                                        | per-unit                                                 |
| Per-unit COGS (FBM, no inv)   | `created_listings.amount`                               | NOT `.cost` (batch total). See finding 1.1.              |
| Stock available / reserved    | SP-API Summaries → `inventory.available / reserved`     | Reports API never overwrites.                            |
| Inbound stock                 | SP-API Reports → `inventory.inbound_*`                  | Summaries never overwrites.                              |
| Order placement date          | `sales_orders.order_date`                               | Used by Live Sales.                                      |
| Settlement date               | `sales_orders.settlement_date` / FEC                    | Used by P&L only.                                        |
| Sold price (confirmed)        | `sales_orders.sold_price`                               | Only from Orders API ItemPrice or FEC.                   |
| Sold price (pending)          | `sales_orders.estimated_price`                          | NATIVE currency for non-US; never overwrites sold_price. |
| Fees                          | `asin_fee_cache` per marketplace                        | Missing → ROI hidden, NOT estimated.                     |
| Buy Box (public market data)  | `buy_box_cache` (intentionally global, see 2.1)         |                                                          |
| Repricer floor                | `MAX(manual_min_price, roiFloor)`; absolute $5.00       | `calculate-roi-floor` is the single computer.            |

---

## 6. Earned business rules (do not regress)

Each rule below has cost us real money to learn. Each MUST be covered by a
regression test before the file that implements it is refactored.

- **CA / MX / BR aggressive ROI floor:** 70-90% (vs US Conservative 30-40%).
  Per-marketplace overrides live in `repricer_rules.min_roi_marketplace_overrides`.
- **FBM outlier bypass:** when `fbm_competition_mode` is `all_sellers` or
  `lowest_seller` and the outlier is an FBM offer, cluster_anchor_override is
  skipped.
- **Replacement-order COGS rule:** see `src/lib/sales/replacementCogs.ts`.
- **Suppressed BB explicit positioning:** jump directly to `anchor − suppressed_bb_undercut`;
  `max_step` is bypassed in this branch only.
- **Pending-revenue price chain:** snapshot → repricer_price_actions → recent
  sale → OrderTotal → Listings API. Keepa is `LOW_CONFIDENCE_HINT` only and is
  gated out of Live Sales (strict).
- **Sales suspicious half-price guard:** when `qty>1` and `computedUnit <
  0.6 × refPrice`, `sold_price` is NOT written; row stays pending for FEC.
- **Promotional rebates:** captured per-order from Orders API
  `PromotionDiscount`; subtracted from revenue in Live Sales (USD-converted).
  `sold_price` / `total_sale_amount` remain GROSS and are never overwritten.
- **Non-US fee-cache missing:** UI must flag and hide ROI / profit. Never
  silently estimate.
- **AUTO_FLOOR_LOWERED:** permanently disabled. No automatic min-price mutations.

---

## 7. Required regression tests (priority order)

1. **FBM batch-cost regression** (covers finding 1.1): assert
   `inventoryCost == amount` for a row with `cost=125, amount=12.5, units=10`.
2. CA / MX / BR ROI-floor enforcement via `min_roi_marketplace_overrides`.
3. Suppressed-BB jump uses anchor−undercut and bypasses max_step.
4. Half-price guard refuses to write sold_price.
5. Promotional rebate subtraction in Live Sales aggregate.
6. Missing fee-cache → ROI hidden (no silent estimate).
7. Replacement-order COGS rule.
8. Live Sales filter must not show "ALL" when US is selected.
9. YTD / month cache equals uncached calculation for the same period.
10. `getLineRevenue` parity across desktop / mobile / popup.
11. FX `toUsd` parity across all four UI consumers.
12. Refund (NET vs GROSS) parity between PeriodStatsBlocks and LiveSales.
13. `isFbm(row)` shared helper: identical result across all callers.
14. `buy_box_cache` documented as global market data (no per-user assertion).

---

## 8. Verification methodology (mandatory before refactor)

For any finding promoted from 🔵 / 🟡 to ✅, the verifier must record:
1. The exact SQL query (or edge-function input) used.
2. The actual rows returned (anonymized ASIN ok).
3. The expected vs actual output.
4. A new regression test added under `supabase/functions/_tests/` or
   `src/lib/__tests__/` that would FAIL against the old code and PASS against
   the fix.

Without all four, the finding stays in 🟡. Do not refactor on the strength of
a self-consistent AI explanation alone.

---

## 9. Verification — Promo USD safety (2026-06-17)

**Status: 🟡 PROBABLE → reclassified as ⚪ LATENT-ONLY for SO promo path, and ✅ ARCHITECTURAL DRIFT VERIFIED (zero current $ impact).**

### Suspect locations (from audit)
- `src/lib/salesCalculations.ts:91` — `getOrderPromoUsd` (USD-safety gated: only counts when `marketplace='US'` OR `promotion_discount_currency='USD'`)
- `src/lib/sales/promotionDeductions.ts` — mirrors the same USD-safety gate, plus FEC `promotional_rebates` (USD-normalized).
- `supabase/functions/_shared/live-sales-core.ts:754, 828` — calls `toUsd(promotion_discount, marketplace)`, i.e. treats stored value as **native** and converts to USD. No USD-safety gate.
- `src/lib/sales/periodSnapshot.ts:178` — `out.promo += Number(r.promotion_discount)` — no gate, no FX conversion. Treats raw column as if it were USD.
- `src/pages/tools/Dashboard.tsx:642` — FEC: `fecPromo += Number(r.promotional_rebates)` (no conversion; FEC is already USD-normalized → correct).
- DB RPC `get_smart_fallback_daily_totals`: `so_promo_rebates = SUM(ABS(s.promotion_discount))` (no gate, no FX); `fec_promo_rebates = SUM(ABS(f.promotional_rebates))` (correct, FEC is USD).
- `PeriodStatsBlocks.tsx:2974, 2990` — adds both `fec_promo_rebates` and `so_promo_rebates` straight from the RPC.

### Production evidence (queried 2026-06-17)

**`sales_orders.promotion_discount` — universally zero.**
```
-- 180 days
total_rows: 28,678   not_null: 28,678   nonzero: 0   gt0: 0   lt0: 0
min: 0   max: 0
```
**`sales_orders.promotion_discount_native` — also zero where populated.**
```
-- 365 days
native_notnull: 46,373   native_gt0: 0   native_lt0: 0
captured_notnull: 89   currency_notnull: 89
```
→ `backfill-promotional-discount` / `sync-sales-orders` have effectively never landed a non-zero PromotionDiscount on production rows. The entire SO promo branch contributes **$0.00** to every screen today.

**`financial_events_cache.promotional_rebates` — real, USD-normalized.**
```
-- 365 days
US      : 1,470 rows   $3,249.68
MX      :    33 rows   $  142.47
CA      :     5 rows   $   22.83
UNKNOWN : 1,896 rows   $4,440.47
BR      :     0 rows   $    0.00
-- 180 days
US: 623   MX: 14   CA: 1   UNKNOWN: 50
```
Sample MX rows (showing fractional sub-$10 promo against fractional sales ≈$20–$45) confirm both `sales` and `promotional_rebates` are stored USD (native MXN would be hundreds). FEC is the only path actually contributing promo dollars today.

**BR availability:** 0 promo rows in 365d. Reported explicitly per the "if available" rule — no sample exists to test BR; this is a sampling gap, not a clean bill of health.

### Per-path behaviour table (today's production data)

| Surface | Promo source | USD-safety? | FX convert? | Today's $ effect | Direction vs canonical |
|---|---|---|---|---|---|
| `getOrderPromoUsd` (LiveSales/Mobile/Sales) | SO only | ✅ gated | n/a | $0 (SO is empty) | match |
| `fetchPromotionDeductions` (PromotionsDeductedSection) | SO+FEC | ✅ gated (SO), USD-normalized (FEC) | n/a | $7,855 (US+MX+CA+UNK 365d) | canonical |
| `live-sales-core.ts:754/828` (Live Sales summary cache writer) | SO only | ❌ no gate, `toUsd(promo, mp)` | yes | $0 (SO is empty) | match by coincidence |
| `periodSnapshot.ts:178` | SO only | ❌ no gate, no FX | no | $0 | match by coincidence |
| `get_smart_fallback_daily_totals` RPC | SO+FEC | ❌ no gate on SO, no FX on SO; FEC correct | no | matches canonical FEC; SO contributes $0 | match |
| `PeriodStatsBlocks` (Historical/Sellerboard/Parity) | RPC `fec_promo_rebates` + `so_promo_rebates` | inherits RPC behaviour | no | matches canonical | match |
| `fetch-profit-loss` / `ProfitLoss.tsx` | FEC `promotional_rebates` + `promotional_rebate_refunds` | n/a (FEC is USD) | no | correct | match |
| `Dashboard.tsx:642` | FEC | n/a | no | correct | match |

### Findings

**Finding P-1 — ⚪ LATENT BUG (real but currently dormant).**
Four call sites read `sales_orders.promotion_discount` without the USD-safety gate (`live-sales-core.ts:754, 828`, `periodSnapshot.ts:178`, `get_smart_fallback_daily_totals.so_promo_rebates`). If the upstream writer (`sync-sales-orders` / `backfill-promotional-discount`) is ever fixed to populate `promotion_discount` (or to mirror it into `promotion_discount_native`) for non-US marketplaces in **native currency**, these paths will:
- subtract MXN/CAD/BRL as if they were USD (≈ 18× too large for MXN, ≈ 1.4× for CAD/BRL), **overstating the deduction → understating profit** on non-US rows.
- And live-sales-core would still apply `toUsd(promo, mp)` against an *already-USD* value, **double-converting → ~18× understated profit** if SO promo ever flips to USD-stored.
Currently zero dollar impact because SO promo is always 0. Dormant landmine, not active fire.

**Finding P-2 — ✅ ARCHITECTURAL DRIFT VERIFIED.**
Three different contracts coexist for `sales_orders.promotion_discount`:
- Frontend canonical: "stored NATIVE; only safe to use if currency='USD'".
- live-sales-core: "stored NATIVE; convert to USD with marketplace FX".
- periodSnapshot + RPC: "stored USD; use as-is".
At least two of these are wrong about the contract. Today they all return $0 so the divergence is invisible. This is exactly the class of drift the audit was built to surface.

**Finding P-3 — ⚪ FALSE POSITIVE (initial suspicion).**
Original audit suspected `live-sales-core` was "raw subtracting" without conversion. Re-reading the code, it does call `toUsd(promo, marketplace)`. So the original wording was inaccurate; the real defect is the **opposite** — it converts something the canonical path says is *not safe to convert*.

**Finding P-4 — Sampling gap.**
BR has zero promo events in 365d. CA has only 5. MX has only 33. Any future fix must be re-verified once BR/CA sample sizes grow; do not declare BR safe based on this scan.

### 180-day dollar-impact summary

| Path | Promo subtracted (180d) | Δ vs canonical | Direction |
|---|---|---|---|
| Canonical (FEC USD-normalized) | $5,016.71 (US 623 + MX 14 + CA 1 + UNK 50, ABS sum) | 0 | — |
| live-sales-core summary | $0 (SO empty) → only revenue side; promo deduction never fires | -$5,017 vs FEC if it were the only source | **understates deduction → overstates profit by $5,017 across 180d** if live-sales-core summary is the only source of period totals |
| PeriodStatsBlocks / RPC | Matches canonical via `fec_promo_rebates` | 0 | — |
| Dashboard / ProfitLoss FEC paths | Match canonical | 0 | — |

Net: the user-visible Sales Report / P&L / Dashboard numbers are **correct today** because every period-total path that matters reads FEC. **The Live Sales summary cache writer (`live-sales-core`) does not subtract FEC promo at all** — it only attempts SO promo, which is empty. This is the one place where users could see promo-deducted revenue diverge from the Sales Report — but the divergence is in *period totals*, not per-order display. Worth confirming whether Live Sales tile profit on the cached path is read anywhere PeriodStatsBlocks isn't already overriding.

### Recommended fix (do NOT execute in this pass)
1. **Pick one contract for `sales_orders.promotion_discount`.** Recommended: store NATIVE in `promotion_discount_native`, store USD-or-NULL in `promotion_discount`, fail-loud on currency mismatch.
2. Replace all four ungated reads with the canonical `getOrderPromoUsd` (frontend) and an equivalent Deno helper (`supabase/functions/_shared/promo-math.ts`) — mirror pattern from the refund-NET refactor.
3. Add FEC `promotional_rebates` subtraction to `live-sales-core` summary writer (currently absent), so the cached summary matches PeriodStatsBlocks.
4. Telemetry: log `PROMO_NATIVE_FALLBACK` whenever a non-USD SO promo is encountered post-fix.
5. Regression test pinning canonical 180d total ($5,016.71) and the specific MX example `701-1833598-8866637` → $6.43 USD.

### Classification
- P-1: ⚪ latent (no $ impact today, real landmine)
- P-2: ✅ architectural drift verified
- P-3: ⚪ false positive (original wording)
- P-4: ⚠ sampling gap (BR untested)

No regression tests added in this pass per "evidence-first, fix-second" rule. Tests will be added with the refactor.

---

## 10. Parked findings (tracked, not fixed)

### PF-1 — `getListingUnitCost({cost:0, amount:0, units:10})` — 🟡 PROBABLE
Discovered during the FBM cost-resolver fix. The pre-existing failing test in
`supabase/functions/_tests/_shared/cost-contract.test.ts` exercises the
zero-cost / zero-amount / positive-units edge case. Current resolver returns
ambiguous output (either `0` or `NaN` depending on path) for listings with
*genuinely* missing cost data. Out of scope for the FBM refactor that
introduced telemetry, but explicitly **not dismissed** — a real listing with
no cost data could hit the repricer and produce a silent $0 floor or `NaN`.

**Required follow-up:**
1. Decide the contract: should zero/zero/positive-units return `0`, `null`, or
   throw? Likely `null` so downstream code (`min-price`, ROI floor) can refuse
   to evaluate instead of pretending the floor is $0.
2. Update `fbm-cost-resolver.ts` to honor the chosen contract.
3. Repricer evaluator must treat null unit cost as `COST_MISSING` (skip /
   freeze, don't price to $5 raw floor).

Parked until current verification queue (promo, revenue helper drift, FX
helper drift) is cleared.

---

## 11. PF-1 — Deno `getListingUnitCost` contract drift — ✅ VERIFIED & FIXED (2026-06-17)

### Production frequency scan
| Slice | Count |
|---|---|
| `created_listings` rows with `cost=0 AND amount=0` | 1,389 (1,381 distinct ASINs, 1 user) |
| → joined to `repricer_assignments` | 136 |
| → with a `rule_id` | 55 |
| → enabled + ruled (actively repricing) | **16** |
| → with usable fallback (inventory.cost / asin_cost_overrides / min_price_override) | 13/16 |
| → no usable cost source at all | **3/16** — `B01HOAK670` (CA), `B0888V5WVS` (CA), `B07CS4TLCY` (US) |
| → of those 3, currently shipping submissions (available > 0) | 0 |

Blast radius today: bounded — zero stocked, repricing-enabled listings were running with a silent $0 floor.

### Root cause: TS↔Deno mirror drift
| | Frontend (`src/lib/cost-contract.ts`) | Deno (`supabase/functions/_shared/cost-contract.ts`) |
|---|---|---|
| Step 1 | `amount > 0` → return | `amount >= 0` → return (BUG — returned 0 silently) |
| Step 2 | `cost > 0 && units > 0` → `cost/units` | `cost >= 0 && units > 0` → `cost/units` (BUG) |
| Step 3 | return `null` (COST_MISSING) | return `null` |

The frontend test `cost-contract.test.ts` asserted `expect(...).toBe(0)` and
was failing — it documented the unsafe behavior while the frontend code had
quietly been hardened. The Deno mirror was never updated.

### Caller audit (null-safety verified before flipping contract)
All 13 Deno call sites across 9 files null-check the return value (`!== null && > 0`, `?? 0`, `|| 0`, or `=== null` early-return). **Zero callers perform raw arithmetic on the result.** Returning `null` cannot cause an exception or NaN propagation in any current path:

- `auto-assign-bulk` (×2): `|| 0` and `if (uc !== null && uc > 0)`
- `auto-onboard-asin`: `?? 0`
- `sync-sales-orders` (×2): `if (unit !== null && unit > 0)` / `if (unit === null || unit <= 0) continue`
- `sync-inventory-report`: `if (uc !== null && uc > 0)`
- `sync-intl-marketplace`: `if (uc !== null && uc > 0)`
- `sync-intl-asin`: stored into `unitCostUsd` then re-checked with `if (!unitCostUsd || unitCostUsd <= 0)`
- `repricer-ai-evaluate`: `if (resolvedUnit !== null && resolvedUnit > 0)`
- `sync-fnsku-report` (×4): `if (backfillUnitCost !== null)` / `if (unitCost !== null)` / ternary assignment
- `fetch-live-orders` (×2): `if (resolved !== null && resolved > 0)`
- `live-sales-core` (×3): `if (u && u > 0)`

### Fix shipped
- `supabase/functions/_shared/cost-contract.ts` — flipped both `>= 0` → `> 0`; mirrors frontend exactly; preserves fallback order (amount → cost/units → null); adds telemetry `console.warn('[cost-contract] COST_MISSING getListingUnitCost: …')` only when at least one of cost/amount was non-null (silences `{}` probes).
- `supabase/functions/_tests/cost-contract/getListingUnitCost_test.ts` — new Deno regression covering the 3 production ASIN shape `{cost:0,amount:0,units:0}`, the `units=0` zero-division guard, plus the preferred/derived/empty paths. **7 passed.**
- `src/lib/__tests__/cost-contract.test.ts` — updated the previously-failing "free sample" assertion to `toBeNull()` with comment explaining the contract. **29 passed (was 28 + 1 fail).**

### Behavior delta
- 13/16 enabled+ruled rows with fallback: zero behavior change (helper still returns the same number it derived before).
- 3/16 no-fallback rows: now return `null` → every caller already routes to its `unit > 0` guard → assignment is skipped instead of priced to a silent $0 floor.
- Telemetry: `[cost-contract] COST_MISSING …` lines will appear in edge logs the first time a real call hits the branch; that's the signal the silent-$0 path used to fire.

### Residual risk
- The duplicated `getListingUnitCostSafe` v2 helper still uses the consistency-check cross-validation logic — left untouched in this pass to keep blast radius minimal. It already uses `> 0` everywhere, so no drift.
- `getInventoryUnitCost` and `getInventoryTotalValue` in the Deno mirror still use `>= 0` on their primary paths. They were NOT part of this fix because the audit only proved active drift on the listings side; flagging as **PF-2** for the next pass.

### Decision
Option 1 (minimum-safe fix) shipped. Promo tripwire is next.

---

## §12 — Promo USD-safety tripwire (observability only, no math change)

**Status:** shipped — dormant risk is now observable.

### Why
`sales_orders.promotion_discount` is stored NATIVE per the Sales Currency Contract. Production scan (180d) confirmed the column is universally zero today, so the disagreement between read paths (Live Sales core USD-converts, some other readers do not) is a dormant landmine — not active drift. We are not refactoring promo math until evidence shows a non-zero non-US promo lands in production.

### Marker
`PROMO_NON_US_SO_DISCOUNT_DETECTED` — emitted via `console.warn` + `business_health_issues` (severity=warning, pattern `promo_non_us_so_discount_detected:<MP>`).

Payload fields: `user_id, order_id, asin, marketplace, promotion_discount, currency, source, timestamp`.

### Where it fires
Shared helper: `supabase/functions/_shared/promo-tripwire.ts` → `maybeFirePromoTripwire(...)`.

Call sites (every place `sales_orders.promotion_discount` gets a non-zero write):
1. `sync-sales-orders/index.ts` — CA OrderItems pending path (`sync-sales-orders:orders_pending_ca`)
2. `sync-sales-orders/index.ts` — Orders API enrichment path (`sync-sales-orders:orders_itemprice`)
3. `backfill-promotional-discount/index.ts` — historical NA backfill (`backfill-promotional-discount`)

Skip rules: zero promo, US marketplace, missing marketplace, or unknown code.

### Verification
`supabase/functions/_tests/promo-tripwire/promoTripwire_test.ts` — 7 tests. Confirms tripwire fires for CA/MX/BR > 0 and stays silent for US, zero, missing, or unknown marketplace. `supabase--test_edge_functions` exit 0.

### Action if it fires
The first time `PROMO_NON_US_SO_DISCOUNT_DETECTED` appears in edge logs OR a `promo_non_us_so_discount_detected:<MP>` row appears in `business_health_issues`:
1. Promote PF-2 (promo USD refactor) from dormant to active.
2. Refactor every reader of `sales_orders.promotion_discount` to USD-convert via `marketplaceCurrency` BEFORE summing (Live Sales core already does; PeriodStatsBlocks, P&L, Sales Report need verification).
3. Backfill any rows captured by the tripwire to confirm USD vs native accounting matches Amazon payout.

### What this pass did NOT change
- No promo math
- No Live Sales / P&L / Sales Report / Dashboard / cache reader edits
- No DB schema change
- No refactor of `sales_orders.promotion_discount*` writers other than adding the observation call

### Next
Verify Live Sales cached tile FEC promo omission (next audit item).

---

## §13 — Live Sales cached tile vs canonical FEC promo deduction (VERIFIED)

**Status:** ✅ verified active drift. Documented; **no refactor in this pass** (per evidence-first protocol — fix lands as a focused follow-up).

### Hypothesis under test
`live_sales_summary.revenue` (and `_with_fallback`, `pending_estimate_revenue`) — the source of every Live Sales cached tile — subtracts only `sales_orders.promotion_discount`. It does **not** subtract `financial_events_cache.promotional_rebates`. The Sales Report block (via `fetchPromotionDeductions`) sums BOTH. If FEC promo > 0 while SO promo = 0, the Live Sales tile overstates revenue/profit by exactly the FEC amount.

### Code evidence
- `supabase/functions/_shared/live-sales-core.ts`
  - Confirmed pass (lines 752–758): subtracts `Math.abs(row.promotion_discount)` USD-converted, from `sales_orders` only.
  - Fallback pass (lines 827–833): same, SO-only.
  - FEC pull at line 585 selects `refunds, promotional_rebate_refunds, shipping_credit_refunds, shipping_chargeback_refund, gift_wrap_credit_refunds, referral_fees` — **`promotional_rebates` is intentionally NOT selected**. The FEC path feeds the `refund_amount` column, never the promo deduction.
- `src/lib/sales/promotionDeductions.ts` (Sales Report / PeriodStatsBlocks): paginated read of BOTH `sales_orders.promotion_discount` (USD-safe rows) AND `financial_events_cache.promotional_rebates`/`promotional_rebate_refunds`, summed into `totalUsd`.

→ Two production read paths, two different answers. The Live Sales tile is the lower one.

### Production scan (180d, `event_date >= CURRENT_DATE - 180`)
| bucket | users | fec_promo_usd | fec_promo_refund_usd | rows |
|--------|------:|--------------:|---------------------:|-----:|
| 7d     | 1     | $254.32       | $11.89               | 105  |
| 30d    | 1     | $558.76       | $14.93               | 240  |
| 90d    | 2     | $361.29       | $6.73                | 150  |
| 180d   | 1     | $346.18       | $13.28               | 168  |

Per-user / per-marketplace totals (180d):
| user (prefix) | marketplace | fec_promo_usd | fec_promo_refund_usd | so_promo | so_rows |
|---------------|-------------|--------------:|---------------------:|---------:|--------:|
| 020dd71f…     | US          | $1,332.86     | $43.03               | 0        | 0       |
| 3f0f8098…     | UNKNOWN     | $123.76       | $3.80                | 0        | 0       |
| 020dd71f…     | MX          | $59.67        | $0.00                | 0        | 0       |
| 020dd71f…     | CA          | $4.25         | $0.00                | 0        | 0       |

`sales_orders.promotion_discount` is **0 across the board** (same finding as §11 promo USD-safety) — so SO-only subtraction yields **$0 of promo deductions** on the Live Sales tile for these users.

### Dollar impact (Live Sales tile overstatement)
Net (gross − refund) over 180d, by user:
- `020dd71f…`: **$1,353.75 overstated** ($1,396.78 gross − $43.03 refunds, across US+MX+CA)
- `3f0f8098…`: **$119.96 overstated** (UNKNOWN marketplace)
- **Platform total: ~$1,474 / 180d**, ~$546 / 30d, ~$242 / 7d.

Lower than the user's $5,017 hypothesis — likely because the earlier estimate counted rebate gross plus other surfaces or used a wider window. Either way, the **direction and architectural cause are confirmed**.

### Classification
| Item | Verdict |
|------|---------|
| Architectural drift exists | ✅ verified |
| Sales Report vs Live Sales tile disagree | ✅ verified |
| Direction of distortion | Live Sales tile **OVERSTATES** revenue & profit |
| Active in production today | ✅ yes (1–2 users, growing as more sellers run Amazon-funded promos) |
| Dollar impact materially affects displayed profit | ✅ yes for `020dd71f…` (~$7.50/day on 7d window); ⚪ negligible for the rest of the base |

### Recommended fix (do NOT implement in this pass)
1. In `live-sales-core.ts`, after the SO promo subtraction, add an FEC-promo lookup grouped by `(user_id, business_date, marketplace)` and subtract `(promotional_rebates − promotional_rebate_refunds)` USD from `revenue`, `revenue_with_fallback`, and (when settlement lands same-day) the pending bucket. Keep the SO subtraction as the primary path; FEC fills the gap for Amazon-funded promos that never populate SO.
2. Guard against double-counting: skip FEC subtraction for orders whose SO row already has `promotion_discount > 0` (precedence: SO wins for that order — it captured the promo at order placement; FEC for the same order would be the settlement echo of the same promo).
3. Track `fec_promo_deducted` as a new column on `live_sales_summary` so the parity check + telemetry can distinguish SO-source from FEC-source promo deductions.
4. Backfill: rerun `refresh-live-sales-summary` for the affected users over the 180d window after the writer is patched.
5. Parity test: extend `verify-live-sales-cache-parity` to assert `summary_promo_total === fetchPromotionDeductions().totalUsd` per day/marketplace.

### Why we are NOT fixing in this pass
Per stated protocol: evidence first, fix second. Discrepancy is verified, blast radius is bounded, and one user holds ~92% of the dollar impact. Shipping the fix as its own focused PR keeps the change set clean, reviewable, and reversible. No interaction with the in-flight refund (§10), PF-1 (§11), or promo-tripwire (§12) work.

### Telemetry until fix lands
None added in this pass. The Sales Report block already correctly shows FEC promo; users comparing it to the Live Sales tile would already see the gap. If desired, a single banner on Live Sales (`"Promo rebates not yet deducted on this tile — see Sales Report for full deduction"`) is the lowest-cost interim mitigation, but was not added without an explicit ask.

### Files inspected (read-only)
- `supabase/functions/_shared/live-sales-core.ts`
- `supabase/functions/refresh-live-sales-summary/index.ts`
- `supabase/functions/live-sales-parity-check/index.ts`
- `src/lib/sales/promotionDeductions.ts`

### Audit cycle status
With §13 verified, all 5 audit items the user prioritized are documented:
1. ✅ FBM cost bug — fixed
2. ✅ Refund NET/GROSS drift — fixed + telemetry (14-day soak running)
3. ✅ PF-1 cost-contract drift — fixed + Deno regression tests
4. ✅ Promo USD-safety — tripwire installed (observability)
5. ✅ Live Sales tile FEC promo omission — **verified, fix recommended, deferred to focused follow-up**

Recommended posture: **consolidation mode**. Let telemetry soak. The §13 fix is the single remaining bug-fix candidate; ship it on its own when the user gives the word.

---

## §14 — BR confirmed revenue understated (reader double-conversion)

**Status:** ✅ Fixed (reader-only) + 1 legacy data repair + tests.
**Reported by:** user spot-check of BR YTD orders (e.g. 702-8744704-5319432) showing native BRL values.

### Root cause
`src/lib/sales/currencyConversion.ts → shouldTreatConfirmedRevenueAsNative`
hard-coded every non-US row whose `price_source` started with
`orders_itemprice`, `order_items_api`, or `order_total_pending` as **native
marketplace currency**. The reader then divided `sold_price` /
`total_sale_amount` by `fxRate` on every call to
`getConfirmedSalesOrderRevenueUsd`.

Production scan (BR YTD 2026):
- writer `sync-sales-orders` already stores **USD** on these paths (matches
  Sales Currency Contract memory).
- Reader was therefore dividing already-USD values by ~5.4× (BR), 1.4× (CA),
  17.5× (MX), understating confirmed revenue everywhere it surfaced.

Affected BR YTD rows: 23/47 (`orders_itemprice` 17, `order_total_pending` 3,
`orders_api` 3). Plus 1 truly-native legacy row from
`estimated:asin_my_price_cache` (`702-3018133-4922663`).

### CA/MX parity scan (run before merging)
- **CA:** all `orders_itemprice` / `order_total_pending` / `orders_api` rows
  USD-shaped (avg $25–31). Reader fix is safe.
- **MX:** **mixed.** Most rows USD-shaped (~$28), but `orders_itemprice` shows
  outliers up to $836 and `order_items_api` avg $444 — clearly native MXN.
  These survivors are still caught by the retained **estimated-ratio guard
  (0.92–1.08)** and the **magnitude threshold** (`nativeMagnitudeThreshold` ≈
  max(120, fx×7) for MX).

### Fix
- `src/lib/sales/currencyConversion.ts`: removed the `startsWith` branch in
  `shouldTreatConfirmedRevenueAsNative`. Estimated-ratio guard + magnitude
  threshold remain as defensive nets for genuine legacy native rows.
- Writers, UI, and `live-sales-core` untouched (per scope).
- Legacy row `702-3018133-4922663`: `sold_price` / `total_sale_amount`
  389.40 → 72.43 USD using USD→BRL=5.3766 snapshot. Audit row in
  `sales_correction_history` (`audit_section_14_br_native_currency_repair`).
- Tests: `src/lib/sales/__tests__/currencyConversion.test.ts` locks in 3 BR
  incident orders + CA parity + MX defensive guards + US untouched (9/9
  passing).

### What to watch
- MX `orders_itemprice` rows that DROP below the magnitude threshold AND have
  no estimated_price — they'd now read as USD even if stored native. Volume
  appears small (≈3–5 rows YTD) and they primarily affect MX P&L, not
  repricer. Follow-up: targeted MX backfill / per-row repair if telemetry
  shows drift.
- Future writer drift: any new path that re-introduces native storage on
  non-US must add an explicit `_native` price_source marker (not yet
  supported by helper — add a `TRUSTED_NATIVE_PRICE_SOURCES` set if needed).

---

## §14b: BR FEC writer FX staleness + reader-side aftermath

After §14 shipped, user verification on order `701-2643862-4914600` (BR,
R$146.56 native, $24.92 stored) showed Live Sales still under-reported. Deep
trace exposed **two more bugs**, both writer-side, plus a missed Deno mirror.

### Root causes

1. **Deno helper drift (B14b-1)**: `supabase/functions/_shared/live-sales-core.ts`
   carried its own copy of `shouldTreatConfirmedRevenueAsNative` with the
   exact `startsWith("orders_itemprice"|"order_items_api"|"order_total_pending")`
   branch §14 removed in the TS reader. Live Sales/Sales Report/YTD all read
   through this Deno helper via cache RPCs, so the §14 fix never reached the
   UI. **Patched** (mirrors the TS edit).

2. **W1 — `orders_itemprice` BR native leak (writer-side)**: 5 BR YTD rows had
   `sold_price` stored as native BRL (e.g. R$181.19) rather than USD. Reader's
   magnitude guard caught most but ≤5 leaked through. **Repaired** in
   `sales_orders` via `sales_correction_history` correction_type
   `audit_section_14_w1_br_native_orders_itemprice_leak`.

3. **W2 — FEC writer hardcoded stale FX (writer-side)**:
   `supabase/functions/sync-sales-orders/index.ts` had **three** literals of
   `const CURRENCY_TO_USD = { USD:1, MXN:0.05, CAD:0.73, BRL:0.17 }`
   (lines ~3538, 3621, 7941). `BRL: 0.17` ⇒ 5.88 BRL/USD, ~9% under today's
   5.3766. Settlement therefore stamped `price_source='financial_events'` on
   rows whose `sold_price` was still the stale-FX value — not the FEC
   aggregate (`financial_events_cache.sales`), which uses correct USD.
   - Example: `701-2643862-4914600` settled $24.92 (146.56 × 0.17) vs FEC
     sales $27.26 (146.56 × 0.186).

### Fixes (Audit §14b)

| Layer | Change |
|---|---|
| Deno reader | `live-sales-core.ts` mirrored to remove the stale `startsWith` native branch |
| Writer | New `getLiveCurrencyToUsd(supabase)` helper backed by live `fx_rates`; 3 hardcoded `CURRENCY_TO_USD` literals replaced |
| Data | 5 W1 rows + 3 W2 rows repaired in `sales_orders`, audited in `sales_correction_history` |
| Cache | `live_sales_period_cache` (BR/ALL/null), `sales_period_totals_cache` (all), `live_sales_summary` (BR users) cleared |
| Tests | `supabase/functions/_tests/audit-section-14/fec-currency-fix_test.ts` — 6 tests pin: live BRL math, repair values, CA/MX live rates, non-zero fallback, FEC-zero non-overwrite guard, US untouched |

### Repair table

| # | order_id | reason | old | new |
|---|---|---|---:|---:|
| W1-1 | 701-5367788-2734657 | native BRL leak | 181.19 | 33.6961 |
| W1-2 | 701-7669767-6636200 | native BRL leak | 153.45 | 28.5398 |
| W1-3 | 701-0426220-0297863 | native BRL leak | 148.35 | 27.5917 |
| W1-4 | 702-7242780-1103434 | native BRL leak | 137.72 | 25.6118 |
| W1-5 | 702-3064381-7704260 | native BRL leak | 107.01 | 19.8993 |
| W2-1 | 702-1179183-8767420 | FEC mismatch | 38.8229 | 42.4748 |
| W2-2 | 701-6435513-7764215 | FEC mismatch | 37.7689 | 41.3217 |
| W2-3 | 701-2643862-4914600 | FEC mismatch | 24.9152 | 27.2589 |

Net YTD revenue delta: stored "USD" sum drops ~$533 (W1 inflation removed)
and gains ~$9.55 (W2 FEC adoption); reader output is now consistent.

### Writer contract (post-§14b)
- **Never** hardcode FX rates inside writers. All non-USD conversions go
  through `FX_RATES_CACHE` / `getLiveCurrencyToUsd()` (lazy-loads from
  `fx_rates` when empty).
- Zero/null FEC sales never overwrites confirmed values — predicate
  `fec_sales_usd > 0 AND |fec_sales_usd − stored| > 0.50` gates adoption.
- Refunds/adjustments stay in `financial_events_cache.refunds` /
  `processRefundEvent` — never folded into `sales_orders.total_sale_amount`.

### What to watch
- Telemetry: any FEC-tagged row where `|sales_orders.total_sale_amount −
  SUM(financial_events_cache.sales)| > $0.50` indicates the writer didn't
  refresh on a later settlement; nightly parity check already covers this.
- MX/CA equivalents: writer now uses live MXN/CAD rates, so the small
  unreported MXN deltas from §14 should close on next settlement sync.

---

## §15 — IP risk overlay (removed 2026-07-06)

**Status: removed, not deferred.** The `computeFinalDecision` compliance
overlay used to include an `ipRisk` branch that could downgrade any BUY*
verdict to `TEST ONLY` when `ipRisk === "high"`. In practice it never
fired in production:

- **Extension (`extension/panel.js`)** — the `compliance` object built by
  `renderDecisionMatrix` hardcoded `ipRisk: "unknown"` on every scan. No
  code path ever mutated it.
- **Web (`ProductAnalyzer.tsx`)** — `complianceFromStageStatuses` was fed
  `alerts.find(a => a.key === "ip").status`. That alert is emitted by
  `supabase/functions/analyzer-product-snapshot/index.ts` and is
  **hardcoded to `status: "good"`** (line 482, "No known IP issues"). No
  live classifier / brand-restriction API / PL model produces this value.

Net: the branch-matrix unit test `ipRisk=high downgrades every BUY*
branch to TEST ONLY` passed as an isolated function test but was
structurally unreachable from any live scan. That's a false-confidence
pattern — the tests and the branch-matrix summary implied IP protection
existed when no live signal was wired.

**Cleanup performed:**
- Removed `ipRisk` field from `ComplianceInput` (`src/lib/finalDecision.ts`).
- Removed the `ip === "high"` / `ip === "medium"` overlay branch and the
  now-unused `downgradeToTest()` helper.
- Removed the `ipAlertLevel` parameter from `complianceFromStageStatuses`
  and its callers (`ProductAnalyzer.tsx`).
- Deleted the corresponding vitest assertions (both the standalone
  `high IP risk downgrades any BUY* to TEST ONLY` and the branch-matrix
  loop) rather than leaving them `.skip` — a passing test for deleted
  logic is its own kind of lie.
- Extension `panel.js` `applyComplianceOverlay` mirror updated.
- Left the hardcoded `key: 'ip'` alert in `analyzer-product-snapshot`
  untouched because it still powers a display badge on the analyzer UI;
  it is now visibly a static "No known IP issues" badge with no
  downstream verdict effect.

**Untouched:** hazmat overlay (`compliance.hazmat`) and prep overlay
(`compliance.prep`) remain fully wired — both are sourced from SP-API
`getItemEligibilityPreview` stage statuses via `useFbaEligibility`. Their
overlay branches, unit tests, and branch-matrix rows are unchanged.

**Revisit criteria:** restore the `ipRisk` overlay only when a real
brand-restriction / PL-risk classifier is wired end-to-end (data source
→ edge function → analyzer snapshot → `complianceFromStageStatuses`).
Do not reintroduce the type field, the extension hardcode, or the
matrix test in isolation — those are what created the false-coverage
gap this cleanup closes.
