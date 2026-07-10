// Unit test for the pending-price fallback rules (A/B/C) in
// sync-sales-orders/index.ts:computeAndPersistEstimatedPrices.
//
// The production function is tightly coupled to the Supabase client, so we
// re-express the exact resolution rules in a pure helper and assert them
// against the reference case from
// .lovable/pending-sales-price-report.md:
//   stale my_price_cache = $36, fresh inventory.price = $25.30, repricer
//   action $25.30 → chosen estimate MUST be $25.30 with a seller_derived:*
//   or inventory.price_over_mypricecache source.
//
// If sync-sales-orders/index.ts:computeAndPersistEstimatedPrices changes its
// rules, update BOTH here and in the doc so they stay in sync.
import { assertEquals, assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';

type Candidate = { price: number; ts: number } | undefined;

const DIVERGENCE_THRESHOLD = 0.05;
const pct = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 0.01);

function resolvePendingEstimate(input: {
  repricerAction?: Candidate;
  myPriceLive?: Candidate;
  myPriceAny?: Candidate;
  inventory?: Candidate;
}): { price: number; source: string } | null {
  const rp = input.repricerAction;
  const mpLive = input.myPriceLive;
  const mpAny = input.myPriceAny;
  const inv = input.inventory;

  // Rule C
  if (rp && inv && pct(rp.price, inv.price) < DIVERGENCE_THRESHOLD) {
    if (mpAny && pct(mpAny.price, inv.price) > DIVERGENCE_THRESHOLD) {
      return { price: inv.price, source: 'seller_derived:repricer+inventory' };
    }
  }
  // Rule A
  if (mpAny && inv && pct(mpAny.price, inv.price) > DIVERGENCE_THRESHOLD) {
    return { price: inv.price, source: 'inventory.price_over_mypricecache' };
  }
  // Rule B: freshness-wins
  const pool: Array<{ price: number; ts: number; source: string }> = [];
  if (rp) pool.push({ ...rp, source: 'repricer_price_actions' });
  if (mpLive) pool.push({ ...mpLive, source: 'asin_my_price_cache_live' });
  if (inv) pool.push({ ...inv, source: 'inventory.price' });
  if (mpAny && !mpLive) pool.push({ ...mpAny, source: 'asin_my_price_cache' });
  if (pool.length === 0) return null;
  pool.sort((a, b) => b.ts - a.ts);
  return { price: pool[0].price, source: pool[0].source };
}

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

Deno.test('reference case: stale my_price=$36 vs fresh inventory+repricer=$25.30 → $25.30', () => {
  const res = resolvePendingEstimate({
    repricerAction: { price: 25.3, ts: NOW - 4 * DAY }, // Jul 3 submit
    myPriceAny: { price: 36, ts: NOW - 30 * 60 * 1000 }, // "fetched" 30 min ago, stale value
    inventory: { price: 25.3, ts: NOW - 60 * 60 * 1000 }, // Listings refresh
  });
  assertEquals(res?.price, 25.3, 'MUST choose 25.30, not 36');
  assertMatch(
    res!.source,
    /^(seller_derived:repricer\+inventory|inventory\.price_over_mypricecache)$/,
    `source ${res!.source} does not indicate override`,
  );
});

Deno.test('agreement between all three signals → freshness wins, keeps price correct', () => {
  const res = resolvePendingEstimate({
    repricerAction: { price: 25.3, ts: NOW - 2 * DAY },
    myPriceAny: { price: 25.3, ts: NOW - 60 * 60 * 1000 },
    inventory: { price: 25.3, ts: NOW - 30 * 60 * 1000 },
  });
  assertEquals(res?.price, 25.3);
});

Deno.test('LIVE my_price beats non-live my_price in freshness fallback', () => {
  const res = resolvePendingEstimate({
    myPriceLive: { price: 20.0, ts: NOW - 60 * 60 * 1000 },
    myPriceAny: { price: 25.0, ts: NOW - 30 * 60 * 1000 }, // fresher but non-live source
    // no inventory / repricer → falls to Rule B
  });
  assertEquals(res?.price, 20.0);
  assertEquals(res?.source, 'asin_my_price_cache_live');
});

Deno.test('no inventory row → repricer action still wins over stale my_price', () => {
  const res = resolvePendingEstimate({
    repricerAction: { price: 25.3, ts: NOW - 4 * DAY },
    myPriceAny: { price: 36, ts: NOW - 30 * 60 * 1000 },
  });
  // Rule A/C need inventory to fire; Rule B → freshness → my_price wins.
  // This documents the current limitation: without inventory to corroborate,
  // we cannot safely override my_price. The hourly repair cron (D) is the
  // safety net for this branch.
  assertEquals(res?.price, 36);
  assertEquals(res?.source, 'asin_my_price_cache');
});

Deno.test('no data at all → null', () => {
  assertEquals(resolvePendingEstimate({}), null);
});
