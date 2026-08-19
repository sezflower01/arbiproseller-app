// Canonical reading of Keepa's offer array.
//
// WHY THIS EXISTS. Two code paths classified the same offers differently, and
// the disagreement was invisible because it does not currently fire:
//
//   analyzer-product-snapshot   isFBA && isPrime, plus a 7-day lastSeen window
//   strict-mode summarizeOffers isFBA alone, no recency window
//
// Same ASIN, two surfaces, two answers -- and nothing would have flagged a
// drift. Measured 2026-08-19 across 46 live offers on three ASINs: isFBA and
// isPrime moved TOGETHER on every single offer (true/true or false/false,
// never split), so both rules agree today. That is exactly what makes it
// dangerous: it is correct by coincidence, not by construction.
//
// The stricter rule is adopted as canonical. It is what the user-facing
// analyzer already shows, so nothing visibly changes, and if Keepa ever does
// over-flag isFBA the strict reading fails safe. The analyzer's comment
// claiming "Keepa over-flags FBA" has no support in this sample -- someone hit
// a real problem once and added a guard -- but a guard that costs nothing and
// might be load-bearing is worth keeping.

export interface KeepaOfferLike {
  sellerId?: string | null;
  isFBA?: boolean | null;
  isPrime?: boolean | null;
  condition?: number | null;
  /** Keepa minutes since 2011-01-01. */
  lastSeen?: number | null;
}

export const KEEPA_EPOCH_MS = Date.UTC(2011, 0, 1);

/**
 * How stale an offer may be and still count as live.
 *
 * Keepa's `offers` array is every offer EVER seen on the listing, not the
 * current ones. Measured 2026-08-19: B0GYVHLP4L returned 116 offers of which
 * 41 were live; B078ZLHXWX returned 74 of which 3 were live. Counting the raw
 * array overstates competition by 65-96%, which would make every FBA count and
 * every "is this contested" judgement wrong in the same direction.
 */
export const LIVE_WINDOW_MIN = 7 * 24 * 60;

export function keepaNowMinutes(): number {
  return Math.floor((Date.now() - KEEPA_EPOCH_MS) / 60000);
}

/**
 * Offers that are live, New, and recently seen.
 *
 * `liveOffersOrder` is Keepa's own index of what is currently on the listing
 * and is the primary filter; the recency window is a second guard for stale
 * entries that linger in it.
 */
export function selectLiveNewOffers(
  offers: readonly KeepaOfferLike[] | null | undefined,
  liveOffersOrder: readonly number[] | null | undefined,
  nowMin: number = keepaNowMinutes(),
): KeepaOfferLike[] {
  const all = Array.isArray(offers) ? offers : [];
  const order = Array.isArray(liveOffersOrder) ? liveOffersOrder : [];
  const live = order.length
    ? order.map((i) => all[i]).filter((o): o is KeepaOfferLike => !!o)
    : all;

  return live.filter((o) => {
    // condition 1 is New. Keepa also uses 0 for unknown on some rows; anything
    // else (used, collectible, refurbished) is not competing New supply.
    const isNew = o.condition === 1 || o.condition === 0 || o.condition == null;
    if (!isNew) return false;
    const ls = Number(o.lastSeen ?? 0);
    return !ls || nowMin - ls <= LIVE_WINDOW_MIN;
  });
}

/** THE single definition of an FBA offer. Do not inline this test elsewhere. */
export function isFbaOffer(o: KeepaOfferLike): boolean {
  return o.isFBA === true && o.isPrime === true;
}

export interface OfferSummary {
  fbaCount: number;
  fbmCount: number;
  /** Whether a specific seller's own offer was found in the live set. */
  sellerOfferFound: boolean;
  /** null = not found. Unknown, NOT "FBM" -- callers must not conflate them. */
  sellerOfferIsFba: boolean | null;
}

export function summarizeOffers(
  offers: readonly KeepaOfferLike[] | null | undefined,
  liveOffersOrder: readonly number[] | null | undefined,
  watchedSellerId?: string | null,
  nowMin: number = keepaNowMinutes(),
): OfferSummary {
  const live = selectLiveNewOffers(offers, liveOffersOrder, nowMin);
  const fbaCount = live.filter(isFbaOffer).length;
  const mine = watchedSellerId
    ? live.find((o) => String(o.sellerId ?? '') === String(watchedSellerId))
    : undefined;

  return {
    fbaCount,
    fbmCount: live.length - fbaCount,
    sellerOfferFound: !!mine,
    // A seller absent from the live snapshot is UNKNOWN. They can legitimately
    // drop out between detection and this call (out of stock, suppressed, or a
    // scrape-timing gap), and reading that as FBM would reject real FBA sellers.
    sellerOfferIsFba: mine ? isFbaOffer(mine) : null,
  };
}
