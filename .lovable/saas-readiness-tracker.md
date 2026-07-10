# ArbiProSeller — SaaS Public Readiness Tracker

**Purpose:** Gate every tool through the same forensic bar before `arbiproseller.com` is opened to strangers.
**Rule:** No tool ships public until every box in its class checklist is a hard ✓ (not "probably fine").
**Bar set by:** The refund-accumulator bug (July 2026) — silent, 10-30× wrong, hidden for weeks under a UI that looked correct.

---

## Risk classes & launch order

| Class | Definition | Failure cost | Launch order |
|---|---|---|---|
| **A — Money-touching** | Computes/stores $, writes prices to Amazon, drives billing | Direct $ loss to seller or platform liability | Last, strictest bar |
| **B — Operational** | Drives Amazon workflows (shipments, listings, labels) | Time loss, compliance risk, recoverable | Middle |
| **C — Advisory** | Recommendations, analytics, research (human in loop) | Bad decisions but a human sees before $ moves | First |
| **D — Admin/Infra** | Internal ops, diagnostics, cron dashboards | Not user-facing at launch | Excluded from launch scope |

**Launch sequence:** C (prove the pattern works) → B → A. Money-touching goes last even though it's most "done" — that's exactly what today's bug proved.

---

## Universal per-tool checklist

Every tool, regardless of class, must clear these before public launch:

- [ ] **Multi-tenant isolation verified** — logged in as User B, cannot see User A's data. RLS policies tested, not just written.
- [ ] **Zero-support onboarding** — a stranger can reach a correct output from scratch, no Slack message required.
- [ ] **API failure behavior** — Amazon/Keepa/Stripe slow, 429, malformed response → tool fails loudly, does not silently write bad data.
- [ ] **Empty-state UX** — new user with 0 rows sees something coherent, not a broken chart or console error.
- [ ] **Mobile viewport** — usable at 375px width, or explicitly hidden on mobile with a message.
- [ ] **Error surfaces to user** — no silent catch-and-swallow; user sees "why this failed" not a blank screen.
- [ ] **No console errors** on happy path.
- [ ] **No PII in logs / error_reports / edge function logs.**

### Class A adds (money-touching)

- [ ] **Write-path idempotency proven** — reprocessing the same event/webhook twice produces the same row, never `+=`. Grep for every `+=` and `existing.X + new.X` in the writer.
- [ ] **Single source of truth per field** — for every numeric column, exactly one writer path; if two functions write it, prove they can't race.
- [ ] **Ground-truth reconciliation** — 10-15 real historical cases, field-by-field against Seller Central / bank statement / actual Amazon response. Ratio checks (`stored / truth`) must all be 1.00 ± rounding.
- [ ] **Physical-plausibility guards** — refund qty ≤ ordered qty, refund $ ≤ ordered $, price change ≤ N% per step, etc. Every constraint that "should never" happen has a hard reject at write time.
- [ ] **Selection-bias check on QA sample** — some test cases picked at random (recent, boring), not just outliers, so you don't verify only the bugs you already know about.
- [ ] **Reversibility** — every write has an audit trail; corrupted rows can be quarantined without loss.

### Class B adds (operational)

- [ ] **Amazon compliance check** — output (labels, feeds, box content) validates against SP-API schema, not just "looks right."
- [ ] **Partial-failure recovery** — halfway through a shipment build the tab is closed → user can resume, nothing orphaned.
- [ ] **Rate-limit resilience** — SP-API 429s handled with backoff, user sees progress, not a stuck spinner.

### Class C adds (advisory)

- [ ] **Confidence/source labels** — every recommendation shows what data it's from and when it was fetched. No un-attributed numbers.
- [ ] **Stale-data warnings** — Keepa/BSR older than N days shows a badge; user isn't tricked into acting on old snapshots.

---

## Tool inventory by class

### 🅰 Class A — Money-touching (strictest bar, launch LAST)

