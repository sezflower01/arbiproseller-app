import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShieldCheck, ShieldAlert, Shield } from "lucide-react";

interface ConfidenceOrder {
  sold_price: number;
  total_sale_amount: number;
  price_source?: string | null;
  fees_source?: string | null;
  total_fees: number;
  unit_cost: number | null;
  is_cancelled?: boolean | null;
  order_status?: string | null;
}

interface DataConfidenceBadgeProps {
  orders: ConfidenceOrder[];
  className?: string;
}

export interface ConfidenceMetrics {
  pctActualPrice: number;
  pctSnapshotPrice: number;
  pctEstimatedPrice: number;
  pctActualFees: number;
  pctEstimatedFees: number;
  pctResolvedCogs: number;
  score: number;
  level: 'high' | 'medium' | 'low';
}

export function computeConfidence(orders: ConfidenceOrder[]): ConfidenceMetrics {
  const active = orders.filter(o =>
    !o.is_cancelled &&
    o.order_status !== 'Cancelled' &&
    o.order_status !== 'Canceled'
  );

  const total = active.length || 1;

  let actualPrice = 0, snapshotPrice = 0, estimatedPrice = 0;
  let actualFees = 0, estimatedFees = 0;
  let resolvedCogs = 0;

  for (const o of active) {
    const src = o.price_source || '';
    const hasActualPrice = (o.sold_price || 0) > 0 || (o.total_sale_amount || 0) > 0;

    if (hasActualPrice && (src === 'financial_events' || src === 'orders_itemprice' || src === 'listings_api' || src === 'order_total_pending' || !src)) {
      actualPrice++;
    } else if (src === 'snapshot') {
      snapshotPrice++;
    } else if (src === 'estimated' || src === 'enrichment' || src.includes('inventory')) {
      estimatedPrice++;
    }

    const fSrc = o.fees_source || '';
    if (fSrc === 'learned_history' || fSrc === 'financial_events' || fSrc === 'settled') {
      actualFees++;
    } else if (fSrc === 'from_cache' || fSrc === 'fees_api' || fSrc === 'fees_api_proportional') {
      estimatedFees++;
    }

    if ((o.unit_cost || 0) > 0) resolvedCogs++;
  }

  const pctActualPrice = (actualPrice / total) * 100;
  const pctSnapshotPrice = (snapshotPrice / total) * 100;
  const pctEstimatedPrice = (estimatedPrice / total) * 100;
  const pctActualFees = (actualFees / total) * 100;
  const pctEstimatedFees = (estimatedFees / total) * 100;
  const pctResolvedCogs = (resolvedCogs / total) * 100;

  // Weighted score: actual prices (40%), actual fees (30%), COGS (30%)
  const score = (pctActualPrice * 0.4) + (pctActualFees * 0.3) + (pctResolvedCogs * 0.3);

  const level: 'high' | 'medium' | 'low' =
    score >= 80 ? 'high' :
    score >= 50 ? 'medium' : 'low';

  return {
    pctActualPrice, pctSnapshotPrice, pctEstimatedPrice,
    pctActualFees, pctEstimatedFees, pctResolvedCogs,
    score, level,
  };
}

export default function DataConfidenceBadge({ orders, className }: DataConfidenceBadgeProps) {
  const metrics = useMemo(() => computeConfidence(orders), [orders]);

  const Icon = metrics.level === 'high' ? ShieldCheck : metrics.level === 'medium' ? Shield : ShieldAlert;
  const variant = metrics.level === 'high' ? 'default' : metrics.level === 'medium' ? 'secondary' : 'destructive';
  const label = metrics.level === 'high' ? 'High Confidence' : metrics.level === 'medium' ? 'Medium Confidence' : 'Low Confidence';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className={`gap-1 cursor-help ${className || ''}`}>
          <Icon className="h-3 w-3" />
          {label} ({Math.round(metrics.score)}%)
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <div className="space-y-1 text-xs">
          <div className="font-medium mb-1">Data Confidence Breakdown</div>
          <div>Actual Prices: {metrics.pctActualPrice.toFixed(0)}%</div>
          <div>Snapshot Prices: {metrics.pctSnapshotPrice.toFixed(0)}%</div>
          <div>Estimated Prices: {metrics.pctEstimatedPrice.toFixed(0)}%</div>
          <div>Actual Fees: {metrics.pctActualFees.toFixed(0)}%</div>
          <div>Estimated Fees: {metrics.pctEstimatedFees.toFixed(0)}%</div>
          <div>Resolved COGS: {metrics.pctResolvedCogs.toFixed(0)}%</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
