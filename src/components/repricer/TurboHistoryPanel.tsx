import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { History, TrendingDown, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { startOfToday, startOfYesterday, subDays, startOfWeek, startOfMonth, endOfYesterday } from "date-fns";

type Period = "today" | "yesterday" | "this_week" | "this_month";

interface AlertRecord {
  id: string;
  asin: string;
  sku: string | null;
  marketplace: string;
  bb_before: number | null;
  bb_now: number | null;
  drop_pct: number | null;
  created_at: string;
}

export default function TurboHistoryPanel() {
  const { user } = useAuth();
  const [period, setPeriod] = useState<Period>("today");
  const [records, setRecords] = useState<AlertRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const getDateRange = useCallback((p: Period): { from: string; to: string } => {
    const now = new Date();
    switch (p) {
      case "today":
        return { from: startOfToday().toISOString(), to: now.toISOString() };
      case "yesterday":
        return { from: startOfYesterday().toISOString(), to: endOfYesterday().toISOString() };
      case "this_week":
        return { from: startOfWeek(now, { weekStartsOn: 1 }).toISOString(), to: now.toISOString() };
      case "this_month":
        return { from: startOfMonth(now).toISOString(), to: now.toISOString() };
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { from, to } = getDateRange(period);
      const { data, error } = await supabase
        .from("bb_price_alerts")
        .select("id, asin, sku, marketplace, bb_before, bb_now, drop_pct, created_at")
        .eq("user_id", user.id)
        .gte("created_at", from)
        .lte("created_at", to)
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) throw error;
      setRecords(data || []);
    } catch (e: any) {
      console.error("Error fetching turbo history:", e);
    } finally {
      setLoading(false);
    }
  }, [user, period, getDateRange]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const uniqueAsins = [...new Set(records.map((r) => r.asin))];

  const periodLabels: Record<Period, string> = {
    today: "Today",
    yesterday: "Yesterday",
    this_week: "This Week",
    this_month: "This Month",
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4" />
            Turbo ASINs History
          </CardTitle>
          <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="yesterday">Yesterday</SelectItem>
              <SelectItem value="this_week">This Week</SelectItem>
              <SelectItem value="this_month">This Month</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : records.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No BB price alerts for {periodLabels[period].toLowerCase()}.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {uniqueAsins.length} unique ASINs · {records.length} alerts
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(uniqueAsins.join(", "));
                    toast.success(`${uniqueAsins.length} ASINs copied!`);
                  } catch {
                    toast.error("Failed to copy");
                  }
                }}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy All
              </Button>
            </div>

            <div className="max-h-64 overflow-y-auto space-y-1.5">
              {records.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between p-2 rounded border bg-background text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <TrendingDown className="h-3 w-3 text-red-500 shrink-0" />
                    <span className="font-mono font-medium">{r.asin}</span>
                    {r.sku && (
                      <span className="text-muted-foreground truncate max-w-[100px]">
                        {r.sku}
                      </span>
                    )}
                    {r.marketplace && r.marketplace !== "US" && (
                      <Badge variant="outline" className="text-[10px] h-4">
                        {r.marketplace}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.bb_before != null && r.bb_now != null && (
                      <span className="text-muted-foreground">
                        ${r.bb_before.toFixed(2)} → ${r.bb_now.toFixed(2)}
                      </span>
                    )}
                    {r.drop_pct != null && (
                      <Badge variant="destructive" className="text-[10px] h-4">
                        -{Math.abs(r.drop_pct).toFixed(1)}%
                      </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(r.created_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