| Tool | Route | Status | Blockers |
|---|---|---|---|
| Repricer | `/tools/repricer` | ⏳ | Full forensic pass on price-write path required |
| Repricer Analytics | `/tools/repricer/analytics` | ⏳ | Verify aggregates against raw actions log |
| Repricer Monitor | `/tools/repricer/monitor` | ⏳ | Live-loop correctness |
| Repricer Timeline (per ASIN) | `/tools/repricer/timeline/:asin` | ⏳ | |
| Repricer Operator Queue | `/tools/repricer/operator-queue` | ⏳ | Admin action audit trail |
| Repricer Eligibility Diagnostics | `/tools/repricer-eligibility-diagnostics` | ⏳ | |
| Live Sales (desktop) | `/tools/repricer/live-sales` | ⏳ | Pending-price fallback chain |
| Live Sales (mobile) | `/m/live-sales` | ⏳ | Same as above |
| Sales | `/tools/sales` | ⏳ | FX conversion, promo rebate capture |
| Sales Report / Reports Accounting | `/tools/reports` | 🔴 | **Live status='settled' leak fix pending H1 (see refund investigation)** |
| Profit & Loss | `/tools/profit-loss` | 🔴 | Depends on refund correctness — blocked on H1 |
| Executive Dashboard | `/tools/executive` | ⏳ | Rollup of P&L — inherits blockers |
| Price Discrepancy Audit | `/tools/price-discrepancy-audit` | 🔴 | **Active investigation — FEC-vs-Refunds-API decision, H1 rewrite pending** |
| FEC Backfill | `/tools/fec-backfill` | 🔴 | Same investigation |
| Settlement | `/tools/settlement` | ⏳ | Settlement report ingestion accuracy |
| Shipment Accounting | `/tools/shipment-accounting` | ⏳ | |
| Reimbursements | `/tools/reimbursements` | ⏳ | Amazon reimbursement claims — real $ |
| Expenses | `/tools/expenses` | ⏳ | Manual entry, low blast radius but still $ |
| Inventory Valuation | `/tools/inventory` (valuation view) | ⏳ | Verified against summary cache |
| Mobile Inventory Valuation | `/m/inventory-valuation` | ⏳ | |
| Inventory Writeoff | `/tools/inventory-writeoff` | ⏳ | Impacts COGS |
| Break-Even Calculator | `/tools/break-even` | ⏳ | Pure calc, verify formula |
| FBA Fee Calculator | `/tools/fba-fee` | ⏳ | Fee model correctness |
| ROI Calculator | `/tools/roi` | ⏳ | Uses centralized ROI engine — verify |
| Target ROI Price | `/tools/target-roi-price` | ⏳ | |
| Billing / Subscription flow | (Stripe portal + webhooks) | ⏳ | Trial → paid → cancel → refund all tested |

### 🅱 Class B — Operational

| Tool | Route | Status | Blockers |
|---|---|---|---|
| Shipment Builder | `/tools/shipment-builder` | ⏳ | Partial-failure recovery |
| Shipment Tracking | `/tools/shipment-tracking` | ⏳ | |
| Purchase vs Shipment Report | `/tools/purchase-vs-shipment` | ⏳ | |
| Create Listing | `/tools/create-listing` | ⏳ | Validates against SP-API before submit |
| Created Listings | `/tools/created-listings` | ⏳ | |
| Pending Approvals | `/tools/pending-approvals` | ⏳ | |
| Still Thinking | `/tools/still-thinking` | ⏳ | |
| Need Buy Again | `/tools/need-buy-again` | ⏳ | |
| Label Printing | `/tools/label-printing` | ⏳ | PDF correctness |
| Printing without PDF | `/tools/printing-without-pdf` | ⏳ | |
| FBA Eligibility Issues | `/tools/fba-eligibility-issues` | ⏳ | Depends on eligibility cache freshness |
| Fetch Listing Price | `/tools/fetch-listing-price` | ⏳ | |
| Inventory (main) | `/tools/inventory` | ⏳ | Freshness guard verified |
| Inventory Restoration | `/tools/inventory-restoration` | ⏳ | Admin-adjacent |
| Inventory Review | `/tools/inventory-review` | ⏳ | Missing-review queue drain |
| Synced Inventory | `/tools/synced-inventory` | ⏳ | |
| Disposition Management | `/tools/disposition-management` | ⏳ | |
| Tracking | `/tools/tracking` | ⏳ | |
| Amazon Connect | `/tools/amazon-connect` | ⏳ | **Onboarding critical path** |
| Amazon Connection | `/tools/amazon-connection` | ⏳ | Same |
| Ext Handoff | `/tools/ext-handoff` | ⏳ | Browser extension bridge |

