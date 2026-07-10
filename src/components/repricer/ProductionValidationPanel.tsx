import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Activity, CheckCircle2, XCircle, RefreshCw, Clock, Zap,
  Database, Shield, TrendingUp, AlertTriangle, BarChart3,
} from "lucide-react";

interface WorkerMetrics {
  worker_id: string;
  cycles: number;
  totalDispatched: number;
  totalEvaluated: number;
  totalApplied: number;
  avgDispatchMs: number;
  userCount: number;
  activeAsins: number;
}

interface MeasuredMetrics {
  // Scale
  totalAssignments: number;
  enabledAssignments: number;
  hotCount: number;
  warmCount: number;
  coldCount: number;

  // Throughput (measured)
  evalsInWindow: number;
  priceChangesInWindow: number;
  feedsSubmittedInWindow: number;
  feedSuccessRate: number;

  // Freshness (measured from timestamps)
  avgEvalAgeMinutes: number;
  p50EvalAgeMinutes: number;
  p90EvalAgeMinutes: number;
  staleCount: number; // not evaluated in >60m

  // API health
  throttleCount: number;
  failureCount: number;
  consecutiveFailureMax: number;

  // DB pressure
  writesThisCycle: number;
  writesCap: number;
  safeMode: boolean;
  queuePaused: boolean;

  // SP-API
  spApiCallsThisWindow: number;
  spApiCap: number;

  // Worker-level
  workers: WorkerMetrics[];
}

type TimeWindow = "1h" | "4h" | "12h" | "24h";

const WINDOW_HOURS: Record<TimeWindow, number> = { "1h": 1, "4h": 4, "12h": 12, "24h": 24 };

