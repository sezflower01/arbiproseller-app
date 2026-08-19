import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  isFbaOffer,
  selectLiveNewOffers,
  summarizeOffers,
  keepaNowMinutes,
  LIVE_WINDOW_MIN,
  type KeepaOfferLike,
} from './keepa-offers.ts';

const NOW = keepaNowMinutes();
const fresh = (o: Partial<KeepaOfferLike>): KeepaOfferLike =>
  ({ lastSeen: NOW, condition: 1, ...o });

// ── The single FBA definition ──

Deno.test('FBA requires BOTH isFBA and isPrime', () => {
  assertEquals(isFbaOffer({ isFBA: true, isPrime: true }), true);
  assertEquals(isFbaOffer({ isFBA: true, isPrime: false }), false);
  assertEquals(isFbaOffer({ isFBA: false, isPrime: true }), false);
  assertEquals(isFbaOffer({ isFBA: false, isPrime: false }), false);
});

Deno.test('missing flags are not FBA -- absence is never evidence of fulfilment', () => {
  assertEquals(isFbaOffer({}), false);
  assertEquals(isFbaOffer({ isFBA: null, isPrime: null }), false);
});

Deno.test('the measured reality: isFBA and isPrime move together, so both rules agree', () => {
  // 46 live offers across 3 ASINs on 2026-08-19 were all true/true or
  // false/false. This pins that the strict rule matches the loose one on that
  // shape -- if it ever stops, this test is where the surprise surfaces.
  const realistic = [
    fresh({ isFBA: true, isPrime: true }),
    fresh({ isFBA: false, isPrime: false }),
    fresh({ isFBA: true, isPrime: true }),
  ];
  const strict = realistic.filter(isFbaOffer).length;
  const loose = realistic.filter((o) => o.isFBA === true).length;
  assertEquals(strict, loose);
  assertEquals(strict, 2);
});

// ── Live selection: the filter that does the most work ──

Deno.test('walks liveOffersOrder rather than the raw array', () => {
  // B0GYVHLP4L: 116 offers in the payload, 41 live. Counting raw overstates
  // competition by ~180%.
  const offers = Array.from({ length: 116 }, (_, i) => fresh({ sellerId: `S${i}` }));
  const order = Array.from({ length: 41 }, (_, i) => i);
  assertEquals(selectLiveNewOffers(offers, order, NOW).length, 41);
});

Deno.test('falls back to the raw array when liveOffersOrder is absent', () => {
  const offers = [fresh({ sellerId: 'A' }), fresh({ sellerId: 'B' })];
  assertEquals(selectLiveNewOffers(offers, null, NOW).length, 2);
});

Deno.test('drops offers older than the live window', () => {
  const offers = [
    fresh({ sellerId: 'recent' }),
    { sellerId: 'stale', condition: 1, lastSeen: NOW - LIVE_WINDOW_MIN - 1 },
  ];
  const live = selectLiveNewOffers(offers, [0, 1], NOW);
  assertEquals(live.length, 1);
  assertEquals(live[0].sellerId, 'recent');
});

Deno.test('an offer with no lastSeen is kept -- unknown age is not stale', () => {
  const offers = [{ sellerId: 'A', condition: 1 }];
  assertEquals(selectLiveNewOffers(offers, [0], NOW).length, 1);
});

Deno.test('used and collectible are not competing New supply', () => {
  const offers = [
    fresh({ sellerId: 'new', condition: 1 }),
    fresh({ sellerId: 'used', condition: 2 }),
    fresh({ sellerId: 'collectible', condition: 11 }),
  ];
  assertEquals(selectLiveNewOffers(offers, [0, 1, 2], NOW).length, 1);
});

// ── summarizeOffers ──

Deno.test('counts FBA and FBM over the live set only', () => {
  // Shape from B078ZLHXWX: 1 FBA, 2 FBM.
  const offers = [
    fresh({ sellerId: 'A1004UH4648KKM', isFBA: true, isPrime: true }),
    fresh({ sellerId: 'A1475CCQ884959', isFBA: false, isPrime: false }),
    fresh({ sellerId: 'A2JQF8IKG83XTC', isFBA: false, isPrime: false }),
  ];
  const s = summarizeOffers(offers, [0, 1, 2], null, NOW);
  assertEquals(s.fbaCount, 1);
  assertEquals(s.fbmCount, 2);
});

Deno.test('zero FBA is a real answer, not a missing one', () => {
  // B0FV4WB7VQ genuinely had no FBA sellers at all.
  const offers = [
    fresh({ sellerId: 'A2Q31ZHSRJJP6C', isFBA: false, isPrime: false }),
    fresh({ sellerId: 'A36Y9C4PU0TCER', isFBA: false, isPrime: false }),
  ];
  const s = summarizeOffers(offers, [0, 1], null, NOW);
  assertEquals(s.fbaCount, 0);
  assertEquals(s.fbmCount, 2);
});

Deno.test('locates the watched seller and reports their fulfilment', () => {
  const offers = [
    fresh({ sellerId: 'A1004UH4648KKM', isFBA: true, isPrime: true }),
    fresh({ sellerId: 'OTHER', isFBA: false, isPrime: false }),
  ];
  const s = summarizeOffers(offers, [0, 1], 'A1004UH4648KKM', NOW);
  assertEquals(s.sellerOfferFound, true);
  assertEquals(s.sellerOfferIsFba, true);
});

Deno.test('an FBM watched seller reads false, not null', () => {
  const offers = [fresh({ sellerId: 'A107R8AYIVW2F4', isFBA: false, isPrime: false })];
  const s = summarizeOffers(offers, [0], 'A107R8AYIVW2F4', NOW);
  assertEquals(s.sellerOfferIsFba, false);
});

Deno.test('a seller absent from the live set is UNKNOWN, never FBM', () => {
  const offers = [fresh({ sellerId: 'SOMEONE_ELSE', isFBA: true, isPrime: true })];
  const s = summarizeOffers(offers, [0], 'A1004UH4648KKM', NOW);
  assertEquals(s.sellerOfferFound, false);
  assertEquals(s.sellerOfferIsFba, null);
});

Deno.test('empty or missing offer data yields zeroes and an unknown seller', () => {
  const s = summarizeOffers(null, null, 'A1004UH4648KKM', NOW);
  assertEquals(s.fbaCount, 0);
  assertEquals(s.fbmCount, 0);
  assertEquals(s.sellerOfferFound, false);
  assertEquals(s.sellerOfferIsFba, null);
});
