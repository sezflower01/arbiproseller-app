import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Flame, Thermometer, Snowflake, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

interface TierData {
  hot: number;
  warm: number;
  cold: number;
  total: number;
  hotReasons: Record<string, number>;
  loading: boolean;
}

export default function TierDistributionPanel() {
  const { user } = useAuth();
  const [data, setData] = useState<TierData>({
    hot: 0, warm: 0, cold: 0, total: 0, hotReasons: {}, loading: true,
  });

  const classify = async () => {
    if (!user) return;
    setData(d => ({ ...d, loading: true }));

    try {
      // Fetch active assignments with required fields
      const { data: assignments } = await (supabase as any)
        .from("repricer_assignments")
        .select("id, asin, sku, is_priority, last_sp_api_check_at, last_buybox_price, last_applied_price, last_buybox_status, buybox_lost_at, last_price_change_at, marketplace, min_price_override")
        .eq("user_id", user.id)
        .eq("is_enabled", true)
        .not("rule_id", "is", null)
        .in("status", ["active"]);

      if (!assignments || assignments.length === 0) {
        setData({ hot: 0, warm: 0, cold: 0, total: 0, hotReasons: {}, loading: false });
        return;
      }

      // Filter setup-incomplete
      const eligible = assignments.filter((a: any) => a.min_price_override && a.min_price_override > 0);
      const usAssignments = eligible.filter((a: any) => a.marketplace === "US");

      // Fetch inventory stock
      const skus = [...new Set(usAssignments.map((a: any) => a.sku).filter(Boolean))] as string[];
      const stockMap = new Map<string, boolean>();
      const BATCH = 200;
      for (let i = 0; i < skus.length; i += BATCH) {
        const batch = skus.slice(i, i + BATCH);
        const { data: inv } = await (supabase as any)
          .from("inventory")
          .select("sku, available, reserved, inbound")
          .eq("user_id", user.id)
          .in("sku", batch);
        for (const row of inv || []) {
          stockMap.set(row.sku, (row.available || 0) > 0 || (row.reserved || 0) > 0);
        }
      }

      // Fetch today's sales
      const todayStr = new Date().toISOString().split("T")[0];
      const { data: todaySales } = await (supabase as any)
        .from("asin_sales_daily")
        .select("asin")
        .eq("user_id", user.id)
        .eq("date", todayStr)
        .gt("units", 0);
      const soldToday = new Set((todaySales || []).map((s: any) => s.asin));

      // Fetch BB alerts
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data: alerts } = await (supabase as any)
        .from("bb_price_alerts")
        .select("asin")
        .eq("user_id", user.id)
        .eq("dismissed", false)
        .gte("created_at", twoHoursAgo);
      const alertedAsins = new Set((alerts || []).map((a: any) => a.asin));

      // Classify using v5 logic
      const nowMs = Date.now();
      const fifteenMinAgo = nowMs - 15 * 60 * 1000;
      let hot = 0, warm = 0, cold = 0;
      const reasons: Record<string, number> = {};

      const toCents = (v: number | null) => Math.round((v ?? 0) * 100);

      for (const a of usAssignments) {
        const hasStock = stockMap.get(a.sku) ?? false;
        if (!hasStock) { cold++; continue; }

        const losingBb = !!(a.last_buybox_status && a.last_buybox_status !== "winning");
        let aboveBbGap = 0;
        if (a.last_applied_price && a.last_buybox_price) {
          const gap = toCents(a.last_applied_price) - toCents(a.last_buybox_price);
          if (gap > 0) aboveBbGap = gap;
        }
        const recentChange = a.last_price_change_at && new Date(a.last_price_change_at).getTime() > fifteenMinAgo;
        const sold = soldToday.has(a.asin);
        const starred = !!a.is_priority;
        const bbAlert = alertedAsins.has(a.asin);

        const hotReasons: string[] = [];
        if (starred) hotReasons.push("starred");
        if (bbAlert) hotReasons.push("bb_alert");
        if (losingBb && aboveBbGap >= 5) hotReasons.push("losing_bb_gap");
        if (aboveBbGap >= 10 && !hotReasons.some(r => r.startsWith("losing"))) hotReasons.push("above_bb_significant");
        if (losingBb && sold && !hotReasons.some(r => r.startsWith("losing"))) hotReasons.push("losing_bb_sold");
        if (recentChange && losingBb && !hotReasons.some(r => r.startsWith("losing"))) hotReasons.push("competitor_moved");

        if (hotReasons.length > 0) {
          hot++;
          for (const r of hotReasons) reasons[r] = (reasons[r] || 0) + 1;
        } else {
          warm++;
        }
      }

      // International = cold
      const intlCount = eligible.filter((a: any) => a.marketplace !== "US").length;
      cold += intlCount;

      setData({
        hot, warm, cold,
        total: hot + warm + cold,
        hotReasons: reasons,
        loading: false,
      });
    } catch (e) {
      console.error("[TierDistribution] Error:", e);
      setData(d => ({ ...d, loading: false }));
    }
  };

  useEffect(() => { classify(); }, [user]);

  if (data.loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const pct = (n: number) => data.total > 0 ? Math.round((n / data.total) * 100) : 0;

  const hotHealthy = data.hot <= 80;
  const hotWarning = data.hot > 80 && data.hot <= 150;

  const sortedReasons = Object.entries(data.hotReasons).sort((a, b) => b[1] - a[1]);

  const reasonLabels: Record<string, string> = {
    starred: "⭐ Starred",
    bb_alert: "🔔 BB Alert",
    losing_bb_gap: "📉 Losing BB + Gap",
    above_bb_significant: "⬆️ Above BB ≥10¢",
    losing_bb_sold: "🔥 Losing BB + Sold",
    competitor_moved: "⚡ Competitor Moved",
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Flame className="h-5 w-5 text-orange-500" />
          Tier Distribution (v5)
          <Badge
            variant={hotHealthy ? "default" : hotWarning ? "secondary" : "destructive"}
            className="ml-auto text-xs"
          >
            {data.total} eligible
          </Badge>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={classify}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Tier bars */}
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 rounded-lg border bg-orange-500/10 border-orange-500/20">
            <div className="flex items-center gap-1.5 mb-1">
              <Flame className="h-3.5 w-3.5 text-orange-500" />
              <span className="text-xs font-medium text-orange-700 dark:text-orange-400">HOT</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold text-foreground">{data.hot}</span>
              <span className="text-xs text-muted-foreground">({pct(data.hot)}%)</span>
            </div>
            <Progress value={pct(data.hot)} className="h-1.5 mt-1.5 [&>div]:bg-orange-500" />
          </div>

          <div className="p-3 rounded-lg border bg-yellow-500/10 border-yellow-500/20">
            <div className="flex items-center gap-1.5 mb-1">
              <Thermometer className="h-3.5 w-3.5 text-yellow-600" />
              <span className="text-xs font-medium text-yellow-700 dark:text-yellow-400">WARM</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold text-foreground">{data.warm}</span>
              <span className="text-xs text-muted-foreground">({pct(data.warm)}%)</span>
            </div>
            <Progress value={pct(data.warm)} className="h-1.5 mt-1.5 [&>div]:bg-yellow-500" />
          </div>

          <div className="p-3 rounded-lg border bg-blue-500/10 border-blue-500/20">
            <div className="flex items-center gap-1.5 mb-1">
              <Snowflake className="h-3.5 w-3.5 text-blue-500" />
              <span className="text-xs font-medium text-blue-700 dark:text-blue-400">COLD</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold text-foreground">{data.cold}</span>
              <span className="text-xs text-muted-foreground">({pct(data.cold)}%)</span>
            </div>
            <Progress value={pct(data.cold)} className="h-1.5 mt-1.5 [&>div]:bg-blue-500" />
          </div>
        </div>

        {/* HOT health indicator */}
        {!hotHealthy && (
          <div className={`text-xs px-3 py-2 rounded-md ${hotWarning ? "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400" : "bg-destructive/10 text-destructive"}`}>
            ⚠️ HOT queue has {data.hot} items — {hotWarning ? "getting crowded" : "too many for effective rotation"}. Target: ≤80.
          </div>
        )}
        {hotHealthy && data.hot > 0 && (
          <div className="text-xs px-3 py-2 rounded-md bg-green-500/10 text-green-700 dark:text-green-400">
            ✅ HOT queue healthy at {data.hot} items — urgent ASINs will rotate quickly.
          </div>
        )}

        {/* HOT reasons breakdown */}
        {sortedReasons.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Why ASINs are HOT:</span>
            <div className="flex flex-wrap gap-1.5">
              {sortedReasons.map(([key, count]) => (
                <Badge key={key} variant="outline" className="text-xs gap-1">
                  {reasonLabels[key] || key}
                  <span className="font-bold">{count}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