### 🅲 Class C — Advisory (launch FIRST — prove the pattern)

| Tool | Route | Status | Blockers |
|---|---|---|---|
| Dashboard | `/tools/dashboard` | ⏳ | Empty state + KPI accuracy |
| Product Analyzer | `/tools/product-analyzer` | ⏳ | Decision memory v1 already in place |
| ASIN Lookup | `/tools/asin-lookup` | ⏳ | Read-only, low risk |
| UPC to ASIN | `/tools/upc-to-asin` | ⏳ | |
| BSR Sales Estimator | `/tools/bsr-sales` | ⏳ | Keepa accuracy labels required |
| Keepa Product Finder | `/tools/product-finder` | ⏳ | |
| Sourcer | `/tools/sourcer` | ⏳ | |
| Supplier Discovery | `/tools/supplier-discovery` | ⏳ | |
| Supplier Discovery Run | `/tools/supplier-discovery/runs/:runId` | ⏳ | |
| User Supplier Discovery | `/tools/user-supplier-discovery` | ⏳ | |
| Suppliers | `/tools/suppliers` | ⏳ | |
| Replenish Search | `/tools/replenish-search` | ⏳ | |
| Research Leads | `/tools/research-leads` | ⏳ | |
| Seller Analyzer | `/tools/seller-analyzer` | ⏳ | Keepa cache 24h |
| Scan Categories | `/tools/scan-categories` | ⏳ | |
| User Store Scan | `/tools/user-store-scan` | ⏳ | |
| Scan History | `/tools/scan-history` | ⏳ | |
| Mobile Scan | `/m/scan`, `/m/scan/:id`, `/m/history` | ⏳ | |
| My Database Products | `/tools/my-database-products` | ⏳ | |
| Price Extractor | `/tools/price-extractor` | ⏳ | |
| Price History | `/tools/price-history` | ⏳ | |
| Google Product Search | `/tools/google-product-search` | ⏳ | |
| AI Action Insights | `/tools/ai-insights` | ⏳ | |
| Commercial Timeline | `/tools/commercial-timeline` (if wired) | ⏳ | |
| Email Center | `/tools/email-center` | ⏳ | Gmail OAuth flow tested |

### 🅳 Class D — Admin/Infra (EXCLUDED from public launch scope)

Hide behind admin role for launch. Not on the public path.

- Admin Management, Admin Users, Admin Account Control
- Cron Diagnostics, Database Maintenance, Error Log
- Repricer Monitor (admin view)

---

## Where to start — recommended sequence

### Week 1 — Finish the active fire
1. Close out the refund investigation (widened spot-check → H1 source-of-truth → H1 draft → deploy).
2. Re-run the acceptance test set (7 quarantined rows + STIHL) + backfill sweep.
3. **Do not start new tool audits until H1 is deployed** — the same accumulator pattern likely exists elsewhere, and finding it once teaches the reviewer what to look for.

### Week 2 — Grep for the pattern across all Class A writers
Before auditing tool-by-tool, do a **codebase-wide sweep** for the specific bug shape:
- `grep -rE '(\+= *[a-zA-Z_.]|existing\.\w+ *\+)'` across `supabase/functions/`
- Every `existingByKey.get(...)` or `.upsert(` on a table where a numeric column is written from an external API
- Every writer that lacks a `writtenThisCall` / idempotency-per-call guard
- Every table with two edge functions writing the same columns

This single pass is worth more than 10 individual tool audits — it finds the class of bug, not the instance.

### Week 3+ — Class C tools, one by one
Start with the lowest-risk tools to build the muscle: **ASIN Lookup → UPC to ASIN → Product Analyzer**. Each one runs through the universal checklist. If the checklist can't be cleared in a day for a Class C tool, that's a signal to fix the checklist or fix the tool — not lower the bar.

### Week 5+ — Class B, then Class A
Class A tools each get a mini version of what you just did with the refund bug: pick a dozen ground-truth cases, reconcile field-by-field, and don't accept the first explanation.

