// ⚠ DISPLAY-ONLY — DO NOT IMPORT FROM PRICING PATHS ⚠
//
// ROI computed here is for UI/trace visibility only.
// It MUST NOT be imported by:
//   - repricer-ai-evaluate
//   - repricer-evaluate
//   - repricer-unified-dispatch
//   - repricer-scheduler
//
// A guard test enforces this (see supabase/functions/_tests/no-profit-guard-enforcement_test.ts).
// The user's manual min_price_override is the ONLY authoritative price floor.
// See mem://strategy/repricer/manual-min-only-v1

export type RoiDisplayInput = {
  price: number;           // proposed or current sell price (marketplace currency)
  cost: number;            // landed cost in same currency
  referralRate?: number;   // e.g. 0.15
  fbaFeeFixed?: number;    // per-unit FBA fixed
};

export type RoiDisplay = {
  roi_percent: number | null;
  profit_amount: number | null;
  referral_fee: number | null;
  fba_fee_fixed: number | null;
  formula: string;
};

/**
 * Compute ROI at a given price for DISPLAY ONLY.
 * Never call this from any code that can influence the price the engine submits.
 */
export function computeRoiAtPriceDisplayOnly(input: RoiDisplayInput): RoiDisplay {
  const price = Number(input.price) || 0;
  const cost = Number(input.cost) || 0;
  const refRate = typeof input.referralRate === "number" ? input.referralRate : 0.15;
  const fbaFee = typeof input.fbaFeeFixed === "number" ? input.fbaFeeFixed : 0;

  if (!price || !cost || price <= 0 || cost <= 0) {
    return {
      roi_percent: null,
      profit_amount: null,
      referral_fee: null,
      fba_fee_fixed: fbaFee || null,
      formula: "ROI = (Price − Referral% × Price − FBA − Cost) / Cost",
    };
  }

  const referral = price * refRate;
  const profit = price - referral - fbaFee - cost;
  const roi = (profit / cost) * 100;

  return {
    roi_percent: Math.round(roi * 10) / 10,
    profit_amount: Math.round(profit * 100) / 100,
    referral_fee: Math.round(referral * 100) / 100,
    fba_fee_fixed: Math.round(fbaFee * 100) / 100,
    formula: "ROI = (Price − Referral% × Price − FBA − Cost) / Cost",
  };
}
