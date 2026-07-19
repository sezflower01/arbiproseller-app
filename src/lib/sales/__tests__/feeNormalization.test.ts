import { describe, it, expect } from "vitest";
import { getSalesOrderFeeBreakdownUsd, getSalesOrderFeesUsd } from "../feeNormalization";

// fx_rates snapshot used in the audit (USD->quote): BRL=5.3766
const FX: Record<string, number> = { BR: 5.3766, US: 1 };
const toUsd = (amount: number, mp?: string | null) => {
  const r = FX[String(mp || "US").toUpperCase()] ?? 1;
  return amount / r;
};

describe("getSalesOrderFeeBreakdownUsd — combined-total native-currency detection", () => {
  it("converts multiple native-BRL fee components even when each is individually below the per-component threshold (real order 702-5229920-7869069)", () => {
    // referral_fee=15.39 and fba_fee=2.87 are both native BRL (128.22 * 0.12
    // referral rate = 15.39 exactly), but neither alone exceeds 70% of the
    // $23.85 USD revenue. Their sum (18.26) is 77% of revenue and must be
    // detected as native currency.
    const row = {
      marketplace: "BR",
      referral_fee: 15.39,
      fba_fee: 2.87,
      closing_fee: 0,
      total_fees: 18.26,
    };
    const revenueUsd = 23.847784845441357;
    const result = getSalesOrderFeeBreakdownUsd(row, revenueUsd, toUsd);

    // Correct conversion: 18.26 / 5.3766 ~= 3.396
    expect(result.total).toBeCloseTo(18.26 / 5.3766, 2);
    expect(result.total).toBeLessThan(revenueUsd * 0.3);
    expect(getSalesOrderFeesUsd(row, revenueUsd, toUsd)).toBeCloseTo(result.total, 5);
  });

  it("leaves genuinely small USD fee components unconverted", () => {
    const row = {
      marketplace: "BR",
      referral_fee: 2.86,
      fba_fee: 0.53,
      closing_fee: 0,
      total_fees: 3.39,
    };
    const revenueUsd = 23.85;
    const result = getSalesOrderFeeBreakdownUsd(row, revenueUsd, toUsd);
    expect(result.total).toBeCloseTo(3.39, 2);
  });

  it("still converts a single implausibly large component (legacy per-component case)", () => {
    // A single native-BRL referral fee of 20 exceeds 70% of the $23.85 USD
    // revenue (16.695) on its own -- must still be caught and converted.
    const row = {
      marketplace: "BR",
      referral_fee: 20,
      fba_fee: 0,
      closing_fee: 0,
      total_fees: 20,
    };
    const revenueUsd = 23.85;
    const result = getSalesOrderFeeBreakdownUsd(row, revenueUsd, toUsd);
    expect(result.total).toBeCloseTo(20 / 5.3766, 2);
  });

  it("US marketplace fees are never converted", () => {
    const row = { marketplace: "US", referral_fee: 15.39, fba_fee: 2.87, closing_fee: 0 };
    const result = getSalesOrderFeeBreakdownUsd(row, 23.85, toUsd);
    expect(result.total).toBeCloseTo(18.26, 2);
  });
});