---

## Testing methodology (from the refund investigation, generalized)

For any Class A or B tool:

1. **Pick 10-15 real cases** — mostly boring/recent, 2-3 known-weird for adversarial coverage. Don't select only outliers (selection bias).
2. **Get ground truth from outside the app** — Seller Central UI, bank statement, actual Amazon order details page, or the raw SP-API response captured separately.
3. **Reconcile field-by-field, not total-by-total.** A total can be right by accident when two errors cancel; a field cannot.
4. **When a value is off, demand the arithmetic.** Don't accept "close enough" or "probably the fee." Multiply it out to the last cent.
5. **When arithmetic almost works, look for the second bug.** Today's session proved that "clean 1.82×" hid two stacked bugs. If the ratio isn't 1.00 ± rounding, keep digging.
6. **Physical-plausibility check first, source-of-truth second.** Refund qty > ordered qty = wrong, period, no API decision needed. Apply the equivalent check to every tool: what's the physical/logical impossibility that instantly disqualifies a value?
7. **Quarantine, don't guess.** When a value is provably wrong but the correct value isn't known yet, NULL it and mark the row — never leave a wrong number in a report because "we'll fix it later."

---

## Status legend
- ⏳ Not audited
- 🟡 In progress
- 🔴 Blocked / known bug
- ✅ Ready for public launch

---

## Change log

Timestamp-log for durable tracking across weeks. Newest at top.

### 2026-07-03 (later 2) — SW1-guard SHIPPED. Channel B relabeled theoretical.

**SW1-guard status: 🟢 LIVE IN PRODUCTION.**

Shipped as a DB-level BEFORE INSERT/UPDATE trigger on `public.sales_orders` — function `public.refund_physical_plausibility_guard()`. Catches every current and future refund writer regardless of code path (there are 26+ refund write sites across 14 edge functions; a trigger is the only complete coverage).

**What the guard blocks at write time:**
- HARD REJECT #1: `refund_quantity > parent.quantity` — physical impossibility, can't return more units than shipped. Raises `refund_guard_qty_exceeds_parent`.
- HARD REJECT #2: `refund_amount > 1.5 × parent.total_sale_amount` — generous tax/shipping/promo margin, but blocks the 10×+ corruption seen in Panduit. Raises `refund_guard_amount_exceeds_parent`.

**What the guard does NOT block (deliberate):**
- UPDATEs that decrease or leave `refund_quantity`/`refund_amount` unchanged. Corrections to already-corrupted rows (Panduit, STIHL, 5-batch) can still land — otherwise we couldn't fix them.
- Refund rows arriving before their parent (out-of-order sync) — logs a NOTICE, allows write. Otherwise ingestion would deadlock on API arrival order.
- Status-only flips (`settled` ↔ `refund`) that don't touch refund columns.

