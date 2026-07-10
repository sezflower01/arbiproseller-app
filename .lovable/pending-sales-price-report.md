# Pending Sales Price — How It Works & Why the 1% Fails

Concrete case: order **113-8883103-0582614**, ASIN **B016Q4DMDA**, US, qty 1.
Amazon Seller Central shows unit price **$25.30**. Mobile Live Sales shows **$36.00**.

## 1. Data flow for a pending order

Amazon's Orders API returns pending orders **without `ItemPrice`** (the address is
hidden and the payment is not yet authorized). We therefore never have an
authoritative `sold_price` while the order is Pending. To keep the UI usable we
write an **`estimated_price`** and tag it with `price_source`. The chain lives in
`supabase/functions/sync-sales-orders/index.ts`:

1. **`order_price_snapshots`** — real Buy Box / featured-offer snapshot captured
   at order-discovery time.
   → path: `computeAndPersistEstimatedPrices` / `enrichFromSpApiFallback` line 1789–1804.
2. **`repricer_price_actions`** — most recent **successful** submit for that ASIN
   (US). Freshest "seller-derived" number after a repricer change.
   → line 5569–5590.
3. **`asin_my_price_cache.my_price`** — Product Pricing API "GetMyPrice" for the
   seller's own SKU (marketplace-scoped).
   → line 5592–5606.
4. **`inventory.price / amazon_price / my_price`** — Listings-API price captured
   by the last inventory refresh.
   → line 5608–5623.
5. **`buy_box_cache`** — *explicitly excluded* from `estimated_price` (line 5625)
   because BB may be another seller.
6. **BB own-estimate** — captured into `bb_estimate_*` columns but **never
   promoted** to `estimated_price` for pending orders (line 7762–7775).

Whichever candidate has the **latest timestamp** wins (line 5563–5567).
`price_source` is stamped `estimated:<source>` so we know where it came from.

Live Sales / Mobile Live Sales revenue is
`getLineRevenue = total_sale_amount ?? sold_price × qty ?? estimated_price × qty`.
For a pending order the first two are 0, so the UI shows
`estimated_price × qty`.

## 2. Why this order shows $36 instead of $25.30

Actual DB state (as of the sync at 15:54 UTC on 2026-07-07):

| Source | Value | Fetched / Updated | Notes |
|---|---|---|---|
| `sales_orders.estimated_price` | **36.00** | 18:00 UTC | `price_source = estimated:asin_my_price_cache` |
| `sales_orders.sold_price` | 0 | — | Pending — no `ItemPrice` from Orders API |
| `order_price_snapshots` | — | — | No row: sync ran 5 min after purchase, discovery had no live snapshot |
| `repricer_price_actions` (US) | new_price **25.30** | **2026-07-03 17:19** | Successful submit (`price_and_minmax_change`) 4 days before the order |
| `asin_my_price_cache` (US, `ATVPDKIKX0DER`) | **36.00** | **2026-07-07 18:00** (source: `auto_activation`) | Timestamp is fresher but the *value* is stale — Product Pricing API returned $36 |
| `inventory.price` | **25.30** | 2026-07-07 17:15 | Listings-API price refresh got the real price |

The fallback chain is timestamp-based. `asin_my_price_cache.fetched_at` (18:00)
is newer than the repricer action's `created_at` (Jul 3 17:19), so it wins even
though its value is stale — and because we only fall through to
`inventory.price` when no timestamped source exists, the correct $25.30 in
`inventory` never gets a chance.

### Why `asin_my_price_cache` disagrees with `inventory`

Both come from Amazon SP-API but different endpoints:

- `inventory.price` ← **Listings Items API** (`/listings/2021-08-01`). Returns
  the current *featured* price ($25.30 — the effective sale/deal price).
- `asin_my_price_cache.my_price` ← **Product Pricing API GetMyPrice**. Returns
  the seller's "listing price" ($36 — the list price before deal/promotion).

Amazon lets these disagree during deals, coupons, "Sale" prices, and after some
repricer edits (the featured offer updates in <1 min, GetMyPrice can lag hours).
Additionally, some cached rows are written by our own `auto_activation` /
`repricer` code paths and stamp `fetched_at = now()` even when the number came
from a stale server response. That's the whole 1% bug: **freshness is measured
by write time, not by API response time.**

