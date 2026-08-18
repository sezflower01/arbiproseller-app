// Server-side ROI arithmetic for the auto-lower-min worker.
//
// WHY THIS EXISTS (and why it is not `roi-math.ts`):
// `roi-math.ts` takes ABSOLUTE fee amounts and answers "what is the ROI at this
// price". This worker needs the INVERSE -- "what price yields exactly N% ROI" --
// which requires the referral RATE, not a referral dollar amount, because the
// referral fee moves with the price we are solving for.
//
// It is a faithful port of the browser's `src/lib/roiCalc.ts` +
// `calculatePriceFromRoi` in AssignmentsTable.tsx, deliberately kept
// number-for-number identical so a floor computed here matches what the seller
// sees in the table. If you change one, change both.
//
// ── The FX bug this fixes (found 2026-08-18) ────────────────────────────────
// The browser computes ROI as calcRoiAtPrice(cost, fees_json, price, fxRate, mp)
// where fxRate is a CLIENT-CACHED value. On MX the same saved min of 400 was
// observed rendering as 73.2% and later as 99.8% -- a 26-point swing with no
// price change, purely because the cached rate differed between renders. Any
// automation that reads ROI off the screen is therefore measuring with a rubber
// ruler, and will happily set a floor it believes is compliant when it is not.
//
// The fix is structural: the caller resolves the FX rate ONCE per run via
// `getUsdToRate()` and passes the same pinned value into every call here. The
// rate used is returned with each decision so a historical number can always be
// explained.
//
// ── NO GUESSED FEES (changed after the first dry run, 2026-08-18) ───────────
// The browser falls back to a flat 15% when fees_json is unusable, and enriches
// from asin_fee_cache separately. This module originally copied that fallback to
// match the seller-visible number. The first dry run proved that unsafe:
// B074678KNX came back at +1.7% ROI on a price LOWER than one the table had
// shown at -14.3%. A lower price cannot improve ROI -- the 15% assumption was
// simply understating real fees (~36% on that ASIN), and the worker was about to
// set a floor below true break-even while reporting it as profitable.
//
// So this module now follows `roi-math.ts`'s rule instead: fees are REQUIRED.
// A usable referral RATE must be derivable -- either `referral_rate` directly,
// or a legacy amount paired with the price it was captured at. Anything else
// returns null, and the worker skips the row as `fees_unresolvable`. Refusing to
// act on a row is cheap; setting a loss-making floor is not.

export const getOtherFixedFees = (feesJson: any): number =>
  Number(
    feesJson?.otherFees ??
      feesJson?.other_fees ??
      feesJson?.fixedClosingFee ??
      feesJson?.fixed_closing_fee ??
      feesJson?.closingFee ??
      feesJson?.FixedClosingFee ??
      0,
  );

/** Fee shape resolved to a rate + fixed component, in MARKETPLACE-LOCAL currency. */
interface ResolvedFees {
  referralRate: number;
  fixedFees: number;
  localCost: number;
  /** true when fees_json was unusable and a flat 15% was assumed. */
  assumed: boolean;
}

