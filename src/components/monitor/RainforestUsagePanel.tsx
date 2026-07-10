import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Cloud, Zap, ShieldCheck, SkipForward, Database } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

const DAILY_LIMIT = 100;

interface UsageData {
  call_count: number;
  sp_api_throttled_count: number;
  cache_fallback_count: number;
  rainforest_success_count: number;
  rainforest_skipped_not_priority: number;
  rainforest_skipped_cache_fresh: number;
}

export default function RainforestUsagePanel() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
    const __unsub = onMonitorRefresh(fetchData);
    return () => __unsub();
  }, []);

  async function fetchData() {
    const today = new Date().toISOString().split("T")[0];
    const { data: row } = await (supabase as any)
      .from("rainforest_daily_usage")
      .select("*")
      .eq("usage_date", today)
      .maybeSingle();

    setData(row as UsageData | null);
    setLoading(false);
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center justify-center">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </CardContent>
      </Card>
    );
  }

  const callCount = data?.call_count ?? 0;
  const remaining = DAILY_LIMIT - callCount;
  const usagePct = Math.round((callCount / DAILY_LIMIT) * 100);
  const throttled = data?.sp_api_throttled_count ?? 0;
  const cacheFallback = data?.cache_fallback_count ?? 0;
  const rainforestSuccess = data?.rainforest_success_count ?? 0;
  const skippedNotPriority = data?.rainforest_skipped_not_priority ?? 0;
  const skippedCacheFresh = data?.rainforest_skipped_cache_fresh ?? 0;

  const usageColor = usagePct >= 90 ? "text-destructive" : usagePct >= 70 ? "text-yellow-600" : "text-green-600";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Cloud className="h-5 w-5 text-primary" />
          Rainforest API Fallback
          <Badge variant="outline" className="ml-auto text-xs">Today</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Usage bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Daily Usage</span>
            <span className={`text-sm font-bold ${usageColor}`}>
              {callCount} / {DAILY_LIMIT} ({remaining} remaining)
            </span>
          </div>
          <Progress value={usagePct} className="h-2" />
        </div>

        {/* Decision flow counters */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <Zap className="h-3.5 w-3.5 text-red-500" />
              <span className="text-xs text-muted-foreground">SP-API Throttled</span>
            </div>
            <span className="text-xl font-bold text-foreground">{throttled}</span>
          </div>

          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <Database className="h-3.5 w-3.5 text-blue-500" />
              <span className="text-xs text-muted-foreground">Cache Fallback</span>
            </div>
            <span className="text-xl font-bold text-foreground">{cacheFallback}</span>
          </div>

          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <ShieldCheck className="h-3.5 w-3.5 text-green-500" />
              <span className="text-xs text-muted-foreground">Rainforest Success</span>
            </div>
            <span className="text-xl font-bold text-foreground">{rainforestSuccess}</span>
          </div>

          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <SkipForward className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Skipped (Not Priority)</span>
            </div>
            <span className="text-xl font-bold text-foreground">{skippedNotPriority}</span>
          </div>

          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <SkipForward className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Skipped (Cache Fresh)</span>
            </div>
            <span className="text-xl font-bold text-foreground">{skippedCacheFresh}</span>
          </div>

          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <Cloud className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs text-muted-foreground">Calls Remaining</span>
            </div>
            <span className={`text-xl font-bold ${remaining <= 10 ? "text-destructive" : "text-green-600"}`}>{remaining}</span>
          </div>
        </div>

        {/* Decision flow explanation */}
        <div className="p-3 rounded-lg border bg-muted/20 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Decision Flow:</p>
          <p>1️⃣ Fresh SP-API → 2️⃣ Cached Snapshot (≤30m) → 3️⃣ Rainforest (HOT/Priority only) → 4️⃣ Skip</p>
        </div>
      </CardContent>
    </Card>
  );
}
