// ROI arithmetic, extracted from calculate-roi so it can be reused WITHOUT
// that function's pipeline.
//
// calculate-roi is ASIN-based and would work for a competitor listing, but it
// fetches its own price -- including /products/pricing/v0/items/{asin}/offers,
// the getItemOffers endpoint on the 0.5 req/s pricing_api bucket that is
// already double-claimed by the repricer through a second, uncoordinated
// limiter. Calling it to get a number we can already compute would re-enter
// exactly the contention we routed around by taking price from Keepa.
//
// So this is the MATH only. Inputs come from the caller; nothing here fetches.
//
// The strictness is deliberate and carried over verbatim in intent: fees are
// REQUIRED. There is no 15% / $3.22 fallback. An ROI computed from guessed
// fees looks identical to one computed from real fees, and that is the failure
// mode worth preventing -- a plausible number nobody can tell is wrong.

export interface ActualFees {
  referralFee: number;
  fbaFee: number;
  variableClosingFee?: number;
  otherFees?: number;
}

export interface RoiResult {
  referralFee: number;
  fbaFee: number;
  variableClosingFee: number;
  otherFees: number;
  totalFees: number;
  profit: number;
  /** Return on the money spent. null when cost is unknown or zero. */
  roi: number | null;
  /** Share of the sale price left as profit. null when sell price is unknown. */
  margin: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * @param amzPrice  What it sells for on Amazon.
 * @param buyCost   What it costs at the source.
 * @param fees      REAL fees. Omit and you get zeros, not a guess.
 *
 * roi is null rather than 0 when buyCost is 0 -- "no cost data" and "0% return"
 * are different facts, and the original returning 0 for both is what made a
 * missing input indistinguishable from a bad deal.
 */
export function feesAndRoi(
  amzPrice: number,
  buyCost: number,
  fees?: ActualFees,
): RoiResult {
  const referralFee = fees?.referralFee ?? 0;
  const fbaFee = fees?.fbaFee ?? 0;
  const variableClosingFee = fees?.variableClosingFee ?? 0;
  const otherFees = fees?.otherFees ?? 0;
  const totalFees = referralFee + fbaFee + variableClosingFee + otherFees;
  const profit = amzPrice - buyCost - totalFees;

  return {
    referralFee: round2(referralFee),
    fbaFee: round2(fbaFee),
    variableClosingFee: round2(variableClosingFee),
    otherFees: round2(otherFees),
    totalFees: round2(totalFees),
    profit: round2(profit),
    roi: buyCost > 0 ? round2((profit / buyCost) * 100) : null,
    margin: amzPrice > 0 ? round2((profit / amzPrice) * 100) : null,
  };
}
