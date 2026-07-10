/**
 * SHARED SALES CALCULATIONS - Single source of truth for Blocks AND Records
 * This file ensures Gross Sales, Fees, and other calculations match exactly
 * between PeriodStatsBlocks.tsx and Sales.tsx
 * 
 * PRICING PRIORITY (ChatGPT approved):
 * 1. sold_price / item_price - Actual from Financial Events / settled
 * 2. snapshot_item_price - Frozen at order discovery (NEW!)
 * 3. estimated_price - DB estimate field
 * 4. inventory.price - Live fallback (last resort)
 * 
 * IMPORTANT: ROI uses item_price only, never includes shipping
 */

export interface InventoryInfo {
  price: number | null;
  amazon_price?: number | null;
}

export interface PriceSnapshot {
  snapshot_item_price: number | null;
  snapshot_shipping_price: number | null;
  snapshot_source: string;
  currency_code?: string;
}

export interface SaleOrder {
  asin: string;
  order_id?: string;
  sold_price: number;
  total_sale_amount: number;
  quantity: number;
  estimated_price?: number | null;
  referral_fee?: number | null;
  fba_fee?: number | null;
  closing_fee?: number | null;
  total_fees?: number | null;
  fees_source?: string | null;
  fees_missing?: boolean | null;
  price_source?: string | null;
  price_confidence?: string | null;
  // Replacement / free-shipment flag — when true, revenue is locked at $0
  // and we never fall back to estimated/snapshot/inventory price. See
  // src/lib/sales/replacementOrder.ts.
  is_replacement?: boolean | null;
  order_type?: string | null;
}

export interface FeeCache {
  fbaFeeFixed: number;
  referralRate: number;
  isMedia?: boolean;
}

export interface GrossSalesResult {
  totalSale: number | null;
  source: 'actual' | 'snapshot' | 'estimated' | 'inventory' | null;
  priceMissing: boolean;
}

export interface FeesResult {
  referralFee: number | null;
  fbaFee: number | null;
  closingFee: number | null;
  totalFees: number | null;
  source: 'actual' | 'cache' | null;
  feesMissing: boolean;
}

/**
 * Amazon-funded promotional rebate captured per-row by sync-sales-orders /
 * backfill-promotional-discount (Orders API → OrderItem.PromotionDiscount).
 *
 * Why this exists: every "revenue/profit/ROI" formula in the app must net out
 * promo rebates so Sellerboard parity holds. FEC-side rebates
 * (`financial_events_cache.promotional_rebates`) cover Amazon-initiated promos
 * (lightning deals / marketplace coupons, esp MX/CA/BR) and are subtracted by
 * the period totals + live-sales-core. THIS helper covers the per-order Orders
 * API path so getLineRevenue + per-ASIN popups don't overstate revenue.
 *
 * CURRENCY SAFETY: sold_price from orders_itemprice is USD (US). For non-US
 * marketplaces sold_price is still stored USD (memory: currency-contract-v1
 * "flip pending") but promotion_discount is captured NATIVE
 * (promotion_discount_currency = MX/CA/BR currency). To avoid mixing currencies
 * we ONLY subtract when both sides share USD basis:
 *   • marketplace === 'US', OR
 *   • promotion_discount_currency === 'USD'.
 * For non-US the FEC path (USD-normalized) is the source of truth and is
 * already wired into PeriodStatsBlocks / live-sales-core / Dashboard MTD.
 */
export function getOrderPromoUsd(row: {
  promotion_discount?: number | null;
  promotion_discount_currency?: string | null;
  marketplace?: string | null;
}): number {
  const promo = Number(row.promotion_discount || 0);
  if (!(promo > 0)) return 0;
  const mp = String(row.marketplace || '').toUpperCase();
  const curr = String(row.promotion_discount_currency || '').toUpperCase();
  if (mp === 'US' || curr === 'USD') return promo;
  return 0;
}



/**
 * Get gross sales for a single order - SINGLE SOURCE OF TRUTH
 * Used by BOTH PeriodStatsBlocks and Sales.tsx
 * 
 * PRICING PRIORITY (ChatGPT approved - Jan 2026):
 * 1. sold_price / item_price / total_sale_amount > 0 → use it (actual settled sale)
 * 2. snapshot_item_price from order_price_snapshots (frozen at discovery) - NEW!
 * 3. estimated_price from sales_orders (DB cache)
 * 4. inventory.price (live fallback - last resort)
 * 5. Otherwise → NULL (not 0!) and mark price_missing=true
 * 
 * RATIONALE: Snapshot price captures the listing price at the MOMENT of order
 * discovery. This prevents the "$40 then $50 same day both show $50" problem.
 * Inventory price is a LAST RESORT because it changes live and would corrupt
 * historical accuracy for pending orders.
 */