## 3. Fix proposal (drop-in, low-risk)

Three targeted changes, all inside
`supabase/functions/sync-sales-orders/index.ts:computeAndPersistEstimatedPrices`
(and the twin path in `enrichFromSpApiFallback`):

### A. Prefer `inventory.price` over `asin_my_price_cache` when they diverge >5%

`inventory.price` is written by the Listings-API refresh and matches what the
customer sees on the product page. When two seller-derived sources disagree by
more than 5%, the Listings value is almost always correct.

```ts
// After collecting my_price + inventory candidates, resolve conflicts:
const myp = myPriceCandidate;      // asin_my_price_cache
const inv = inventoryCandidate;    // inventory.price / amazon_price
if (myp && inv && Math.abs(myp.price - inv.price) / Math.max(inv.price, 0.01) > 0.05) {
  // Trust Listings (inventory) over GetMyPrice — GetMyPrice returns list price,
  // not featured/sale price.
  consider(asin, inv.price, 'inventory.price_over_mypricecache', inv.ts);
} else {
  // normal timestamp-wins path
}
```

### B. Skip `asin_my_price_cache` rows whose write source is not a live pull

We already store `asin_my_price_cache.source`. Values like `auto_activation`,
`repricer_write_back`, `manual` are **not** live GetMyPrice responses. Exclude
those from freshness comparison (still let them warm the cache, just don't let
them beat `repricer_price_actions` or `inventory`):

```ts
.from('asin_my_price_cache')
.select('asin, my_price, fetched_at, source')
.eq('source', 'listings_api')   // only trust real API fetches
```

### C. Cross-check against the newest `repricer_price_actions` (last 14 days)

If a successful repricer submission exists within 14 days of the order and
`inventory.price` matches it, prefer that pair over `my_price_cache`. Rationale:
after a repricer edit, `inventory` picks up the new price in minutes, but
`my_price_cache` can stay stale for hours.

```ts
if (repricerAction && inv && Math.abs(repricerAction.price - inv.price) < 0.05
    && Math.abs(myp.price - inv.price) > 0.05) {
  // Repricer + Listings agree, GetMyPrice is stale — override.
  consider(asin, inv.price, 'seller_derived:repricer+inventory', inv.ts);
}
```

### D. Late correction: hourly repair sweep for still-pending orders

`repair-pending-listings-price` already exists. Add a light hourly cron that,
for any order still `status='pending'` older than 30 min:
1. Fetch live Listings-API price (single call, cheap).
2. If it differs from `estimated_price` by >5%, rewrite `estimated_price`
   with `price_source='seller_derived:listings_api_repair'`.
3. Cap at 200 orders per run to stay inside SP-API rate limits.

This closes the last window where a truly stale cache slips through — the
$25.30 case would self-correct within an hour.

## 4. What we won't do

- Never promote `bb_estimate_price` into `estimated_price` while pending — BB
  may be another seller (memory:
  `features/sales/seller-derived-pending-price-fallback-v1`).
- Never write `estimated_price` into `sold_price`. `sold_price` only accepts
  real Orders-API `ItemPrice` or FEC settlement (memory core rule).
- No hardcoded FX (memory: `infrastructure/edge-functions/no-hardcoded-fx-v1`).

## 5. Verification plan

1. Re-run pending enrichment for `113-8883103-0582614` — with changes A+B it
   should stamp `estimated_price=25.30`, `price_source=seller_derived:...`.
2. Backfill sweep across last 7 days of pending orders — count rows whose
   `estimated_price × qty` is >5% off `inventory.price × qty`. Report before/after.
3. Add a Deno test to `sync-sales-orders`: given stale `my_price_cache=$36`,
   fresh `inventory.price=$25.30`, repricer action `$25.30` — assert chosen
   estimate is $25.30 with `seller_derived:*` source.

---
Files touched by the fix (proposed):
- `supabase/functions/sync-sales-orders/index.ts` — lines 5563–5623, 1370–1470.
- `supabase/functions/repair-pending-listings-price/index.ts` — new hourly path.
- Cron: `repair-pending-listings-price-hourly`.
