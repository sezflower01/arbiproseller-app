import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Clock, AlertCircle, CheckCircle } from "lucide-react";

interface PeriodFreshnessProps {
  userId: string;
  dateRange: { startDate: string; endDate: string } | null;
  ordersCount: number;
  className?: string;
}

interface FreshnessData {
  lastOrdersSync: string | null;
  lastFinancialSync: string | null;
  lastEnrichment: string | null;
  staleOrdersCount: number;
}

export default function PeriodFreshnessIndicators({ userId, dateRange, ordersCount, className }: PeriodFreshnessProps) {
  const [data, setData] = useState<FreshnessData | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || !dateRange) return;
    const key = `${userId}:${dateRange.startDate}:${dateRange.endDate}`;
    if (fetchedKeyRef.current === key) return;
    fetchedKeyRef.current = key;

    const fetchFreshness = async () => {
      setLoading(true);
      try {
        // Fetch latest sync timestamps in parallel
        const [ordersRes, financialRes, enrichRes, staleRes] = await Promise.all([
          supabase
            .from('enrichment_logs')
            .select('created_at')
            .eq('user_id', userId)
            .eq('enrichment_type', 'sync')
            .eq('status', 'started')
            .order('created_at', { ascending: false })
            .limit(1),
          supabase
            .from('financial_sync_state')
            .select('last_sync_at')
            .eq('user_id', userId)
            .maybeSingle(),
          supabase
            .from('enrichment_logs')
            .select('created_at')
            .eq('user_id', userId)
            .in('enrichment_type', ['price', 'fees'])
            .eq('status', 'success')
            .order('created_at', { ascending: false })
            .limit(1),
          supabase
            .from('sales_orders')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .gte('order_date', dateRange.startDate)
            .lte('order_date', dateRange.endDate)
            .or('fees_source.is.null,fees_source.eq.unavailable')
            .eq('sold_price', 0),
        ]);

        setData({
          lastOrdersSync: ordersRes.data?.[0]?.created_at || null,
          lastFinancialSync: financialRes.data?.last_sync_at || null,
          lastEnrichment: enrichRes.data?.[0]?.created_at || null,
          staleOrdersCount: staleRes.count || 0,
        });
      } catch (err) {
        console.error('Freshness fetch error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchFreshness();
  }, [userId, dateRange]);

  if (!data || loading) return null;

  const formatAgo = (iso: string | null) => {
    if (!iso) return 'Never';
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const isStale = (iso: string | null, thresholdMinutes: number) => {
    if (!iso) return true;
    return (Date.now() - new Date(iso).getTime()) > thresholdMinutes * 60000;
  };

  const items = [
    { label: 'Orders', time: data.lastOrdersSync, staleThreshold: 30 },
    { label: 'Financial', time: data.lastFinancialSync, staleThreshold: 60 },
    { label: 'Enrichment', time: data.lastEnrichment, staleThreshold: 60 },
  ];

  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${className || ''}`}>
      <Clock className="h-3 w-3 text-muted-foreground" />
      {items.map(item => {
        const stale = isStale(item.time, item.staleThreshold);
        return (
          <Tooltip key={item.label}>
            <TooltipTrigger asChild>
              <Badge
                variant={stale ? 'secondary' : 'outline'}
                className="gap-1 text-[10px] cursor-help"
              >
                {stale ? <AlertCircle className="h-2.5 w-2.5" /> : <CheckCircle className="h-2.5 w-2.5" />}
                {item.label}: {formatAgo(item.time)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              Last {item.label.toLowerCase()} sync: {item.time ? new Date(item.time).toLocaleString() : 'Never'}
            </TooltipContent>
          </Tooltip>
        );
      })}
      {data.staleOrdersCount > 0 && (
        <Badge variant="destructive" className="text-[10px]">
          {data.staleOrdersCount} stale orders
        </Badge>
      )}
    </div>
  );
}
