type FeeRow = {
  marketplace?: string | null;
  total_fees?: number | null;
  referral_fee?: number | null;
  fba_fee?: number | null;
  closing_fee?: number | null;
  // FBM Buy Shipping label cost captured per-order (sales_orders.shipping_label_fee).
  // Already resolved in marketplace currency; treated like other fees.
  shipping_label_fee?: number | null;
  // sales_orders.fees_source — which writer produced referral_fee/fba_fee/
  // closing_fee, and therefore what currency they're actually in. See the
  // fee-currency-convention audit below.
  fees_source?: string | null;
};

// === FEE CURRENCY CONVENTION AUDIT (2026-07-19) ===
// Every fees_source value that carries real (non-null) fee data was traced to
// its writer in supabase/functions/{sync-sales-orders,fetch-live-orders}/index.ts:
//
//  - 'from_cache' (both call sites in sync-sales-orders): referral_fee is
//    computed as nativePrice * cache.referral_rate (NEVER converted — NATIVE
//    currency). fba_fee/closing_fee come straight from asin_fee_cache, which
//    is contractually stored in USD since the 2026-06-20 fix. MIXED currency
//    within one row.
//  - 'fees_api' / 'fees_api_fx' / 'fees_api_<marketplace-id-suffix>' (e.g.
//    'fees_api_y8' for MX, 'fees_api_g2' for CA, 'fees_api_wc' for BR): every
//    independent implementation (fetch-live-orders' getProductFees,
//    sync-sales-orders' own fetchProductFees, repair-pending-prices) divides
//    all three components by the FX rate before returning. Always USD.
//  - 'learned_history' / 'learned_history_old': referral is priceToUse (USD,
//    converted earlier in the same function) * a currency-neutral rate;
//    fba/closing come from financial_events_cache, which fetch-profit-loss
//    converts to USD at write time via convertToUSD. Always USD.
//  - 'financial_events' (settled orders): explicitly multiplied by
//    CURRENCY_TO_USD[feeCurrency] before the settle-write. Always USD.
//  - null/empty with non-null fee values: the only identified writer of this
//    state is the orders_itemprice success branch in sync-sales-orders, which
//    writes apiFees.* (already USD) but omits fees_source. Treat as USD.
//  - 'cleared:*' (one-off repair-script tags): fee columns are always NULL
//    for these — non-issue, componentTotal will be 0.
//  - 'unavailable': fees are null — non-issue.
//
// Only 'from_cache' needs a currency conversion at all, and only for
// referral_fee. Everything else with real data is already USD.
const FROM_CACHE_SOURCE = "from_cache";

const isKnownUsdFeeSource = (source: string | null | undefined): boolean => {
  const s = String(source || "").trim().toLowerCase();
  if (s === "") return true; // null/empty — see audit above
  if (s.startsWith("fees_api")) return true;
  if (s === "learned_history" || s === "learned_history_old") return true;
  if (s === "financial_events") return true;
  return false;
};

export type FeeCacheEntry = {
  fba: number;
  refRate: number;
  isMedia?: boolean;
  /**
   * DEPRECATED. asin_fee_cache.fba_fee_fixed is stored in USD per the writer
   * contract (sync-sales-orders/fetchProductFees + backfill-fee-cache, post
   * 2026-06-20 currency fix). New callers MUST leave this false/undefined.
   * Branch retained only to avoid breaking callers that have not been audited.
   */
  marketplaceNativeFixedFee?: boolean;
};


export type FxToUsd = (amount: number, marketplace?: string | null) => number;

const normalizeMarketplace = (marketplace?: string | null) =>
  String(marketplace || "US").trim().toUpperCase() || "US";

const isNonUsMarketplace = (marketplace?: string | null) =>
  normalizeMarketplace(marketplace) !== "US";

export const feeCacheKey = (asin: string, marketplace?: string | null) =>
  `${String(asin || "").trim()}::${normalizeMarketplace(marketplace)}`;

const normalizePossibleLocalFee = (
  amount: number,
  marketplace: string | null | undefined,
  revenueUsd: number,
  toUsd: FxToUsd,
) => {
  if (amount <= 0) return 0;
  if (!isNonUsMarketplace(marketplace)) return amount;

  // sales_orders fees should be USD, but older MX/CA rows can contain mixed
  // local-currency referral/total fees. If a single fee is implausibly larger
  // than the USD sale, treat that component as local and convert it once.
  if (revenueUsd > 0 && amount > revenueUsd * 0.7) {
    return toUsd(amount, marketplace);
  }

  return amount;
};

export type FeeBreakdownUsd = {
  referral: number;
  fba: number;
  closing: number;
  label: number;
  total: number;
};

