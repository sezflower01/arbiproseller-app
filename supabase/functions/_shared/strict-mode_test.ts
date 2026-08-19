import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  evaluateStrictMode,
  estimateMonthlySales,
  maxRankForMonthlySales,
  summarizeOffers,
  STRICT_DEFAULTS,
} from './strict-mode.ts';

// ── The curve, pinned to the calibration points in the source comment ──

Deno.test('estimateMonthlySales matches the documented calibration points', () => {
  assertEquals(estimateMonthlySales(1_000), 1585);
  assertEquals(estimateMonthlySales(100_000), 100);
  assertEquals(estimateMonthlySales(500_000), 38);
});

Deno.test('estimateMonthlySales rejects non-ranks rather than inventing a number', () => {
  assertEquals(estimateMonthlySales(null), null);
  assertEquals(estimateMonthlySales(0), null);
  assertEquals(estimateMonthlySales(-5), null);
  assertEquals(estimateMonthlySales(Number.NaN), null);
});

Deno.test('50/month lands near rank 317k -- the reason the default is 50, not 10', () => {
  const r = maxRankForMonthlySales(50);
  // Guard the order of magnitude, not the exact float.
  assertEquals(r > 300_000 && r < 330_000, true);
  // And prove the old suggestion would have been inert: 10/month sits far
  // beyond the existing MAX_SALES_RANK of 500,000, so nothing could fail it.
  assertEquals(maxRankForMonthlySales(10) > 500_000, true);
});

// ── Rule (b): the watched seller's own offer ──

Deno.test('rejects when the seller own offer is FBM', () => {
  const r = evaluateStrictMode({ salesRank: 1000, fbaOfferCount: 10, sellerOfferIsFba: false });
  assertEquals(r.pass, false);
  assertEquals(r.reason, 'seller_offer_is_fbm');
});

Deno.test('accepts when the seller own offer is FBA', () => {
  assertEquals(
    evaluateStrictMode({ salesRank: 1000, fbaOfferCount: 10, sellerOfferIsFba: true }).pass,
    true,
  );
});

Deno.test('UNKNOWN seller fulfilment passes -- a missing offer is not an FBM offer', () => {
  const r = evaluateStrictMode({ salesRank: 1000, fbaOfferCount: 10, sellerOfferIsFba: null });
  assertEquals(r.pass, true);
  assertEquals(r.reason, null);
});

// ── Rule 3: rank must exist. The 60% gap. ──

Deno.test('rejects a listing with no sales rank', () => {
  const r = evaluateStrictMode({ salesRank: null, fbaOfferCount: 10, sellerOfferIsFba: true });
  assertEquals(r.pass, false);
  assertEquals(r.reason, 'no_sales_rank');
});

Deno.test('no_sales_rank is reported ahead of the sales floor, so the reason is unambiguous', () => {
  // Both would fail; the diagnosis must be the missing rank, not a derived number.
  assertEquals(
    evaluateStrictMode({ salesRank: null, fbaOfferCount: 10 }).reason,
    'no_sales_rank',
  );
});

// ── Rule (a): FBA offer count ──

Deno.test('rejects below the FBA offer floor', () => {
  const r = evaluateStrictMode({ salesRank: 1000, fbaOfferCount: 3, sellerOfferIsFba: true });
  assertEquals(r.pass, false);
  assertEquals(r.reason, 'fba_offers_3_below_4');
});

Deno.test('accepts exactly at the FBA offer floor', () => {
  assertEquals(
    evaluateStrictMode({ salesRank: 1000, fbaOfferCount: 4, sellerOfferIsFba: true }).pass,
    true,
  );
});

Deno.test('zero FBA offers is a rejection, not an unknown', () => {
  assertEquals(
    evaluateStrictMode({ salesRank: 1000, fbaOfferCount: 0, sellerOfferIsFba: true }).reason,
    'fba_offers_0_below_4',
  );
});

Deno.test('uncaptured offers pass -- a Keepa outage must not empty the search queue', () => {
  assertEquals(
    evaluateStrictMode({ salesRank: 1000, fbaOfferCount: null, sellerOfferIsFba: true }).pass,
    true,
  );
});

// ── Rule 4: derived sales floor ──

Deno.test('rejects a rank implying fewer than 50 sales a month', () => {
  // 400k -> ~43/month, inside the old 500k ceiling but below the new floor.
  const r = evaluateStrictMode({ salesRank: 400_000, fbaOfferCount: 10, sellerOfferIsFba: true });
  assertEquals(r.pass, false);
  assertEquals(r.reason?.startsWith('est_sales_'), true);
});