function resolveFees(
  cost: number,
  feesJson: any,
  fxRate: number,
  marketplace: string,
  priceHint: number,
): ResolvedFees | null {
  if (!cost || cost <= 0) return null;

  const intl = marketplace !== "US" && fxRate > 1;
  let localCost = cost;
  let referralRate = 0.15;
  let fixedFees = 0;
  let assumed = true;

  if (feesJson) {
    // Legacy format: actual dollar amounts captured at a specific price.
    if (feesJson.referralFee !== undefined || feesJson.fbaFee !== undefined) {
      const origReferralFee = Number(feesJson.referralFee || 0);
      let fbaFee = Number(feesJson.fbaFee || 0);
      let variableClosingFee = Number(feesJson.variableClosingFee || 0);
      let otherFees = getOtherFixedFees(feesJson);
      const feeMarketplace = String(feesJson.marketplace || "US").toUpperCase();
      if (intl && feeMarketplace === "US") {
        localCost = cost * fxRate;
        fbaFee *= fxRate;
        variableClosingFee *= fxRate;
        otherFees *= fxRate;
      }
      // Referral scales with price; everything else is fixed. Derive the rate
      // from the price the fees were captured at.
      // The referral RATE is what the inversion turns on. Without the price the
      // amount was captured at, the rate cannot be derived -- and guessing it is
      // the exact failure this module refuses to make.
      const feesAtPrice = feesJson.price ? Number(feesJson.price) : 0;
      if (!(feesAtPrice > 0)) return null;
      referralRate = origReferralFee / feesAtPrice;
      fixedFees = fbaFee + variableClosingFee + otherFees;
      assumed = false;
    }
    // New format: rate-based, straight from asin_fee_cache.
    else if (feesJson.referral_rate !== undefined || feesJson.fba_fee_fixed !== undefined) {
      referralRate = Number(feesJson.referral_rate ?? 0.15);
      let fbaFeeFixed = Number(feesJson.fba_fee_fixed ?? 0);
      let variableClosingFee = Number(
        feesJson.variable_closing_fee ?? feesJson.variableClosingFee ?? 0,
      );
      let otherFees = getOtherFixedFees(feesJson);
      if (intl) {
        localCost = cost * fxRate;
        const feeMarketplace = feesJson.marketplace || "US";
        if (feeMarketplace === "US") {
          fbaFeeFixed *= fxRate;
          variableClosingFee *= fxRate;
          otherFees *= fxRate;
        }
      }
      fixedFees = fbaFeeFixed + variableClosingFee + otherFees;
      assumed = false;
    }
  }

  // No recognisable fee structure at all -> refuse. `assumed` is still true only
  // if neither branch above ran, which is exactly the guessed-fees case.
  if (assumed) return null;

  // Cost still needs converting when the fee branch did not do it.
  if (intl && localCost === cost) localCost = cost * fxRate;

  // A referral rate at or above 100% makes the inverse undefined (and the
  // forward calculation meaningless) -- refuse rather than emit a number.
  if (!(referralRate < 1) || referralRate < 0) return null;
  if (!(localCost > 0)) return null;
  void priceHint;

  return { referralRate, fixedFees, localCost, assumed };
}

/**
 * ROI (%) at a given price. Mirrors `calcRoiAtPrice` in src/lib/roiCalc.ts.
 * Returns null when it cannot be computed -- which callers must treat as
 * "do not act", never as 0.
 */
export function roiAtPrice(
  cost: number | null,
  feesJson: any,
  price: number,
  fxRate: number,
  marketplace: string,
): number | null {
  if (!cost || cost <= 0 || !price || price <= 0) return null;
  const f = resolveFees(cost, feesJson, fxRate, marketplace, price);
  if (!f) return null;
  const totalFees = price * f.referralRate + f.fixedFees;
  const profit = price - totalFees - f.localCost;
  return Math.round((profit / f.localCost) * 1000) / 10;
}

/**
 * The price that yields exactly `targetRoi` %. Mirrors `calculatePriceFromRoi`.
 *
 *   price = (cost + cost*targetRoi/100 + fixedFees) / (1 - referralRate)
 *
 * Rounded UP to the cent: rounding down would land a hair under the floor, and
 * this number IS the floor.
 */
export function priceForRoi(
  cost: number | null,
  feesJson: any,
  targetRoi: number,
  fxRate: number,
  marketplace: string,
): number | null {
  if (!cost || cost <= 0) return null;
  const f = resolveFees(cost, feesJson, fxRate, marketplace, 0);
  if (!f) return null;
  const requiredProfit = f.localCost * (targetRoi / 100);
  const price = (f.localCost + requiredProfit + f.fixedFees) / (1 - f.referralRate);
  if (!isFinite(price) || price <= 0) return null;
  return Math.ceil(price * 100) / 100;
}
