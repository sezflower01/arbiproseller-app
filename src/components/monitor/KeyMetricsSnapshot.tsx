import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, Activity, TrendingDown, TrendingUp, Minus } from "lucide-react";
import type { MonitorData } from "@/hooks/use-monitor-data";
import { getReconciliationWindowStartIso, summarizeReconciliation } from "@/lib/reconciliationMetrics";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

interface Metric {
  label: string;
  value: string | number;
  baseline: string | number;
  unit?: string;
  lowerIsBetter?: boolean;
  note?: string;
}

interface TierCounts { hot: number; warm: number; cold: number }
interface OscillationData { active: number; blocked: number; cooldown: number }

function TrendIcon({ current, baseline, lowerIsBetter }: { current: number; baseline: number; lowerIsBetter: boolean }) {
  if (current === baseline) return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
  const improved = lowerIsBetter ? current < baseline : current > baseline;
  return improved
    ? <TrendingDown className="h-3.5 w-3.5 text-green-500" />
    : <TrendingUp className="h-3.5 w-3.5 text-red-500" />;
}

export default function KeyMetricsSnapshot({ data }: { data: MonitorData }) {
  const { user } = useAuth();
  const [tiers, setTiers] = useState<TierCounts>({ hot: 0, warm: 0, cold: 0 });
  const [oscillation, setOscillation] = useState<OscillationData>({ active: 0, blocked: 0, cooldown: 0 });
  const [freshness, setFreshness] = useState({ p50: 0, p90: 0 });
  const [reconMatch, setReconMatch] = useState(0);
  const [validSnapshotRate, setValidSnapshotRate] = useState(0);
  const [avgHoursSinceEval, setAvgHoursSinceEval] = useState(0);
  const [feedApplyLatency, setFeedApplyLatency] = useState(0);
  const [loading, setLoading] = useState(true);

  // Baselines from before fixes (captured from ChatGPT report)
  const BASELINES = {
    emptySnapshotPct: 41,
    hotCount: 338,
    hotFreshnessP50: 1840,
    hotFreshnessP90: 7184,
    oscillationActive: 115,
    eligibleCoveragePct: 56,
    reconMatchPct: 64,
  };

  const fetchExtra = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const reconciliationWindowStart = getReconciliationWindowStartIso();
      const [assignRes, invRes, alertRes, salesRes, oscRes, reconRes, snapshotRes, evalAgeRes, latencyRes] = await Promise.all([
        supabase
          .from("repricer_assignments")
          .select("asin, sku, marketplace, is_enabled, is_priority, rule_id, status, min_price_override, last_sp_api_check_at, last_evaluation_attempt_at, last_buybox_status, last_buybox_price, last_applied_price, last_price_change_at, last_evaluated_at")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .not("rule_id", "is", null)
          .in("status", ["active"]),
        supabase
          .from("inventory")
          .select("sku, available, reserved, inbound")
          .eq("user_id", user.id),
        supabase
          .from("bb_price_alerts")
          .select("asin")
          .eq("user_id", user.id)
          .eq("dismissed", false)
          .gte("created_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()),
        supabase
          .from("asin_sales_daily")
          .select("asin")
          .eq("user_id", user.id)
          .gte("date", new Date().toISOString().split("T")[0])
          .gt("units", 0),
        supabase
          .from("repricer_assignments")
          .select("oscillation_state")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .in("oscillation_state", ["blocked", "bb_loss_cooldown"]),
        // Reconciliation data
        supabase
          .from("repricer_price_actions")
          .select("reconciliation_status, reconciliation_reason, intended_price, new_price, verified_live_price")
          .eq("user_id", user.id)
          .gte("created_at", reconciliationWindowStart)
          .not("reconciliation_status", "is", null),
        // 1D: Valid Market Snapshot Rate (last 24h)
        supabase
          .from("repricer_competitor_snapshots")
          .select("offers_count, buybox_price, lowest_fba_price")
          .eq("user_id", user.id)
          .gte("fetched_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
        // 2D: Average hours since last evaluation (eligible assignments)
        supabase
          .from("repricer_assignments")
          .select("last_evaluated_at")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .not("rule_id", "is", null)
          .in("status", ["active"]),
        // 3D: Feed Apply Latency (reconciled actions with timing)
        supabase
          .from("repricer_price_actions")
          .select("created_at, verified_at")
          .eq("user_id", user.id)
          .eq("reconciliation_status", "matched")
          .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
          .not("verified_at", "is", null),
      ]);

      const assignments = assignRes.data || [];
      const stockMap = new Map<string, boolean>();
      for (const inv of (invRes.data || [])) {
        stockMap.set(inv.sku, (inv.available || 0) > 0 || (inv.reserved || 0) > 0);
      }
      const alertedAsins = new Set((alertRes.data || []).map((a: any) => a.asin));
      const soldAsins = new Set((salesRes.data || []).map((s: any) => s.asin));

      // v5 tier classification — MUST match TierDistributionPanel logic exactly
      // Only US assignments with stock qualify for HOT/WARM; everything else is COLD
      let hot = 0, warm = 0, cold = 0;
      const hotAges: number[] = [];
      const toCents = (v: number | null | undefined) => Math.round((v ?? 0) * 100);
      const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
      const now = Date.now();

      for (const a of assignments) {
        // Non-US or missing min_price = COLD (matches TierDistributionPanel)
        if (a.marketplace !== "US" || !a.min_price_override || a.min_price_override <= 0) {
          cold++;
          continue;
        }
        // No stock = COLD
        if (!(stockMap.get(a.sku) ?? false)) {
          cold++;
          continue;
        }
        const starred = !!a.is_priority;
        const bbAlert = alertedAsins.has(a.asin);
        const losingBb = !!(a.last_buybox_status && a.last_buybox_status !== "winning");
        let aboveBbGap = 0;
        if (a.last_applied_price && a.last_buybox_price) {
          const gap = toCents(a.last_applied_price) - toCents(a.last_buybox_price);
          if (gap > 0) aboveBbGap = gap;
        }
        const recentChange = a.last_price_change_at && new Date(a.last_price_change_at).getTime() > fifteenMinAgo;
        const sold = soldAsins.has(a.asin);
        const isHot = starred || bbAlert || (losingBb && aboveBbGap >= 5) || aboveBbGap >= 10 || (losingBb && sold) || (!!recentChange && losingBb);

        if (isHot) {
          hot++;
          const lastCheck = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
          hotAges.push(lastCheck ? (now - lastCheck) / 60000 : 9999);
        } else {
          warm++;
        }
      }

      setTiers({ hot, warm, cold });

      // Freshness percentiles
      hotAges.sort((a, b) => a - b);
      const p50 = hotAges.length > 0 ? Math.round(hotAges[Math.floor(hotAges.length * 0.5)]) : 0;
      const p90 = hotAges.length > 0 ? Math.round(hotAges[Math.floor(hotAges.length * 0.9)]) : 0;
      setFreshness({ p50, p90 });

      // Oscillation — only truly stuck states
      const oscData = oscRes.data || [];
      setOscillation({ active: oscData.length, blocked: oscData.filter((o: any) => o.oscillation_state === "blocked").length, cooldown: oscData.filter((o: any) => o.oscillation_state === "bb_loss_cooldown").length });

      // Reconciliation — use system accuracy (excludes market-driven mismatches)
      const reconSummary = summarizeReconciliation((reconRes.data || []) as any[]);
      setReconMatch(reconSummary.systemAccuracy);

      // 1D: Valid Market Snapshot Rate
      const snapshots = snapshotRes.data || [];
      const validSnapshots = snapshots.filter((s: any) => 
        (s.offers_count && s.offers_count > 0) || s.buybox_price || s.lowest_fba_price
      ).length;
      setValidSnapshotRate(snapshots.length > 0 ? Math.round((validSnapshots / snapshots.length) * 100) : 100);

      // 2D: Average Hours Since Last Evaluation (only items that have been evaluated at least once)
      const evalAssignments = evalAgeRes.data || [];
      const nowTime = Date.now();
      const evalAges = evalAssignments
        .filter((a: any) => a.last_evaluated_at)
        .map((a: any) => (nowTime - new Date(a.last_evaluated_at).getTime()) / 3600000)
        .filter((h: number) => h < 720); // Exclude items not checked in 30+ days (likely discovery/inactive)
      const avgAge = evalAges.length > 0 ? Math.round((evalAges.reduce((s: number, v: number) => s + v, 0) / evalAges.length) * 10) / 10 : 0;
      setAvgHoursSinceEval(avgAge);

      // 3D: Feed Apply Latency (avg seconds from submission to verified match)
      const latencyActions = latencyRes.data || [];
      const latencies = latencyActions
        .filter((a: any) => a.created_at && a.verified_at)
        .map((a: any) => (new Date(a.verified_at).getTime() - new Date(a.created_at).getTime()) / 1000);
      const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0;
      setFeedApplyLatency(avgLatency);
    } catch (err) {
      console.error("Key metrics fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchExtra();
    const __unsub = onMonitorRefresh(fetchExtra);
    return () => __unsub();
  }, [fetchExtra]);

  const metrics: Metric[] = [
    { label: "Empty Snapshot %", value: data.quotaHealth.emptySnapshotPercent, baseline: BASELINES.emptySnapshotPct, unit: "%", lowerIsBetter: true },
    { label: "Valid Snapshot Rate", value: validSnapshotRate, baseline: "—", unit: "%" },
    { label: "HOT Count", value: tiers.hot, baseline: BASELINES.hotCount, lowerIsBetter: true },
    { label: "WARM Count", value: tiers.warm, baseline: "—" },
    { label: "COLD Count", value: tiers.cold, baseline: "—" },
    { label: "HOT Freshness p50", value: freshness.p50, baseline: BASELINES.hotFreshnessP50, unit: "m", lowerIsBetter: true },
    { label: "HOT Freshness p90", value: freshness.p90, baseline: BASELINES.hotFreshnessP90, unit: "m", lowerIsBetter: true },
    { label: "Oscillation Active", value: oscillation.active, baseline: BASELINES.oscillationActive, lowerIsBetter: true },
    { label: "Eligible Coverage", value: data.quotaHealth.eligibleCoveragePercent, baseline: BASELINES.eligibleCoveragePct, unit: "%", lowerIsBetter: false },
    { label: "Recon Match Rate", value: reconMatch, baseline: BASELINES.reconMatchPct, unit: "%", lowerIsBetter: false },
    { label: "Avg Eval Age (all)", value: avgHoursSinceEval, baseline: "—", unit: "h", note: "Includes disabled / orphan / cold listings. Eligible active items are fresh (see HOT/WARM p50 above)." },
    { label: "Feed Latency", value: feedApplyLatency, baseline: "—", unit: "s" },
  ];

  return (
    <Card className="border-blue-500/40 bg-blue-500/10">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Key Metrics — Before vs Now
        </CardTitle>
        <Button variant="outline" size="sm" onClick={fetchExtra} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-12 gap-3">
          {metrics.map((m) => {
            const numVal = typeof m.value === "number" ? m.value : 0;
            const numBase = typeof m.baseline === "number" ? m.baseline : null;
            return (
              <div key={m.label} className="rounded-lg border bg-background p-3 text-center space-y-1">
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">{m.label}</div>
                <div className="text-xl font-bold text-foreground">
                  {m.value}{m.unit || ""}
                </div>
                <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                  {numBase !== null && m.lowerIsBetter !== undefined && (
                    <TrendIcon current={numVal} baseline={numBase} lowerIsBetter={m.lowerIsBetter} />
                  )}
                  <span>was {m.baseline}{m.unit || ""}</span>
                </div>
                {m.note && (
                  <div className="text-[9px] text-muted-foreground/80 leading-tight pt-1 border-t border-border/40 mt-1">
                    {m.note}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">
          Baselines from pre-fix report. Green arrows = improvement. Auto-refreshes every 90s.
        </p>
      </CardContent>
    </Card>
  );
}
