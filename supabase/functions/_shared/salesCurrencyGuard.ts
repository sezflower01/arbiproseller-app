/**
 * Shared, source-aware currency guard for sales_orders revenue figures used by
 * one-off admin maintenance endpoints (fix_unit_costs, refresh_all_unit_costs,
 * recalculate_fees in sync-sales-orders). Ported from the frontend's
 * src/lib/sales/currencyConversion.ts so backend ROI recalculation uses the
 * exact same proven heuristic instead of blindly treating `sold_price` as USD
 * (which breaks for non-US orders where legacy writers stored it native) or
 * blindly dividing by FX (which double-converts rows already stored in USD —
 * a previously-fixed regression class, see AUDIT §14/§14c in the frontend file).
 */

export const MARKETPLACE_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL", UK: "GBP",
  DE: "EUR", ES: "EUR", FR: "EUR", IT: "EUR", NL: "EUR", BE: "EUR",
  JP: "JPY", AU: "AUD", IN: "INR", SG: "SGD", AE: "AED", SA: "SAR",
  SE: "SEK", PL: "PLN", TR: "TRY",
};

export function getMarketplaceCurrency(marketplace: string | null | undefined): string {
  const mp = String(marketplace || "US").trim().toUpperCase();
  return MARKETPLACE_CURRENCY[mp] || "USD";
}

export type ToUsdConverter = (amount: number, marketplace?: string | null) => number;

export type ConfirmedSalesRevenueRow = {
  marketplace?: string | null;
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  price_source?: string | null;
  price_calc_mode?: string | null;
};

const TRUSTED_USD_PRICE_SOURCES = new Set([
  "financial_events", "reconciled_fec", "settled", "orders_api",
  "orders_api_ca_reconciled", "data_repair", "orders_itemprice_usd",
]);

const SUSPECT_NATIVE_PRICE_SOURCES = [
  "", "orders_itemprice", "order_items_api", "order_total_pending",
  "fees_api", "listings_api", "pricing_api", "estimate", "estimated:",
];

function nativeMagnitudeThreshold(marketplace: string, fxRate: number): number {
  if (marketplace === "MX") return Math.max(120, fxRate * 7);
  if (marketplace === "BR") return Math.max(75, fxRate * 14);
  if (marketplace === "CA") return 150;
  return 150;
}

function shouldTreatConfirmedRevenueAsNative(
  row: ConfirmedSalesRevenueRow,
  rawTotal: number,
  qty: number,
  marketplace: string,
  fxRate: number,
): boolean {
  const priceSource = String(row.price_source || "").trim().toLowerCase();
  const calcMode = String(row.price_calc_mode || "").trim().toLowerCase();
  const hasTrustedUsdMarker =
    TRUSTED_USD_PRICE_SOURCES.has(priceSource) ||
    TRUSTED_USD_PRICE_SOURCES.has(calcMode) ||
    priceSource.endsWith("_usd") ||
    calcMode.endsWith("_usd") ||
    priceSource.includes("_reconciled") ||
    calcMode.includes("_reconciled");
  if (hasTrustedUsdMarker) return false;

  const suspectSource = SUSPECT_NATIVE_PRICE_SOURCES.some((prefix) => (
    prefix === "" ? priceSource === "" : priceSource.startsWith(prefix) || calcMode.startsWith(prefix)
  ));
  if (!suspectSource) return false;

  const estimatedTotal = Number(row.estimated_price || 0) * qty;
  if (estimatedTotal > 0) {
    const usdLikeRatio = rawTotal / estimatedTotal;
    // See AUDIT §15 in src/lib/sales/currencyConversion.ts (this is a straight
    // port) — ×1.35 overlapped with genuinely-native CAD rows near ratio≈1.0.
    if (usdLikeRatio >= (1 / fxRate) * 0.75 && usdLikeRatio <= (1 / fxRate) * 1.15) return false;
  }

  if (estimatedTotal > 0) {
    const ratio = rawTotal / estimatedTotal;
    if (ratio >= fxRate * 0.65 && ratio <= fxRate * 1.45) return true;
  }

  return rawTotal >= nativeMagnitudeThreshold(marketplace, fxRate);
}