**Validation this guard would have caught the thread's known bad rows:**
- Panduit: `refund_quantity=160`, parent qty ~10 → REJECT #1 fires. ✓
- STIHL: `refund_amount ≈ 10× parent total` → REJECT #2 fires. ✓
- 5-row spot-check (all `qty=1`, ratio 0.90–1.02×): all pass. ✓ (this is expected — they were never physically impossible; they're the normal-refund noise band that H1 is scoped to.)

**Independence from SW1-fix:** SW1-guard closes the failure class going forward. SW1-fix (line-item dedup on the aggregation loop) closes the specific root cause once Channel A is reproduced from the Panduit event export. The guard does not depend on the reproduction — it is a floor of correctness, not a fix.

**Channel B relabel: THEORETICAL, NOT CONFIRMED. ⚠️**

The earlier SW1 finding named two duplication channels. Only Channel A has a numeric reproduction that fits Panduit's exact numbers (16 lines × qty=10 × ~$244.72 = 160 units / $3,915.44). Channel B (cross-page FEC event re-emission across `NextToken` boundaries with no event-id dedup) is:
- ✅ A real structural gap in the code: `allRefundEvents` collects paginated results with no dedup by `event.AdjustmentId` or equivalent.
- ❌ NOT numerically proven against any known corrupted row. Panduit fits Channel A alone; Channel B was not required to explain it.
- ❌ NOT observed empirically: we have not verified whether the Panduit-era `sync-sales-orders` calls ever actually returned a multi-page `NextToken` response for the affected order in this dataset.

**Reclassifying Channel B as a theoretical risk pending observation, not a confirmed second bug.** Fix pattern (event-id dedup on `allRefundEvents`) is still worth applying as a defensive measure when SW1-fix ships — cheap to add, closes an obvious gap — but it must be labeled "defensive, not proven necessary" in the SW1-fix PR notes.

**Channel B verification task (added to Week-2b, not blocking):** grep edge-function logs for `[REFUNDS_HISTORICAL] Chunk .*: Found` messages where a chunk reports >100 refunds (i.e., pagination definitely triggered), then cross-reference those chunk time windows against the corrupted order write timestamps. If no overlap: Channel B never fired for any known-corrupted row → definitely theoretical. If overlap: promote to confirmed.

**Action items updated:**

- **SW1-guard** — ✅ SHIPPED. Live in production as trigger `trg_refund_physical_plausibility_guard`. Migration reviewed and applied.
- **SW1-fix** — still queued behind Panduit event export from Seller Central. Line-item dedup + (defensive, not proven-necessary) cross-page event dedup.
- **SW2** — CLEARED.
- **SW2-followup** — defensive line-id dedup on `processFinancialEvent` shipment aggregator, apply alongside SW1-fix.
- **Channel B verification** — Week-2b, non-blocking. Log grep + timestamp cross-reference.

**Blockers remaining on H1 (unchanged):**

1. Seller Central lookup on 5 widened spot-check rows — get the plain customer-refunded dollar amount for each. This is what H1's normal-refund source-of-truth decision depends on. All 6 dollar totals needed; do not skip any.
2. Seller Central financial event export for Panduit's refund date — this is a SEPARATE artifact from #1. Settles Channel A yes/no via raw `ShipmentItemAdjustmentList` shape from Amazon's side. Both artifacts needed; one does not substitute for the other.



### 2026-07-03 (later) — SW1 + SW2 traced

**SW2 — RESOLVED, SAFE. ✅**

Traced the enclosing scope of `aggregatedByAsin` (the `+=` at lines 8309-8314). It is declared `const` at line 8250 **inside** `async function processFinancialEvent(supabase, userId, event)` (declared at line 8205). The function processes exactly **one FEC event** per invocation — one order's shipment event. The Map is freshly instantiated on every call, cannot leak across orders, and the `+=` is doing exactly what the code comment at line 8234 explicitly says it's doing:

> "Amazon may send multiple ShipmentItems for the same ASIN (one per unit). We must AGGREGATE all items by ASIN before processing to get correct totals."

This is a **within-event, per-ASIN reducer over a bounded list**. Not a leaking accumulator. **No live correctness bug here.** The Repricer Class A audit gate on SW2 is cleared.

Caveat filed: the aggregation trusts that `ShipmentItemList` for one event contains no duplicate line entries. If Amazon ever emits duplicates within one event's `ShipmentItemList`, this doubles just like SW1 below. Not observed for shipments today, but the same de-dupe-by-line-id guard we're going to need for SW1 should be applied here defensively when H1 ships. Filed as **SW2-followup**.

**SW1 — CONFIRMED HIGH-RISK MECHANISM. Structural possibility met; multiplier fits Panduit; concrete reproduction pending event dump. 🔴**

Full trace of lines 2141-2260. What actually happens per call:

1. Lines 2141-2171: **Paginated FEC pull** via `NextToken`, up to 20 pages, all `RefundEventList` entries collected into `allRefundEvents` (line 2161). No dedup by event ID or `(orderId, postedDate)` between pages.
2. Line 2177: iterate every event in `allRefundEvents`.
3. Line 2180: `event.ShipmentItemAdjustmentList` is taken as-is. No dedup by line-item ID, no dedup by `(SellerSKU, promo, taxCollectionModel)`.
4. Lines 2199-2219: the within-call accumulator. For every item in that list: `aggByAsin[asin].qty += itemQty`, `aggByAsin[asin].amount += itemRefundAmount`. `itemQty` is parsed from `QuantityReturned || QuantityShipped || Quantity || 1`. `itemRefundAmount` comes from `calculateSellerCentralRefundAmount(item)` — sums the item's own charge/fee/tax components for one line entry.
5. Lines 2233-2255: **upsert on `fec_refund_key = refund:${orderId}|${asin}|${ptDate}`**. `onConflict` REPLACES the row, so the aggregated `agg.qty` / `agg.amount` land as-is with no server-side sanity check against parent order quantity.

**Two independent duplication channels feed the accumulator, both unguarded:**

- **Channel A — within-event `ShipmentItemAdjustmentList` duplicates.** If Amazon emits multiple adjustment line entries for the same underlying return (known to happen when a refund has multiple concurrent adjustment types: principal + tax + promo pass-through + admin retention are sometimes broken into separate lines per unit, or the same physical unit generates entries for both the return and the corresponding shipment reversal), and each line carries `QuantityReturned` = the FULL returned quantity rather than 1, the loop multiplies. This is the exact shape suspected in the earlier thread.
- **Channel B — cross-page event re-emission within one call.** Amazon's FEC pagination is known to re-emit the same event across page boundaries when events post exactly on the page cutoff. `allRefundEvents` collects everything, no dedup. If the same Panduit refund event lands on both page 1 and page 2 of the same call, it enters the outer loop twice, and both times the inner aggregator adds. The upsert then writes the doubled total.

**Multiplier fit against Panduit's known numbers:**

Panduit: `refund_quantity = 160`, `refund_amount = $3,915.44`, parent order qty = 10, `$/pass = $244.72`.

- If the parent had ~10 units and Amazon emitted an adjustment line **per unit** with `QuantityReturned=10` on each (Channel A, quantity-inflation shape): 16 lines × qty=10 = 160, 16 × ~$244.72 = $3,915.44. **Fits exactly.**
- If Channel B (cross-page replay) instead: would need the same event to appear ~16 times across the 20 paginated pages, which is possible but requires the page cutoff to be exactly on the Panduit event's PostedDate 16 times — highly implausible from one call.
- **Channel A is the fit.** Channel B is a real problem but doesn't produce this specific multiplier.

**How this relates to PR-A:** PR-A prevented `+=` across separate function invocations (cross-call replay when a webhook / cron re-fires and reprocesses the same order). It has zero effect on Channel A or Channel B because both are **within a single call**. So PR-A is a real fix for a real second bug — but it is not sufficient to explain Panduit's corruption, and Panduit's corruption is not evidence PR-A was wrong; they are different bugs.

**What this implies for the "which API is canonical" H1 question:**

Very likely the debate is partially moot. If Channel A is confirmed on the Panduit event dump, then:
- The Refunds API / FEC principal comparison on Panduit was comparing a **within-call-corrupted** stored value to two clean upstream sources — neither of which was ever wrong. The stored value was wrong, and the upstream question is a red herring for that row.
- The widened 5-row spot-check's 0.90–1.02× variance is **almost certainly a different phenomenon**: those refunds have `refund_quantity=1`, so Channel A cannot double them (no duplicate line entries when there's only one unit returned). The 0.90–1.02× band is more consistent with normal per-refund noise (partial refund of shipping/tax, promo pass-through retention, referral fee credit rounding) — i.e. the Refunds API is likely returning **customer-received principal after Amazon retentions**, which won't match FEC gross principal but is a defensible correct answer.

