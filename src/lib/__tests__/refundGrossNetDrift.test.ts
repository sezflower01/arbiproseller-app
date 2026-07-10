/**
 * Regression test for the Refund GROSS vs NET drift bug.
 *
 * Originally three formulas coexisted (verified 2026-06-17 against production
 * `financial_events_cache`, 386 refund events / 180-day window):
 *
 *   • PeriodStatsBlocks paths       → GROSS principal only  ($101.84)
 *   • canonical periodTotals (old)  → principal − referral  ($89.62)
 *   • Live Sales / Mobile           → principal − referral + admin ($92.06)
 *
 * After the unification (this commit), the canonical formula in
 * `src/lib/sales/periodTotals.ts` is:
 *
 *   refundCostTotal = refundedAmount − refundedReferralFee + refundAdminRetention
 *
 * which collapses all three surfaces onto **$92.06** for the verified
 * incident order 111-1115828-9929022 (US, 2026-05-23):
 *
 *   principal = $101.84, referral credit = $12.22, admin retention = $2.44
 *   → 101.84 − 12.22 + 2.44 = 92.06   ✓ matches Live Sales exactly.
 *
 * The shared FEC-row helper lives in `src/lib/sales/refundMath.ts` and is
 * mirrored to `supabase/functions/_shared/refund-math.ts`. The tests below
 * cover:
 *   1. The verified incident (single refund event)
 *   2. Zero referral fee edge case (NET == GROSS, formula must not break)
 *   3. Multiple refund events on the same order (composition is correct)
 *   4. Backward compat: callers that omit refundAdminRetention default to 0
 */

import { describe, it, expect } from 'vitest';
import {
  computePeriodTotals,
  EMPTY_FEE_BREAKDOWN,
  EMPTY_RECORD_FEES,
} from '@/lib/sales/periodTotals';
import {
  computeNetRefundFromFecRows,
  type FecRefundRow,
} from '@/lib/sales/refundMath';

const baseInput = {
  periodId: 'incident-2026-05-23',
  periodStart: '2026-05-23',
  periodEnd: '2026-05-23',
  salesPrincipal: 1000,
  shippingCredits: 0,
  giftWrapCredits: 0,
  promoRebates: 0,
  units: 5,
  orders: 5,
  refundCount: 1,
  amazonFeesNet: 0,
  feeBreakdown: { ...EMPTY_FEE_BREAKDOWN },
  recordFees: { ...EMPTY_RECORD_FEES },
  cogsTotal: 500,
  expenses: 0,
  inboundFees: 0,
};

describe('Refund canonical NET — verified incident 111-1115828-9929022', () => {
  it('unified formula collapses all three surfaces onto $92.06', () => {
    const totals = computePeriodTotals({
      ...baseInput,
      refundBreakdown: {
        refundedAmount: 101.84,           // principal refunded
        refundedReferralFee: 12.22,       // positive credit Amazon returned
        refundedOtherFees: 0,
        refundAdminRetention: 2.44,       // min($5, 20% × $12.22)
        refundEventCount: 1,
      },
    });
    expect(totals.refundCostTotal).toBeCloseTo(92.06, 2);
  });

  it('historical values are documented (Sales Report popup=$101.84 GROSS, canonical-no-admin=$89.62) so any future regression that brings them back will fail this test', () => {
    const totals = computePeriodTotals({
      ...baseInput,
      refundBreakdown: {
        refundedAmount: 101.84,
        refundedReferralFee: 12.22,
        refundedOtherFees: 0,
        refundAdminRetention: 2.44,
        refundEventCount: 1,
      },
    });
    expect(totals.refundCostTotal).not.toBeCloseTo(101.84, 2); // not GROSS
    expect(totals.refundCostTotal).not.toBeCloseTo(89.62, 2);  // not old canonical
    expect(totals.refundCostTotal).toBeCloseTo(92.06, 2);      // unified
  });

  it('shared FEC helper produces the same $92.06 from a raw FEC refund row', () => {
    // FEC sign convention (verified production): refunds POSITIVE, referral_fees NEGATIVE.
    const row: FecRefundRow = {
      amazon_order_id: '111-1115828-9929022',
      asin: 'B0EXAMPLE',
      marketplace: 'US',
      event_date: '2026-05-23',
      refunds: 101.84,                   // POSITIVE cost
      referral_fees: -12.22,             // NEGATIVE credit
      promotional_rebate_refunds: 0,
      shipping_credit_refunds: 0,
      shipping_chargeback_refund: 0,
      gift_wrap_credit_refunds: 0,
      fba_fees: 0,
      fba_customer_return_fees: 0,
      restocking_fee: 0,
      other_fees: 0,
      digital_services_fee: 0,
      reversal_reimbursement: 0,
    };
    const canon = computeNetRefundFromFecRows([row], 'full');
    expect(canon.principalRefunded).toBeCloseTo(101.84, 2);
    expect(canon.referralFeeCreditPositive).toBeCloseTo(12.22, 2);
    expect(canon.refundAdminRetention).toBeCloseTo(2.44, 2);
    expect(canon.refundCostNet).toBeCloseTo(92.06, 2);
  });
});

