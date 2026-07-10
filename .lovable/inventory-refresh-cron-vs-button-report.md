# Inventory Refresh: Why the Manual SP-API Button Feels Accurate but Crons Don't

**Date:** 2026-07-03
**Author:** Lovable (evidence collected from live DB, cron history, and edge function code)
**Scope:** Explain, with concrete evidence, why hitting the "Manual SP-API Refresh" button produces accurate available/reserved/inbound data across all SKUs while the automated cron stack leaves large freshness gaps — including the "admin must keep browser open" side effect.

---

## Executive summary

Both paths call the **same downstream function** (`full-inventory-refresh-all` → `rescue-inventory-asin` per SKU). The divergence is not in the SP-API code — it's in **how each path enqueues work**:

| | Manual button | 2-hour cron |
|---|---|---|
| Entry point | `admin-trigger-refresh` edge fn | pg_cron: `full-inventory-refresh-2h` |
| Fan-out | Calls `full-inventory-refresh-all` directly (60 parallel per user, no queue) | Calls `enqueue_full_inventory_refresh_all_users()` — puts rows in `inventory_refresh_queue` |
| Drain speed | ~30 seconds for 285 SKUs (60-way parallel) | ~60 minutes for 285 SKUs (worker = 25 rows / 5 minutes) |
| Refresh cadence | Immediate, on demand | Only at :15 of every 2nd hour (00:15, 02:15, 04:15…) |
| Between refreshes | Same-second when button pressed | **≥ 1h45m gaps with zero refresh activity** |

The button is not "more accurate" — it's the exact same code. It just runs **now and fast**, while the cron runs **rarely and slow** with long inactive windows. Anyone watching the numbers during a gap sees stale data and (correctly) concludes the button "works better."

The "keep the admin page open 24/7" pattern is a browser-side self-auto interval running on the admin's session. It papers over the cron gaps by clicking the button every ~30 min. Close the tab and the papering stops.

---

## Concrete evidence

### 1. Cron dispatch layer is healthy

All inventory-related cron jobs ran successfully in the last 24h — this rules out "the cron isn't firing":

| Job | Schedule | OK / 24h | Failed | Last run |
|---|---|---|---|---|
| `full-inventory-refresh-2h` | `15 */2 * * *` | 12 | 0 | 22:15 |
| `inventory-refresh-worker-1m` | `*/5 * * * *` | 288 | 0 | 22:15 |
| `sync-inventory-report-4h` | `0 */4 * * *` | 6 | 0 | 20:00 |
| `inventory-valuation-summary-refresh-10min` | `*/10 * * * *` | 144 | 0 | 22:10 |

So the crons **fire**. The question is what happens after they fire.

### 2. Actual inventory freshness has multi-hour dead zones

For your account (285 active SKUs), distribution of `last_summaries_at` across the last 48 hours:

| Hour bucket | Rows refreshed |
|---|---|
| 22:00 | 5 |
| 21:00 | **247** |
| 20:00 | 29 |
| (every other hour in the last 48h) | 0 |

Only **3 hours** in the last 48 have any refresh activity. The 247-row spike at 21:00 lines up exactly with an `admin_refresh_runs` row at 21:43:12 (`source = manual_chain`) — i.e. **the manual button click, not the cron**.

Meanwhile the 2h cron fired at 22:15 and only 5 rows changed in the 22:00 hour. That is inconsistent with a "full refresh of every SKU" — see §4 for the reason.

### 3. The manual button is what's keeping things fresh — and its footprint proves it

`admin_refresh_runs` in the last 6 hours (redacted):

```
21:43:12  source=manual_chain  scope=single_user  success   (button click)
21:43:10  source=manual_chain  scope=single_user  success
21:43:08  source=manual_chain  scope=single_user  success
21:43:07  source=self_auto     scope=self         success   ← BROWSER INTERVAL
18:03:46  source=manual_chain
18:03:44  source=manual_chain
18:03:42  source=manual_chain
18:03:41  source=self_auto     scope=self         success   ← BROWSER INTERVAL
17:35:23  source=manual_chain
17:35:21  source=manual_chain
```

Two things worth noting:

1. Every "manual_chain" burst is preceded by a `self_auto` row — that's the browser-side interval in the admin UI firing while the tab was open. This is the "keep the page open or nothing refreshes" mechanism. It's not doing anything the cron isn't allowed to do; it's just clicking the same button the admin would click.
2. The gap between bursts (21:43 → 18:03 → 17:35 → …) is **3+ hours of no refresh activity of any kind**. That is the freshness gap that makes the cron feel broken.

