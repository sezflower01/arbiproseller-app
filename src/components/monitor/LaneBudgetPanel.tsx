import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { AlertTriangle, Gauge, Zap, Clock, RotateCcw, Star, Hand, CheckCircle, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

interface LaneUsage {
  cron_hot: number;
  cron_warm: number;
  cron_cold: number;
  sweep: number;
  manual: number;
  priority: number;
}

interface StalePromotionStats {
  total_promoted: number;
  evaluated_after: number;
  pending: number;
  effectiveness_pct: number;
}

const LANE_CONFIG = [
  { key: "cron_hot", label: "Cron HOT", icon: Zap, color: "text-red-500" },
  { key: "cron_warm", label: "Cron WARM", icon: Clock, color: "text-yellow-500" },
  { key: "cron_cold", label: "Cron COLD", icon: RotateCcw, color: "text-blue-400" },
  { key: "sweep", label: "Sweep", icon: RotateCcw, color: "text-purple-500" },
  { key: "priority", label: "Priority/Turbo", icon: Star, color: "text-orange-500" },
  { key: "manual", label: "Manual", icon: Hand, color: "text-muted-foreground" },
] as const;

export default function LaneBudgetPanel() {
  const { user } = useAuth();
  const [laneUsage, setLaneUsage] = useState<LaneUsage>({ cron_hot: 0, cron_warm: 0, cron_cold: 0, sweep: 0, manual: 0, priority: 0 });
  const [totalBudget, setTotalBudget] = useState(10);
  const [windowCalls, setWindowCalls] = useState(0);
  const [queuePaused, setQueuePaused] = useState(false);
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const [staleStats, setStaleStats] = useState<StalePromotionStats>({ total_promoted: 0, evaluated_after: 0, pending: 0, effectiveness_pct: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    fetchData();
    const __unsub = onMonitorRefresh(fetchData);
    return () => __unsub();
  }, [user]);

  async function fetchData() {
    if (!user) return;

    const [settingsRes, staleRes] = await Promise.all([
      supabase
        .from("repricer_settings")
        .select("sp_api_lane_usage, sp_api_lane_usage_date, sp_api_calls_per_minute_cap, sp_api_calls_this_window, queue_paused, queue_pause_reason")
        .eq("user_id", user.id)
        .maybeSingle(),
      // Stale promotion effectiveness — assignments promoted today
      supabase
        .from("repricer_assignments")
        .select("id, stale_promoted_at, stale_promoted_from, stale_promotion_evaluated")
        .eq("user_id", user.id)
        .not("stale_promoted_at", "is", null)
        .gte("stale_promoted_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
    ]);

    const settings = settingsRes.data as any;
    if (settings) {
      const todayStr = new Date().toISOString().split("T")[0];
      const usage = (settings.sp_api_lane_usage_date === todayStr && settings.sp_api_lane_usage)
        ? settings.sp_api_lane_usage as LaneUsage
        : { cron_hot: 0, cron_warm: 0, cron_cold: 0, sweep: 0, manual: 0, priority: 0 };
      setLaneUsage(usage);
      setTotalBudget(settings.sp_api_calls_per_minute_cap || 10);
      setWindowCalls(settings.sp_api_calls_this_window || 0);
      setQueuePaused(!!settings.queue_paused);
      setPauseReason(settings.queue_pause_reason || null);
    }

    const promoted = staleRes.data || [];
    const evaluatedAfter = promoted.filter((p: any) => p.stale_promotion_evaluated).length;
    const totalPromoted = promoted.length;
    setStaleStats({
      total_promoted: totalPromoted,
      evaluated_after: evaluatedAfter,
      pending: totalPromoted - evaluatedAfter,
      effectiveness_pct: totalPromoted > 0 ? Math.round((evaluatedAfter / totalPromoted) * 100) : 0,
    });

    setLoading(false);
  }

  const totalCalls = Object.values(laneUsage).reduce((s, v) => s + v, 0);
  const hotShare = totalCalls > 0 ? Math.round((laneUsage.cron_hot / totalCalls) * 100) : 0;
  const sweepShare = totalCalls > 0 ? Math.round((laneUsage.sweep / totalCalls) * 100) : 0;
  const priorityShare = totalCalls > 0 ? Math.round(((laneUsage.priority) / totalCalls) * 100) : 0;

  // Starvation detection
  const starvationWarnings: string[] = [];
  if (totalCalls > 50) {
    if (sweepShare < 5 && laneUsage.cron_hot > 100) {
      starvationWarnings.push("Sweep is being starved by HOT tier — broad catalog coverage may lag.");
    }
    if (hotShare > 85) {
      starvationWarnings.push("HOT tier consuming >85% of budget — WARM/COLD items may be delayed.");
    }
    if (priorityShare > 40) {
      starvationWarnings.push("Priority/Turbo consuming >40% of budget — consider reducing starred items.");
    }
  }

  const budgetPressure = totalBudget > 0 ? Math.round((windowCalls / totalBudget) * 100) : 0;
  const pressureColor = budgetPressure >= 90 ? "text-destructive" : budgetPressure >= 70 ? "text-yellow-600" : "text-green-600";

  // Recommended actions
  const recommendations: string[] = [];
  if (hotShare > 80 && totalCalls > 50) {
    recommendations.push("HOT lane dominating → reduce manual stars or check if urgency signals are too broad.");
  }
  if (sweepShare < 5 && totalCalls > 50 && laneUsage.sweep < 10) {
    recommendations.push("Sweep nearly idle → increase sweep batch size or reduce interval to improve broad coverage.");
  }
  if (priorityShare > 35 && totalCalls > 30) {
    recommendations.push("Too many starred ASINs consuming budget → review Priority/Turbo slots and remove low-value stars.");
  }
  if (queuePaused) {
    recommendations.push("Queue is paused → avoid manual runs until auto-resume. Repeated pauses suggest SP-API cap is too aggressive.");
  }
  if (budgetPressure >= 90 && !queuePaused) {
    recommendations.push("Budget pressure near max → consider increasing SP-API calls/min cap or reducing batch sizes.");
  }
  if (staleStats.effectiveness_pct < 50 && staleStats.total_promoted > 5) {
    recommendations.push("Stale promotions not being evaluated → system may be too overloaded to process promoted ASINs. Check HOT lane congestion.");
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Gauge className="h-5 w-5 text-primary" />
          Lane Budget & SP-API Usage
          <Badge variant="outline" className="ml-auto text-xs">Today</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Current budget pressure */}
        <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
          <div>
            <span className="text-sm font-medium">Current Window Pressure</span>
            <p className="text-xs text-muted-foreground">{windowCalls} / {totalBudget} calls/min</p>
          </div>
          <span className={`text-2xl font-bold ${pressureColor}`}>{budgetPressure}%</span>
        </div>

        {/* Queue status */}
        {queuePaused && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-destructive/50 bg-destructive/10">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="text-sm">
              <span className="font-medium text-destructive">Queue Paused</span>
              <p className="text-muted-foreground text-xs mt-0.5">{pauseReason || "Manual pause"}</p>
            </div>
          </div>
        )}

        {/* Per-lane breakdown */}
        <div className="space-y-2">
          <p className="text-sm font-medium">SP-API Calls by Lane (Today: {totalCalls} total)</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {LANE_CONFIG.map(({ key, label, icon: Icon, color }) => {
              const calls = laneUsage[key as keyof LaneUsage] || 0;
              const pct = totalCalls > 0 ? Math.round((calls / totalCalls) * 100) : 0;
              return (
                <div key={key} className="p-3 rounded-lg border bg-muted/30">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon className={`h-3.5 w-3.5 ${color}`} />
                    <span className="text-xs text-muted-foreground">{label}</span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-bold text-foreground">{calls}</span>
                    <span className="text-xs text-muted-foreground">({pct}%)</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Lane distribution bar */}
        {totalCalls > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Budget Distribution</p>
            <div className="flex h-3 rounded-full overflow-hidden border">
              {LANE_CONFIG.map(({ key }) => {
                const calls = laneUsage[key as keyof LaneUsage] || 0;
                const pct = (calls / totalCalls) * 100;
                const colors: Record<string, string> = {
                  cron_hot: "bg-red-500",
                  cron_warm: "bg-yellow-500",
                  cron_cold: "bg-blue-400",
                  sweep: "bg-purple-500",
                  priority: "bg-orange-500",
                  manual: "bg-muted-foreground",
                };
                if (pct < 1) return null;
                return <div key={key} className={`${colors[key]} transition-all`} style={{ width: `${pct}%` }} />;
              })}
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {LANE_CONFIG.map(({ key, label }) => {
                const calls = laneUsage[key as keyof LaneUsage] || 0;
                if (calls === 0) return null;
                const dotColors: Record<string, string> = {
                  cron_hot: "bg-red-500",
                  cron_warm: "bg-yellow-500",
                  cron_cold: "bg-blue-400",
                  sweep: "bg-purple-500",
                  priority: "bg-orange-500",
                  manual: "bg-muted-foreground",
                };
                return (
                  <span key={key} className="flex items-center gap-1">
                    <span className={`w-2 h-2 rounded-full ${dotColors[key]}`} />
                    {label}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Stale Promotion Effectiveness */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Stale Auto-Promotion Effectiveness (Today)</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded-lg border bg-muted/30 text-center">
              <span className="text-xl font-bold text-foreground">{staleStats.total_promoted}</span>
              <p className="text-xs text-muted-foreground">Promoted</p>
            </div>
            <div className="p-3 rounded-lg border bg-muted/30 text-center">
              <div className="flex items-center justify-center gap-1">
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                <span className="text-xl font-bold text-foreground">{staleStats.evaluated_after}</span>
              </div>
              <p className="text-xs text-muted-foreground">Evaluated</p>
            </div>
            <div className="p-3 rounded-lg border bg-muted/30 text-center">
              <span className={`text-xl font-bold ${staleStats.effectiveness_pct >= 80 ? "text-green-600" : staleStats.effectiveness_pct >= 50 ? "text-yellow-600" : "text-destructive"}`}>
                {staleStats.effectiveness_pct}%
              </span>
              <p className="text-xs text-muted-foreground">Success Rate</p>
            </div>
          </div>
          {staleStats.pending > 0 && (
            <p className="text-xs text-muted-foreground">
              {staleStats.pending} promoted ASINs still awaiting evaluation.
            </p>
          )}
        </div>

        {/* Starvation warnings */}
        {starvationWarnings.map((warning, i) => (
          <div key={i} className="flex items-start gap-2 p-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10">
            <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground">{warning}</p>
          </div>
        ))}

        {/* Recommended Actions */}
        {recommendations.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Recommended Actions</p>
            <div className="space-y-1.5">
              {recommendations.map((rec, i) => (
                <div key={i} className="flex items-start gap-2 p-2.5 rounded-lg border bg-muted/20">
                  <span className="text-xs mt-0.5">💡</span>
                  <p className="text-xs text-muted-foreground">{rec}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
