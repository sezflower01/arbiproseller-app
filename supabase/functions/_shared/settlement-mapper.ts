// Maps a Settlement Report V2 row to a P&L category.
// Based on Amazon SP-API V2 flat file documentation + a2x mapping rules.

export type SettlementRow = {
  'transaction-type'?: string;
  'amount-type'?: string;
  'amount-description'?: string;
  amount?: string;
  'fulfillment-id'?: string;
  'posted-date-time'?: string;
  'posted-date'?: string;
  'order-id'?: string;
  'shipment-id'?: string;
  'marketplace-name'?: string;
  sku?: string;
  'merchant-order-id'?: string;
  'quantity-purchased'?: string;
  [k: string]: string | undefined;
};

export type Mapped = {
  category: string;
  amount: number;
};

// Parse amount string handling EU comma format ("95,00") and dot format ("95.00")
export function parseAmount(s?: string): number {
  if (!s) return 0;
  const t = s.trim().replace(/\s/g, '');
  if (!t) return 0;
  // If contains both comma and dot, comma is thousand separator (US format)
  if (t.includes(',') && t.includes('.')) {
    return parseFloat(t.replace(/,/g, '')) || 0;
  }
  // If only comma, treat as decimal separator (EU format)
  if (t.includes(',') && !t.includes('.')) {
    return parseFloat(t.replace(',', '.')) || 0;
  }
  return parseFloat(t) || 0;
}

export function parsePostedDate(row: SettlementRow): string | null {
  const raw = row['posted-date-time'] || row['posted-date'];
  if (!raw) return null;
  // Handle "YYYY-MM-DD HH:MM:SS UTC", ISO, or "MM/DD/YYYY"
  let s = raw.trim().replace(' UTC', 'Z').replace(' ', 'T');
  let d = new Date(s);
  if (isNaN(d.getTime())) {
    // try MM/DD/YYYY
    const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) d = new Date(`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`);
  }
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Map a settlement V2 row to one of our P&L categories.
 * Returns null if the row should be ignored (e.g. transfer rows, tax that we already track elsewhere, etc.)
 */
export function mapSettlementRow(row: SettlementRow): Mapped | null {
  const tt = (row['transaction-type'] || '').toLowerCase().trim();
  const at = (row['amount-type'] || '').toLowerCase().trim();
  const ad = (row['amount-description'] || '').toLowerCase().trim();
  const fid = (row['fulfillment-id'] || '').toUpperCase().trim();
  const amount = parseAmount(row.amount);

  if (!amount && !tt) return null;

  // === SALES ===
  if (tt === 'order' && at === 'itemprice' && ad === 'principal') {
    return { category: 'sales', amount };
  }
  if (tt === 'order' && at === 'itemprice' && ad === 'shipping') {
    return { category: 'shipping_credits', amount };
  }
  if (tt === 'order' && at === 'itemprice' && (ad === 'giftwrap' || ad === 'gift wrap')) {
    return { category: 'gift_wrap_credits', amount };
  }
  if (tt === 'order' && at === 'promotion') {
    return { category: 'promotional_rebates', amount };
  }

  // === REFUNDS ===
  if (tt === 'refund' && at === 'itemprice' && ad === 'principal') {
    return { category: 'refunds', amount };
  }
  if (tt === 'refund' && at === 'itemprice' && ad === 'shipping') {
    return { category: 'shipping_credit_refunds', amount };
  }
  if (tt === 'refund' && at === 'promotion') {
    return { category: 'promotional_rebate_refunds', amount };
  }

  // === FEES (Order/Refund-related) ===
  if (at === 'itemfees' && ad === 'commission') {
    return { category: 'referral_fees', amount };
  }
  if (at === 'itemfees' && (ad.includes('fbaperunitfulfillment') || ad === 'fbaperunitfulfillmentfee')) {
    return { category: 'fba_fees', amount };
  }
  if (at === 'itemfees' && ad === 'variableclosingfee') {
    return { category: 'variable_closing_fees', amount };
  }
  if (at === 'itemfees' && ad === 'fixedclosingfee') {
    return { category: 'fixed_closing_fees', amount };
  }
  if (at === 'itemfees' && ad === 'shippingchargeback') {
    return { category: 'shipping_chargeback', amount };
  }

  // === SERVICE FEES (the critical missing piece for InventoryLab parity) ===
  if (tt === 'servicefee' || tt === 'service fee' || at === 'servicefee') {
    if (ad.includes('storage') && ad.includes('long')) {
      return { category: 'fba_long_term_storage_fees', amount };
    }
    if (ad.includes('storage')) {
      return { category: 'fba_storage_fees', amount };
    }
    if (ad.includes('removal')) {
      return { category: 'fba_removal_fees', amount };
    }
    if (ad.includes('disposal')) {
      return { category: 'fba_disposal_fees', amount };
    }
    if (ad.includes('inbound')) {
      return { category: 'fba_inbound_fees', amount };
    }
    if (ad.includes('subscription')) {
      return { category: 'subscription_fees', amount };
    }
    return { category: 'other_fees', amount };
  }

  // === FBA WAREHOUSE FEES (top-level transaction-type categories) ===
  if (tt === 'fba inventory fee' || tt === 'storage fee' || tt === 'fbainventoryfee') {
    if (ad.includes('long')) return { category: 'fba_long_term_storage_fees', amount };
    return { category: 'fba_storage_fees', amount };
  }
  if (tt === 'removalcomplete' || tt.includes('removal')) {
    return { category: 'fba_removal_fees', amount };
  }
  if (tt === 'disposalcomplete' || tt.includes('disposal')) {
    return { category: 'fba_disposal_fees', amount };
  }

  // === LIQUIDATIONS ===
  if (tt === 'liquidations' && at === 'itemprice' && ad === 'principal') {
    return { category: 'liquidations', amount };
  }
  if (tt === 'liquidations' && at === 'itemfees') {
    return { category: 'liquidations_brokerage_fee', amount };
  }

  // === REIMBURSEMENTS ===
  if (at === 'fba inventory reimbursement' || ad.includes('inventoryreimbursement') || tt === 'adjustment' && ad.includes('reimbursement')) {
    return { category: 'reimbursements', amount };
  }

  // === TAXES (collected/refunded — for InventoryLab parity) ===
  if (at === 'itemwithheldtax' || ad === 'marketplacefacilitatortax-principal') {
    return { category: 'marketplace_facilitator_tax', amount };
  }
  if (at === 'itemprice' && ad === 'tax') {
    return { category: 'sales_tax_collected', amount };
  }

  // === OTHER (catch-all for adjustments, chargebacks, misc service fees) ===
  if (tt === 'adjustment' || tt === 'other') {
    return { category: 'other_fees', amount };
  }

  return null;
}

export const SETTLEMENT_CATEGORIES = [
  'sales','refunds','shipping_credits','shipping_credit_refunds',
  'gift_wrap_credits','promotional_rebates','promotional_rebate_refunds',
  'referral_fees','fba_fees','variable_closing_fees','fixed_closing_fees',
  'shipping_chargeback','fba_storage_fees','fba_long_term_storage_fees',
  'fba_removal_fees','fba_disposal_fees','fba_inbound_fees',
  'subscription_fees','other_fees','liquidations','liquidations_brokerage_fee',
  'reimbursements','marketplace_facilitator_tax','sales_tax_collected',
];
