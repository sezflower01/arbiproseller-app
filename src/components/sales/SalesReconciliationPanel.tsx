import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface ReconciliationFeeBreakdown {
  referral: number;
  fbaFulfillment: number;
  closing: number;
  inbound: number;
  other: number;
}

export interface ReconciliationTotals {
  grossSales: number;
  netSales: number;
  refunds: number;
  promo: number;
  amazonFeesTotal: number;
  amazonFeesByType: ReconciliationFeeBreakdown;
  grossProfit: number;
  netProfit: number;
}

export interface OrderStatusCounts {
  total: number;
  completed: number;
  pending: number;
  estimated: number;
  incomplete: number;
}

export interface SalesReconciliationData {
  periodLabel: string;
  blockTotals: ReconciliationTotals;
  rowTotals: ReconciliationTotals;
  delta: ReconciliationTotals;
  withinPennies: boolean;
  orderCounts?: OrderStatusCounts;
}

export interface ParityComparison {
  label: string;
  pass: boolean;
  metric: string;
  expected: number;
  actual: number;
  delta: number;
  likelySource: string;
}

interface SalesReconciliationPanelProps {
  data: SalesReconciliationData;
  parityChecks?: ParityComparison[];
}

const money = (value: number) => { const safe = Number.isFinite(value) ? value : 0; return `$${safe.toFixed(2)}`; };

const deltaClass = (value: number, threshold = 0.02) =>
  Math.abs(value) > threshold ? "text-destructive font-semibold" : "text-muted-foreground";

export default function SalesReconciliationPanel({ data, parityChecks }: SalesReconciliationPanelProps) {
  const rows = [
    { key: "grossSales", label: "gross_sales" },
    { key: "netSales", label: "net_sales" },
    { key: "refunds", label: "refunds" },
    { key: "promo", label: "promo" },
    { key: "amazonFeesTotal", label: "amazon_fees_total" },
    { key: "grossProfit", label: "gross_profit" },
    { key: "netProfit", label: "net_profit" },
  ] as const;

  const feeRows = [
    { key: "referral", label: "fees.referral" },
    { key: "fbaFulfillment", label: "fees.fba_fulfillment" },
    { key: "closing", label: "fees.closing" },
    { key: "inbound", label: "fees.inbound" },
    { key: "other", label: "fees.other" },
  ] as const;

  const deltaCount = rows.filter(r => Math.abs(data.delta[r.key]) > 0.01).length
    + feeRows.filter(r => Math.abs(data.delta.amazonFeesByType[r.key]) > 0.01).length;

  const parityFailCount = (parityChecks || []).filter(p => !p.pass).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Operational Reconciliation • {data.periodLabel}</CardTitle>
          <div className="flex items-center gap-2">
            {deltaCount > 0 && (
              <Badge variant="outline" className="text-xs text-amber-600 border-amber-600">
                {deltaCount} discrepanc{deltaCount === 1 ? 'y' : 'ies'}
              </Badge>
            )}
            {parityFailCount > 0 && (
              <Badge variant="destructive" className="text-xs">
                {parityFailCount} parity fail{parityFailCount !== 1 ? 's' : ''}
              </Badge>
            )}
            <Badge variant={data.withinPennies ? "default" : "destructive"}>
              {data.withinPennies ? "PASS (≤$0.01)" : "DELTA FOUND"}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Order Status Breakdown */}
        {data.orderCounts && (
          <div className="flex flex-wrap items-center gap-3 text-xs font-mono px-1">
            <span className="text-foreground font-semibold">Orders: {data.orderCounts.total}</span>
            <span className="text-emerald-600">Completed: {data.orderCounts.completed}</span>
            <span className="text-amber-600">Pending: {data.orderCounts.pending}</span>
            <span className="text-blue-600">Estimated: {data.orderCounts.estimated}</span>
            {data.orderCounts.incomplete > 0 && (
              <span className="text-destructive">Incomplete: {data.orderCounts.incomplete}</span>
            )}
            {(() => {
              const pct = data.orderCounts!.total > 0 ? Math.round((data.orderCounts!.completed / data.orderCounts!.total) * 100) : 0;
              const dot = pct >= 90 ? '🟢' : pct >= 70 ? '🟡' : pct >= 50 ? '🟠' : '🔴';
              return (
                <span className="ml-auto text-muted-foreground">
                  Financial Coverage: {data.orderCounts!.completed}/{data.orderCounts!.total} ({pct}%) {dot}
                </span>
              );
            })()}
          </div>
        )}

        {/* Block vs Row reconciliation */}
        <div className="rounded-md border overflow-hidden">
          <div className="grid grid-cols-4 gap-2 px-3 py-2 text-xs bg-muted/50 font-medium">
            <span>Component</span>
            <span className="text-right">Block</span>
            <span className="text-right">SUM(rows)</span>
            <span className="text-right">Delta</span>
          </div>

          {rows.map((row) => {
            const d = data.delta[row.key];
            const hasDelta = Math.abs(d) > 0.01;
            return (
              <div
                key={row.key}
                className={cn(
                  "grid grid-cols-4 gap-2 px-3 py-2 text-xs border-t transition-colors",
                  hasDelta && "bg-destructive/5"
                )}
              >
                <span className="font-mono">{row.label}</span>
                <span className="text-right font-mono">{money(data.blockTotals[row.key])}</span>
                <span className="text-right font-mono">{money(data.rowTotals[row.key])}</span>
                <span className={cn("text-right font-mono", deltaClass(d))}>{money(d)}</span>
              </div>
            );
          })}

          {feeRows.map((row) => {
            const d = data.delta.amazonFeesByType[row.key];
            const hasDelta = Math.abs(d) > 0.01;
            return (
              <div
                key={row.key}
                className={cn(
                  "grid grid-cols-4 gap-2 px-3 py-2 text-xs border-t transition-colors",
                  hasDelta && "bg-destructive/5"
                )}
              >
                <span className="font-mono text-muted-foreground">{row.label}</span>
                <span className="text-right font-mono">{money(data.blockTotals.amazonFeesByType[row.key])}</span>
                <span className="text-right font-mono">{money(data.rowTotals.amazonFeesByType[row.key])}</span>
                <span className={cn("text-right font-mono", deltaClass(d))}>{money(d)}</span>
              </div>
            );
          })}
        </div>

        {/* Parity validation checks */}
        {parityChecks && parityChecks.length > 0 && (
          <div className="rounded-md border overflow-hidden">
            <div className="grid grid-cols-5 gap-2 px-3 py-2 text-xs bg-muted/50 font-medium">
              <span>Parity Check</span>
              <span className="text-right">Expected</span>
              <span className="text-right">Actual</span>
              <span className="text-right">Delta</span>
              <span>Status</span>
            </div>
            {parityChecks.map((check, idx) => (
              <div
                key={idx}
                className={cn(
                  "grid grid-cols-5 gap-2 px-3 py-2 text-xs border-t transition-colors",
                  !check.pass && "bg-destructive/5"
                )}
              >
                <span className="font-mono truncate" title={check.label}>{check.label}</span>
                <span className="text-right font-mono">{money(check.expected)}</span>
                <span className="text-right font-mono">{money(check.actual)}</span>
                <span className={cn("text-right font-mono", deltaClass(check.delta))}>{money(check.delta)}</span>
                <span>
                  <Badge variant={check.pass ? "default" : "destructive"} className="text-[10px]">
                    {check.pass ? 'PASS' : 'FAIL'}
                  </Badge>
                  {!check.pass && (
                    <span className="text-[10px] text-muted-foreground ml-1">{check.likelySource}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
