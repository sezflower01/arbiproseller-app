// Strict mode: decide whether a detected listing deserves one of the day's
// scarce auto-source searches.
//
// This is NOT qualification. evaluateQualification() answers "is this the kind
// of product we ever source" (category, brand, rank ceiling, eligibility) and
// runs on every detection. Strict mode answers the narrower commercial
// question -- "is this worth spending one of 80 daily CSE/Gemini searches on"
// -- and is applied at the pre-search step, where the budget is actually spent.
// Keeping them separate matters: a listing that fails strict mode is still a
// real, correctly-qualified detection and stays visible in the UI. It just does
// not consume search budget.
//
// EVERY threshold below was verified against live Keepa data on 2026-08-19
// before being written, not inferred:
//
//   stats.current[11] (COUNT_NEW) IS populated by stats=1 alone, tokensConsumed
//   1, confirmed on 3 ASINs. But it counts FBA AND FBM together -- B00JSWP62I
//   reported COUNT_NEW 2 with ZERO FBA offers, and B0D8H77XRY reported 1 with
//   zero FBA. So the free number cannot answer an FBA-only question, and the
//   offer counts here come from offers=20 (measured 5-6 tokens) instead.
//
//   A watched seller's own offer IS findable inside that offers array by exact
//   sellerId match -- 2/2 on real watches (Colorado Knife and Tool matched with
//   isFBA true; Cookiepretty1971 matched with isFBA false). Rule (b) rests on
//   that match, so it was proven before being built on.

/** Keepa offer, narrowed to the fields strict mode reads. */
export interface KeepaOfferLike {
  sellerId?: string | null;
  isFBA?: boolean | null;
  condition?: number | null;
}

export interface StrictModeThresholds {
  /** Minimum FBA New offers on the ASIN, the watched seller included. */
  minFbaOffers: number;
  /** Minimum estimated monthly sales, derived from the broad sales rank. */
  minMonthlySales: number;
  /** Reject listings with no sales rank at all. */
  requireRank: boolean;
  /** Reject when the watched seller's own new offer is FBM. */
  requireSellerFba: boolean;
  /**
   * Minimum Amazon sell price, in CENTS. Below this the arithmetic cannot
   * work regardless of where the product is sourced.
   */
  minPriceCents: number;
}

/**
 * Defaults chosen with the user 2026-08-19, and two of them deliberately differ
 * from the obvious value:
 *
 * minMonthlySales is 50, NOT 10. The existing MAX_SALES_RANK of 500,000 already
 * implies ~38/month on the curve below, so a 10/month rule would have filtered
 * nothing at all -- it was inert by construction. 50/month corresponds to rank
 * ~317,000, which genuinely bites the 317k-500k band.
 *
 * requireRank exists because the qualification rank ceiling is applied ONLY when
 * a rank is present, and 60% of detections carry no broad rank -- so six in ten
 * listings skip that check entirely today. Requiring a rank is the single
 * highest-impact rule here, and it costs nothing.
 */
export const STRICT_DEFAULTS: StrictModeThresholds = {
  minFbaOffers: 4,
  minMonthlySales: 50,
  requireRank: true,
  requireSellerFba: true,
  // $12.00. Not a taste threshold -- an arithmetic one. Total FBA fees measured
  // $6.63 on a real captured row, so a $10 item leaves under $3.40 to cover
  // BOTH the source cost and any profit. Items below this were never sourceable
  // at any cost, so searching for a supplier cannot pay off.
  minPriceCents: 1200,
};

/**
 * BSR -> estimated monthly sales.
 *
 * Same curve as mobile-scan-price-stability's bsrToMonthlySales, duplicated
 * here ON PURPOSE rather than imported: that function lives inside an edge
 * function's request handler module, and importing it would drag a Keepa
 * client and its env requirements into every caller of strict mode. If the
 * curve is ever recalibrated, both copies must move together -- the constant
 * is named so a grep for MONTHLY_SALES_EXPONENT finds them.
 *
 * Calibrated against Amazon's public "bought in past month" indicator:
 * rank 1k ~ 1.6k/mo, 10k ~ 400/mo, 35k ~ 190/mo, 100k ~ 100/mo, 317k ~ 50/mo,
 * 500k ~ 38/mo.
 */
export const MONTHLY_SALES_COEFFICIENT = 100_000;
export const MONTHLY_SALES_EXPONENT = -0.6;

export function estimateMonthlySales(salesRank: number | null | undefined): number | null {
  if (typeof salesRank !== 'number' || !Number.isFinite(salesRank) || salesRank <= 0) return null;
  return Math.max(1, Math.round(MONTHLY_SALES_COEFFICIENT * Math.pow(salesRank, MONTHLY_SALES_EXPONENT)));
}

