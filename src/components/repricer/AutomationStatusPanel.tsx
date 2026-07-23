import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Clock, Play, RefreshCw, CheckCircle, XCircle, AlertTriangle, Info, Zap } from "lucide-react";

interface RunResult {
  status: 'success' | 'failed' | 'warning';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: {
    evaluated: number;
    applied: number;
    skipped: number;
    errors: number;
    rainforestCreditsUsed: number;
  };
  exitReason?: string;
  details?: Array<{
    asin: string;
    sku?: string;
    action: string;
    reason: string;
  }>;
}

interface AutomationStatusPanelProps {
  isAdmin?: boolean;
}

export default function AutomationStatusPanel({ isAdmin = false }: AutomationStatusPanelProps) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<{
    scheduler_enabled: boolean;
    scheduler_status: string | null;
    last_scheduler_run_at: string | null;
    queue_paused: boolean;
  } | null>(null);
  const [runningScheduler, setRunningScheduler] = useState(false);
  const [lastRunResult, setLastRunResult] = useState<RunResult | null>(null);
  const [liveActivity, setLiveActivity] = useState<{
    lastEvalAt: string | null;
    writes24h: number;
    evals24h: number;
    bySource: Record<string, { writes: number; evals: number; lastAt: string | null }>;
  } | null>(null);

  const fetchSettings = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("repricer_settings")
      .select("scheduler_enabled, scheduler_status, last_scheduler_run_at, queue_paused")
      .eq("user_id", user.id)
      .maybeSingle();
    if (data) setSettings(data as any);
  }, [user]);

  const fetchLiveActivity = useCallback(async () => {
    if (!user) return;
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: acks } = await supabase
        .from("repricer_eval_acks")
        .select("result, trigger_source, acked_at")
        .eq("user_id", user.id)
        .gte("acked_at", twentyFourHoursAgo)
        .order("acked_at", { ascending: false })
        .limit(3000);

      if (!acks) return;

      const bySource: Record<string, { writes: number; evals: number; lastAt: string | null }> = {};
      let writes24h = 0;
      const lastEvalAt: string | null = acks.length > 0 ? acks[0].acked_at : null;

      for (const ack of acks) {
        const source = ack.trigger_source || "unknown";
        if (!bySource[source]) bySource[source] = { writes: 0, evals: 0, lastAt: null };
        bySource[source].evals++;
        if (!bySource[source].lastAt) bySource[source].lastAt = ack.acked_at;
        if (ack.result === "changed") {
          bySource[source].writes++;
          writes24h++;
        }
      }

      setLiveActivity({ lastEvalAt, writes24h, evals24h: acks.length, bySource });
    } catch (err) {
      console.error("Live activity fetch error:", err);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      fetchSettings();
      fetchLiveActivity();
      const refreshInterval = setInterval(() => { fetchSettings(); fetchLiveActivity(); }, 30_000);
      return () => clearInterval(refreshInterval);
    }
  }, [user, fetchSettings, fetchLiveActivity]);

  const runSchedulerManually = async () => {
    const startTime = Date.now();
    const startedAt = new Date().toISOString();

    try {
      setRunningScheduler(true);
      setLastRunResult(null);
      toast.info("Running scheduler...");

      const result = await (await import("@/lib/edgeFunctionClient")).invokeEdgeFunction({
        functionName: "repricer-scheduler",
        body: { dry_run: false },
        maxRetries: 1,
        context: { source: "settings_run" },
      });

      const data = result.data;
      const error = result.ok ? null : { message: `${result.errorCategory}: ${result.errorMessage}` };

      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;

      if (error) {
        setLastRunResult({
          status: 'failed',
          startedAt,
          finishedAt,
          durationMs,
          summary: { evaluated: 0, applied: 0, skipped: 0, errors: 1, rainforestCreditsUsed: 0 },
          exitReason: error.message || 'Unknown error'
        });
        throw error;
      }

      const summary = data.summary || { evaluated: 0, applied: 0, skipped: 0, errors: 0, rainforestCreditsUsed: 0 };
      const results = data.results || [];

      let exitReason = 'SUCCESS';
      if (summary.evaluated === 0 && summary.applied === 0) {
        if (data.message === 'Scheduler disabled') {
          exitReason = 'SCHEDULER_DISABLED';
        } else if (results.length === 0) {
          exitReason = 'NO_ASSIGNMENTS';
        } else {
          exitReason = 'NO_ITEMS_MATCHED';
        }
      } else if (summary.errors > 0) {
        exitReason = 'PARTIAL_SUCCESS';
      }

      const runResult: RunResult = {
        status: summary.errors > 0 ? 'warning' : (summary.evaluated === 0 ? 'warning' : 'success'),
        startedAt,
        finishedAt,
        durationMs,
        summary: {
          evaluated: summary.evaluated || 0,
          applied: summary.applied || 0,
          skipped: summary.skipped || results.filter((r: any) => r.action === 'skipped').length || 0,
          errors: summary.errors || results.filter((r: any) => r.action === 'error').length || 0,
          rainforestCreditsUsed: summary.rainforestCreditsUsed || 0
        },
        exitReason,
        details: results.slice(0, 10)
      };

      setLastRunResult(runResult);

      if (exitReason === 'NO_ASSIGNMENTS') {
        toast.warning("No enabled assignments found. Enable repricing on items in the Assignments tab.", { duration: 6000 });
      } else if (exitReason === 'SCHEDULER_DISABLED') {
        toast.warning("Scheduler is disabled. Enable it in Settings to run.", { duration: 6000 });
      } else {
        toast.success(
          `Complete: ${summary.evaluated} evaluated, ${summary.applied} applied, ${summary.rainforestCreditsUsed} credits used`,
          { duration: 6000 }
        );
      }

      fetchSettings();
    } catch (error: any) {
      toast.error("Scheduler failed: " + error.message);
    } finally {
      setRunningScheduler(false);
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const rawSchedulerStatus = settings?.scheduler_status || 'idle';
  const lastRunDate = settings?.last_scheduler_run_at ? new Date(settings.last_scheduler_run_at) : null;
  const lastEvalDate = liveActivity?.lastEvalAt ? new Date(liveActivity.lastEvalAt) : null;
  const trueLastActivity = lastEvalDate && lastRunDate
    ? (lastEvalDate > lastRunDate ? lastEvalDate : lastRunDate)
    : lastEvalDate || lastRunDate;
  const isRecentlyActive = trueLastActivity && (Date.now() - trueLastActivity.getTime()) < 20 * 60 * 1000;
  const lastRun = trueLastActivity ? trueLastActivity.toLocaleString() : 'Never';

  const effectiveStatus = rawSchedulerStatus === 'running'
    ? 'running'
    : settings?.queue_paused
      ? 'paused'
      : settings?.scheduler_enabled && isRecentlyActive
        ? 'active'
        : settings?.scheduler_enabled
          ? 'scheduled'
          : 'idle';

  const statusLabel: Record<string, string> = {
    running: '⚡ Running Now',
    active: '✅ Active',
    scheduled: '⏳ Scheduled (Waiting)',
    paused: '⏸ Paused',
    idle: 'Idle',
  };
  const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    running: 'default',
    active: 'default',
    scheduled: 'secondary',
    paused: 'destructive',
    idle: 'secondary',
  };

  return (
    <div className="space-y-4">
      <div className="p-4 border rounded-lg bg-muted/30">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-500" />
            <span className="font-medium">Automation Status</span>
          </div>
          <Badge variant={statusVariant[effectiveStatus] || 'secondary'}>
            {statusLabel[effectiveStatus] || 'Idle'}
          </Badge>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <div>
              {lastEvalDate && (
                <div className="flex items-center gap-1">
                  <CheckCircle className="h-3 w-3 text-green-500" />
                  <span className="text-xs text-foreground font-medium">
                    Last activity: {lastEvalDate.toLocaleString()}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ({Math.round((Date.now() - lastEvalDate.getTime()) / 60000)} min ago)
                  </span>
                </div>
              )}
              {isAdmin && lastRunDate && lastEvalDate && lastRunDate < lastEvalDate && (
                <div className="flex items-center gap-1 mt-0.5">
                  <AlertTriangle className="h-3 w-3 text-amber-500" />
                  <span className="text-[10px] text-muted-foreground">
                     Legacy scheduler idle. Unified dispatch is currently driving repricer activity.
                   </span>
                </div>
              )}
              {!lastEvalDate && (
                <div>
                  <span className="text-xs text-muted-foreground">Last scheduler run: {lastRun}</span>
                  {lastRunDate && (
                    <span className="text-xs text-muted-foreground ml-2">
                      ({Math.round((Date.now() - lastRunDate.getTime()) / 60000)} min ago)
                    </span>
                  )}
                </div>
              )}
            </div>
            {isAdmin && (
            <Button
              size="sm"
              variant="outline"
              onClick={runSchedulerManually}
              disabled={runningScheduler || settings?.queue_paused}
            >
              {runningScheduler ? (
                <RefreshCw className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Play className="h-3 w-3 mr-1" />
              )}
              Run Now
            </Button>
            )}
          </div>

          {isAdmin && liveActivity && (
            <div className="mt-2 pt-2 border-t text-xs">
              <div className="flex gap-4 text-muted-foreground">
                <span><strong className="text-foreground">{liveActivity.writes24h}</strong> writes (24h)</span>
                <span><strong className="text-foreground">{liveActivity.evals24h}</strong> evals (24h)</span>
              </div>
            </div>
          )}
        </div>

        {isAdmin && lastRunResult && (
          <div className="mt-3 p-3 border rounded-lg bg-background/50 text-xs space-y-2">
            <div className="flex items-center gap-2 font-medium">
              {lastRunResult.status === 'success' && <CheckCircle className="h-4 w-4 text-green-500" />}
              {lastRunResult.status === 'failed' && <XCircle className="h-4 w-4 text-destructive" />}
              {lastRunResult.status === 'warning' && <AlertTriangle className="h-4 w-4 text-amber-500" />}
              <span>
                {lastRunResult.exitReason === 'SUCCESS' && 'Run completed successfully'}
                {lastRunResult.exitReason === 'NO_ASSIGNMENTS' && 'No enabled assignments found'}
                {lastRunResult.exitReason === 'NO_ITEMS_MATCHED' && 'No items matched criteria'}
                {lastRunResult.exitReason === 'SCHEDULER_DISABLED' && 'Scheduler is disabled'}
                {lastRunResult.exitReason === 'PARTIAL_SUCCESS' && 'Completed with some errors'}
                {lastRunResult.exitReason === 'QUEUE_PAUSED' && 'Queue is paused'}
                {!['SUCCESS', 'NO_ASSIGNMENTS', 'NO_ITEMS_MATCHED', 'SCHEDULER_DISABLED', 'PARTIAL_SUCCESS', 'QUEUE_PAUSED'].includes(lastRunResult.exitReason || '') && lastRunResult.exitReason}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-muted-foreground">
              <div>Started: {new Date(lastRunResult.startedAt).toLocaleTimeString()}</div>
              <div>Duration: {formatDuration(lastRunResult.durationMs)}</div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="text-xs">
                <Info className="h-3 w-3 mr-1" />
                {lastRunResult.summary.evaluated} evaluated
              </Badge>
              <Badge variant={lastRunResult.summary.applied > 0 ? "default" : "secondary"} className="text-xs">
                {lastRunResult.summary.applied} applied
              </Badge>
              <Badge variant="secondary" className="text-xs">
                {lastRunResult.summary.skipped} skipped
              </Badge>
              {lastRunResult.summary.errors > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {lastRunResult.summary.errors} errors
                </Badge>
              )}
              <Badge variant="outline" className="text-xs">
                <Zap className="h-3 w-3 mr-1" />
                {lastRunResult.summary.rainforestCreditsUsed} credits
              </Badge>
            </div>

            {lastRunResult.details && lastRunResult.details.length > 0 && (
              <div className="mt-2 pt-2 border-t">
                <div className="font-medium mb-1">Details (first {lastRunResult.details.length}):</div>
                <div className="max-h-24 overflow-y-auto space-y-1">
                  {lastRunResult.details.map((d, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <span className="font-mono text-[10px] bg-muted px-1 rounded">{d.asin}</span>
                      <Badge variant={
                        d.action === 'applied' ? 'default' :
                        d.action === 'error' ? 'destructive' :
                        d.action === 'skipped' ? 'secondary' : 'outline'
                      } className="text-[10px] h-4">
                        {d.action}
                      </Badge>
                      <span className="text-muted-foreground truncate flex-1">{d.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {isAdmin && liveActivity && Object.keys(liveActivity.bySource).length > 0 && (
        <div className="p-4 border rounded-lg bg-muted/30">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="h-4 w-4 text-primary" />
            <span className="font-medium text-sm">Live Activity Source (24h)</span>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Shows which subsystem is actually generating evaluations and writes right now.
          </p>
          <div className="space-y-1.5">
            {Object.entries(liveActivity.bySource)
              .sort(([, a], [, b]) => b.evals - a.evals)
              .map(([source, stats]) => {
                const sourceLabels: Record<string, string> = {
                  cron: "⏰ Cron Scheduler",
                  sweep: "🔄 Sequential Sweep",
                  turbo: "⚡ Turbo / Priority",
                  manual: "👤 Manual Run",
                  bb_alert: "🔔 Buy Box Alert",
                  dispatch: "📡 Unified Dispatch",
                  unknown: "❓ Unknown",
                };
                const label = sourceLabels[source] || `📡 ${source}`;
                const lastAt = stats.lastAt ? new Date(stats.lastAt) : null;
                const minutesAgo = lastAt ? Math.round((Date.now() - lastAt.getTime()) / 60000) : null;

                return (
                  <div key={source} className="flex items-center justify-between p-2 rounded border bg-background text-xs">
                    <span className="font-medium">{label}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground">
                        <strong className="text-foreground">{stats.writes}</strong> writes
                      </span>
                      <span className="text-muted-foreground">
                        <strong className="text-foreground">{stats.evals}</strong> evals
                      </span>
                      {minutesAgo !== null && (
                        <span className={`text-[10px] ${minutesAgo < 20 ? "text-green-600" : minutesAgo < 60 ? "text-amber-600" : "text-muted-foreground"}`}>
                          {minutesAgo}m ago
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
