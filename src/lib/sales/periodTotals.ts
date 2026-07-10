/**
 * SINGLE SOURCE OF TRUTH: Period Totals Calculator
 * 
 * This module defines the PeriodTotals interface and computePeriodTotals() function.
 * ALL UI consumers (Blocks, Popup, Table Totals, Export) MUST use PeriodTotals.
 * 
 * NO component should compute sales, fees, refunds, or profit independently.
 * If a number appears on screen, it came from PeriodTotals.
 */

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

/** Fee breakdown matching Sellerboard's 30+ line-item categories */
export interface FeeBreakdown {
  // Fees (positive values = costs)
  fbaFulfillmentFee: number;
  referralFee: number;
  inboundTransportation: number;
  variableClosingFee: number;
  fixedClosingFee: number;
  storageFees: number;
  removalFees: number;
  disposalFees: number;
  longTermStorageFees: number;
  digitalServicesFee: number;
  liquidationsBrokerageFee: number;
  compensatedClawback: number;
  hrrNonApparelRollup: number;
  reCommerceGradingCharge: number;
  fbaCustomerReturnFee: number;
  otherFees: number;
  amazonOtherFees: number;
  inboundDelta: number;
  // Credits (positive values = reduce net fees)
  freeReplacementRefundItems: number;
  liquidationsRevenue: number;
  warehouseDamage: number;
  warehouseLost: number;
  reversalReimbursement: number;
  otherReimbursements: number;
  otherIncome: number;
  // Totals
  totalFees: number;
  totalCredits: number;
  netAmazonFees: number;
  // Metadata
  eventCount: number;
  dateRangeUsed: string;
}

/** Refund breakdown from financial_events_cache */
export interface RefundBreakdown {
  refundedAmount: number;
  refundedReferralFee: number;
  refundedOtherFees: number;
  refundEventCount: number;
  /**
   * Amazon retention per refund event: min($5.00, 20% × |referral_fee|).
   * Not in FEC — synthesized by `src/lib/sales/refundMath.ts`.
   * Optional for backward compat; defaults to 0 in legacy callers.
   * See .lovable/architecture-audit.md §1.2.
   */
  refundAdminRetention?: number;
}

/** Net Sales breakdown (Sellerboard-style) */
export interface NetSalesBreakdown {
  grossSales: number;
  promotionalRebates: number;
  shippingCredits: number;
  giftWrapCredits: number;
  netSales: number;
}

/** Record-level fees (from actual DB order records, no estimates) */
export interface RecordFees {
  totalFees: number;
  fbaFee: number;
  referralFee: number;
  closingFee: number;
}

/**
 * THE authoritative period totals object.
 * Every UI surface reads from this. No exceptions.
 */
export interface PeriodTotals {
  // Identity
  periodId: string;
  periodStart: string;
  periodEnd: string;
  
  // Revenue
  salesPrincipal: number;       // Gross Sales (sold_price only)
  shippingCredits: number;      // Display-only revenue
  giftWrapCredits: number;      // Display-only revenue
  promoRebates: number;         // ALWAYS deducted from profit
  
  // Counts
  units: number;
  orders: number;
  refundCount: number;
  
  // Fees
  amazonFeesNet: number;        // Single authoritative fee total for profit calc
  feeBreakdown: FeeBreakdown;   // Itemized for popup display
  recordFees: RecordFees;       // DB-only fees (no cache estimates)
  
  // Refunds
  refundCostTotal: number;      // refundedAmount - refundedReferralFee
  refundBreakdown: RefundBreakdown;
  
  // Cost of Goods
  cogsTotal: number;
  
  // Expenses
  expenses: number;
  inboundFees: number;
  
  // Computed Profits (THE numbers shown everywhere)
  grossProfit: number;
  netProfit: number;
  estPayout: number;
  
  // Metrics
  roi: number;
  margin: number;
  refundPercent: number;
  avgOrderValue: number;
  avgUnitPrice: number;
  profitPerUnit: number;
  
  // Net Sales breakdown for display
  netSalesBreakdown: NetSalesBreakdown;
  
  // Metadata
  cancelledOrders: number;
  pendingStatusCheck: number;
  pendingEnrichment?: { orders: number; units: number };
}