export default function ProductionValidationPanel() {
  const { user } = useAuth();
  const [window, setWindow] = useState<TimeWindow>("1h");
  const [metrics, setMetrics] = useState<MeasuredMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const fetchMetrics = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const hours = WINDOW_HOURS[window];
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const now = new Date().toISOString();

      // Parallel queries
      const [
        assignmentsRes,
        priceActionsRes,
        snapshotsCountRes,
        feedsRes,
        settingsRes,
        dispatchMetricsRes,
        shardStatsRes,
      ] = await Promise.all([
        // All assignments with tier info
        supabase
          .from("repricer_assignments")
          .select("id, is_enabled, status, last_evaluated_at, consecutive_failures, last_throttle_at, last_failure_at")
          .eq("user_id", user.id),

        // Price actions in window (actual evaluations — every eval writes here)
        supabase
          .from("repricer_price_actions")
          .select("id, action_type, old_price, new_price, created_at, error_type")
          .eq("user_id", user.id)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(1000),

        // Competitor snapshots in window (actual SP-API fetches)
        supabase
          .from("repricer_competitor_snapshots")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .gte("fetched_at", since),

        // Feed submissions in window
        supabase
          .from("repricer_feed_submissions")
          .select("id, status, skus_succeeded, skus_failed, submitted_at")
          .eq("user_id", user.id)
          .gte("submitted_at", since)
          .limit(500),

        // Settings
        supabase
          .from("repricer_settings")
          .select("writes_this_cycle, safe_mode_active, queue_paused, sp_api_calls_this_window, sp_api_calls_per_minute_cap")
          .eq("user_id", user.id)
          .maybeSingle(),

        // Worker dispatch metrics
        supabase
          .from("repricer_dispatch_metrics")
          .select("worker_id, total_dispatched, total_evaluated, total_applied, dispatch_ms")
          .eq("user_id", user.id)
          .gte("cycle_started_at", since)
          .limit(500),

        // Per-worker shard stats (user counts + active ASINs)
        supabase
          .from("repricer_settings")
          .select("dispatch_worker_shard, user_id")
          .eq("scheduler_enabled", true),
      ]);

      const assignments = assignmentsRes.data || [];
      const priceActions = priceActionsRes.data || [];
      const fetchCount = snapshotsCountRes.count || 0;
      const feeds = feedsRes.data || [];
      const settings = settingsRes.data;

      // Count tiers from assignments
      const enabled = assignments.filter(a => a.is_enabled);
      const nowMs = Date.now();

      // Estimate tiers from last_evaluated_at freshness
      let hotCount = 0, warmCount = 0, coldCount = 0;
      const evalAges: number[] = [];
      let staleCount = 0;

      for (const a of enabled) {
        const evalAt = a.last_evaluated_at ? new Date(a.last_evaluated_at).getTime() : 0;
        const ageMin = evalAt ? (nowMs - evalAt) / 60000 : 9999;

        if (evalAt) evalAges.push(ageMin);
        if (ageMin > 60) staleCount++;

        if (a.status === "hot" || ageMin < 15) hotCount++;
        else if (a.status === "warm" || ageMin < 45) warmCount++;
        else coldCount++;
      }

      evalAges.sort((a, b) => a - b);
      const p50Idx = Math.floor(evalAges.length * 0.5);
      const p90Idx = Math.floor(evalAges.length * 0.9);

      // Price changes = price actions where new_price differs from old_price
      const priceChanges = priceActions.filter(d => d.new_price && d.old_price && d.new_price !== d.old_price);

      // Feed success rate
      const completedFeeds = feeds.filter(f => f.status === "DONE" || f.status === "completed");
      const totalFeedSkus = feeds.reduce((s, f) => s + (f.skus_succeeded || 0) + (f.skus_failed || 0), 0);
      const succeededSkus = feeds.reduce((s, f) => s + (f.skus_succeeded || 0), 0);
      const feedSuccessRate = totalFeedSkus > 0 ? (succeededSkus / totalFeedSkus) * 100 : 100;

      // Throttle & failure counts
      const throttled = assignments.filter(a => a.last_throttle_at && new Date(a.last_throttle_at) > new Date(since));
      const failed = assignments.filter(a => a.last_failure_at && new Date(a.last_failure_at) > new Date(since));
      const maxConsecutiveFailures = Math.max(0, ...assignments.map(a => a.consecutive_failures || 0));

      // Aggregate worker-level dispatch metrics
      const dispatchRows = dispatchMetricsRes.data || [];
      const shardRows = shardStatsRes.data || [];
      
      // Count users per shard
      const shardUserCounts = new Map<string, number>();
      for (const row of shardRows) {
        const shard = (row as any).dispatch_worker_shard || 'A';
        shardUserCounts.set(shard, (shardUserCounts.get(shard) || 0) + 1);
      }

      // Get active ASIN counts per shard by looking up assignments for shard users
      const shardUserIds = new Map<string, string[]>();
      for (const row of shardRows) {
        const shard = (row as any).dispatch_worker_shard || 'A';
        const existing = shardUserIds.get(shard) || [];
        existing.push((row as any).user_id);
        shardUserIds.set(shard, existing);
      }

      const workerMap = new Map<string, { cycles: number; dispatched: number; evaluated: number; applied: number; totalMs: number }>();
      for (const row of dispatchRows) {
        const wid = (row as any).worker_id || 'A';
        const prev = workerMap.get(wid) || { cycles: 0, dispatched: 0, evaluated: 0, applied: 0, totalMs: 0 };
        prev.cycles++;
        prev.dispatched += (row as any).total_dispatched || 0;
        prev.evaluated += (row as any).total_evaluated || 0;
        prev.applied += (row as any).total_applied || 0;
        prev.totalMs += (row as any).dispatch_ms || 0;
        workerMap.set(wid, prev);
      }

      // Fetch active ASIN counts per shard
      const shardAsinCounts = new Map<string, number>();
      for (const [shard, userIds] of shardUserIds.entries()) {
        // Query enabled assignments for all users in this shard
        const { count } = await supabase
          .from("repricer_assignments")
          .select("id", { count: "exact", head: true })
          .in("user_id", userIds)
          .eq("is_enabled", true);
        shardAsinCounts.set(shard, count || 0);
      }

      // Ensure both A and B always show
      const allShards = new Set([...workerMap.keys(), ...shardUserCounts.keys(), 'A', 'B']);
      const workers: WorkerMetrics[] = Array.from(allShards).map((id) => {
        const w = workerMap.get(id) || { cycles: 0, dispatched: 0, evaluated: 0, applied: 0, totalMs: 0 };
        return {
          worker_id: id,
          cycles: w.cycles,
          totalDispatched: w.dispatched,
          totalEvaluated: w.evaluated,
          totalApplied: w.applied,
          avgDispatchMs: w.cycles > 0 ? Math.round(w.totalMs / w.cycles) : 0,
          userCount: shardUserCounts.get(id) || 0,
          activeAsins: shardAsinCounts.get(id) || 0,
        };
      }).sort((a, b) => a.worker_id.localeCompare(b.worker_id));

      setMetrics({
        totalAssignments: assignments.length,
        enabledAssignments: enabled.length,
        hotCount,
        warmCount,
        coldCount,
        evalsInWindow: priceActions.length,
        priceChangesInWindow: priceChanges.length,
        feedsSubmittedInWindow: feeds.length,
        feedSuccessRate,
        avgEvalAgeMinutes: evalAges.length > 0 ? evalAges.reduce((a, b) => a + b, 0) / evalAges.length : 0,
        p50EvalAgeMinutes: evalAges[p50Idx] || 0,
        p90EvalAgeMinutes: evalAges[p90Idx] || 0,
        staleCount,
        throttleCount: throttled.length,
        failureCount: failed.length,
        consecutiveFailureMax: maxConsecutiveFailures,
        writesThisCycle: settings?.writes_this_cycle || 0,
        writesCap: 500,
        safeMode: settings?.safe_mode_active || false,
        queuePaused: settings?.queue_paused || false,
        spApiCallsThisWindow: settings?.sp_api_calls_this_window || 0,
        spApiCap: settings?.sp_api_calls_per_minute_cap || 30,
        workers,
      });
      setLastFetched(new Date());
    } catch (err) {
      console.error("Production validation fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [user, window]);

  useEffect(() => { fetchMetrics(); }, [fetchMetrics]);

  const fmtNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0);

  if (!metrics) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground text-sm">
          {loading ? "Loading production metrics…" : "No data available"}
        </CardContent>
      </Card>
    );
  }

  const hours = WINDOW_HOURS[window];
  const evalsPerMin = metrics.evalsInWindow / (hours * 60);
  const changesPerMin = metrics.priceChangesInWindow / (hours * 60);
  const hotP90Ok = metrics.p90EvalAgeMinutes <= 30;
  const dbPressureOk = metrics.writesThisCycle < metrics.writesCap * 0.8;
  const apiHealthOk = metrics.throttleCount < 10 && metrics.consecutiveFailureMax < 5;
  const overallHealthy = hotP90Ok && dbPressureOk && apiHealthOk && !metrics.safeMode && !metrics.queuePaused;

  // Scale projections
  const currentAsinsPerUser = metrics.enabledAssignments || 1;
  const projectedUsers1k = Math.round(evalsPerMin > 0 ? (1000 * currentAsinsPerUser) / (evalsPerMin * 60) : 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-lg">Production Validation — Measured Results</h3>
          <Badge variant="outline" className="text-[10px]">LIVE DATA</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Select value={window} onValueChange={(v) => setWindow(v as TimeWindow)}>
            <SelectTrigger className="w-20 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">1h</SelectItem>
              <SelectItem value="4h">4h</SelectItem>
              <SelectItem value="12h">12h</SelectItem>
              <SelectItem value="24h">24h</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={fetchMetrics} disabled={loading} className="h-8 gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
        <Shield className="h-4 w-4 text-primary mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground">
          These are <strong>real measured values</strong> from your production system — not theoretical estimates.
          Use this alongside the Capacity Simulation to validate scaling assumptions with actual data.
        </p>
      </div>

      {/* Overall verdict */}
      <Card className={overallHealthy ? "border-emerald-500/50 bg-emerald-500/5" : "border-yellow-500/50 bg-yellow-500/5"}>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-3">
            {overallHealthy
              ? <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
              : <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0" />}
            <div>
              <h4 className="font-semibold text-sm">
                {overallHealthy
                  ? "✅ Production Health: All Systems Nominal"
                  : "⚠️ Production Health: Attention Needed"}
              </h4>
              <p className="text-xs text-muted-foreground mt-0.5">
                {metrics.enabledAssignments} active ASINs · {fmtNum(metrics.evalsInWindow)} evals in {hours}h ·
                {lastFetched ? ` Last checked ${lastFetched.toLocaleTimeString()}` : ""}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Metrics grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Measured Freshness */}
        <Card>
          <CardContent className="pt-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Clock className="h-4 w-4 text-primary" />
              Eval Freshness
              {hotP90Ok
                ? <Badge variant="secondary" className="text-emerald-600 bg-emerald-500/10 text-[10px]">OK</Badge>
                : <Badge variant="destructive" className="text-[10px]">SLOW</Badge>}
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-md bg-muted p-2">
                <div className="text-lg font-bold">{Math.round(metrics.p50EvalAgeMinutes)}m</div>
                <div className="text-[10px] text-muted-foreground">p50 freshness</div>
              </div>
              <div className={`rounded-md p-2 ${hotP90Ok ? "bg-emerald-500/10" : "bg-destructive/10"}`}>
                <div className="text-lg font-bold">{Math.round(metrics.p90EvalAgeMinutes)}m</div>
                <div className="text-[10px] text-muted-foreground">p90 freshness</div>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground text-center">
              {metrics.staleCount > 0 ? `${metrics.staleCount} stale (>60m)` : "No stale items"} · Avg {Math.round(metrics.avgEvalAgeMinutes)}m
            </div>
          </CardContent>
        </Card>

        {/* Measured Throughput */}
        <Card>
          <CardContent className="pt-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Activity className="h-4 w-4 text-primary" />
              Measured Throughput
            </div>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Evals/{hours}h</span>
                <span className="font-mono font-semibold">{fmtNum(metrics.evalsInWindow)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Evals/min</span>
                <span className="font-mono font-semibold">{evalsPerMin.toFixed(1)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Price changes</span>
                <span className="font-mono font-semibold">{metrics.priceChangesInWindow}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Feeds submitted</span>
                <span className="font-mono font-semibold">{metrics.feedsSubmittedInWindow}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* API Health */}
        <Card>
          <CardContent className="pt-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Zap className="h-4 w-4 text-orange-500" />
              API Health
              {apiHealthOk
                ? <Badge variant="secondary" className="text-emerald-600 bg-emerald-500/10 text-[10px]">HEALTHY</Badge>
                : <Badge variant="destructive" className="text-[10px]">ISSUES</Badge>}
            </div>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Throttled ASINs</span>
                <span className={`font-mono font-semibold ${metrics.throttleCount > 5 ? "text-destructive" : ""}`}>
                  {metrics.throttleCount}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Failed ASINs</span>
                <span className="font-mono font-semibold">{metrics.failureCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Max consecutive fails</span>
                <span className="font-mono font-semibold">{metrics.consecutiveFailureMax}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Feed success rate</span>
                <span className="font-mono font-semibold">{metrics.feedSuccessRate.toFixed(1)}%</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* System Pressure */}
        <Card>
          <CardContent className="pt-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Database className="h-4 w-4 text-violet-500" />
              System Pressure
              {dbPressureOk && !metrics.safeMode
                ? <Badge variant="secondary" className="text-emerald-600 bg-emerald-500/10 text-[10px]">NORMAL</Badge>
                : <Badge variant="destructive" className="text-[10px]">HIGH</Badge>}
            </div>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Writes this cycle</span>
                <span className="font-mono font-semibold">{metrics.writesThisCycle} / {metrics.writesCap}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">SP-API calls/window</span>
                <span className="font-mono font-semibold">{metrics.spApiCallsThisWindow}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Safe Mode</span>
                <span className={`font-mono font-semibold ${metrics.safeMode ? "text-destructive" : "text-emerald-600"}`}>
                  {metrics.safeMode ? "ACTIVE" : "OFF"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Queue</span>
                <span className={`font-mono font-semibold ${metrics.queuePaused ? "text-destructive" : "text-emerald-600"}`}>
                  {metrics.queuePaused ? "PAUSED" : "RUNNING"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tier distribution (measured) */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-3 text-sm font-medium">
            <TrendingUp className="h-4 w-4" />
            Measured Tier Distribution
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center text-sm">
            <div className="rounded-md bg-destructive/10 p-3">
              <div className="text-xs text-muted-foreground">🔴 HOT</div>
              <div className="text-lg font-bold text-destructive">{metrics.hotCount}</div>
            </div>
            <div className="rounded-md bg-orange-500/10 p-3">
              <div className="text-xs text-muted-foreground">🟠 WARM</div>
              <div className="text-lg font-bold text-orange-500">{metrics.warmCount}</div>
            </div>
            <div className="rounded-md bg-muted p-3">
              <div className="text-xs text-muted-foreground">⚪ COLD</div>
              <div className="text-lg font-bold">{metrics.coldCount}</div>
            </div>
            <div className="rounded-md bg-primary/10 p-3">
              <div className="text-xs text-muted-foreground">📊 Enabled</div>
              <div className="text-lg font-bold text-primary">{metrics.enabledAssignments}</div>
            </div>
            <div className="rounded-md bg-muted p-3">
              <div className="text-xs text-muted-foreground">📦 Total</div>
              <div className="text-lg font-bold">{metrics.totalAssignments}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Parallel Dispatcher Worker Health */}
      {metrics.workers.length > 0 && (
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-3 text-sm font-medium">
              <Zap className="h-4 w-4" />
              Parallel Dispatcher Workers
              <Badge variant="outline" className="text-[10px]">{metrics.workers.length} active</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {metrics.workers.map(w => (
                <div key={w.worker_id} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">Worker {w.worker_id}</span>
                    <div className="flex gap-1.5">
                      <Badge variant="outline" className="text-[10px]">{w.userCount} users</Badge>
                      <Badge variant="outline" className="text-[10px]">{w.activeAsins} ASINs</Badge>
                      <Badge variant="secondary" className="text-[10px]">{w.cycles} cycles</Badge>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div>
                      <div className="text-muted-foreground">Dispatched</div>
                      <div className="font-bold">{w.totalDispatched}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Evaluated</div>
                      <div className="font-bold">{w.totalEvaluated}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Applied</div>
                      <div className="font-bold">{w.totalApplied}</div>
                    </div>
                  </div>
                  <div className="text-[10px] text-muted-foreground text-center">
                    Avg cycle: {w.avgDispatchMs}ms
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-primary/20">
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-3 text-sm font-medium">
            <Shield className="h-4 w-4 text-primary" />
            Scale Readiness Assessment (based on measured data)
          </div>
          <div className="grid gap-2 sm:grid-cols-2 text-sm">
            {[
              {
                label: "Eval Freshness (p90 < 30m)",
                ok: hotP90Ok,
                detail: `Measured: ${Math.round(metrics.p90EvalAgeMinutes)}m`,
              },
              {
                label: "DB Write Headroom (< 80% cap)",
                ok: dbPressureOk,
                detail: `${metrics.writesThisCycle}/${metrics.writesCap} (${Math.round(metrics.writesThisCycle / metrics.writesCap * 100)}%)`,
              },
              {
                label: "API Stability (< 10 throttles)",
                ok: apiHealthOk,
                detail: `${metrics.throttleCount} throttles, max ${metrics.consecutiveFailureMax} consecutive fails`,
              },
              {
                label: "No Safe Mode / Queue Pause",
                ok: !metrics.safeMode && !metrics.queuePaused,
                detail: metrics.safeMode ? "Safe Mode active" : metrics.queuePaused ? "Queue paused" : "All clear",
              },
              {
                label: "Feed Delivery Rate (> 95%)",
                ok: metrics.feedSuccessRate >= 95,
                detail: `${metrics.feedSuccessRate.toFixed(1)}%`,
              },
              {
                label: "Stale Coverage (< 10% stale)",
                ok: metrics.enabledAssignments > 0 ? (metrics.staleCount / metrics.enabledAssignments) < 0.1 : true,
                detail: `${metrics.staleCount}/${metrics.enabledAssignments} stale`,
              },
            ].map((check) => (
              <div key={check.label} className="flex items-start gap-2 rounded-md border p-2.5">
                {check.ok
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                  : <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
                <div>
                  <div className="font-medium text-xs">{check.label}</div>
                  <div className="text-[10px] text-muted-foreground">{check.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-3">
            ✅ = production-verified · Scale claims should be backed by measured data at each ASIN tier (279 → 1K → 2K → 5K → 10K).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
