import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Key, Zap, ShieldCheck, SkipForward, Database, RefreshCw, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

const DAILY_SOFT_CAP = 500;
const GUARD_LIMIT = 4; // of 5 tokens/min plan

interface UsageData {
  call_count: number;
  sp_api_throttled_count: number;
  cache_fallback_count: number;
  keepa_success_count: number;
  keepa_skipped_not_eligible: number;
  keepa_skipped_cache_fresh: number;
  keepa_skipped_token_budget: number;
  keepa_429_count: number;
  keepa_retry_success_count: number;
}

export default function KeepaUsagePanel() {
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
      .from("keepa_daily_usage")
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
  const remaining = DAILY_SOFT_CAP - callCount;
  const usagePct = Math.round((callCount / DAILY_SOFT_CAP) * 100);
  const throttled = data?.sp_api_throttled_count ?? 0;
  const cacheFallback = data?.cache_fallback_count ?? 0;
  const keepaSuccess = data?.keepa_success_count ?? 0;
  const skippedNotEligible = data?.keepa_skipped_not_eligible ?? 0;
  const skippedCacheFresh = data?.keepa_skipped_cache_fresh ?? 0;
  const skippedTokenBudget = data?.keepa_skipped_token_budget ?? 0;
  const keepa429Count = data?.keepa_429_count ?? 0;
  const keepaRetrySuccess = data?.keepa_retry_success_count ?? 0;

  const usageColor = usagePct >= 90 ? "text-destructive" : usagePct >= 70 ? "text-yellow-600" : "text-green-600";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Key className="h-5 w-5 text-primary" />
          Keepa API Fallback
          <Badge variant="outline" className="ml-auto text-xs">Today</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Usage bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Daily Usage</span>
            <span className={`text-sm font-bold ${usageColor}`}>
              {callCount} / {DAILY_SOFT_CAP} ({Math.max(0, remaining)} remaining)
            </span>
          </div>
          <Progress value={Math.min(usagePct, 100)} className="h-2" />
        </div>

        {/* Decision flow counters */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
              <span className="text-xs text-muted-foreground">Keepa Success</span>
            </div>
            <span className="text-xl font-bold text-foreground">{keepaSuccess}</span>
          </div>

          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <SkipForward className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Skipped (Not Eligible)</span>
            </div>
            <span className="text-xl font-bold text-foreground">{skippedNotEligible}</span>
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
              <SkipForward className="h-3.5 w-3.5 text-orange-500" />
              <span className="text-xs text-muted-foreground">Skipped (Token Budget)</span>
            </div>
            <span className="text-xl font-bold text-foreground">{skippedTokenBudget}</span>
          </div>

          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
              <span className="text-xs text-muted-foreground">Keepa 429s</span>
            </div>
            <span className="text-xl font-bold text-foreground">{keepa429Count}</span>
          </div>

          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <RefreshCw className="h-3.5 w-3.5 text-green-500" />
              <span className="text-xs text-muted-foreground">Retry Successes</span>
            </div>
            <span className="text-xl font-bold text-foreground">{keepaRetrySuccess}</span>
          </div>
        </div>

        {/* Decision flow explanation */}
        <div className="p-3 rounded-lg border bg-muted/20 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Decision Flow:</p>
          <p>1️⃣ Fresh SP-API → 2️⃣ Cached Snapshot → 3️⃣ Keepa (HOT/Priority/Manual only, ≤{GUARD_LIMIT}/min guard) → 4️⃣ Skip</p>
          <p className="mt-1">Plan: 5 tokens/min • Guard: {GUARD_LIMIT}/min (prevents 429) • Soft cap: {DAILY_SOFT_CAP}/day</p>
        </div>
      </CardContent>
    </Card>
  );
}