// ════════════════════════════════════════════════════════════════════════
// INPUT INTERFACE — what callers pass to computePeriodTotals
// ════════════════════════════════════════════════════════════════════════

export interface ComputePeriodTotalsInput {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  
  // Revenue metrics (from the ONE authoritative data source for this period)
  salesPrincipal: number;
  shippingCredits: number;
  giftWrapCredits: number;
  promoRebates: number;
  
  // Counts
  units: number;
  orders: number;
  refundCount: number;
  
  // Fees — caller decides which source, but only ONE source
  amazonFeesNet: number;
  feeBreakdown: FeeBreakdown;
  recordFees: RecordFees;
  
  // Refunds
  refundBreakdown: RefundBreakdown;
  
  // COGS
  cogsTotal: number;
  
  // Expenses
  expenses: number;
  inboundFees: number;
  
  // Metadata
  cancelledOrders?: number;
  pendingStatusCheck?: number;
  pendingEnrichment?: { orders: number; units: number };
}

// ════════════════════════════════════════════════════════════════════════
// CALCULATOR — The ONE function that computes all derived values
// ════════════════════════════════════════════════════════════════════════

/**
 * computePeriodTotals — THE single calculator for all period metrics.
 * 
 * FORMULA (Sellerboard-aligned):
 *   Gross Profit = Sales - Promo Rebates - Amazon Fees (Net) - Refund Cost - COGS
 *   Net Profit   = Gross Profit - Expenses
 *   Est. Payout  = Sales - Amazon Fees - Refund Cost
 * 
 * Every component (blocks, popup, table footer, export) MUST call this.
 * No component may compute profit independently.
 */
export function computePeriodTotals(input: ComputePeriodTotalsInput): PeriodTotals {
  const {
    periodId, periodStart, periodEnd,
    salesPrincipal, shippingCredits, giftWrapCredits, promoRebates,
    units, orders, refundCount,
    amazonFeesNet, feeBreakdown, recordFees,
    refundBreakdown,
    cogsTotal,
    expenses, inboundFees,
    cancelledOrders = 0,
    pendingStatusCheck = 0,
    pendingEnrichment,
  } = input;

  // Canonical NET refund cost = principal − referral credit + admin retention.
  // See src/lib/sales/refundMath.ts and architecture-audit.md §1.2.
  // refundAdminRetention is optional (default 0) for legacy callers.
  const safeRefundedAmount = Number(refundBreakdown.refundedAmount || 0);
  const safeRefundedReferralFee = Number(refundBreakdown.refundedReferralFee || 0);
  const safeRefundAdmin = Number(refundBreakdown.refundAdminRetention || 0);
  const refundCostTotal = safeRefundedAmount - safeRefundedReferralFee + safeRefundAdmin;

  // Guard all inputs against NaN
  const safeSales = Number.isFinite(salesPrincipal) ? salesPrincipal : 0;
  const safeShipping = Number.isFinite(shippingCredits) ? shippingCredits : 0;
  const safePromo = Number.isFinite(promoRebates) ? promoRebates : 0;
  const safeFees = Number.isFinite(amazonFeesNet) ? amazonFeesNet : 0;
  const safeCogs = Number.isFinite(cogsTotal) ? cogsTotal : 0;
  const safeExpenses = Number.isFinite(expenses) ? expenses : 0;

  // ─── PROFIT CALCULATION (Sellerboard formula + shipping credits as income) ───
  // Net Profit = Gross Sales - Refunds - Amazon Fees - COGS - Promo Rebates - Expenses
  const grossProfit = safeSales + safeShipping - safePromo - safeFees - refundCostTotal - safeCogs;
  const netProfit = grossProfit - safeExpenses;
  const estPayout = safeSales + safeShipping - safeFees - refundCostTotal;

  // ─── METRICS ───
  const roi = cogsTotal > 0 ? (grossProfit / cogsTotal) * 100 : 0;
  const margin = salesPrincipal > 0 ? (grossProfit / salesPrincipal) * 100 : 0;
  const refundPercent = salesPrincipal > 0 ? (refundBreakdown.refundedAmount / salesPrincipal) * 100 : 0;
  const avgOrderValue = orders > 0 ? salesPrincipal / orders : 0;
  const avgUnitPrice = units > 0 ? salesPrincipal / units : 0;
  const profitPerUnit = units > 0 ? grossProfit / units : 0;

  // Net Sales breakdown
  const netSalesBreakdown: NetSalesBreakdown = {
    grossSales: salesPrincipal,
    promotionalRebates: promoRebates,
    shippingCredits,
    giftWrapCredits,
    netSales: salesPrincipal - promoRebates,
  };

  return {
    periodId, periodStart, periodEnd,
    salesPrincipal, shippingCredits, giftWrapCredits, promoRebates,
    units, orders, refundCount,
    amazonFeesNet, feeBreakdown, recordFees,
    refundCostTotal, refundBreakdown,
    cogsTotal,
    expenses, inboundFees,
    grossProfit, netProfit, estPayout,
    roi, margin, refundPercent, avgOrderValue, avgUnitPrice, profitPerUnit,
    netSalesBreakdown,
    cancelledOrders, pendingStatusCheck, pendingEnrichment,
  };
}

