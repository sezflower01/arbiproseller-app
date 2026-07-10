/**
 * Replacement / Free-Shipment Order Helpers
 *
 * Amazon sometimes ships our FBA inventory to a customer at $0 sale price
 * (replacement, exchange, promo). Revenue is $0 but the unit was consumed,
 * so COGS must still be deducted from profit.
 *
 * Detection sources (set by sync-sales-orders / fetch-live-orders):
 *   - orders_api_replacement       (OrderType = Replacement/Exchange/SOD)
 *   - fec_zero_principal_shipped   (Shipped + $0 OrderTotal)
 *   - manual_fix_replacement       (user triggered)
 *   - heuristic_zero_price_afn     (fallback)
 *
 * UI rule:
 *   - revenue shown as "—" (never inferred from estimated/inventory price)
 *   - profit = -(unit_cost * quantity) + any FEC fees if present
 *   - ROI hidden / N/A
 *   - amber "Replacement" badge with tooltip
 */

export interface ReplacementAwareRow {
  is_replacement?: boolean | null;
  replacement_reason?: string | null;
  order_type?: string | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  fulfillment_channel?: string | null;
  is_cancelled?: boolean | null;
  order_status?: string | null;
}

/**
 * THE single boolean every UI / calc surface should consult.
 * Trusts the DB flag first, falls back to legacy order_type string.
 */
export function isReplacementRow(row: ReplacementAwareRow | null | undefined): boolean {
  if (!row) return false;
  if (row.is_replacement === true) return true;
  const ot = (row.order_type || '').toLowerCase();
  if (ot.includes('replacement') || ot.includes('exchange') || ot.includes('sourcingondemand')) {
    return true;
  }
  return false;
}

export interface ReplacementProfit {
  revenue: number;          // always 0 for replacements
  cogs: number;             // unit_cost * quantity (deducted from profit)
  fees: number;             // FEC fees if present, else 0
  netProfit: number;        // revenue - cogs - fees (always <= 0)
  roi: null;                // ROI is N/A for $0 revenue
}

/** Compute the per-row profit impact of a replacement. */
export function computeReplacementProfit(
  unitCost: number | null | undefined,
  quantity: number | null | undefined,
  fecFees: number = 0
): ReplacementProfit {
  const qty = Math.max(1, Number(quantity || 0) || 1);
  const cost = Math.max(0, Number(unitCost || 0)) * qty;
  const fees = Math.max(0, Number(fecFees || 0));
  return {
    revenue: 0,
    cogs: cost,
    fees,
    netProfit: -(cost + fees),
    roi: null,
  };
}

/** Human label for the badge. */
export function replacementLabel(row: ReplacementAwareRow): string {
  const r = row.replacement_reason || '';
  if (r === 'orders_api_replacement') return 'Replacement';
  if (r === 'manual_fix_replacement') return 'Replacement';
  if (r === 'fec_zero_principal_shipped') return 'Free Shipment';
  if (r === 'heuristic_zero_price_afn') return 'Free Shipment';
  if (r === 'replacement_classifier_zero_principal_afn') return 'Free Shipment';
  return 'Replacement';
}

export const REPLACEMENT_TOOLTIP =
  'Amazon shipped your inventory to a customer at $0 revenue (replacement or free shipment). ' +
  'Revenue is $0 but the unit cost is still deducted from profit. ROI is N/A.';
