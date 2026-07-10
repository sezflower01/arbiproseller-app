/**
 * Sellerboard-style MTD Breakdown Component
 * Replicates Sellerboard's 30+ line-item period breakdown exactly.
 * 
 * DISPLAY-ONLY: This component does ZERO calculations.
 * All values come from PeriodTotals (single source of truth).
 */

import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { PeriodTotals, FeeBreakdown, RefundBreakdown, RecordFees, NetSalesBreakdown } from "@/lib/sales/periodTotals";

// Legacy interface for backward compatibility during migration
// TODO: Remove once all callers pass PeriodTotals directly
export interface BreakdownData {
  label: string;
  dateLabel: string;
  sales: number;
  units: number;
  orders: number;
  refunds: number;
  refundAmount: number;
  refundedReferralFee: number;
  totalCost: number;
  expenses: number;
  inboundFees: number;
  estPayout: number;
  netSalesBreakdown?: NetSalesBreakdown;
  feeBreakdown: FeeBreakdown;
  refundsFromCache: RefundBreakdown;
  recordFees: RecordFees;
  unattributedSettledFees?: number; // UNKNOWN marketplace fees (shown separately when filtered)
}

interface SellerboardBreakdownProps {
  data: BreakdownData;
  // ALL of these are pre-computed by the parent from PeriodTotals.
  // This component MUST NOT recompute any of them.
  salesTotal: number;
  unitsTotal: number;
  ordersTotal: number;
  cogsTotal: number;
  amazonFeesNetTotal: number;
  /** Pre-computed refund cost total from parent (must match block formula) */
  refundCostTotal: number;
  /** Pre-computed gross profit from parent (must match block formula) */
  grossProfit: number;
  /** Pre-computed net profit from parent (must match block formula) */
  netProfit: number;
  /** Period ID to determine fee breakdown source (today/yesterday = orders, mtd/month = settlement) */
  periodId?: string;
  /** Whether a marketplace filter is active (to show unattributed fees separately) */
  isMarketplaceFiltered?: boolean;
  /** Home currency symbol for the seller (e.g. "$", "£", "€"). Defaults to "$". */
  currencySymbol?: string;
  className?: string;
}

