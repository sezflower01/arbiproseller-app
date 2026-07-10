import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, TrendingUp, Activity, Zap, Send, AlertTriangle, Clock, TrendingDown, Minus, ChevronDown, ChevronUp } from "lucide-react";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

type ErrorSeverity = "normal" | "warning" | "critical";
type ErrorTrend = "stable" | "rising" | "spiking";

interface RecentError {
  action_type: string;
  action_reason: string;
  created_at: string;
  category: string;
}

interface TrendData {
  writes15m: number;
  evals15m: number;
  feeds15m: number;
  errors15m: number;
  writes1h: number;
  evals1h: number;
  feeds1h: number;
  errors1h: number;
  breakerIncidents24h: number;
  safeModeMinutes24h: number;
  lastOutageStart: string | null;
  lastOutageEnd: string | null;
  outageActive: boolean;
  currentHealthScore: number;
  trailingHealthScore: number;
  scoreBreakdown15m: ScoreBreakdown;
  scoreBreakdown1h: ScoreBreakdown;
  errorSeverity: ErrorSeverity;
  errorTrend: ErrorTrend;
  recentErrors: RecentError[];
}

interface ScoreBreakdown {
  writesScore: number;
  evalsScore: number;
  errorsScore: number;
  schedulerScore: number;
}

function scoreHealthDetailed(writes: number, evals: number, errors: number): { score: number; breakdown: ScoreBreakdown } {
  // Writes: 0-35 points
  const writesScore = writes === 0 ? 0 : writes > 20 ? 35 : writes > 5 ? 25 : 15;
  // Evals: 0-35 points
  const evalsScore = evals === 0 ? 0 : evals > 10 ? 35 : evals > 3 ? 25 : 15;
  // Errors: 0-15 penalty
  const errorsScore = errors === 0 ? 15 : errors <= 3 ? 10 : errors <= 10 ? 5 : 0;
  // Scheduler health: 15 bonus if both writes and evals active
  const schedulerScore = (writes > 0 && evals > 0) ? 15 : (writes > 0 || evals > 0) ? 8 : 0;

  return {
    score: Math.min(100, writesScore + evalsScore + errorsScore + schedulerScore),
    breakdown: { writesScore, evalsScore, errorsScore, schedulerScore },
  };
}

function classifyErrorSeverity(errors15m: number, errors1h: number, writes15m: number, outageActive: boolean): ErrorSeverity {
  if (outageActive) return "critical";
  if (errors15m >= 10 && writes15m === 0) return "critical";
  if (errors15m >= 5 || (errors15m > errors1h * 0.6 && errors15m >= 3)) return "warning";
  return "normal";
}

function classifyErrorTrend(errors15m: number, errors1h: number): ErrorTrend {
  if (errors1h === 0) return errors15m > 0 ? "rising" : "stable";
  const rate15m = errors15m / 0.25; // per hour rate from 15m window
  const rate1h = errors1h;
  if (rate15m > rate1h * 2) return "spiking";
  if (rate15m > rate1h * 1.3) return "rising";
  return "stable";
}

function categorizeError(reason: string): string {
  const r = (reason || "").toLowerCase();
  if (r.includes("429") || r.includes("throttl") || r.includes("rate limit")) return "Throttling";
  if (r.includes("401") || r.includes("403") || r.includes("auth") || r.includes("token")) return "Auth";
  if (r.includes("502") || r.includes("503") || r.includes("504") || r.includes("gateway")) return "Gateway";
  if (r.includes("deploy") || r.includes("boot") || r.includes("function not found")) return "Deploy";
  if (r.includes("price_change_failed") || r.includes("feed")) return "Price Write";
  return "Eval Error";
}