Deno.test('the 317k-500k band is exactly what the 50/month floor adds', () => {
  // Passes qualification's 500k ceiling today, fails strict mode now.
  assertEquals(evaluateStrictMode({ salesRank: 450_000, fbaOfferCount: 10 }).pass, false);
  // Comfortably inside the floor.
  assertEquals(evaluateStrictMode({ salesRank: 250_000, fbaOfferCount: 10 }).pass, true);
});

// ── Thresholds are configurable, not hardcoded at the call site ──

Deno.test('thresholds can be overridden per user', () => {
  const lenient = { ...STRICT_DEFAULTS, minFbaOffers: 1, minMonthlySales: 5 };
  assertEquals(
    evaluateStrictMode({ salesRank: 450_000, fbaOfferCount: 1, sellerOfferIsFba: true }, lenient).pass,
    true,
  );
});

Deno.test('requireSellerFba off lets an FBM listing through', () => {
  const off = { ...STRICT_DEFAULTS, requireSellerFba: false };
  assertEquals(
    evaluateStrictMode({ salesRank: 1000, fbaOfferCount: 10, sellerOfferIsFba: false }, off).pass,
    true,
  );
});

// ── summarizeOffers, against the real shapes measured 2026-08-19 ──

Deno.test('counts only LIVE offers, not the historical array', () => {
  // B0GYVHLP4L returned 116 offers with liveOffersOrder of 61. Counting the
  // raw array would overstate competition by ~90%.
  const offers = Array.from({ length: 116 }, (_, i) => ({
    sellerId: `S${i}`, isFBA: i % 2 === 0, condition: 1,
  }));
  const live = Array.from({ length: 61 }, (_, i) => i);
  const s = summarizeOffers(offers, live, null);
  assertEquals(s.fbaCount + s.fbmCount, 61);
});

Deno.test('locates the watched seller own offer by exact sellerId', () => {
  // Shape taken from the live probe: Colorado Knife and Tool on B078ZLHXWX.
  const offers = [
    { sellerId: 'A1004UH4648KKM', isFBA: true, condition: 1 },
    { sellerId: 'A1475CCQ884959', isFBA: false, condition: 1 },
    { sellerId: 'A2JQF8IKG83XTC', isFBA: false, condition: 1 },
  ];
  const s = summarizeOffers(offers, [0, 1, 2], 'A1004UH4648KKM');
  assertEquals(s.sellerOfferFound, true);
  assertEquals(s.sellerOfferIsFba, true);
  assertEquals(s.fbaCount, 1);
  assertEquals(s.fbmCount, 2);
});

Deno.test('an FBM watched seller is reported as such', () => {
  // Cookiepretty1971 on B084ZBRSKR: own offer present, isFBA false.
  const offers = [
    { sellerId: 'A107R8AYIVW2F4', isFBA: false, condition: 1 },
    { sellerId: 'A1N7FKJ87LS16Z', isFBA: false, condition: 1 },
  ];
  const s = summarizeOffers(offers, [0, 1], 'A107R8AYIVW2F4');
  assertEquals(s.sellerOfferIsFba, false);
  assertEquals(s.fbaCount, 0);
});

Deno.test('a seller absent from the live list is unknown, not FBM', () => {
  const offers = [{ sellerId: 'SOMEONE_ELSE', isFBA: true, condition: 1 }];
  const s = summarizeOffers(offers, [0], 'A1004UH4648KKM');
  assertEquals(s.sellerOfferFound, false);
  assertEquals(s.sellerOfferIsFba, null);
  // ...and that unknown must not reject.
  assertEquals(evaluateStrictMode({ salesRank: 1000, fbaOfferCount: 10, sellerOfferIsFba: null }).pass, true);
});

Deno.test('used and collectible offers are not counted as New competition', () => {
  const offers = [
    { sellerId: 'A', isFBA: true, condition: 1 },   // New
    { sellerId: 'B', isFBA: true, condition: 2 },   // Used-like
    { sellerId: 'C', isFBA: true, condition: 11 },  // Collectible-like
  ];
  const s = summarizeOffers(offers, [0, 1, 2], null);
  assertEquals(s.fbaCount, 1);
  assertEquals(s.fbmCount, 0);
});

Deno.test('empty or missing offer data yields zeroes and an unknown seller', () => {
  const s = summarizeOffers(null, null, 'A1004UH4648KKM');
  assertEquals(s.fbaCount, 0);
  assertEquals(s.sellerOfferFound, false);
  assertEquals(s.sellerOfferIsFba, null);
});