function fmt(value: number, symbol: string = '$'): string {
  return `${symbol}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(value: number): string {
  return Math.round(value).toLocaleString();
}

// Collapsible section header matching Sellerboard's +/- style
function Section({
  label,
  total,
  color,
  prefix = '',
  children,
  defaultOpen = false,
  badge,
}: {
  label: string;
  total: string;
  color: string;
  prefix?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <div className={cn("flex justify-between items-center py-1.5 border-b border-border/50 cursor-pointer hover:bg-muted/30 rounded px-1 -mx-1 transition-colors")}>
          <span className={cn("font-semibold text-sm flex items-center gap-1.5", color)}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
            {prefix}{label}
            {badge}
          </span>
          <span className={cn("font-bold text-sm", color)}>{total}</span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pl-5 pr-1 py-1 space-y-0.5 text-xs text-muted-foreground">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span>{label}</span>
      <span className={cn("font-medium tabular-nums", color)}>{value}</span>
    </div>
  );
}

export default function SellerboardBreakdown({
  data,
  salesTotal,
  unitsTotal,
  ordersTotal,
  cogsTotal,
  amazonFeesNetTotal,
  refundCostTotal: parentRefundCostTotal,
  grossProfit,
  netProfit,
  periodId,
  isMarketplaceFiltered = false,
  currencySymbol: cs = '$',
  className,
}: SellerboardBreakdownProps) {
  // Create a local fmt that uses the seller's home currency symbol
  const f = (v: number) => fmt(v, cs);
  const fb = data.feeBreakdown;
  const rc = data.refundsFromCache;
  const promoRebates = data.netSalesBreakdown?.promotionalRebates || 0;

  // Determine fee breakdown source:
  // Prefer FEC (Settlement) component breakdown for ANY period when it's been
  // loaded (eventCount > 0 OR any non-zero component). Only fall back to
  // order-level fees when no FEC breakdown is available — this keeps Today /
  // Yesterday / Custom showing referral / FBA / closing rows the moment the
  // settlement data is in.
  const hasFecBreakdown = (fb.eventCount || 0) > 0
    || (fb.fbaFulfillmentFee + fb.referralFee + fb.variableClosingFee + fb.fixedClosingFee + fb.storageFees) > 0
    || (fb.amazonOtherFees || fb.inboundTransportation || fb.removalFees || fb.disposalFees || fb.otherFees || 0) > 0;
  const useOrderFees = !hasFecBreakdown;
  const feeSourceLabel = hasFecBreakdown ? 'Financial Events' : 'Orders estimate';

  // Refund cost breakdown (for display only — profit uses parentRefundCostTotal)
  const refundedAmount = rc.refundedAmount || data.refundAmount;
  const refundCommission = rc.refundedOtherFees || 0;
  const fbaCustomerReturnFee = fb.fbaCustomerReturnFee || 0;
  const refundedReferralFee = rc.refundedReferralFee || data.refundedReferralFee;
  const valueOfReturnedItems = 0; // We don't have this data yet

  // Shipping costs (from fba_inbound_fees or financial events)
  const shippingCostTotal = data.inboundFees || 0;

  // Keep section total aligned with the selected source model.
  const orderFeesBreakdownTotal = data.recordFees.fbaFee + data.recordFees.referralFee + data.recordFees.closingFee;
  const orderFeesFallbackTotal = data.recordFees.totalFees || amazonFeesNetTotal;
  const orderFeesResidual = Math.max(0, orderFeesFallbackTotal - orderFeesBreakdownTotal);
  const orderFeesDisplayTotal = orderFeesBreakdownTotal > 0
    ? Math.max(orderFeesBreakdownTotal, orderFeesFallbackTotal)
    : orderFeesFallbackTotal;

  // Check if feeBreakdown already has populated fee values (e.g. from parity mode unsettled supplement)
  // to avoid double-counting when eventCount is 0 but fb fields are non-zero
  const hasFeeBreakdownValues = (fb.fbaFulfillmentFee + fb.referralFee + fb.variableClosingFee + fb.fixedClosingFee) > 0;
  // Any non-FBA itemized signal proves the breakdown is real (not a lump). If
  // ANY of these are populated, ALWAYS render the itemized branch.
  const hasNonFbaItemization =
    fb.referralFee > 0 || fb.variableClosingFee > 0 || fb.fixedClosingFee > 0 ||
    fb.storageFees > 0 || fb.removalFees > 0 || fb.disposalFees > 0 ||
    fb.longTermStorageFees > 0 || fb.fbaCustomerReturnFee > 0 ||
    fb.digitalServicesFee > 0 || fb.inboundTransportation > 0 ||
    fb.liquidationsBrokerageFee > 0 || fb.compensatedClawback > 0 ||
    fb.hrrNonApparelRollup > 0 || fb.reCommerceGradingCharge > 0 ||
    fb.otherFees > 0 || (fb.amazonOtherFees || 0) > 0 || (fb.inboundDelta || 0) > 0;
  // Collapsed-FBA guard: only triggers for legitimately fee-less sources
  // (no FEC eventCount, no itemized signal at all). MTD/Custom with any FEC
  // data or any itemized field MUST always render the itemized branch.
  const looksLikeCollapsedFbaTotal = !useOrderFees
    && !hasNonFbaItemization
    && (fb.eventCount || 0) === 0
    && orderFeesBreakdownTotal > 0
    && fb.fbaFulfillmentFee > 0
    && Math.abs(fb.fbaFulfillmentFee - (fb.totalFees || amazonFeesNetTotal)) <= 0.01;

  // Reimbursements / credits are NOT Amazon fees — they are Other Income.
  // Display them as a separate section above Gross Profit.
  const otherIncomeTotal = (fb.liquidationsRevenue || 0) + (fb.freeReplacementRefundItems || 0)
    + (fb.warehouseLost || 0) + (fb.warehouseDamage || 0)
    + (fb.reversalReimbursement || 0) + (fb.otherReimbursements || 0)
    + (fb.otherIncome || 0);

  const amazonFeesDisplayTotal = useOrderFees
    ? orderFeesDisplayTotal
    : (() => {
        const fees = fb.fbaFulfillmentFee + fb.referralFee + fb.storageFees + fb.variableClosingFee
          + fb.fixedClosingFee + fb.inboundTransportation + fb.compensatedClawback
          + fb.removalFees + fb.disposalFees + fb.longTermStorageFees + fb.fbaCustomerReturnFee
          + fb.hrrNonApparelRollup + fb.liquidationsBrokerageFee + fb.digitalServicesFee
          + fb.reCommerceGradingCharge + fb.otherFees
          + (fb.amazonOtherFees || 0) + (fb.inboundDelta || 0);
        // Only add recordFees fallback when feeBreakdown has NO populated values at all
        const recordFallback = (!hasFeeBreakdownValues && fb.eventCount === 0 && data.recordFees.totalFees > 0)
          ? data.recordFees.totalFees : 0;
        // Note: NOT subtracting credits/reimbursements here — they render as Other Income below.
        return fees + recordFallback;
      })();

  // Metrics — all derived from parent-provided authoritative values
  const refundPercent = salesTotal > 0 ? (refundedAmount / salesTotal * 100) : 0;
  const margin = salesTotal > 0 ? (netProfit / salesTotal * 100) : 0;
  const roi = cogsTotal > 0 ? (netProfit / cogsTotal * 100) : 0;
  const estPayoutValue = salesTotal + (data.netSalesBreakdown?.shippingCredits || 0) - amazonFeesNetTotal - parentRefundCostTotal;
  const profitPerUnitValue = unitsTotal > 0 ? netProfit / unitsTotal : 0;

  return (
    <div className={cn("space-y-1", className)}>
      {/* Header */}
      <div className="text-center pb-2 border-b border-border">
        <p className="text-xs text-muted-foreground font-medium">
          {periodId === 'today' ? 'Today' : periodId === 'yesterday' ? 'Yesterday' : periodId === 'month_to_date' ? 'Month to date' : periodId === 'this_month' ? 'This month' : periodId === 'last_month' ? 'Last month' : periodId === 'custom' ? 'Custom range' : 'Month to date'}
        </p>
        <p className="text-sm font-semibold">{data.dateLabel}</p>
      </div>

      {/* +Sales */}
      <Section label="Sales" total={f(salesTotal)} color="text-green-500" prefix="+" defaultOpen>
        <Row label="Organic" value={f(salesTotal)} />
        <Row label="Sponsored Products (same day)" value={`${cs}0.00`} />
        <Row label="Sponsored Display (same day)" value={`${cs}0.00`} />
      </Section>

      {/* +Units */}
      <Section label="Units" total={fmtNum(unitsTotal)} color="text-cyan-500" prefix="+" defaultOpen>
        <Row label="Organic" value={fmtNum(unitsTotal)} />
        <Row label="Sponsored Products (same day)" value="0" />
        <Row label="Sponsored Display (same day)" value="0" />
      </Section>

      {/* Shipping Paid by Buyer */}
      <div className="flex justify-between py-1.5 px-1 text-sm">
        <span className="text-muted-foreground">Shipping Paid by Buyer</span>
        <span className="font-medium text-green-500">+{f(data.netSalesBreakdown?.shippingCredits || 0)}</span>
      </div>

      {/* Gift Wrap Paid by Buyer */}
      <div className="flex justify-between py-1.5 px-1 text-sm">
        <span className="text-muted-foreground">Gift Wrap Paid by Buyer</span>
        <span className="font-medium text-green-500">+{f(data.netSalesBreakdown?.giftWrapCredits || 0)}</span>
      </div>

      {/* Promo */}
      <div className="flex justify-between py-1.5 px-1 text-sm">
        <span className="text-muted-foreground">Promo</span>
        <span className="font-medium text-red-400">-{f(promoRebates)}</span>
      </div>

      {/* +Advertising cost */}
      <Section label="Advertising cost" total={`${cs}0.00`} color="text-amber-500" prefix="+">
        <Row label="Sponsored Products" value={`${cs}0.00`} />
        <Row label="Sponsored Brands Video" value={`${cs}0.00`} />
        <Row label="Sponsored Display" value={`${cs}0.00`} />
        <Row label="Sponsored Brands" value={`${cs}0.00`} />
      </Section>

      {/* +Shipping costs */}
      <Section 
        label="Shipping costs" 
        total={shippingCostTotal > 0 ? `-${f(shippingCostTotal)}` : `${cs}0.00`} 
        color="text-blue-400" 
        prefix="+"
      >
        <Row 
          label="Transport partner program" 
          value={shippingCostTotal > 0 ? `-${f(shippingCostTotal)}` : `${cs}0.00`} 
        />
      </Section>

      {/* +Refund cost */}
      <Section label="Refund cost" total={`-${f(Math.abs(parentRefundCostTotal))}`} color="text-purple-500" prefix="+">
        <Row label={`Refunded amount`} value={`-${f(refundedAmount)}`} />
        {refundCommission > 0 && (
          <Row label="Refund commission" value={`-${f(refundCommission)}`} />
        )}
        {fbaCustomerReturnFee > 0 && (
          <Row label="FBA customer return per unit fee" value={`-${f(fbaCustomerReturnFee)}`} />
        )}
        {refundedReferralFee > 0 && (
          <Row label="Refunded referral fee" value={`+${f(refundedReferralFee)}`} color="text-green-400" />
        )}
        {valueOfReturnedItems > 0 && (
          <Row label="Value of returned items" value={`+${f(valueOfReturnedItems)}`} color="text-green-400" />
        )}
      </Section>

      {/* +Amazon fees — the big section */}
      <Section
        label={`Amazon fees`}
        total={`-${f(amazonFeesDisplayTotal)}`}
        color="text-red-500"
        prefix="+"
        defaultOpen
        badge={(periodId === 'today' || periodId === 'yesterday') ? (
          <span
            title="Today's and yesterday's fees are Amazon's initial estimates and are typically revised down (often by 30-50%) once orders ship and settle. Final actuals usually appear within 24-72 hours."
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-500 border border-amber-500/30"
          >
            ⏳ Pending settlement
          </span>
        ) : undefined}
      >

        {useOrderFees || looksLikeCollapsedFbaTotal ? (
          /* ═══ LIVE DAYS (Today/Yesterday): STRICT orders-only fees ═══ */
          <>
            {orderFeesBreakdownTotal <= 0 && orderFeesFallbackTotal > 0 && (
              <Row label="Amazon order fees" value={`-${f(orderFeesFallbackTotal)}`} />
            )}
            {data.recordFees.fbaFee > 0 && (
              <Row label="FBA per unit fulfilment fee" value={`-${f(data.recordFees.fbaFee)}`} />
            )}
            {data.recordFees.referralFee > 0 && (
              <Row label="Referral fee" value={`-${f(data.recordFees.referralFee)}`} />
            )}
            {data.recordFees.closingFee > 0 && (
              <Row label="Variable closing fee" value={`-${f(data.recordFees.closingFee)}`} />
            )}
            {orderFeesBreakdownTotal > 0 && orderFeesResidual > 0.01 && (
              <Row label="Other Amazon order fees" value={`-${f(orderFeesResidual)}`} />
            )}
          </>
        ) : (
          /* ═══ MTD / MONTH / CUSTOM: Use financial_events_cache breakdown ═══ */
          <>
            {/* Core fees */}
            {fb.fbaFulfillmentFee > 0 && (
              <Row label="FBA per unit fulfilment fee" value={`-${f(fb.fbaFulfillmentFee)}`} />
            )}
            {fb.referralFee > 0 && (
              <Row label="Referral fee" value={`-${f(fb.referralFee)}`} />
            )}
            {fb.storageFees > 0 && (
              <Row label="FBA storage fee" value={`-${f(fb.storageFees)}`} />
            )}
            {fb.variableClosingFee > 0 && (
              <Row label="Variable closing fee" value={`-${f(fb.variableClosingFee)}`} />
            )}
            {fb.fixedClosingFee > 0 && (
              <Row label="Fixed closing fee" value={`-${f(fb.fixedClosingFee)}`} />
            )}
            {fb.inboundTransportation > 0 && (
              <Row label="Inbound transportation" value={`-${f(fb.inboundTransportation)}`} />
            )}
            {fb.compensatedClawback > 0 && (
              <Row label="Compensated clawback" value={`-${f(fb.compensatedClawback)}`} />
            )}
            {/* Additional fees */}
            {fb.removalFees > 0 && (
              <Row label="FBA removal fee" value={`-${f(fb.removalFees)}`} />
            )}
            {fb.disposalFees > 0 && (
              <Row label="FBA disposal fee" value={`-${f(fb.disposalFees)}`} />
            )}
            {fb.longTermStorageFees > 0 && (
              <Row label="FBA long-term storage fee" value={`-${f(fb.longTermStorageFees)}`} />
            )}
            {fb.hrrNonApparelRollup > 0 && (
              <Row label="Hrr non apparel rollup" value={`-${f(fb.hrrNonApparelRollup)}`} />
            )}
            {fb.liquidationsBrokerageFee > 0 && (
              <Row label="Liquidations brokerage fee" value={`-${f(fb.liquidationsBrokerageFee)}`} />
            )}
            {fb.digitalServicesFee > 0 && (
              <Row label="Digital services fee" value={`-${f(fb.digitalServicesFee)}`} />
            )}
            {fb.reCommerceGradingCharge > 0 && (
              <Row label="Re-commerce grading charge" value={`-${f(fb.reCommerceGradingCharge)}`} />
            )}
            {fb.fbaCustomerReturnFee > 0 && (
              <Row label="FBA customer return per unit fee" value={`-${f(fb.fbaCustomerReturnFee)}`} />
            )}
            {fb.otherFees > 0 && (
              <Row label="Other fees" value={`-${f(fb.otherFees)}`} />
            )}
            {(fb.amazonOtherFees || 0) > 0 && (
              <Row label="Other Amazon order fees" value={`-${f(fb.amazonOtherFees)}`} />
            )}
            {(fb.inboundDelta || 0) > 0 && (
              <Row label="Inbound transportation (additional)" value={`-${f(fb.inboundDelta)}`} />
            )}

            {/* Reimbursements / credits moved out of Amazon fees → see "Other income" section below */}

            {/* Fallback: if no financial events AND no populated fee values, show record-based fees */}
            {!hasFeeBreakdownValues && fb.eventCount === 0 && data.recordFees.totalFees > 0 && (
              <>
                {data.recordFees.fbaFee > 0 && (
                  <Row label="FBA fee (from records)" value={`-${f(data.recordFees.fbaFee)}`} />
                )}
                {data.recordFees.referralFee > 0 && (
                  <Row label="Referral fee (from records)" value={`-${f(data.recordFees.referralFee)}`} />
                )}
                {data.recordFees.closingFee > 0 && (
                  <Row label="Closing fee (from records)" value={`-${f(data.recordFees.closingFee)}`} />
                )}
              </>
            )}
          </>
        )}
      </Section>

      {/* +Other income (Reimbursements) — separate from Amazon fees so reimbursements are NOT misclassified */}
      {otherIncomeTotal > 0 && (
        <Section
          label="Other income (Reimbursements)"
          total={`+${f(otherIncomeTotal)}`}
          color="text-green-500"
          prefix="+"
          defaultOpen
        >
          {fb.warehouseLost > 0 && (
            <Row label="Warehouse lost (Amazon reimbursement)" value={`+${f(fb.warehouseLost)}`} color="text-green-400" />
          )}
          {fb.warehouseDamage > 0 && (
            <Row label="Warehouse damage (Amazon reimbursement)" value={`+${f(fb.warehouseDamage)}`} color="text-green-400" />
          )}
          {fb.reversalReimbursement > 0 && (
            <Row label="Reversal reimbursement" value={`+${f(fb.reversalReimbursement)}`} color="text-green-400" />
          )}
          {fb.otherReimbursements > 0 && (
            <Row label="Other reimbursements" value={`+${f(fb.otherReimbursements)}`} color="text-green-400" />
          )}
          {fb.freeReplacementRefundItems > 0 && (
            <Row label="Free replacement refund items" value={`+${f(fb.freeReplacementRefundItems)}`} color="text-green-400" />
          )}
          {fb.liquidationsRevenue > 0 && (
            <Row label="Liquidations revenue" value={`+${f(fb.liquidationsRevenue)}`} color="text-green-400" />
          )}
          {(fb.otherIncome || 0) > 0 && (
            <Row label="Other income" value={`+${f(fb.otherIncome || 0)}`} color="text-green-400" />
          )}
        </Section>
      )}

      {/* Unattributed account-level fees (shown only when marketplace filter is active) */}
      {isMarketplaceFiltered && (data.unattributedSettledFees ?? 0) !== 0 && (
        <div className="flex justify-between py-1.5 px-1 text-sm border-b border-dashed border-border/50">
          <span className="text-muted-foreground italic text-xs">
            Unattributed fees (account-level)
          </span>
          <span className="font-medium text-muted-foreground italic text-xs">
            {(data.unattributedSettledFees ?? 0) > 0 ? '-' : '+'}{f(Math.abs(data.unattributedSettledFees ?? 0))}
          </span>
        </div>
      )}
      {isMarketplaceFiltered && (data.unattributedSettledFees ?? 0) !== 0 && (
        <div className="text-[10px] text-muted-foreground/60 italic px-1 py-0.5">
          ⚠ These fees (storage, adjustments, etc.) couldn't be attributed to a specific marketplace. They are NOT included in the totals above.
        </div>
      )}

      {/* +Cost of goods */}
      <Section label="Cost of goods" total={`-${f(cogsTotal)}`} color="text-orange-500" prefix="-">
        <Row label="Cost of goods sold" value={`-${f(cogsTotal)}`} />
      </Section>

      {/* ════════════════════════ Gross Profit ════════════════════════ */}
      <div className="flex justify-between py-2 px-1 border-t border-b border-border font-semibold text-sm">
        <span>Gross profit</span>
        <span className={cn(grossProfit >= 0 ? "text-green-500" : "text-red-500")}>
          {grossProfit < 0 ? '-' : ''}{f(grossProfit)}
        </span>
      </div>

      {/* +Indirect expenses */}
      <Section label="Indirect expenses" total={`-${f(data.expenses)}`} color="text-pink-500" prefix="+">
        <Row label="Other expenses" value={`-${f(data.expenses)}`} />
      </Section>

      {/* ════════════════════════ Net Profit ════════════════════════ */}
      <div className={cn(
        "flex justify-between py-2 px-1 border-t border-b-2 border-border font-bold text-base",
        netProfit >= 0 ? "text-green-500" : "text-red-500"
      )}>
        <span>Net profit</span>
        <span>{netProfit < 0 ? '-' : ''}{f(netProfit)}</span>
      </div>

      {/* ════════════════════════ Waterfall Bar ════════════════════════ */}
      {salesTotal > 0 && (
        <div className="pt-2 pb-1 space-y-1">
          <p className="text-[10px] text-muted-foreground font-medium">Profit Waterfall</p>
          <div className="flex h-5 rounded-md overflow-hidden border border-border">
            {(() => {
              const feePct = Math.min((amazonFeesNetTotal / salesTotal) * 100, 100);
              const cogsPct = Math.min((cogsTotal / salesTotal) * 100, 100 - feePct);
              const refPct = Math.min((Math.abs(parentRefundCostTotal) / salesTotal) * 100, 100 - feePct - cogsPct);
              const expPct = Math.min((data.expenses / salesTotal) * 100, 100 - feePct - cogsPct - refPct);
              const profitPct = Math.max(100 - feePct - cogsPct - refPct - expPct, 0);
              return (
                <>
                  {profitPct > 0 && (
                    <div
                      className={cn("transition-all", netProfit >= 0 ? "bg-green-500/70" : "bg-red-500/70")}
                      style={{ width: `${profitPct}%` }}
                      title={`Profit: ${f(netProfit)} (${profitPct.toFixed(1)}%)`}
                    />
                  )}
                  {feePct > 0 && (
                    <div
                      className="bg-red-400/60"
                      style={{ width: `${feePct}%` }}
                      title={`Amazon Fees: ${f(amazonFeesNetTotal)} (${feePct.toFixed(1)}%)`}
                    />
                  )}
                  {cogsPct > 0 && (
                    <div
                      className="bg-orange-400/60"
                      style={{ width: `${cogsPct}%` }}
                      title={`COGS: ${f(cogsTotal)} (${cogsPct.toFixed(1)}%)`}
                    />
                  )}
                  {refPct > 0 && (
                    <div
                      className="bg-purple-400/60"
                      style={{ width: `${refPct}%` }}
                      title={`Refunds: ${f(Math.abs(parentRefundCostTotal))} (${refPct.toFixed(1)}%)`}
                    />
                  )}
                  {expPct > 0 && (
                    <div
                      className="bg-pink-400/60"
                      style={{ width: `${expPct}%` }}
                      title={`Expenses: ${f(data.expenses)} (${expPct.toFixed(1)}%)`}
                    />
                  )}
                </>
              );
            })()}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className={cn("w-2 h-2 rounded-sm inline-block", netProfit >= 0 ? "bg-green-500/70" : "bg-red-500/70")} />Profit</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-400/60 inline-block" />Fees</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-orange-400/60 inline-block" />COGS</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-purple-400/60 inline-block" />Refunds</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-pink-400/60 inline-block" />Expenses</span>
          </div>
        </div>
      )}

      {/* Amazon payout (before COGS) — what Amazon will deposit, before product cost & expenses */}
      <div
        className="flex justify-between py-1.5 px-1 text-sm"
        title="What Amazon will deposit to your bank: Sales + Shipping − Amazon fees − Refund cost. This does NOT subtract product cost (COGS) or expenses. See Net Profit below for your real profit after COGS."
      >
        <span className="text-muted-foreground">Amazon payout (before COGS)</span>
        <span className="font-medium text-blue-500">{f(estPayoutValue)}</span>
      </div>
      {(() => {
        const netProfitValue = estPayoutValue - (data.totalCost || 0) - (data.expenses || 0);
        const isLoss = netProfitValue < 0;
        const sign = isLoss ? '-' : '';
        return (
          <div className={`flex justify-between py-0.5 px-1 text-[11px] italic ${isLoss ? 'text-red-500 font-medium' : 'text-muted-foreground'}`}>
            <span>{isLoss ? 'Net loss (after COGS & expenses)' : 'Net profit (after COGS & expenses)'}</span>
            <span>{sign}{f(netProfitValue)}</span>
          </div>
        );
      })()}

      {/* ════════════════════════ Bottom Metrics ════════════════════════ */}
      <div className="pt-2 border-t border-border space-y-1 text-xs">
        <div className="flex justify-between py-0.5">
          <span className="text-muted-foreground">Real ACOS</span>
          <span className="font-medium">0.00%</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted-foreground">% Refunds</span>
          <span className="font-medium">{refundPercent.toFixed(2)}%</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted-foreground">Margin</span>
          <span className={cn("font-medium", margin >= 0 ? "text-green-500" : "text-red-500")}>
            {margin.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted-foreground">ROI</span>
          <span className={cn("font-medium", roi >= 0 ? "text-green-500" : "text-red-500")}>
            {roi.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted-foreground">Avg Order Value</span>
          <span className="font-medium">{ordersTotal > 0 ? f(salesTotal / ordersTotal) : '$0.00'}</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted-foreground">Avg Unit Price</span>
          <span className="font-medium">{unitsTotal > 0 ? f(salesTotal / unitsTotal) : '$0.00'}</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted-foreground">Profit per Unit</span>
          <span className={cn("font-medium", profitPerUnitValue >= 0 ? "text-green-500" : "text-red-500")}>
            {profitPerUnitValue < 0 ? '-' : ''}{f(profitPerUnitValue)}
          </span>
        </div>
      </div>
    </div>
  );
}