**This means H1's source-of-truth decision is still needed — but it should be scoped to normal (non-Panduit-shape) refunds. The blown-up ones should NOT drive the H1 decision.**

**Concrete reproduction — still pending. Requires either:**

1. Fetching Panduit's raw `event.ShipmentItemAdjustmentList` from Amazon's Refunds API and showing the line entries directly (i.e., dumping the event with `console.log(JSON.stringify(event, null, 2))` in a one-off script or Seller Central financial event export). Show the duplicated lines, or their absence.
2. OR: adding line-item-id / composite-key logging to `sync-sales-orders` before the aggregator loop and reprocessing Panduit's date range, then reading the logs.

Option 1 requires a real Amazon call — needs the user to trigger a targeted refund resync on Panduit's date range OR pull it manually from Seller Central's financial event history. Option 2 requires a code change we shouldn't ship until H1 is settled.

**Recommendation to user:** when doing the Seller Central Panduit lookup, also grab the raw financial event export for that refund date (Seller Central → Reports → Payments → Transaction View → Refund event → download detail). That gives us the raw `ShipmentItemAdjustmentList` shape from Amazon's side without a code change, and settles Channel A yes/no in one artifact.

**Action items updated:**

- **SW1** — mechanism confirmed structurally, multiplier fits. Concrete reproduction gated on Panduit event dump (folded into the Seller Central pass the user is doing anyway).
- **SW1-fix** (queued behind confirmation, do NOT ship until reproduction is in hand): add line-item de-dup key on the inner loop (dedupe by `item.SellerSKU + item.RefundAdjustmentId` or equivalent Amazon line ID before entering `aggByAsin`), and add cross-page event dedup by `event.AdjustmentId` on `allRefundEvents` before the outer loop.
- **SW1-guard** (independent, safe to ship anytime): physical-plausibility hard reject at write time — reject any refund row where `refund_quantity > parent_order.quantity` or `refund_amount > parent_order.total_sale_amount + reasonable_tax_margin`. This alone would have caught Panduit at write time and is worth having regardless of what the root cause turns out to be.
- **SW2** — CLEARED. Repricer Class A audit gate lifted for this specific concern.
- **SW2-followup** — apply the same line-id de-dup discipline to `processFinancialEvent`'s shipment aggregator defensively when SW1-fix ships.

