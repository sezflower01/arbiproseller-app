import { describe, it, expect } from "vitest";
import { getSalesOrderFeeBreakdownUsd, getSalesOrderFeesUsd } from "../feeNormalization";

// fx_rates snapshot used in the audit (USD->quote): BRL=5.3766
const FX: Record<string, number> = { BR: 5.3766, US: 1 };
const toUsd = (amount: number, mp?: string | null) => {
  const r = FX[String(mp || "US").toUpperCase()] ?? 1;
  return amount / r;
};

describe("getSalesOrderFeeBreakdownUsd — fees_source-aware currency conversion", () => {
  it("'from_cache': converts only referral_fee (native), leaves fba_fee/closing_fee as-is (already USD)", () => {
    // Real order 702-5229920-7869069: referral_fee=15.39 (native BRL,
    // 128.22 * 0.12 referral rate), fba_fee=2.87 (already USD, straight from
    // asin_fee_cache.fba_fee_fixed per the writer contract).
    const row = {
      marketplace: "BR",
      fees_source: "from_cache",
      referral_fee: 15.39,
      fba_fee: 2.87,
      closing_fee: 0,
      total_fees: 18.26,
    };
    const revenueUsd = 23.847784845441357;
    const result = getSalesOrderFeeBreakdownUsd(row, revenueUsd, toUsd);

    expect(result.referral).toBeCloseTo(15.39 / 5.3766, 3); // ~2.862
    expect(result.fba).toBeCloseTo(2.87, 5); // unconverted
    expect(result.total).toBeCloseTo(15.39 / 5.3766 + 2.87, 3); // ~5.73
    expect(getSalesOrderFeesUsd(row, revenueUsd, toUsd)).toBeCloseTo(result.total, 5);
  });

  it("'fees_api': already USD, never converted even though componentTotal exceeds 70% of revenue", () => {
    const row = {
      marketplace: "BR",
      fees_source: "fees_api",
      referral_fee: 3.5,
      fba_fee: 15.0, // deliberately large — must NOT be treated as native
      closing_fee: 0,
    };
    const revenueUsd: number = 23.85;
    const result = getSalesOrderFeeBreakdownUsd(row, revenueUsd, toUsd);
    expect(result.total).toBeCloseTo(18.5, 5);
  });

  it("'fees_api_y8' (MX marketplace-id-suffixed variant): treated the same as 'fees_api'", () => {
    const row = { marketplace: "BR", fees_source: "fees_api_y8", referral_fee: 3.5, fba_fee: 2.0, closing_fee: 0 };
    const result = getSalesOrderFeeBreakdownUsd(row, 23.85, toUsd);
    expect(result.total).toBeCloseTo(5.5, 5);
  });

  it("'learned_history' and 'learned_history_old': already USD, never converted", () => {
    const row1 = { marketplace: "BR", fees_source: "learned_history", referral_fee: 3.5, fba_fee: 2.0, closing_fee: 0 };
    const row2 = { marketplace: "BR", fees_source: "learned_history_old", referral_fee: 3.5, fba_fee: 2.0, closing_fee: 0 };
    expect(getSalesOrderFeeBreakdownUsd(row1, 23.85, toUsd).total).toBeCloseTo(5.5, 5);
    expect(getSalesOrderFeeBreakdownUsd(row2, 23.85, toUsd).total).toBeCloseTo(5.5, 5);
  });

  it("'financial_events' (settled): already USD, never converted", () => {
    const row = { marketplace: "BR", fees_source: "financial_events", referral_fee: 3.5, fba_fee: 2.0, closing_fee: 0 };
    const result = getSalesOrderFeeBreakdownUsd(row, 23.85, toUsd);
    expect(result.total).toBeCloseTo(5.5, 5);
  });

  it("null/empty fees_source with real fee data: treated as already-USD (orders_itemprice success-branch writer)", () => {
    const row = { marketplace: "BR", fees_source: null, referral_fee: 3.5, fba_fee: 2.0, closing_fee: 0 };
    const result = getSalesOrderFeeBreakdownUsd(row, 23.85, toUsd);
    expect(result.total).toBeCloseTo(5.5, 5);
  });

  it("unrecognized fees_source: falls back to combined-total magnitude heuristic", () => {
    const row = {
      marketplace: "BR",
      fees_source: "some_future_unknown_source",
      referral_fee: 15.39,
      fba_fee: 2.87,
      closing_fee: 0,
    };
    const revenueUsd = 23.85;
    const result = getSalesOrderFeeBreakdownUsd(row, revenueUsd, toUsd);
    // componentTotal (18.26) > 70% of revenue -> whole row treated as native and converted
    expect(result.total).toBeCloseTo(18.26 / 5.3766, 2);
  });

  it("US marketplace fees are never converted regardless of fees_source", () => {
    const row = { marketplace: "US", fees_source: "from_cache", referral_fee: 15.39, fba_fee: 2.87, closing_fee: 0 };
    const result = getSalesOrderFeeBreakdownUsd(row, 23.85, toUsd);
    expect(result.total).toBeCloseTo(18.26, 2);
  });
});
