import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, Activity, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

interface DispatchCycle {
  cycle_started_at: string;
  total_eligible: number;
  total_dispatched: number;
  total_evaluated: number;
  total_applied: number;
  total_errors: number;
  scoring_ms: number;
  dispatch_ms: number;
  total_ms: number;
  top_reasons: Record<string, number>;
}

interface HotTierSnapshot {
  healthy: number; // <20m
  breach20m: number;
  severe60m: number;
  critical120m: number;
  total: number;
}

export default function DispatchRecoveryProofPanel() {
  const { user } = useAuth();
  const [cycles, setCycles] = useState<DispatchCycle[]>([]);
  const [hotTiers, setHotTiers] = useState<HotTierSnapshot>({ healthy: 0, breach20m: 0, severe60m: 0, critical120m: 0, total: 0 });
  const [slotAlloc, setSlotAlloc] = useState<{ hotSlots: number; warmSlots: number; intlSlots: number; total: number }>({ hotSlots: 0, warmSlots: 0, intlSlots: 0, total: 0 });
  const [tailMetrics, setTailMetrics] = useState<{ p90_1h: number; p90_3h: number; p90_6h: number; trend: "improving" | "stable" | "degrading" }>({ p90_1h: 0, p90_3h: 0, p90_6h: 0, trend: "stable" });
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

      // Fetch recent dispatch cycles
      const { data: cycleData } = await supabase
        .from("repricer_dispatch_metrics")
        .select("cycle_started_at, total_eligible, total_dispatched, total_evaluated, total_applied, total_errors, scoring_ms, dispatch_ms, total_ms, top_reasons")
        .eq("user_id", user.id)
        .gte("cycle_started_at", sixHoursAgo)
        .order("cycle_started_at", { ascending: false })
        .limit(50);

      setCycles((cycleData as any[]) || []);

      // Compute slot allocation from most recent cycle's top_reasons
      if (cycleData && cycleData.length > 0) {
        const latest = cycleData[0] as any;
        const reasons = latest.top_reasons || {};
        // Estimate from reason keys
        let hotSlots = 0, warmSlots = 0;
        for (const [key, val] of Object.entries(reasons)) {
          const v = val as number;
          if (key.includes("hot_") || key === "starred" || key === "bb_alert" || key === "losing_bb" || key.includes("cooldown_expired")) {
            hotSlots += v;
          } else {
            warmSlots += v;
          }
        }
        // Simple: use dispatched count minus intl
        setSlotAlloc({
          hotSlots: Math.min(hotSlots, latest.total_dispatched),
          warmSlots: Math.max(0, latest.total_dispatched - hotSlots),
          intlSlots: 0,
          total: latest.total_dispatched || 0,
        });
      }

      // HOT tier snapshot — use same tight HOT classification as EligibleFreshnessPanel/CommandBlock
      // Only US marketplace, with min_price, with sellable stock, matching dispatcher HOT triggers
      const { data: hotData } = await supabase
        .from("repricer_assignments")
        .select("asin, sku, marketplace, last_sp_api_check_at, last_evaluated_at, is_priority, last_buybox_status, last_price_change_at, last_applied_price, last_buybox_price, min_price_override, rule_id")
        .eq("user_id", user.id)
        .eq("is_enabled", true)
        .eq("status", "active")
        .eq("marketplace", "US")
        .not("min_price_override", "is", null)
        .gt("min_price_override", 0);

      // Fetch inventory for stock check
      const { data: invRows } = await supabase
        .from("inventory")
        .select("sku, available")
        .eq("user_id", user.id);
      const stockMap = new Map<string, boolean>();
      for (const inv of (invRows || [])) {
        stockMap.set(inv.sku, (inv.available || 0) > 0);
      }

      // Fetch active BB alerts
      const { data: alertRows } = await supabase
        .from("bb_price_alerts")
        .select("asin")
        .eq("user_id", user.id)
        .eq("dismissed", false)
        .eq("acted", false);
      const alertedAsins = new Set((alertRows || []).map((a: any) => a.asin));

      const now = Date.now();
      const fifteenMinAgo = now - 15 * 60 * 1000;
      const toCents = (v: number | null | undefined) => Math.round((v ?? 0) * 100);
      let healthy = 0, breach20 = 0, severe60 = 0, critical120 = 0;

      for (const a of hotData || []) {
        // Must have sellable stock
        if (!(stockMap.get(a.sku) ?? false)) continue;

        const starred = !!a.is_priority;
        const bbAlert = alertedAsins.has(a.asin);
        const losingBb = !!(a.last_buybox_status && a.last_buybox_status !== "winning");
        let aboveBbGap = 0;
        if (a.last_applied_price && a.last_buybox_price) {
          const gap = toCents(a.last_applied_price) - toCents(a.last_buybox_price);
          if (gap > 0) aboveBbGap = gap;
        }
        const recentChange = a.last_price_change_at && new Date(a.last_price_change_at).getTime() > fifteenMinAgo;
        const isHot = starred || bbAlert || (losingBb && aboveBbGap >= 5) || (!!recentChange && losingBb);
        if (!isHot) continue;

        // Use best of last_evaluated_at or last_sp_api_check_at
        const evalTs = a.last_evaluated_at ? new Date(a.last_evaluated_at).getTime() : 0;
        const spTs = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
        const lastCheck = Math.max(evalTs, spTs);
        const ageMin = lastCheck ? (now - lastCheck) / 60000 : 9999;

        if (ageMin >= 120) critical120++;
        else if (ageMin >= 60) severe60++;
        else if (ageMin >= 20) breach20++;
        else healthy++;
      }
      setHotTiers({ healthy, breach20m: breach20, severe60m: severe60, critical120m: critical120, total: healthy + breach20 + severe60 + critical120 });

      // Tail metrics — use same tight HOT classification
      function computeHotP90(data: any[], windowMs: number): number {
        const cutoff = now - windowMs;
        const ages: number[] = [];
        for (const a of data || []) {
          if (!(stockMap.get(a.sku) ?? false)) continue;
          const starred = !!a.is_priority;
          const bbAlert = alertedAsins.has(a.asin);
          const losingBb = !!(a.last_buybox_status && a.last_buybox_status !== "winning");
          let aboveBbGap = 0;
          if (a.last_applied_price && a.last_buybox_price) {
            const gap = toCents(a.last_applied_price) - toCents(a.last_buybox_price);
            if (gap > 0) aboveBbGap = gap;
          }
          const recentChange = a.last_price_change_at && new Date(a.last_price_change_at).getTime() > fifteenMinAgo;
          const isHot = starred || bbAlert || (losingBb && aboveBbGap >= 5) || (!!recentChange && losingBb);
          if (!isHot) continue;
          const evalTs = a.last_evaluated_at ? new Date(a.last_evaluated_at).getTime() : 0;
          const spTs = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
          const checkAt = Math.max(evalTs, spTs);
          if (checkAt >= cutoff) {
            ages.push((now - checkAt) / 60000);
          }
        }
        if (ages.length === 0) return 0;
        ages.sort((a, b) => a - b);
        return Math.round(ages[Math.floor(ages.length * 0.9)] || 0);
      }

      // For trend we use overall HOT ages right now 
      const allHotAges: number[] = [];
      for (const a of hotData || []) {
        if (!(stockMap.get(a.sku) ?? false)) continue;
        const starred = !!a.is_priority;
        const bbAlert = alertedAsins.has(a.asin);
        const losingBb = !!(a.last_buybox_status && a.last_buybox_status !== "winning");
        let aboveBbGap = 0;
        if (a.last_applied_price && a.last_buybox_price) {
          const gap = toCents(a.last_applied_price) - toCents(a.last_buybox_price);
          if (gap > 0) aboveBbGap = gap;
        }
        const recentChange = a.last_price_change_at && new Date(a.last_price_change_at).getTime() > fifteenMinAgo;
        const isHot = starred || bbAlert || (losingBb && aboveBbGap >= 5) || (!!recentChange && losingBb);
        if (!isHot) continue;
        const evalTs = a.last_evaluated_at ? new Date(a.last_evaluated_at).getTime() : 0;
        const spTs = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
        const lastCheck = Math.max(evalTs, spTs);
        const ageMin = lastCheck ? (now - lastCheck) / 60000 : 9999;
        allHotAges.push(ageMin);
      }
      allHotAges.sort((a, b) => a - b);
      const currentP90 = allHotAges.length > 0 ? Math.round(allHotAges[Math.floor(allHotAges.length * 0.9)]) : 0;

      // Use dispatch cycle history to estimate if p90 is improving
      const recentCycles = (cycleData as any[]) || [];
      const firstHalf = recentCycles.slice(0, Math.floor(recentCycles.length / 2));
      const secondHalf = recentCycles.slice(Math.floor(recentCycles.length / 2));
      const avgFirstApplied = firstHalf.length > 0 ? firstHalf.reduce((s, c) => s + (c.total_applied || 0), 0) / firstHalf.length : 0;
      const avgSecondApplied = secondHalf.length > 0 ? secondHalf.reduce((s, c) => s + (c.total_applied || 0), 0) / secondHalf.length : 0;

      const trend = avgFirstApplied > avgSecondApplied * 1.2 ? "improving" : avgFirstApplied < avgSecondApplied * 0.8 ? "degrading" : "stable";

      setTailMetrics({
        p90_1h: computeHotP90(hotData || [], 1 * 60 * 60 * 1000),
        p90_3h: computeHotP90(hotData || [], 3 * 60 * 60 * 1000),
        p90_6h: computeHotP90(hotData || [], 6 * 60 * 60 * 1000),
        trend,
      });
    } catch (err) {
      console.error("DispatchRecoveryProof fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const TrendIcon = tailMetrics.trend === "improving" ? TrendingUp : tailMetrics.trend === "degrading" ? TrendingDown : Minus;
  const trendColor = tailMetrics.trend === "improving" ? "text-green-500" : tailMetrics.trend === "degrading" ? "text-destructive" : "text-muted-foreground";

  const recentCycles = cycles.slice(0, 6);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" />
            Dispatch Recovery Proof
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={fetchData} disabled={loading} className="h-7 gap-1 text-xs">
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Live HOT severity tiers, dispatcher slot allocation, and tail metric trends</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* HOT Severity Buckets */}
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">HOT Severity Tiers (Live)</h4>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <TierCard label="Total HOT" value={hotTiers.total} color="text-foreground" />
            <TierCard label="Healthy <20m" value={hotTiers.healthy} color="text-green-500" />
            <TierCard label="Breach 20m+" value={hotTiers.breach20m} color="text-amber-500" />
            <TierCard label="Severe 60m+" value={hotTiers.severe60m} color="text-orange-500" />
            <TierCard label="Critical 120m+" value={hotTiers.critical120m} color="text-destructive" />
          </div>
        </div>

        {/* Dispatcher Slot Allocation */}
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Last Dispatch Slot Allocation</h4>
          <div className="flex gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs">HOT: {slotAlloc.hotSlots}</Badge>
            <Badge variant="outline" className="text-xs">WARM: {slotAlloc.warmSlots}</Badge>
            {slotAlloc.intlSlots > 0 && <Badge variant="outline" className="text-xs">Intl: {slotAlloc.intlSlots}</Badge>}
            <Badge variant="secondary" className="text-xs">Total: {slotAlloc.total}</Badge>
          </div>
        </div>

        {/* Tail Metrics */}
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            HOT p90 Tail Trend
            <TrendIcon className={`inline h-3.5 w-3.5 ml-1.5 ${trendColor}`} />
            <span className={`ml-1 text-[10px] font-normal ${trendColor}`}>{tailMetrics.trend}</span>
          </h4>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border p-2 text-center">
              <div className="text-[10px] text-muted-foreground">Checked 1h</div>
              <div className="text-sm font-bold">{tailMetrics.p90_1h}m</div>
            </div>
            <div className="rounded-md border p-2 text-center">
              <div className="text-[10px] text-muted-foreground">Checked 3h</div>
              <div className="text-sm font-bold">{tailMetrics.p90_3h}m</div>
            </div>
            <div className="rounded-md border p-2 text-center">
              <div className="text-[10px] text-muted-foreground">Checked 6h</div>
              <div className="text-sm font-bold">{tailMetrics.p90_6h}m</div>
            </div>
          </div>
        </div>

        {/* Recent Dispatch Cycles */}
        {recentCycles.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Recent Dispatch Cycles</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-1 pr-2">Time</th>
                    <th className="text-right py-1 px-1">Eligible</th>
                    <th className="text-right py-1 px-1">Dispatched</th>
                    <th className="text-right py-1 px-1">Applied</th>
                    <th className="text-right py-1 px-1">Errors</th>
                    <th className="text-right py-1 pl-1">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {recentCycles.map((c, i) => {
                    const t = new Date(c.cycle_started_at);
                    const timeStr = t.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
                    return (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-1 pr-2 font-mono">{timeStr}</td>
                        <td className="py-1 px-1 text-right">{c.total_eligible}</td>
                        <td className="py-1 px-1 text-right">{c.total_dispatched}</td>
                        <td className="py-1 px-1 text-right font-medium">{c.total_applied}</td>
                        <td className={`py-1 px-1 text-right ${c.total_errors > 0 ? "text-destructive" : ""}`}>{c.total_errors}</td>
                        <td className="py-1 pl-1 text-right text-muted-foreground">{(c.total_ms / 1000).toFixed(1)}s</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TierCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-md border p-2 text-center">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
    </div>
  );
}
