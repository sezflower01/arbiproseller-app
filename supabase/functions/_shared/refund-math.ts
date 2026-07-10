/**
 * Deno mirror of src/lib/sales/refundMath.ts.
 * Keep BIT-IDENTICAL to the frontend module — these two files form
 * the single source of truth for refund math across the entire stack.
 *
 * If you change one, change the other in the same commit.
 * See .lovable/architecture-audit.md §1.2 for the verified bug history.
 */

export interface FecRefundRow {
  amazon_order_id?: string | null;
  asin?: string | null;
  marketplace?: string | null;
  event_date?: string | null;
  refunds?: number | string | null;
  promotional_rebate_refunds?: number | string | null;
  shipping_credit_refunds?: number | string | null;
  shipping_chargeback_refund?: number | string | null;
  gift_wrap_credit_refunds?: number | string | null;
  referral_fees?: number | string | null;
  fba_fees?: number | string | null;
  fba_customer_return_fees?: number | string | null;
  restocking_fee?: number | string | null;
  other_fees?: number | string | null;
  digital_services_fee?: number | string | null;
  reversal_reimbursement?: number | string | null;
}

export type RefundFormulaMode = 'simple' | 'full';

export interface CanonicalRefundTotals {
  principalRefunded: number;
  referralFeeCreditPositive: number;
  refundAdminRetention: number;
  refundCostNet: number;
  refundEventCount: number;
  refundOrderCount: number;
  mode: RefundFormulaMode;
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export function computeNetRefundFromFecRows(
  rows: FecRefundRow[] | null | undefined,
  mode: RefundFormulaMode = 'full',
): CanonicalRefundTotals {
  const out: CanonicalRefundTotals = {
    principalRefunded: 0,
    referralFeeCreditPositive: 0,
    refundAdminRetention: 0,
    refundCostNet: 0,
    refundEventCount: 0,
    refundOrderCount: 0,
    mode,
  };
  if (!rows || rows.length === 0) return out;
  const orderSet = new Set<string>();
  let signedTotal = 0;

  for (const r of rows) {
    const principal = n(r.refunds);                     // POSITIVE cost in FEC
    const promo = n(r.promotional_rebate_refunds);
    const shipCred = n(r.shipping_credit_refunds);
    const shipCharge = n(r.shipping_chargeback_refund);
    const giftWrap = n(r.gift_wrap_credit_refunds);
    const referralSigned = n(r.referral_fees);          // NEGATIVE credit in FEC
    const referralPositive = Math.abs(referralSigned);
    const admin = Math.min(5.0, referralPositive * 0.20);

    let signedSum =
      principal + promo + shipCred + shipCharge + giftWrap +
      referralSigned + admin;

    if (mode === 'full') {
      signedSum +=
        n(r.fba_fees) +
        n(r.fba_customer_return_fees) +
        n(r.restocking_fee) +
        n(r.other_fees) +
        n(r.digital_services_fee) +
        n(r.reversal_reimbursement);
    }

    out.principalRefunded += Math.abs(principal);
    out.referralFeeCreditPositive += referralPositive;
    out.refundAdminRetention += admin;
    signedTotal += signedSum;
    out.refundEventCount += 1;
    if (r.amazon_order_id) orderSet.add(String(r.amazon_order_id));
  }

  out.refundCostNet = Math.max(0, signedTotal);
  out.refundOrderCount = orderSet.size;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  out.principalRefunded = r2(out.principalRefunded);
  out.referralFeeCreditPositive = r2(out.referralFeeCreditPositive);
  out.refundAdminRetention = r2(out.refundAdminRetention);
  out.refundCostNet = r2(out.refundCostNet);
  return out;
}