export function getGrossSalesForOrder(
  order: SaleOrder,
  inventoryMap: Map<string, InventoryInfo>,
  showEstimatedPrices: boolean,
  snapshotMap?: Map<string, PriceSnapshot>,
  allowLiveInventoryFallback: boolean = true,
  strictMode: boolean = false
): GrossSalesResult {
  const qty = order.quantity || 1;
  const orderId = order.order_id || '';

  // REPLACEMENT / FREE SHIPMENT: revenue is locked at $0. Never fall back
  // to estimated/snapshot/inventory price — Amazon explicitly shipped this
  // unit for free. COGS is still applied downstream so profit goes negative.
  const isReplacement =
    order.is_replacement === true ||
    (order.order_type || '').toLowerCase().includes('replacement') ||
    (order.order_type || '').toLowerCase().includes('exchange');
  if (isReplacement) {
    return { totalSale: 0, source: 'actual', priceMissing: false };
  }


  // STRICT MODE (Live Sales): only CONFIRMED + HIGH_CONFIDENCE_PENDING are accepted.
  // Market-derived hints (Keepa, competitor BB, live inventory.price) are rejected
  // so callers can show "—" instead of a wrong number.
  const ps = (order.price_source || '').toLowerCase();
  const pc = (order.price_confidence || '').toUpperCase();
  const isLowConfidenceHint =
    pc === 'LOW_CONFIDENCE_HINT' ||
    ps.startsWith('hint:') ||
    ps.startsWith('pricing_api_') ||
    ps.startsWith('estimated:keepa') ||
    ps.startsWith('estimated:inventory') ||
    ps.startsWith('estimated:amazon_price') ||
    ps.startsWith('estimated:my_price') ||
    ps.startsWith('estimated:buy_box');

  // Priority 1: sold_price (Principal only) — matches Sellerboard methodology
  if (order.sold_price > 0) {
    return { totalSale: order.sold_price * qty, source: 'actual', priceMissing: false };
  }
  // Priority 2: total_sale_amount as fallback when sold_price missing but settlement exists
  if (order.total_sale_amount > 0) {
    return { totalSale: order.total_sale_amount, source: 'actual', priceMissing: false };
  }

  const isUnsettled = (order.sold_price || 0) === 0 && (order.total_sale_amount || 0) === 0;

  if (isUnsettled && showEstimatedPrices) {
    // Priority 3: Snapshot price — seller-derived
    const snapshotKey = `${orderId}:${order.asin}`;
    const snapshot = snapshotMap?.get(snapshotKey);
    if (snapshot?.snapshot_item_price && snapshot.snapshot_item_price > 0) {
      return { totalSale: snapshot.snapshot_item_price * qty, source: 'snapshot' as const, priceMissing: false };
    }

    // Priority 4: DB estimated_price. Strict mode rejects low-confidence hints.
    const estimatedPrice = Number(order.estimated_price || 0);
    if (estimatedPrice > 0 && !(strictMode && isLowConfidenceHint)) {
      return { totalSale: estimatedPrice * qty, source: 'estimated', priceMissing: false };
    }

    // Priority 5: LIVE inventory.price (last resort) — never in strict mode.
    if (allowLiveInventoryFallback && !strictMode) {
      const invInfo = inventoryMap.get(order.asin);
      const invPrice = invInfo?.price ?? invInfo?.amazon_price ?? null;
      if (typeof invPrice === 'number' && invPrice > 0) {
        return { totalSale: invPrice * qty, source: 'inventory', priceMissing: false };
      }
    }
  }
  
  // No valid price - return NULL (not 0!)
  return {
    totalSale: null,
    source: null,
    priceMissing: true,
  };
}

/**
 * Get fees for a single order - SINGLE SOURCE OF TRUTH
 * Used by BOTH PeriodStatsBlocks and Sales.tsx
 * 
 * Priority:
 * 1. If actual DB fees exist (referral_fee > 0 || fba_fee > 0) → use them
 * 2. If asin_fee_cache exists for this ASIN → calculate from cache
 * 3. Otherwise → NULL (not 0!) and mark fees_missing=true
 */