export const getSalesOrderFeeBreakdownUsd = (
  row: FeeRow,
  revenueUsd: number,
  toUsd: FxToUsd,
): FeeBreakdownUsd => {
  const referralRaw = Number(row.referral_fee || 0);
  const fbaRaw = Number(row.fba_fee || 0);
  const closingRaw = Number(row.closing_fee || 0);
  const labelRaw = Math.max(0, Number(row.shipping_label_fee || 0));
  const labelUsd = labelRaw > 0
    ? normalizePossibleLocalFee(labelRaw, row.marketplace, revenueUsd, toUsd)
    : 0;
  const componentTotal = referralRaw + fbaRaw + closingRaw;

  if (componentTotal > 0 && isNonUsMarketplace(row.marketplace)) {
    const source = row.fees_source;

    if (String(source || "").trim().toLowerCase() === FROM_CACHE_SOURCE) {
      // Confirmed mixed-currency row: only referral_fee is native, fba_fee/
      // closing_fee already USD from asin_fee_cache. Convert referral only.
      const referral = referralRaw > 0 ? toUsd(referralRaw, row.marketplace) : 0;
      return { referral, fba: fbaRaw, closing: closingRaw, label: labelUsd, total: referral + fbaRaw + closingRaw + labelUsd };
    }

    if (isKnownUsdFeeSource(source)) {
      // Confirmed already-USD writer — no conversion.
      return { referral: referralRaw, fba: fbaRaw, closing: closingRaw, label: labelUsd, total: referralRaw + fbaRaw + closingRaw + labelUsd };
    }

    // Unrecognized/legacy fees_source: fall back to the combined-total
    // magnitude heuristic (imperfect, but avoids the old per-component blind
    // spot where several native-currency fees each individually look small
    // enough to pass as USD even though their sum clearly isn't).
    const treatAsLocal = revenueUsd > 0 && componentTotal > revenueUsd * 0.7;
    const convertComponent = (amount: number) => {
      if (amount <= 0) return 0;
      return treatAsLocal ? toUsd(amount, row.marketplace) : amount;
    };
    const referral = convertComponent(referralRaw);
    const fba = convertComponent(fbaRaw);
    const closing = convertComponent(closingRaw);
    return { referral, fba, closing, label: labelUsd, total: referral + fba + closing + labelUsd };
  }

  if (componentTotal > 0) {
    // US marketplace — never converted.
    return { referral: referralRaw, fba: fbaRaw, closing: closingRaw, label: labelUsd, total: referralRaw + fbaRaw + closingRaw + labelUsd };
  }

  // Only total_fees present — cannot split accurately. Approximate referral at
  // 15% (Amazon's typical referral rate), rest as FBA.
  const total = normalizePossibleLocalFee(Number(row.total_fees || 0), row.marketplace, revenueUsd, toUsd);
  const referral = Math.min(total, revenueUsd * 0.15);
  const fba = Math.max(0, total - referral);
  return { referral, fba, closing: 0, label: labelUsd, total: total + labelUsd };
};

export const getSalesOrderFeesUsd = (
  row: FeeRow,
  revenueUsd: number,
  toUsd: FxToUsd,
) => getSalesOrderFeeBreakdownUsd(row, revenueUsd, toUsd).total;


export const getCachedFeesUsd = (
  cache: FeeCacheEntry,
  revenueUsd: number,
  quantity: number,
  marketplace: string | null | undefined,
  toUsd: FxToUsd,
) => {
  const refRate = cache.refRate > 0 ? cache.refRate : 0.15;
  const referralFee = revenueUsd * refRate;
  const fbaRaw = cache.fba * quantity;
  const fbaFee = cache.marketplaceNativeFixedFee && isNonUsMarketplace(marketplace)
    ? toUsd(fbaRaw, marketplace)
    : normalizePossibleLocalFee(fbaRaw, marketplace, revenueUsd, toUsd);
  const closingFee = cache.isMedia ? 1.8 * quantity : 0;
  return referralFee + fbaFee + closingFee;
};

/**
 * True when fees cannot be trusted for a non-US row: marketplace is CA/MX/BR,
 * the row has no real stored fees, AND no asin_fee_cache entry exists.
 * Used by Live Sales to surface a "Missing <MP> fee cache" warning and hide ROI.
 */
export const isFeeCacheMissingForNonUs = (params: {
  marketplace: string | null | undefined;
  storedFeeTotalUsd: number;
  hasCacheEntry: boolean;
  revenueUsd: number;
}) => {
  if (params.revenueUsd <= 0) return false;
  if (!isNonUsMarketplace(params.marketplace)) return false;
  if (params.storedFeeTotalUsd > 0) return false;
  return !params.hasCacheEntry;
};