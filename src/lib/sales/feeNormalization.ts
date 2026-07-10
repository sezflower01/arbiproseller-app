type FeeRow = {
  marketplace?: string | null;
  total_fees?: number | null;
  referral_fee?: number | null;
  fba_fee?: number | null;
  closing_fee?: number | null;
  // FBM Buy Shipping label cost captured per-order (sales_orders.shipping_label_fee).
  // Already resolved in marketplace currency; treated like other fees.
  shipping_label_fee?: number | null;
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

  if (componentTotal > 0) {
    const referral = normalizePossibleLocalFee(referralRaw, row.marketplace, revenueUsd, toUsd);
    const fba = normalizePossibleLocalFee(fbaRaw, row.marketplace, revenueUsd, toUsd);
    const closing = normalizePossibleLocalFee(closingRaw, row.marketplace, revenueUsd, toUsd);
    return { referral, fba, closing, label: labelUsd, total: referral + fba + closing + labelUsd };
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