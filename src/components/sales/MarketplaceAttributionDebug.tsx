/**
 * Debug widget showing marketplace attribution stats for financial_events_cache.
 * Shows counts by marketplace + join-match rate with sales_orders.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  userId: string;
  dateRange?: { start: string; end: string };
}

interface Stats {
  byMarketplace: Array<{ marketplace: string; count: number }>;
  totalEvents: number;
  eventsWithOrderId: number;
  matchedOrders: number;
  loading: boolean;
}

export default function MarketplaceAttributionDebug({ userId, dateRange }: Props) {
  const [stats, setStats] = useState<Stats>({
    byMarketplace: [],
    totalEvents: 0,
    eventsWithOrderId: 0,
    matchedOrders: 0,
    loading: true,
  });

  useEffect(() => {
    if (!dateRange) return;
    let cancelled = false;

    (async () => {
      // 1. Count by marketplace
      const { data: events } = await supabase
        .from("financial_events_cache")
        .select("marketplace, amazon_order_id")
        .eq("user_id", userId)
        .gte("event_date", dateRange.start)
        .lte("event_date", dateRange.end);

      if (cancelled || !events) return;

      const counts = new Map<string, number>();
      let withOrderId = 0;
      const orderIds = new Set<string>();

      for (const e of events) {
        const mp = (e as any).marketplace || "UNKNOWN";
        counts.set(mp, (counts.get(mp) || 0) + 1);
        if (e.amazon_order_id && e.amazon_order_id !== "") {
          withOrderId++;
          orderIds.add(e.amazon_order_id);
        }
      }

      // 2. Check join rate with sales_orders
      let matchedOrders = 0;
      if (orderIds.size > 0) {
        const orderIdArr = [...orderIds].slice(0, 500);
        const { count } = await (supabase
          .from("sales_orders")
          .select("amazon_order_id", { count: "exact", head: true })
          .eq("user_id", userId) as any)
          .in("amazon_order_id", orderIdArr);
        matchedOrders = count ?? 0;
      }

      if (cancelled) return;

      setStats({
        byMarketplace: [...counts.entries()]
          .map(([marketplace, count]) => ({ marketplace, count }))
          .sort((a, b) => b.count - a.count),
        totalEvents: events.length,
        eventsWithOrderId: withOrderId,
        matchedOrders,
        loading: false,
      });
    })();

    return () => { cancelled = true; };
  }, [userId, dateRange?.start, dateRange?.end]);

  if (stats.loading) {
    return <p className="text-[10px] text-muted-foreground py-1">Loading attribution stats...</p>;
  }

  const joinRate = stats.eventsWithOrderId > 0
    ? ((stats.matchedOrders / stats.eventsWithOrderId) * 100).toFixed(1)
    : "N/A";

  return (
    <div className="mt-1 space-y-1 text-[11px]">
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span className="text-muted-foreground">Total events</span>
        <span className="font-mono">{stats.totalEvents}</span>
        <span className="text-muted-foreground">Events with order_id</span>
        <span className="font-mono">{stats.eventsWithOrderId}</span>
        <span className="text-muted-foreground">Matched in sales_orders</span>
        <span className="font-mono">{stats.matchedOrders}</span>
        <span className="text-muted-foreground">Join-match rate</span>
        <span className="font-mono">{joinRate}%</span>
      </div>
      <p className="text-muted-foreground font-medium pt-1">By marketplace:</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {stats.byMarketplace.map(({ marketplace, count }) => (
          <span key={marketplace} className="contents">
            <span className="text-muted-foreground">{marketplace}</span>
            <span className="font-mono">{count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
