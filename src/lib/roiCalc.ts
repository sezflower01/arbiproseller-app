// Shared ROI calculator — single source of truth for computing ROI from
// (cost, fees_json, price, fxRate, marketplace), used by both the active
// Repricer table (AssignmentsTable.tsx) and the Delisted-for-pricing-policy
// panel (PricingSuppressionsSection.tsx) so a price typed into either place
// produces the identical ROI number.
//
// Matches CreateListing's ROI formula: ROI = (Price - TotalFees - Cost) / Cost * 100
// TotalFees = referralFee + fbaFee + variableClosingFee + otherFees

export const getOtherFixedFees = (feesJson: any): number =>
  Number(
    feesJson?.otherFees ??
      feesJson?.other_fees ??
      feesJson?.fixedClosingFee ??
      feesJson?.fixed_closing_fee ??
      feesJson?.closingFee ??
      feesJson?.FixedClosingFee ??
      0
  );

export function calcRoiAtPrice(
  cost: number | null,
  feesJson: any,
  price: number,
  fxRate: number,
  marketplace: string,
): number | null {
  if (!cost || cost <= 0 || !price || price <= 0) return null;

  let totalFees = 0;
  let localCost = cost;

  if (feesJson) {
    // Legacy format: actual dollar amounts (referralFee, fbaFee, variableClosingFee)
    if (feesJson.referralFee !== undefined || feesJson.fbaFee !== undefined) {
      const referralFee = Number(feesJson.referralFee || 0);
      let fbaFee = Number(feesJson.fbaFee || 0);
      let variableClosingFee = Number(feesJson.variableClosingFee || 0);
      let otherFees = getOtherFixedFees(feesJson);
      const feeMarketplace = String(feesJson.marketplace || "US").toUpperCase();
      if (marketplace !== "US" && fxRate > 1 && feeMarketplace === "US") {
        localCost = cost * fxRate;
        fbaFee *= fxRate;
        variableClosingFee *= fxRate;
        otherFees *= fxRate;
      }
      // Scale fees proportionally if price differs from the price fees were calculated at
      const feesAtPrice = feesJson.price ? Number(feesJson.price) : 0;
      if (feesAtPrice > 0 && Math.abs(feesAtPrice - price) > 0.01) {
        // Referral fee scales with price; fbaFee & closingFee are fixed
        const referralRate = feesAtPrice > 0 ? referralFee / feesAtPrice : 0.15;
        totalFees = (price * referralRate) + fbaFee + variableClosingFee + otherFees;
      } else {
        totalFees = referralFee + fbaFee + variableClosingFee + otherFees;
      }
    }
    // New format: rate-based (referral_rate + fba_fee_fixed from asin_fee_cache)
    else if (feesJson.referral_rate !== undefined || feesJson.fba_fee_fixed !== undefined) {
      const referralRate = Number(feesJson.referral_rate ?? 0.15);
      const fbaFeeFixed = Number(feesJson.fba_fee_fixed ?? 0);
      let localVariableClosingFee = Number(feesJson.variable_closing_fee ?? feesJson.variableClosingFee ?? 0);
      let localOtherFees = getOtherFixedFees(feesJson);
      let localFbaFee = fbaFeeFixed;

      if (marketplace !== "US" && fxRate > 1) {
        localCost = cost * fxRate;
        const feeMarketplace = feesJson.marketplace || "US";
        if (feeMarketplace === "US") {
          localFbaFee = fbaFeeFixed * fxRate;
          localVariableClosingFee = localVariableClosingFee * fxRate;
          localOtherFees = localOtherFees * fxRate;
        }
      }
      totalFees = (price * referralRate) + localFbaFee + localVariableClosingFee + localOtherFees;
    }
    // Fallback: no recognizable fee structure
    else {
      totalFees = price * 0.15;
    }
  } else {
    // No fees_json at all — conservative default
    totalFees = price * 0.15;
  }

  if (marketplace !== "US" && fxRate > 1 && localCost === cost) {
    localCost = cost * fxRate;
  }

  const profit = price - totalFees - localCost;
  return Math.round((profit / localCost) * 1000) / 10;
}