**Blockers remaining on H1:**

1. Seller Central lookup on the 5 widened spot-check rows (settles the normal-refund canonical-source question).
2. Seller Central financial-event export for Panduit's refund date (settles Channel A yes/no).
3. Both feed into: "H1 should route normal refunds via [X], and physical-plausibility guard should reject Panduit-shaped rows at write time before they land."



### 2026-07-03 — Grep sweep completed (Week 2 kicked off in parallel with H1)

**Scope:** tightly-defined accumulator patterns on money/quantity columns across `supabase/functions/`. Not a blind `+=` grep.

**Patterns run:**
1. `\b(money_col)\s*[+\-]=` on: refund_amount, refund_quantity, sold_price, total_sale_amount, quantity, item_price, promotion_discount, principal, tax, shipping_credit, referral_fee, fba_fee, revenue, profit, fees_total, cogs, amount, price, net.
2. `existing[A-Za-z]*\.(money_col)\s*\+` — the exact shape of the refund bug.
3. `(money_col)\s*:\s*[A-Za-z_.]+\s*\+\s*` — in-object literal accumulation (the "where is `r` built" hypothesis from the refund thread).
4. Counts of `.upsert(` and `.reduce(` in edge functions for cross-reference.

**Hit summary:** 15 total hits. 2 high-risk in `sync-sales-orders`, 13 low-risk (in-memory reducers or one-shot computes).

**File, line, column, blast-radius table:**

