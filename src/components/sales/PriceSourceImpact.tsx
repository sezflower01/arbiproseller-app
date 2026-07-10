import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";

interface SourceOrder {
  sold_price: number;
  total_sale_amount: number;
  quantity: number;
  price_source?: string | null;
  fees_source?: string | null;
  total_fees: number;
  is_cancelled?: boolean | null;
  order_status?: string | null;
}

interface PriceSourceImpactProps {
  orders: SourceOrder[];
  className?: string;
}

interface SourceBucket {
  label: string;
  count: number;
  revenue: number;
  color: string;
}

export default function PriceSourceImpact({ orders, className }: PriceSourceImpactProps) {
  const { priceBuckets, feeBuckets, totalRevenue, totalFees } = useMemo(() => {
    const activeOrders = orders.filter(o =>
      !o.is_cancelled &&
      o.order_status !== 'Cancelled' &&
      o.order_status !== 'Canceled'
    );

    // Price source buckets
    const priceMap: Record<string, SourceBucket> = {
      actual: { label: 'Actual (Settled)', count: 0, revenue: 0, color: 'bg-green-500' },
      snapshot: { label: 'Snapshot', count: 0, revenue: 0, color: 'bg-blue-500' },
      estimated: { label: 'Estimated', count: 0, revenue: 0, color: 'bg-yellow-500' },
      inventory: { label: 'Inventory Fallback', count: 0, revenue: 0, color: 'bg-purple-500' },
      missing: { label: 'Missing', count: 0, revenue: 0, color: 'bg-red-500' },
    };

    for (const o of activeOrders) {
      const rev = (o.sold_price || o.total_sale_amount || 0) * (o.quantity || 1);
      const src = o.price_source || '';

      if (src === 'financial_events' || src === 'orders_itemprice' || src === 'listings_api' || src === 'order_total_pending') {
        priceMap.actual.count++;
        priceMap.actual.revenue += rev;
      } else if (src === 'snapshot') {
        priceMap.snapshot.count++;
        priceMap.snapshot.revenue += rev;
      } else if (src === 'estimated' || src === 'enrichment') {
        priceMap.estimated.count++;
        priceMap.estimated.revenue += rev;
      } else if (src.includes('inventory')) {
        priceMap.inventory.count++;
        priceMap.inventory.revenue += rev;
      } else if (rev === 0) {
        priceMap.missing.count++;
      } else {
        // Has revenue but unknown source — treat as actual
        priceMap.actual.count++;
        priceMap.actual.revenue += rev;
      }
    }

    // Fee source buckets
    const feeMap: Record<string, SourceBucket> = {
      actual: { label: 'Actual Fees', count: 0, revenue: 0, color: 'bg-green-500' },
      estimated: { label: 'Estimated Fees', count: 0, revenue: 0, color: 'bg-yellow-500' },
      missing: { label: 'Missing Fees', count: 0, revenue: 0, color: 'bg-red-500' },
    };

    for (const o of activeOrders) {
      const fees = o.total_fees || 0;
      const src = o.fees_source || '';

      if (src === 'learned_history' || src === 'financial_events' || src === 'settled') {
        feeMap.actual.count++;
        feeMap.actual.revenue += fees;
      } else if (src === 'from_cache' || src === 'fees_api' || src === 'fees_api_proportional') {
        feeMap.estimated.count++;
        feeMap.estimated.revenue += fees;
      } else if (fees === 0 || src === 'unavailable' || !src) {
        feeMap.missing.count++;
      } else {
        feeMap.actual.count++;
        feeMap.actual.revenue += fees;
      }
    }

    const totalRevenue = activeOrders.reduce((s, o) =>
      s + (o.sold_price || o.total_sale_amount || 0) * (o.quantity || 1), 0);
    const totalFees = activeOrders.reduce((s, o) => s + (o.total_fees || 0), 0);

    return {
      priceBuckets: Object.values(priceMap).filter(b => b.count > 0),
      feeBuckets: Object.values(feeMap).filter(b => b.count > 0),
      totalRevenue,
      totalFees,
    };
  }, [orders]);

  if (orders.length === 0) return null;

  const renderBuckets = (buckets: SourceBucket[], total: number, label: string) => (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {label}
        <Tooltip>
          <TooltipTrigger><Info className="h-3 w-3" /></TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs">
            Shows where each dollar comes from. Actual = settled/verified. Estimated = calculated from cache or API. Missing = no data available.
          </TooltipContent>
        </Tooltip>
      </div>
      {buckets.map(b => {
        const pct = total > 0 ? (b.revenue / total) * 100 : 0;
        return (
          <div key={b.label} className="flex items-center gap-2 text-xs">
            <div className={`w-2 h-2 rounded-full ${b.color} shrink-0`} />
            <span className="w-28 truncate">{b.label}</span>
            <Progress value={pct} className="flex-1 h-1.5" />
            <span className="font-mono w-16 text-right">${b.revenue.toFixed(0)}</span>
            <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
              {b.count}
            </Badge>
          </div>
        );
      })}
    </div>
  );

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Price & Fee Source Impact</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {renderBuckets(priceBuckets, totalRevenue, 'Revenue by Price Source')}
        {renderBuckets(feeBuckets, totalFees, 'Fees by Source')}
      </CardContent>
    </Card>
  );
}