/** Inverse of the curve: the worst rank still meeting a monthly-sales floor. */
export function maxRankForMonthlySales(monthlySales: number): number {
  if (!Number.isFinite(monthlySales) || monthlySales <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(Math.pow(monthlySales / MONTHLY_SALES_COEFFICIENT, 1 / MONTHLY_SALES_EXPONENT));
}

/**
 * Count live New offers by fulfilment channel, and locate the watched seller's
 * own offer.
 *
 * Keepa's `offers` array carries historical offers too; `liveOffersOrder` is
 * the index list of the ones currently live, and only those describe the
 * marketplace as it stands. Verified 2026-08-19: B0GYVHLP4L returned 116
 * offers with liveOffersOrder of 61. Counting the raw array would have
 * overstated competition by ~90%.
 */
export function summarizeOffers(
  offers: readonly KeepaOfferLike[] | null | undefined,
  liveOffersOrder: readonly number[] | null | undefined,
  watchedSellerId: string | null | undefined,
): {
  fbaCount: number;
  fbmCount: number;
  sellerOfferFound: boolean;
  sellerOfferIsFba: boolean | null;
} {
  const all = Array.isArray(offers) ? offers : [];
  const order = Array.isArray(liveOffersOrder) ? liveOffersOrder : [];
  const live = order.length
    ? order.map((i) => all[i]).filter((o): o is KeepaOfferLike => !!o)
    : all;

  // condition 1 is New. Keepa also uses 0 for "unknown/new-ish" on some rows;
  // anything else (used/collectible/refurbished) is not a competing New offer.
  const isNew = (o: KeepaOfferLike) => o.condition === 1 || o.condition === 0 || o.condition == null;
  const newOffers = live.filter(isNew);

  const fbaCount = newOffers.filter((o) => o.isFBA === true).length;
  const mine = watchedSellerId
    ? newOffers.find((o) => String(o.sellerId ?? '') === String(watchedSellerId))
    : undefined;

  return {
    fbaCount,
    fbmCount: newOffers.length - fbaCount,
    sellerOfferFound: !!mine,
    sellerOfferIsFba: mine ? mine.isFBA === true : null,
  };
}

export interface StrictModeInput {
  salesRank?: number | null;
  fbaOfferCount?: number | null;
  /**
   * Whether the watched seller's own offer is FBA. null means the offer could
   * not be located in the Keepa snapshot -- treated as UNKNOWN, not as FBM,
   * because a seller can legitimately vanish from the live offer list between
   * detection and the offers call (out of stock, suppressed, or simply a
   * scrape-timing gap). Failing those closed would silently reject real FBA
   * listings, so unknown passes this rule and is recorded for auditing.
   */
  sellerOfferIsFba?: boolean | null;
  /**
   * Amazon sell price in CENTS -- seller_watch_new_listings.new_price_cents
   * (lowest New), falling back to amazon_price_cents. Captured during
   * detection by the Keepa call that already runs, so this rule costs no API
   * call. null means price capture did not happen, which is UNKNOWN and passes.
   */
  priceCents?: number | null;
}

export interface StrictModeResult {
  pass: boolean;
  /** Machine-readable, null when passing. Stored so rejections are auditable. */
  reason: string | null;
}

export function evaluateStrictMode(
  input: StrictModeInput,
  thresholds: StrictModeThresholds = STRICT_DEFAULTS,
): StrictModeResult {
  // Rule (b): the watched seller's own new listing must be FBA.
  // Explicit false only -- null is unknown and does not reject (see above).
  if (thresholds.requireSellerFba && input.sellerOfferIsFba === false) {
    return { pass: false, reason: 'seller_offer_is_fbm' };
  }

  // Rule 3: a rank must exist. Checked before the sales floor because "no rank"
  // and "rank too weak" are different diagnoses and the reason string should say
  // which. This is the rule that catches the 60% qualification never sees.
  const rank = typeof input.salesRank === 'number' && input.salesRank > 0 ? input.salesRank : null;
  if (thresholds.requireRank && rank == null) {
    return { pass: false, reason: 'no_sales_rank' };
  }

  // Rule (a): enough FBA competition to be a real product.
  // null means offers were never captured; that is unknown, not zero, and is
  // left to pass so a Keepa outage cannot silently empty the search queue.
  const fba = typeof input.fbaOfferCount === 'number' ? input.fbaOfferCount : null;
  if (fba != null && fba < thresholds.minFbaOffers) {
    return { pass: false, reason: `fba_offers_${fba}_below_${thresholds.minFbaOffers}` };
  }

  // Rule 5: price floor. Checked before the sales floor because "too cheap to
  // ever work" is a harder fact than an estimate derived from a rank curve --
  // when both would reject, the price is the more useful reason to report.
  const price = typeof input.priceCents === 'number' && input.priceCents > 0 ? input.priceCents : null;
  if (price != null && price < thresholds.minPriceCents) {
    return {
      pass: false,
      reason: `price_${price}_below_${thresholds.minPriceCents}`,
    };
  }

  // Rule 4: estimated monthly sales floor, derived from the rank above.
  if (rank != null) {
    const est = estimateMonthlySales(rank);
    if (est != null && est < thresholds.minMonthlySales) {
      return { pass: false, reason: `est_sales_${est}_below_${thresholds.minMonthlySales}` };
    }
  }

  return { pass: true, reason: null };
}
