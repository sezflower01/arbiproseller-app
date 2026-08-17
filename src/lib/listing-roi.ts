import type { NewListing, SourceCandidate } from "@/hooks/use-seller-new-listings";

/**
 * ROI for a detected listing, from the three inputs captured overnight plus the
 * source price found by Find Source.
 *
 *   ROI = (Amazon price − source price − fees) / source price
 *
 * Mirrors _shared/roi-math.ts. The strictness is the same and is the point:
 * fees are REQUIRED, there is no 15%/$3.22 fallback, because an ROI computed
 * from guessed fees is indistinguishable from one computed from real fees.
 */

/** Why an ROI could not be produced — shown to the user, never swallowed. */
export type RoiBlocker = "no_amazon_price" | "no_source_price" | "no_fees" | "low_confidence";

export interface ListingRoi {
  ok: boolean;
  blocker: RoiBlocker | null;
  /** Percent return on money spent. Null unless ok. */
  roi: number | null;
  profit: number | null;
  amazonPrice: number | null;
  sourcePrice: number | null;
  totalFees: number | null;
  /** The candidate the numbers came from, so a wrong match is visible. */
  candidate: SourceCandidate | null;
  /** That candidate's match confidence. Always surfaced beside the ROI. */
  confidence: number | null;
}

const BLOCKER_TEXT: Record<RoiBlocker, string> = {
  no_amazon_price: "No Amazon price yet",
  no_source_price: "No source price",
  no_fees: "No fee data",
  low_confidence: "Match confidence too low",
};

export function blockerLabel(b: RoiBlocker | null): string {
  return b ? BLOCKER_TEXT[b] : "ROI unavailable";
}

/**
 * Pick the candidate the ROI is based on: highest confidence that HAS a price.
 *
 * Deliberately not gated on the user's "Mark as source" click — that path has
 * zero real usage (saved_sources is empty), so gating on it would make the
 * filter permanently empty. The trade is that an unverified match can drive a
 * number, which is exactly why confidence travels with every ROI.
 */
export function pickPricedCandidate(listing: NewListing): SourceCandidate | null {
  const priced = (listing.candidates || []).filter(
    (c) => typeof c.price === "number" && (c.price as number) > 0,
  );
  if (!priced.length) return null;
  return priced.reduce((best, c) => (c.confidence > best.confidence ? c : best), priced[0]);
}

export function computeListingRoi(listing: NewListing, minConfidence: number): ListingRoi {
  const empty = (blocker: RoiBlocker, candidate: SourceCandidate | null = null): ListingRoi => ({
    ok: false, blocker, roi: null, profit: null,
    amazonPrice: null, sourcePrice: null, totalFees: null,
    candidate, confidence: candidate ? candidate.confidence : null,
  });

  // Prefer the lowest New offer; fall back to Amazon's own. Cents in the DB.
  const sellCents = listing.new_price_cents ?? listing.amazon_price_cents ?? null;
  if (!sellCents || sellCents <= 0) return empty("no_amazon_price");

  const candidate = pickPricedCandidate(listing);
  if (!candidate) return empty("no_source_price");
  if (candidate.confidence < minConfidence) return empty("low_confidence", candidate);

  const feesCents = listing.total_fees_cents ?? null;
  if (!feesCents || feesCents <= 0) return empty("no_fees", candidate);

  const amazonPrice = sellCents / 100;
  const sourcePrice = candidate.price as number;
  const totalFees = feesCents / 100;
  const profit = amazonPrice - sourcePrice - totalFees;

  return {
    ok: true,
    blocker: null,
    // Guarded, though pickPricedCandidate already excludes non-positive prices.
    roi: sourcePrice > 0 ? Math.round((profit / sourcePrice) * 1000) / 10 : null,
    profit: Math.round(profit * 100) / 100,
    amazonPrice,
    sourcePrice,
    totalFees,
    candidate,
    confidence: candidate.confidence,
  };
}
