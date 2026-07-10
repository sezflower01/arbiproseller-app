// Promo USD-safety tripwire.
//
// Why: `sales_orders.promotion_discount` is stored NATIVE (per the Sales Currency
// Contract). Different read paths (Live Sales core, PeriodStatsBlocks, P&L) treat
// it differently — some convert to USD via marketplaceCurrency, others do not.
// While the column is universally zero in production today, the moment a non-US
// promo lands the downstream surfaces could disagree.
//
// This tripwire converts the dormant architectural risk into an active signal
// WITHOUT changing any promo math. It fires once per (user, order) when a
// non-US marketplace writes a non-zero promotion_discount.
//
// Marker: PROMO_NON_US_SO_DISCOUNT_DETECTED
// Action if it fires: open .lovable/architecture-audit.md §12 and execute the
// promo USD refactor (Live Sales core, PeriodStatsBlocks, P&L parity).
//
// NEVER throws into caller flow.

import { logHealthSignal } from './health-signal.ts';

const NON_US_MARKETPLACES = new Set(['CA', 'MX', 'BR', 'UK', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'PL', 'BE', 'TR', 'JP', 'AU', 'AE', 'SA', 'EG', 'IN', 'SG']);

export interface PromoTripwireArgs {
  userId: string;
  orderId: string;
  asin?: string | null;
  marketplace?: string | null;
  promotionDiscount: number;          // stored value (currently native)
  currency?: string | null;
  sourceFunction: string;             // e.g. 'sync-sales-orders:orders_itemprice'
}

/**
 * Returns true if this write would have triggered the tripwire (for tests).
 * Side effect: logs a structured warning + health-signal when firing.
 */
export function maybeFirePromoTripwire(args: PromoTripwireArgs): boolean {
  try {
    const mp = (args.marketplace || '').toUpperCase();
    const amount = Number(args.promotionDiscount) || 0;
    if (amount <= 0) return false;
    if (!mp || mp === 'US') return false;
    if (!NON_US_MARKETPLACES.has(mp)) return false;

    const payload = {
      marker: 'PROMO_NON_US_SO_DISCOUNT_DETECTED',
      user_id: args.userId,
      order_id: args.orderId,
      asin: args.asin || null,
      marketplace: mp,
      promotion_discount: amount,
      currency: args.currency || null,
      source: args.sourceFunction,
      timestamp: new Date().toISOString(),
    };
    console.warn(`🚨 PROMO_NON_US_SO_DISCOUNT_DETECTED ${JSON.stringify(payload)}`);

    // Fire-and-forget health signal (deduped by pattern+function in DB).
    void logHealthSignal({
      user_id: args.userId,
      module: 'sales_pnl',
      severity: 'warning',
      confidence: 'high',
      pattern: `promo_non_us_so_discount_detected:${mp}`,
      title: `Non-US promo discount captured (${mp})`,
      impact:
        'sales_orders.promotion_discount is stored native; some Live Sales / P&L paths do not USD-convert. Profit may differ across surfaces until the promo USD refactor ships.',
      recommended_fix:
        'Execute promo USD refactor (see .lovable/architecture-audit.md §12). Until then, treat non-US promo totals as approximate.',
      entity: { order_id: args.orderId, asin: args.asin || undefined, marketplace: mp },
      function_name: args.sourceFunction,
      source: 'promo_tripwire',
      raw_message: `promotion_discount=${amount} ${args.currency || ''}`,
    });

    return true;
  } catch (_e) {
    // Never break caller flow.
    return false;
  }
}
