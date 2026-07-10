import { describe, it, expect } from "vitest";
import {
  getConfirmedSalesOrderRevenueUsd,
  getConfirmedSalesOrderUnitRevenueUsd,
} from "../currencyConversion";

// fx_rates snapshot used in the audit (USD->quote):
//   BRL=5.3766  CAD=1.3872  MXN=17.9028
const FX: Record<string, number> = {
  BR: 5.3766,
  CA: 1.3872,
  MX: 17.9028,
  US: 1,
};

// toUsd(amount, marketplace) - mirrors live behavior: amount / fxRate
const toUsd = (amount: number, mp?: string | null) => {
  const r = FX[String(mp || "US").toUpperCase()] ?? 1;
  return amount / r;
};

// oneUsd helper used by guard: toUsd(1, mp) = 1/fxRate, so fxRate = 1/oneUsd
// (callers stay outside the helper - tests just need toUsd)

describe("AUDIT §14 - BR confirmed revenue must NOT be re-divided by FX", () => {
  // Real incident orders from the production scan. sold_price/total_sale_amount
  // were written in USD by sync-sales-orders. Reader must return them as-is.

  it("702-8744704-5319432 (BR, order_total_pending) returns stored USD", () => {
    const row = {
      marketplace: "BR",
      quantity: 1,
      sold_price: 33.97,
      total_sale_amount: 33.97,
      estimated_price: null,
      price_source: "order_total_pending",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(33.97, 2);
    expect(getConfirmedSalesOrderUnitRevenueUsd(row, toUsd)).toBeCloseTo(33.97, 2);
  });

  it("702-6403753-5454661 (BR, orders_itemprice) returns stored USD", () => {
    const row = {
      marketplace: "BR",
      quantity: 1,
      sold_price: 32.86,
      total_sale_amount: 32.86,
      estimated_price: 22.99, // typical: estimate differs from confirmed USD price
      price_source: "orders_itemprice",
    };
    // Pre-fix: startsWith branch -> divided by 5.3766 -> ~$6.11.
    // Post-fix: branch removed, ratio 32.86/22.99=1.43 escapes 0.92-1.08
    // guard, magnitude 32.86 < BR threshold(120) -> stored USD returned.
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(32.86, 2);
  });

  it("701-0363848-6419454 (BR, financial_events) returns stored USD (trusted)", () => {
    const row = {
      marketplace: "BR",
      quantity: 1,
      sold_price: 34.3128,
      total_sale_amount: 34.3128,
      estimated_price: 22.99,
      price_source: "financial_events",
      price_calc_mode: "listings_api",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(34.31, 2);
  });
});

describe("AUDIT §14 - CA parity (USD on read, no re-division)", () => {
  it("CA orders_itemprice typical row stays USD", () => {
    const row = {
      marketplace: "CA",
      quantity: 1,
      sold_price: 28.5,
      total_sale_amount: 28.5,
      price_source: "orders_itemprice",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(28.5, 2);
  });

  it("CA order_total_pending typical row stays USD", () => {
    const row = {
      marketplace: "CA",
      quantity: 1,
      sold_price: 26.0,
      total_sale_amount: 26.0,
      price_source: "order_total_pending",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(26.0, 2);
  });
});

describe("AUDIT §14 - MX defensive guards still catch legacy native rows", () => {
  it("MX small USD row (orders_api $28) stays USD", () => {
    const row = {
      marketplace: "MX",
      quantity: 1,
      sold_price: 28.37,
      total_sale_amount: 28.37,
      price_source: "orders_api",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(28.37, 2);
  });

  it("MX legacy native row (sold=est=native MXN ratio≈1) still converts", () => {
    // Historical broken row: both sold_price and estimated_price stored native.
    const row = {
      marketplace: "MX",
      quantity: 1,
      sold_price: 470.71,
      total_sale_amount: 470.71,
      estimated_price: 470.71,
      price_source: "orders_itemprice",
    };
    // Magnitude OR ratio≈1 guard triggers -> converted: 470.71 / 17.9028 ≈ 26.29
    const usd = getConfirmedSalesOrderRevenueUsd(row, toUsd);
    expect(usd).toBeLessThan(50);
    expect(usd).toBeGreaterThan(20);
  });

  it("MX large outlier ($836) above magnitude threshold still converts", () => {
    const row = {
      marketplace: "MX",
      quantity: 1,
      sold_price: 836.23,
      total_sale_amount: 836.23,
      price_source: "orders_itemprice",
    };
    const usd = getConfirmedSalesOrderRevenueUsd(row, toUsd);
    expect(usd).toBeCloseTo(836.23 / 17.9028, 1);
  });
});

describe("AUDIT §14 - US untouched", () => {
  it("US orders_itemprice returns raw", () => {
    const row = {
      marketplace: "US",
      quantity: 2,
      sold_price: 19.99,
      total_sale_amount: 39.98,
      price_source: "orders_itemprice",
    };
    expect(getConfirmedSalesOrderRevenueUsd(row, toUsd)).toBeCloseTo(39.98, 2);
  });
});