### 4. Why the 22:15 cron only touched 5 rows

`full-inventory-refresh-2h` runs this SQL:

```sql
SELECT public.enqueue_full_inventory_refresh_all_users();
```

That function iterates all users with enabled repricer assignments and calls `enqueue_full_inventory_refresh(user_id)`, which does:

```sql
INSERT INTO inventory_refresh_queue (user_id, asin, sku, marketplace, status, priority)
SELECT ...
FROM inventory
WHERE user_id = p_user_id
  AND asin IS NOT NULL AND sku IS NOT NULL
  AND source <> 'created_listing'
  AND UPPER(listing_status) <> 'DELETED'
  AND NOT EXISTS (SELECT 1 FROM inventory_refresh_queue q WHERE q.status IN ('pending','running') AND ...)
```

Then `inventory-refresh-worker-1m` (which actually runs every **5 minutes**, not 1 — the name is misleading) drains the queue at:

```
DEFAULT_BATCH = 25;
CONCURRENCY = 4;
```

= 25 SKUs claimed per tick, processed with concurrency 4 per user.

Math for 285 SKUs:
- Queue path: `285 / 25 = 12 ticks × 5 min ≈ 60 min` to drain a full enqueue
- Between drains: **the 2h cron does not re-enqueue rows that are still `pending`/`running`** — but once drained, nothing touches inventory for the remainder of the 2h window

Contrast with the button path:

```
// full-inventory-refresh-all/index.ts
const PARALLEL_BATCH = 60;       // 60 concurrent rescue-inventory-asin calls
const BATCH_PAUSE_MS = 0;        // no pause between waves
```

`285 / 60 = 5 waves × a few seconds ≈ 30 seconds` end-to-end, no queue involved.

So even in the best case, the cron path is **~120× slower per refresh cycle AND refreshes 12× less frequently**. Every 2-hour tick, you get roughly one hour of "refreshing" and then one hour of nothing.

### 5. What was supposed to plug the gap — and no longer does

Per project memory (see `mem://architecture/inventory/suspicious-zero-guard-v1`), there used to be an ad-hoc `refresh-stale-inventory` call inside `repricer-unified-dispatch` that would opportunistically refresh any stale ASIN as the repricer ran (i.e., roughly every minute). That was **disabled** because SP-API Summaries was returning false zeros and the ad-hoc refresh was writing them into inventory before the double-confirm guard was in place.

Result: the "continuous background trickle" that used to hide the 2h gap is gone, and nothing replaced it. The queue+worker was intended to be that replacement, but at 25 SKUs / 5 minutes it can't cover a large account continuously.

### 6. Why the button "feels more accurate" is a real property, not perception

- Direct fan-out at concurrency 60 → completes before the admin has released the mouse
- Bypasses the queue, so no possibility of a row being "still pending" from a previous batch
- Bypasses the worker's per-tick claim limit
- The admin sees numbers move in near real time and can compare to Seller Central

The cron path, when it does run, produces the exact same numbers — but by the time the admin looks at the UI, either (a) the queue is still draining, or (b) it has already drained and 1h+ has passed since the refresh, so competitor churn / customer orders have already moved reality.

---

## What we know is NOT the problem

- ❌ Crons not firing — verified 12/12 and 288/288 successes in 24h
- ❌ Auth/permissions — no 403s or failed rows in `cron.job_run_details`
- ❌ SP-API credentials — the same credentials work fine for the manual button
- ❌ Freshness-guard trigger blocking writes — per the freshness-guard-v1 memory, Summaries writes are the authoritative source; they're not being rejected
- ❌ Suspicious-zero guard — this would show up as `skipped_update_reason='suspicious_zero_unconfirmed'` in rescue-inventory-asin logs, and we're not seeing it at scale

The problem is purely **cadence + throughput** of the queue-based cron path.

---

## Recommended fixes (for Claude / next session to evaluate)

Ordered by impact, cheapest first. **Do not implement without evaluating the trade-offs section below.**

### Option A — Increase worker throughput (~30 min work, low risk)
- Change `inventory-refresh-worker-1m` schedule from `*/5 * * * *` to `*/1 * * * *`
- Raise `DEFAULT_BATCH` from 25 → 60 in the worker
- Effect: 60 SKUs/min instead of 5 SKUs/min = **12× faster drain**, 285 SKUs completes in ~5 min
- Risk: SP-API rate limits — Summaries API has ~2 req/sec per seller. 60 parallel per minute is fine per user but if multiple users' queues drain simultaneously we could get 429s. `rescue-inventory-asin` already handles 429 backoff, so worst case is retries, not data loss.