export function getFeesForOrder(
  order: SaleOrder,
  priceToUse: number | null,
  feeCache: FeeCache | null
): FeesResult {
  const qty = order.quantity || 1;
  
  // Priority 1: Actual fees from DB (from settled orders or already enriched)
  const dbReferralFee = Number(order.referral_fee || 0);
  const dbFbaFee = Number(order.fba_fee || 0);
  const dbClosingFee = Number(order.closing_fee || 0);
  
  if (dbReferralFee > 0 || dbFbaFee > 0) {
    return {
      referralFee: dbReferralFee,
      fbaFee: dbFbaFee,
      closingFee: dbClosingFee,
      totalFees: dbReferralFee + dbFbaFee + dbClosingFee,
      source: 'actual',
      feesMissing: false,
    };
  }
  
  // Priority 2: Calculate from asin_fee_cache if available
  if (feeCache && priceToUse && priceToUse > 0) {
    const referralFee = priceToUse * feeCache.referralRate * qty;
    const fbaFee = feeCache.fbaFeeFixed * qty;
    const closingFee = feeCache.isMedia ? 1.80 * qty : 0;
    
    return {
      referralFee: Math.round(referralFee * 100) / 100,
      fbaFee: Math.round(fbaFee * 100) / 100,
      closingFee: Math.round(closingFee * 100) / 100,
      totalFees: Math.round((referralFee + fbaFee + closingFee) * 100) / 100,
      source: 'cache',
      feesMissing: false,
    };
  }
  
  // No valid fees - return NULL (not 0!)
  return {
    referralFee: null,
    fbaFee: null,
    closingFee: null,
    totalFees: null,
    source: null,
    feesMissing: true,
  };
}

/**
 * Calculate estimated fees using asin_fee_cache - NO FALLBACK DEFAULTS
 * Returns null if no cache available (strict accounting rule)
 */
export function calculateEstimatedFeesFromCache(
  price: number,
  quantity: number,
  feeCache: FeeCache | null
): { referralFee: number; fbaFee: number; closingFee: number; totalFees: number } | null {
  if (!feeCache || !price || price <= 0) {
    return null; // STRICT: No cache = no estimate
  }
  
  const referralFee = price * feeCache.referralRate * quantity;
  const fbaFee = feeCache.fbaFeeFixed * quantity;
  const closingFee = feeCache.isMedia ? 1.80 * quantity : 0;
  const totalFees = referralFee + fbaFee + closingFee;
  
  return {
    referralFee: Math.round(referralFee * 100) / 100,
    fbaFee: Math.round(fbaFee * 100) / 100,
    closingFee: Math.round(closingFee * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
  };
}

/**
 * Sum gross sales for a collection of orders
 * Excludes orders with NULL price from the total
 * 
 * NEW: Accepts optional snapshotMap for accurate pending order pricing
 */
export function sumGrossSales(
  orders: SaleOrder[],
  inventoryMap: Map<string, InventoryInfo>,
  showEstimatedPrices: boolean,
  snapshotMap?: Map<string, PriceSnapshot>,
  allowLiveInventoryFallback: boolean = true,
  strictMode: boolean = false
): { total: number; countWithPrice: number; countMissingPrice: number } {
  let total = 0;
  let countWithPrice = 0;
  let countMissingPrice = 0;
  
  for (const order of orders) {
    const result = getGrossSalesForOrder(order, inventoryMap, showEstimatedPrices, snapshotMap, allowLiveInventoryFallback, strictMode);
    if (result.totalSale !== null) {
      total += result.totalSale;
      countWithPrice++;
    } else {
      countMissingPrice++;
    }
  }
  
  return { total, countWithPrice, countMissingPrice };
}

/**
 * Helper to build snapshot lookup key
 */
export function buildSnapshotKey(orderId: string, asin: string): string {
  return `${orderId}:${asin}`;
}

/**
 * Helper to convert snapshot array to lookup map
 */
export function buildSnapshotMap(snapshots: Array<{ order_id: string; asin: string; snapshot_item_price: number | null; snapshot_shipping_price: number | null; snapshot_source: string; currency_code?: string }>): Map<string, PriceSnapshot> {
  const map = new Map<string, PriceSnapshot>();
  for (const s of snapshots) {
    const key = buildSnapshotKey(s.order_id, s.asin);
    map.set(key, {
      snapshot_item_price: s.snapshot_item_price,
      snapshot_shipping_price: s.snapshot_shipping_price,
      snapshot_source: s.snapshot_source,
      currency_code: s.currency_code,
    });
  }
  return map;
}