// Recent still-Pending orders can carry a preliminary/wrong price from
// Amazon before payment authorization finishes -- confirmed live: a 10-unit
// order with price_source="orders_itemprice" showed $150.57 total while the
// order was still Pending and the seller's own current listing price
// (estimated_price) was $215.10 (the real, correct amount). Validated
// against 900 recent (order_date within 30d) Pending + suspect-sourced US
// rows: 893/900 were healthy (raw within 15% of estimated_price*qty); the
// 7 genuine outliers were ALL understated, never overstated. Deliberately
// scoped to Pending + recent + suspect-sourced + understated only -- older
// or non-Pending mismatches usually mean the price legitimately changed
// since the sale (estimated_price drifted, not the sale data), and treating
// those as wrong would reintroduce the AUDIT-class regressions above.
function isRecentPendingSuspectLowball(
  row: ConfirmedSalesRevenueRow & { order_status?: string | null; order_date?: string | null },
  raw: number,
  qty: number,
): boolean {
  const status = String(row.order_status || "").trim().toLowerCase();
  if (status !== "pending") return false;
  const priceSource = String(row.price_source || "").trim().toLowerCase();
  const calcMode = String(row.price_calc_mode || "").trim().toLowerCase();
  const hasTrustedUsdMarker = TRUSTED_USD_PRICE_SOURCES.has(priceSource) || TRUSTED_USD_PRICE_SOURCES.has(calcMode) || priceSource.endsWith("_usd") || calcMode.endsWith("_usd") || priceSource.includes("_reconciled") || calcMode.includes("_reconciled");
  if (hasTrustedUsdMarker) return false;
  const suspectSource = SUSPECT_NATIVE_PRICE_SOURCES.some((prefix) => prefix === "" ? priceSource === "" : priceSource.startsWith(prefix) || calcMode.startsWith(prefix));
  if (!suspectSource) return false;
  const orderDate = String(row.order_date || "");
  if (!orderDate) return false;
  const ageDays = (Date.now() - new Date(`${orderDate}T00:00:00Z`).getTime()) / 86400000;
  if (!(ageDays >= 0 && ageDays <= 30)) return false;
  const est = Number(row.estimated_price || 0) * qty;
  if (!(est > 0)) return false;
  return raw < est * 0.85;
}

/**
 * Return confirmed sales_order revenue in USD. Mirrors the frontend's
 * getConfirmedSalesOrderRevenueUsd exactly — same thresholds, same
 * source-aware guards — so backend ROI recalculation and the on-screen
 * figures never disagree about which rows are native vs. already USD.
 */
export function getConfirmedSalesOrderRevenueUsd(
  row: ConfirmedSalesRevenueRow & { order_status?: string | null; order_date?: string | null },
  toUsd: ToUsdConverter,
): number {
  const qty = Math.max(1, Number(row.quantity || 0));
  const raw = Number(row.total_sale_amount || 0) || (Number(row.sold_price || 0) * qty) || 0;
  if (raw <= 0) return 0;
  if (isRecentPendingSuspectLowball(row, raw, qty)) return Number(row.estimated_price || 0) * qty;

  const marketplace = String(row.marketplace || "US").trim().toUpperCase() || "US";
  if (marketplace === "US") return raw;

  const oneUsd = toUsd(1, marketplace);
  if (!(oneUsd > 0) || Math.abs(oneUsd - 1) < 0.0001) return raw;
  const fxRate = 1 / oneUsd;
  if (!(fxRate > 1.05)) return raw;

  if (shouldTreatConfirmedRevenueAsNative(row, raw, qty, marketplace, fxRate)) return toUsd(raw, marketplace);

  return raw;
}