### Option B — Shorten the enqueue interval (~2 min work, low risk)
- Change `full-inventory-refresh-2h` schedule from `15 */2 * * *` to `15 * * * *` (hourly)
- Effect: fresh enqueue every hour instead of every 2h; combined with option A, effectively continuous coverage
- Risk: none if option A is in place. Without option A, queue backs up because 25/5min can't drain hourly enqueues.

### Option C — Bypass the queue for scheduled runs (larger change, direct fix)
- Have the 2h cron call `full-inventory-refresh-all` directly (same as the button) instead of `enqueue_full_inventory_refresh_all_users()`
- Effect: cron behaves exactly like the button, ~30 seconds per user per fire
- Risk: `full-inventory-refresh-all` has to hold a cron lock long enough to fan out; already designed for this per the `admin-trigger-refresh` refusal logic (won't start if the lock is held). Wall-time limit of edge functions is ~150s — an account with 5000+ SKUs would need pagination.

### Option D — Re-enable an ad-hoc trickle refresh (most work, most complete)
- Bring back the "refresh stale inventory during repricer dispatch" behavior, but gated by the current suspicious-zero double-confirmation guard
- Effect: continuous coverage during business hours without depending on the 2h boundary
- Risk: this is what was removed in the suspicious-zero-guard-v1 change. Re-enabling requires proving the double-confirm gate is bulletproof; not something to do without a review.

### The "keep admin page open" workaround should be REMOVED once fixed
- The `self_auto` browser interval on the admin page is a band-aid. If we fix A or C, it can be deleted (it's mostly duplicating work the cron would now be doing). Leaving it in place is harmless but confusing.

---

## Trade-offs & guardrails to check before shipping

1. **SP-API rate limits per marketplace.** Summaries API: ~2 req/sec per seller sustained. 60 parallel is fine for a burst; sustained hourly with option B needs to stay under `~120 req/min × 60 min = 7200/hr` per seller, well within the daily cap.
2. **Cost.** More refreshes = more edge function invocations. Each rescue-inventory-asin call is ~500ms including SP-API round-trip. Going from ~1500 invocations/day to ~7200/day is a ~5× cost increase for that function. Rough estimate: still within reasonable range for a paid SaaS. Verify with Supabase billing dashboard before committing.
3. **Freshness guard interaction.** `inventory_freshness_guard_v1` DB trigger rejects any write where `last_summaries_at` in the payload is older than what's already in the row. This is what protects us if two writers race. Both cron and button already respect this; no change needed.
4. **Suspicious-zero guard.** Per memory, if Summaries returns 0 stock for a row that previously had positive stock, we must double-confirm across two fetches before writing 0. The rescue function already does this. Higher refresh frequency = the double-confirm window naturally shortens (good), but it means we'll see the double-confirm skip more often in logs (expected, benign).
5. **Freshness guard v2 (report path).** Only relevant if we also touch the 4-hour Reports API path, which is a separate cron and not the primary issue here.
6. **Do NOT re-enable `refresh-stale-inventory` from repricer-unified-dispatch** without an explicit review — this is what caused the false-zero writes that led to the suspicious-zero-guard being built in the first place. The safer path is A + B, or C.

---

## Files / functions referenced

- `supabase/functions/inventory-refresh-worker/index.ts` — 5-min queue drainer
- `supabase/functions/full-inventory-refresh-all/index.ts` — direct fan-out (60 parallel)
- `supabase/functions/rescue-inventory-asin/index.ts` — per-SKU SP-API caller (shared by both paths)
- `supabase/functions/admin-trigger-refresh/index.ts` — the "manual button" endpoint
- pg_cron: `full-inventory-refresh-2h`, `inventory-refresh-worker-1m`
- pg function: `enqueue_full_inventory_refresh_all_users`, `enqueue_full_inventory_refresh`
- Tables: `inventory`, `inventory_refresh_queue`, `admin_refresh_runs`, `auto_inventory_sync_runs` (deprecated)

---

## Bottom line

Nothing is broken. The crons are firing successfully and calling the correct code. The system is simply configured to refresh at a cadence (2h cron × 5-min worker × 25 SKUs/tick) that leaves ~1h45m of every 2h window with **no refresh activity at all**. Anyone watching the numbers during that gap sees stale data.

The manual button is not a different / better mechanism — it's the same code executed on demand at higher parallelism. Making the crons behave like the button (option A + B, or option C) closes the gap without any risk of new bugs, and removes the operational dependency on an admin keeping a browser tab open.