// ════════════════════════════════════════════════════════════════════════
// EMPTY DEFAULTS — reusable zero-value objects
// ════════════════════════════════════════════════════════════════════════

export const EMPTY_FEE_BREAKDOWN: FeeBreakdown = {
  fbaFulfillmentFee: 0, referralFee: 0, inboundTransportation: 0,
  variableClosingFee: 0, fixedClosingFee: 0, storageFees: 0,
  removalFees: 0, disposalFees: 0, longTermStorageFees: 0,
  digitalServicesFee: 0, liquidationsBrokerageFee: 0, compensatedClawback: 0,
  hrrNonApparelRollup: 0, reCommerceGradingCharge: 0, fbaCustomerReturnFee: 0,
  otherFees: 0, amazonOtherFees: 0, inboundDelta: 0,
  freeReplacementRefundItems: 0, liquidationsRevenue: 0,
  warehouseDamage: 0, warehouseLost: 0,
  reversalReimbursement: 0, otherReimbursements: 0, otherIncome: 0,
  totalFees: 0, totalCredits: 0, netAmazonFees: 0,
  eventCount: 0, dateRangeUsed: '',
};

export const EMPTY_REFUND_BREAKDOWN: RefundBreakdown = {
  refundedAmount: 0, refundedReferralFee: 0,
  refundedOtherFees: 0, refundEventCount: 0,
  refundAdminRetention: 0,
};

export const EMPTY_RECORD_FEES: RecordFees = {
  totalFees: 0, fbaFee: 0, referralFee: 0, closingFee: 0,
};

// ════════════════════════════════════════════════════════════════════════
// RUNTIME ASSERTION — log if block ≠ popup by > $0.01
// ════════════════════════════════════════════════════════════════════════

/**
 * Call this after rendering both block and popup to verify consistency.
 * Logs a WARNING if any metric diverges by more than $0.01.
 */
export function assertPeriodConsistency(
  label: string,
  blockTotals: Pick<PeriodTotals, 'salesPrincipal' | 'amazonFeesNet' | 'refundCostTotal' | 'grossProfit' | 'netProfit'>,
  popupTotals: Pick<PeriodTotals, 'salesPrincipal' | 'amazonFeesNet' | 'refundCostTotal' | 'grossProfit' | 'netProfit'>
): void {
  const checks = [
    { name: 'Sales', a: blockTotals.salesPrincipal, b: popupTotals.salesPrincipal },
    { name: 'Amazon Fees', a: blockTotals.amazonFeesNet, b: popupTotals.amazonFeesNet },
    { name: 'Refund Cost', a: blockTotals.refundCostTotal, b: popupTotals.refundCostTotal },
    { name: 'Gross Profit', a: blockTotals.grossProfit, b: popupTotals.grossProfit },
    { name: 'Net Profit', a: blockTotals.netProfit, b: popupTotals.netProfit },
  ];

  for (const check of checks) {
    const diff = Math.abs(check.a - check.b);
    if (diff > 0.01) {
      console.warn(
        `[PeriodTotals MISMATCH] ${label} → ${check.name}: ` +
        `block=$${check.a.toFixed(2)} vs popup=$${check.b.toFixed(2)} (Δ$${diff.toFixed(2)})`
      );
    }
  }
}
