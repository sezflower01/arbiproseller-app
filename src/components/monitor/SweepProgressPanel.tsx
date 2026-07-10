import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { RefreshCw, RotateCcw, Clock, AlertTriangle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

interface SweepState {
  enabled: boolean;
  batchSize: number;
  intervalMinutes: number;
  lastRunAt: string | null;
  checkedThisPass: number;
  totalEligible: number;
  passStartedAt: string | null;
  passesCompleted: number;
}

// Default full-pass target: 60 minutes
const DEFAULT_PASS_TARGET_MINUTES = 60;

export default function SweepProgressPanel() {
  const { user } = useAuth();
  const [sweep, setSweep] = useState<SweepState | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchState = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from("repricer_settings")
        .select("sequential_sweep_enabled, sequential_sweep_batch_size, sequential_sweep_interval_minutes, sequential_sweep_last_run_at, sequential_sweep_checked_this_pass, sequential_sweep_total_eligible, sequential_sweep_pass_started_at, sequential_sweep_passes_completed")
        .eq("user_id", user.id)
        .maybeSingle();

      if (data) {
        setSweep({
          enabled: data.sequential_sweep_enabled ?? false,
          batchSize: data.sequential_sweep_batch_size ?? 10,
          intervalMinutes: data.sequential_sweep_interval_minutes ?? 3,
          lastRunAt: data.sequential_sweep_last_run_at,
          checkedThisPass: data.sequential_sweep_checked_this_pass ?? 0,
          totalEligible: data.sequential_sweep_total_eligible ?? 0,
          passStartedAt: data.sequential_sweep_pass_started_at,
          passesCompleted: data.sequential_sweep_passes_completed ?? 0,
        });
      }
    } catch (err) {
      console.error("Sweep state fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchState();
    const __unsub = onMonitorRefresh(fetchState);
    return () => __unsub();
  }, [fetchState]);

  if (loading || !sweep) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-muted-foreground text-sm">
          Loading sweep progress...
        </CardContent>
      </Card>
    );
  }

  if (!sweep.enabled) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-muted-foreground text-sm">
          Sequential Sweep is disabled
        </CardContent>
      </Card>
    );
  }

  const progressPercent = sweep.totalEligible > 0
    ? Math.round((sweep.checkedThisPass / sweep.totalEligible) * 100)
    : 0;

  // Calculate projected full-pass time
  let projectedMinutes: number | null = null;
  let passElapsedMinutes: number | null = null;
  if (sweep.passStartedAt && sweep.checkedThisPass > 0) {
    passElapsedMinutes = (Date.now() - new Date(sweep.passStartedAt).getTime()) / 60000;
    const ratePerMinute = sweep.checkedThisPass / passElapsedMinutes;
    if (ratePerMinute > 0) {
      projectedMinutes = Math.round(sweep.totalEligible / ratePerMinute);
    }
  }

  const exceedsTarget = projectedMinutes !== null && projectedMinutes > DEFAULT_PASS_TARGET_MINUTES;
  const etaMinutes = projectedMinutes !== null && passElapsedMinutes !== null
    ? Math.max(0, Math.round(projectedMinutes - passElapsedMinutes))
    : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <RotateCcw className="h-5 w-5 text-primary" />
          Sequential Sweep Progress
          {sweep.passesCompleted > 0 && (
            <Badge variant="outline" className="text-xs ml-1">
              Pass #{sweep.passesCompleted + 1}
            </Badge>
          )}
        </CardTitle>
        <Button variant="outline" size="sm" onClick={fetchState} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {sweep.checkedThisPass} / {sweep.totalEligible} checked
            </span>
            <span className="font-bold">{progressPercent}%</span>
          </div>
          <Progress
            value={progressPercent}
            className={`h-3 ${exceedsTarget ? "[&>div]:bg-yellow-500" : "[&>div]:bg-primary"}`}
          />
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
          <div className="rounded-lg border p-2">
            <div className="text-xs text-muted-foreground">Batch Size</div>
            <div className="text-lg font-bold">{sweep.batchSize}</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-xs text-muted-foreground">Interval</div>
            <div className="text-lg font-bold">{sweep.intervalMinutes}m</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-xs text-muted-foreground">Passes Done</div>
            <div className="text-lg font-bold">{sweep.passesCompleted}</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-xs text-muted-foreground">Last Run</div>
            <div className="text-sm font-medium">
              {sweep.lastRunAt
                ? formatDistanceToNow(new Date(sweep.lastRunAt), { addSuffix: true })
                : "Never"}
            </div>
          </div>
        </div>

        {/* ETA and projected time */}
        <div className="flex items-center gap-4 text-sm">
          {projectedMinutes !== null && (
            <div className="flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span>Projected full pass: <strong>{projectedMinutes}m</strong></span>
              {exceedsTarget && (
                <Badge variant="destructive" className="text-[10px] ml-1">
                  <AlertTriangle className="h-3 w-3 mr-0.5" />
                  Exceeds {DEFAULT_PASS_TARGET_MINUTES}m target
                </Badge>
              )}
            </div>
          )}
          {etaMinutes !== null && etaMinutes > 0 && (
            <span className="text-muted-foreground">
              ETA: ~{etaMinutes}m remaining
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