describe('Refund canonical NET — edge cases', () => {
  it('zero-referral refund: NET == GROSS == principal (formula does not break on the trivial case)', () => {
    const row: FecRefundRow = {
      amazon_order_id: 'EDGE-ZERO-REFERRAL',
      refunds: 25.00,                     // POSITIVE FEC convention
      referral_fees: 0,
    };
    const canon = computeNetRefundFromFecRows([row], 'full');
    expect(canon.principalRefunded).toBeCloseTo(25.00, 2);
    expect(canon.referralFeeCreditPositive).toBe(0);
    expect(canon.refundAdminRetention).toBe(0);
    expect(canon.refundCostNet).toBeCloseTo(25.00, 2);

    const totals = computePeriodTotals({
      ...baseInput,
      refundBreakdown: {
        refundedAmount: canon.principalRefunded,
        refundedReferralFee: canon.referralFeeCreditPositive,
        refundedOtherFees: 0,
        refundAdminRetention: canon.refundAdminRetention,
        refundEventCount: 1,
      },
    });
    expect(totals.refundCostTotal).toBeCloseTo(25.00, 2);
  });

  it('multiple refund events on the same order compose correctly through the helper', () => {
    // Two partial refunds for one order (FEC: refunds POSITIVE, referral_fees NEGATIVE).
    const rows: FecRefundRow[] = [
      {
        amazon_order_id: 'MULTI-EVENT-001',
        refunds: 40.00, referral_fees: -6.00,
      },
      {
        amazon_order_id: 'MULTI-EVENT-001',
        refunds: 10.00, referral_fees: -1.50,
      },
    ];
    const canon = computeNetRefundFromFecRows(rows, 'full');
    expect(canon.refundEventCount).toBe(2);
    expect(canon.refundOrderCount).toBe(1);
    expect(canon.principalRefunded).toBeCloseTo(50.00, 2);
    expect(canon.referralFeeCreditPositive).toBeCloseTo(7.50, 2);
    // Admin retention per event: min(5, 0.20 × 6.00) + min(5, 0.20 × 1.50) = 1.20 + 0.30 = 1.50
    expect(canon.refundAdminRetention).toBeCloseTo(1.50, 2);
    // signedTotal = (40 + -6 + 1.20) + (10 + -1.50 + 0.30) = 35.20 + 8.80 = 44.00
    expect(canon.refundCostNet).toBeCloseTo(44.00, 2);
  });

  it('backward compat: callers that omit refundAdminRetention default to 0 and behave like pre-unification canonical', () => {
    const totals = computePeriodTotals({
      ...baseInput,
      refundBreakdown: {
        refundedAmount: 101.84,
        refundedReferralFee: 12.22,
        refundedOtherFees: 0,
        refundEventCount: 1,
        // refundAdminRetention intentionally omitted
      },
    });
    expect(totals.refundCostTotal).toBeCloseTo(89.62, 2); // old canonical
  });
});