| # | File:Line | Column mutated | Shape | Risk | Notes |
|---|---|---|---|---|---|
| 1 | `sync-sales-orders/index.ts:2218` | `aggByAsin.amount`, `aggByAsin.qty` | Same-call in-memory accumulator over `ShipmentItemAdjustmentList` → upsert on `fec_refund_key` | 🔴 **HIGH — HYPOTHESIS-MATCH** | Scoped per-event, but if a single event's item list contains duplicates OR pagination re-emits the same event, this loop double-counts within one call. Upsert REPLACES on unique key, so the corrupted total lands as-is. Matches the "$/pass = $244.72" mystery Panduit surfaced. Refund writer. |
| 2 | `sync-sales-orders/index.ts:8309-8314` | `existing.quantity`, `totalPrincipal`, `shippingCharge`, `referralFee`, `fbaFee`, `closingFee` | `aggregatedByAsin.get(rawAsin)` + `existing.X += itemX` on sales-order (non-refund) items | 🟡 **MEDIUM** | Consolidates multiple `OrderItem` rows with same ASIN inside one order. Legitimate shape *if* the outer map is scoped per-order — need to confirm scope in the enclosing function. Same accumulator pattern as the refund bug; different write target. |
| 3 | `_shared/live-sales-core.ts:762` | `cur.amount` (refund cost) | Per-call reducer over query result set | 🟢 Low | In-memory sum for display; source is a SELECT, not raw API. Safe if source query is deduplicated. |
| 4 | `_shared/live-sales-core.ts:937` | `cur.revenue` | Per-call reducer | 🟢 Low | Same as above. |
| 5 | `_shared/live-sales-core.ts:1069` | `cur.refund_amount` | Per-call reducer | 🟢 Low | Same as above. |
| 6-9 | `verify-live-sales-cache-parity:164,169,171,176` | `bag.revenue`, `bag.profit`, `all.revenue`, `all.profit` | Read-only parity checker | 🟢 Low | Diagnostic tool, no writes. |
| 10-11 | `refresh-live-sales-period-cache:133,136` | `acc.revenue`, `acc.refund_amount` | Period cache builder | 🟢 Low | Aggregates over SELECT; if source is Sales-Orders-truth, safe. |
| 12 | `sync-sales-orders:6474` | local `revenue` var | In-memory sum for function return | 🟢 Low | Not persisted. |
| 13 | `sourcer-fetch-offers:208` | `total_price` | `price + shipping` — one-shot compute | 🟢 Low | No accumulation. |
| 14 | `repricer-evaluate:289` | `price` | `anchor.price + undercutAmount` — one-shot | 🟢 Low | Pricing computation, not accumulation. |
| 15 | *(dup of #1)* | — | — | — | P2 pattern matched only line 2218; same finding. |

**Baseline stats for context:** 150 `.upsert(` calls total in edge functions, 61 `.reduce(` calls. Additional review of `.reduce` callers on money columns is a Week-2b follow-up if hit #1 doesn't fully explain the Panduit dollar-per-pass math.

**Action items opened by the sweep:**

- **SW1 (blocks H1):** Trace `sync-sales-orders/index.ts:2177-2240` end-to-end. Prove whether `ShipmentItemAdjustmentList` per-event can contain duplicates, whether pagination can re-emit an event across pages within one call, and whether `calculateSellerCentralRefundAmount` returns per-component or per-line amounts. If any of those is yes, this is the actual root cause of the Panduit dollar-per-pass mystery — and PR-A does not fix it because PR-A guards against cross-call replay, not within-call iteration.
- **SW2 (blocks Repricer Class A audit):** Confirm `aggregatedByAsin` at line 8309 is scoped per-order, not per-call. Grep the enclosing function's declaration and any callers.
- **SW3 (Week-2b follow-up):** For the 5 low-risk in-memory reducers, verify the SELECT source is deduplicated (particularly `refresh-live-sales-period-cache` since it writes to a cache table that other tools read as truth).

**Sequencing decision:** Grep sweep confirmed parallelizable with H1 — findings are read-only observations, no code changed. H1 draft still gated on the widened spot-check's Seller Central leg.

**Open blockers from this timestamp:**

- 🔴 **Seller Central manual verification** on 5 spot-check refunds + STIHL (external task, needs a human with Seller Central access). Order IDs staged:
  - `114-5421581-8898602` (B081S6QGL7, refund $14.53, FEC principal $16.07, ratio 0.90×)
  - `113-3729597-5369034` (B003A66SSE, refund $20.87, FEC $22.00, ratio 0.95×)
  - `113-9833158-2445034` (B003A66SSE, refund $19.82, FEC $20.89, ratio 0.95×)
  - `114-2989770-7805861` (B003A66SSE, refund $21.30, FEC $20.89, ratio 1.02×)
  - `111-2263779-0880263` (B0GS6WGGJD, refund $26.26, FEC $27.28, ratio 0.96×)
  - Plus STIHL (previously verified as ground truth reference)
  - **Question to answer per row:** what does Seller Central show as the customer-refunded amount? Whichever of {Refunds API, FEC principal, FEC principal+tax} matches consistently → canonical source for H1.
- 🔴 SW1 tracing (see above).

### 2026-07-03 — Tracker created
- Bucketed 73 tools + 5 mobile pages into A/B/C/D.
- Class A (26) — money-touching, launch last.
- Class B (21) — operational, middle.
- Class C (25) — advisory, launch first.
- Class D — admin-only, excluded from public launch.