export default function RecoveryTrendCards() {
  const { user } = useAuth();
  const [data, setData] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchTrends = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const now = Date.now();
      const fifteenMinAgo = new Date(now - 15 * 60 * 1000).toISOString();
      const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
      const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

      const [actions15Res, actions1hRes, settingsLogRes, feedsRes, recentErrorsRes] = await Promise.all([
        // Last 15 min actions
        supabase
          .from("repricer_price_actions")
          .select("action_type, success")
          .eq("user_id", user.id)
          .gte("created_at", fifteenMinAgo),
        // Last 1h actions
        supabase
          .from("repricer_price_actions")
          .select("action_type, success")
          .eq("user_id", user.id)
          .gte("created_at", oneHourAgo),
        // Settings for safe mode history
        (supabase as any)
          .from("repricer_settings")
          .select("safe_mode_active, safe_mode_activated_at, safe_mode_auto_resume_at, circuit_breaker_last_trigger")
          .eq("user_id", user.id)
          .maybeSingle(),
        // Feeds in last hour
        supabase
          .from("repricer_feed_submissions")
          .select("id, submitted_at")
          .eq("user_id", user.id)
          .gte("submitted_at", oneHourAgo),
        // Recent errors with reasons
        supabase
          .from("repricer_price_actions")
          .select("action_type, action_reason, created_at")
          .eq("user_id", user.id)
          .in("action_type", ["eval_error", "price_change_failed", "safe_mode_activated"])
          .gte("created_at", oneHourAgo)
          .order("created_at", { ascending: false })
          .limit(5),
      ]);

      const a15 = actions15Res.data || [];
      const a1h = actions1hRes.data || [];
      const feeds = feedsRes.data || [];
      const settings = settingsLogRes.data;

      // Use REAL action_type values from the database
      const WRITE_TYPES = ["price_change", "price_changed", "price_and_minmax_change", "minmax_change"];
      const EVAL_TYPES = ["priority_eval", "anomaly_eval_only", "no_change", "blocked_by_profit_guard"];
      const ERROR_TYPES = ["eval_error", "price_change_failed", "safe_mode_activated"];

      const countWrites = (arr: any[]) => arr.filter(a => WRITE_TYPES.includes(a.action_type)).length;
      const countEvals = (arr: any[]) => arr.filter(a => EVAL_TYPES.includes(a.action_type)).length;
      const countErrors = (arr: any[]) => arr.filter(a => ERROR_TYPES.includes(a.action_type)).length;

      const writes15m = countWrites(a15);
      const evals15m = countEvals(a15);
      const errors15m = countErrors(a15);
      const feeds15m = feeds.filter(f => new Date(f.submitted_at).getTime() > now - 15 * 60 * 1000).length;

      const writes1h = countWrites(a1h);
      const evals1h = countEvals(a1h);
      const errors1h = countErrors(a1h);
      const feeds1h = feeds.length;

      // Safe mode outage tracking
      const outageActive = settings?.safe_mode_active || false;
      const lastOutageStart = settings?.safe_mode_activated_at || null;
      let safeModeMinutes24h = 0;
      if (lastOutageStart) {
        const startTime = new Date(lastOutageStart).getTime();
        if (startTime > now - 24 * 60 * 60 * 1000) {
          const endTime = outageActive ? now : (settings?.safe_mode_auto_resume_at ? new Date(settings.safe_mode_auto_resume_at).getTime() : now);
          safeModeMinutes24h = Math.round((endTime - startTime) / 60000);
        }
      }

      const breakerIncidents24h = settings?.circuit_breaker_last_trigger ? 1 : 0;

      const current = scoreHealthDetailed(writes15m, evals15m, errors15m);
      const trailing = scoreHealthDetailed(writes1h, evals1h, errors1h);

      const errorSeverity = classifyErrorSeverity(errors15m, errors1h, writes15m, outageActive);
      const errorTrend = classifyErrorTrend(errors15m, errors1h);

      const recentErrors: RecentError[] = (recentErrorsRes.data || []).slice(0, 3).map((e: any) => ({
        action_type: e.action_type,
        action_reason: e.action_reason || "Unknown",
        created_at: e.created_at,
        category: categorizeError(e.action_reason || e.action_type),
      }));

      setData({
        writes15m, evals15m, feeds15m, errors15m,
        writes1h, evals1h, feeds1h, errors1h,
        breakerIncidents24h,
        safeModeMinutes24h,
        lastOutageStart,
        lastOutageEnd: outageActive ? null : settings?.safe_mode_auto_resume_at || null,
        outageActive,
        currentHealthScore: current.score,
        trailingHealthScore: trailing.score,
        scoreBreakdown15m: current.breakdown,
        scoreBreakdown1h: trailing.breakdown,
        errorSeverity,
        errorTrend,
        recentErrors,
      });
    } catch (e) {
      console.error("Recovery trends error:", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchTrends();
    const __unsub = onMonitorRefresh(fetchTrends);
    return () => __unsub();
  }, [fetchTrends]);

  if (loading && !data) return null;
  if (!data) return null;

  const currentColor = data.currentHealthScore >= 80 ? "text-green-500" : data.currentHealthScore >= 50 ? "text-yellow-500" : "text-destructive";
  const trailingColor = data.trailingHealthScore >= 80 ? "text-green-500" : data.trailingHealthScore >= 50 ? "text-yellow-500" : "text-destructive";

  const severityLabel = data.errorSeverity === "critical" ? "Critical" : data.errorSeverity === "warning" ? "Warning" : "Normal Noise";
  const severityColor = data.errorSeverity === "critical" ? "destructive" : data.errorSeverity === "warning" ? "outline" : "secondary";
  const trendIcon = data.errorTrend === "spiking" ? <TrendingUp className="h-3 w-3 text-destructive" /> : data.errorTrend === "rising" ? <TrendingUp className="h-3 w-3 text-yellow-500" /> : <Minus className="h-3 w-3 text-muted-foreground" />;
  const trendLabel = data.errorTrend === "spiking" ? "Spiking" : data.errorTrend === "rising" ? "Rising" : "Stable";

  const renderBreakdown = (bd: ScoreBreakdown) => (
    <div className="grid grid-cols-4 gap-1 text-[9px] text-muted-foreground mt-1.5 bg-muted/30 rounded px-1 py-1">
      <div className="text-center">
        <span className="font-semibold text-foreground">{bd.writesScore}</span> writes
      </div>
      <div className="text-center">
        <span className="font-semibold text-foreground">{bd.evalsScore}</span> evals
      </div>
      <div className="text-center">
        <span className="font-semibold text-foreground">{bd.errorsScore}</span> errors
      </div>
      <div className="text-center">
        <span className="font-semibold text-foreground">{bd.schedulerScore}</span> sched
      </div>
    </div>
  );

  const hasErrors = data.errors15m > 0 || data.errors1h > 0;

  return (
    <div className="space-y-3">
      {/* Outage Banner */}
      {(data.outageActive || data.safeModeMinutes24h > 0) && (
        <Card className={data.outageActive ? "border-destructive bg-destructive/5" : "border-yellow-500/30 bg-yellow-500/5"}>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle className={`h-4 w-4 ${data.outageActive ? "text-destructive" : "text-yellow-500"}`} />
              {data.outageActive ? (
                <span className="font-medium text-destructive">
                  System paused by Safe Mode since {data.lastOutageStart ? new Date(data.lastOutageStart).toLocaleTimeString() : "unknown"}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  System was paused by Safe Mode for {data.safeModeMinutes24h}m
                  {data.lastOutageStart && (
                    <span> (from {new Date(data.lastOutageStart).toLocaleTimeString()}
                    {data.lastOutageEnd && ` to ${new Date(data.lastOutageEnd).toLocaleTimeString()}`})</span>
                  )}
                  . Metrics may be temporarily degraded due to recovery window.
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Health Scores */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Current Health (15m)</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className={`text-3xl font-bold ${currentColor}`}>{data.currentHealthScore}</span>
              <span className="text-xs text-muted-foreground">/ 100</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-2 text-[10px] text-muted-foreground">
              <div className="text-center">
                <div className="font-bold text-foreground text-xs">{data.writes15m}</div>
                writes
              </div>
              <div className="text-center">
                <div className="font-bold text-foreground text-xs">{data.evals15m}</div>
                evals
              </div>
              <div className="text-center">
                <div className="font-bold text-foreground text-xs">{data.feeds15m}</div>
                feeds
              </div>
              <div className="text-center">
                <div className={`font-bold text-xs ${data.errors15m > 0 ? "text-destructive" : "text-foreground"}`}>{data.errors15m}</div>
                errors
              </div>
            </div>
            {renderBreakdown(data.scoreBreakdown15m)}
             {data.writes15m > 0 && data.feeds15m === 0 && (
              <div className="text-[10px] text-muted-foreground mt-1.5 bg-muted/50 rounded px-1.5 py-0.5">
                Writes via direct PATCH (Listings API) — no feed submission needed
              </div>
            )}
            <div className="text-[9px] text-muted-foreground/70 mt-1.5 italic">
              Rolling 15-min window — error counts drop automatically as events age out.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Trailing Health (1h)</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className={`text-3xl font-bold ${trailingColor}`}>{data.trailingHealthScore}</span>
              <span className="text-xs text-muted-foreground">/ 100</span>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-2 text-[10px] text-muted-foreground">
              <div className="text-center">
                <div className="font-bold text-foreground text-xs">{data.writes1h}</div>
                writes
              </div>
              <div className="text-center">
                <div className="font-bold text-foreground text-xs">{data.evals1h}</div>
                evals
              </div>
              <div className="text-center">
                <div className="font-bold text-foreground text-xs">{data.feeds1h}</div>
                feeds
              </div>
              <div className="text-center">
                <div className={`font-bold text-xs ${data.errors1h > 0 ? "text-destructive" : "text-foreground"}`}>{data.errors1h}</div>
                errors
              </div>
            </div>
            {renderBreakdown(data.scoreBreakdown1h)}
             {data.writes1h > 0 && data.feeds1h === 0 && (
              <div className="text-[10px] text-muted-foreground mt-1.5 bg-muted/50 rounded px-1.5 py-0.5">
                Writes via direct PATCH — no feed submission needed
              </div>
            )}
            <div className="text-[9px] text-muted-foreground/70 mt-1.5 italic">
              Rolling 1-hour window — error counts drop automatically as events age out.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Error Classification */}
      {hasErrors && (
        <Card className={data.errorSeverity === "critical" ? "border-destructive bg-destructive/5" : data.errorSeverity === "warning" ? "border-yellow-500/30 bg-yellow-500/5" : ""}>
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className={`h-4 w-4 ${data.errorSeverity === "critical" ? "text-destructive" : data.errorSeverity === "warning" ? "text-yellow-500" : "text-muted-foreground"}`} />
              <span className="text-sm font-medium">Error Status</span>
              <Badge variant={severityColor as any} className="text-xs">{severityLabel}</Badge>
              <div className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
                {trendIcon}
                <span>{trendLabel}</span>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {data.errorSeverity === "normal"
                ? `${data.errors15m} error(s) in 15m with ${data.writes15m} active writes — normal operational noise.`
                : data.errorSeverity === "warning"
                ? `${data.errors15m} error(s) in 15m — elevated but writes still active. Monitor closely.`
                : `${data.errors15m} error(s) in 15m — system may be degraded. Check root cause below.`
              }
            </div>
            {data.recentErrors.length > 0 && (
              <div className="space-y-1 mt-1">
                <div className="text-[10px] font-medium text-muted-foreground">Latest errors:</div>
                {data.recentErrors.map((err, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs bg-muted/30 rounded px-2 py-1">
                    <Badge variant="outline" className="text-[10px] shrink-0">{err.category}</Badge>
                    <span className="truncate text-muted-foreground">{err.action_reason.slice(0, 120)}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0 ml-auto">
                      {new Date(err.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Recovery summary */}
      {data.safeModeMinutes24h > 0 && (
        <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2">
          <span className="font-medium">24h Summary:</span>{" "}
          {data.breakerIncidents24h} breaker incident(s), {data.safeModeMinutes24h}m total downtime.
          {data.safeModeMinutes24h > 30 && " Freshness, coverage, and rotation metrics may be artificially degraded."}
        </div>
      )}
    </div>
  );
}
