import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ShieldAlert, ShieldCheck, Zap, RefreshCw, AlertTriangle, Ban,
  CheckCircle, Clock, Wrench, ChevronDown, ChevronUp,
} from "lucide-react";
import { toast } from "sonner";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

interface ErrorCategory {
  label: string;
  count: number;
  severity: "fatal" | "warning" | "benign";
  icon: React.ReactNode;
  samples: string[];
}

interface DiagnosisResult {
  safeModeActive: boolean;
  safeModeReason: string | null;
  safeModeActivatedAt: string | null;
  autoResumeAt: string | null;
  errorCount: number;
  writesThisCycle: number;
  categories: ErrorCategory[];
  totalErrors: number;
  rootCause: string;
  recommendedAction: string;
  canAutoRecover: boolean;
  lastHealthyWrite: string | null;
  lastSuccessfulEval: string | null;
  lastSchedulerRun: string | null;
  writeBlockReasons: string[];
}

function categorizeErrors(actions: any[]): ErrorCategory[] {
  const cats: Record<string, { count: number; severity: "fatal" | "warning" | "benign"; samples: string[] }> = {
    throttling: { count: 0, severity: "benign", samples: [] },
    auth: { count: 0, severity: "fatal", samples: [] },
    gateway: { count: 0, severity: "warning", samples: [] },
    deployment: { count: 0, severity: "warning", samples: [] },
    fatal_code: { count: 0, severity: "fatal", samples: [] },
    benign: { count: 0, severity: "benign", samples: [] },
  };

  for (const a of actions) {
    const reason = (a.action_reason || a.reason || "").toLowerCase();
    const actionType = (a.action_type || "").toLowerCase();

    if (reason.includes("rate limit") || reason.includes("429") || reason.includes("throttl") || reason.includes("ratelimit") || reason.includes("quota")) {
      cats.throttling.count++;
      if (cats.throttling.samples.length < 3) cats.throttling.samples.push(a.action_reason || a.reason || "Rate limited");
    } else if (reason.includes("401") || reason.includes("403") || reason.includes("unauthorized") || reason.includes("auth") || reason.includes("token expired") || reason.includes("invalid_grant")) {
      cats.auth.count++;
      if (cats.auth.samples.length < 3) cats.auth.samples.push(a.action_reason || a.reason || "Auth error");
    } else if (reason.includes("502") || reason.includes("503") || reason.includes("504") || reason.includes("gateway") || reason.includes("empty invocation") || reason.includes("boot")) {
      cats.gateway.count++;
      if (cats.gateway.samples.length < 3) cats.gateway.samples.push(a.action_reason || a.reason || "Gateway error");
    } else if (reason.includes("deploy") || reason.includes("function not found") || reason.includes("compile")) {
      cats.deployment.count++;
      if (cats.deployment.samples.length < 3) cats.deployment.samples.push(a.action_reason || a.reason || "Deployment error");
    } else if (actionType === "eval_error" || actionType === "error" || reason.includes("error") || reason.includes("exception") || reason.includes("failed")) {
      if (reason.includes("profit_guard") || reason.includes("min_change") || reason.includes("cooldown") || reason.includes("no_change") || reason.includes("skip")) {
        cats.benign.count++;
        if (cats.benign.samples.length < 3) cats.benign.samples.push(a.action_reason || a.reason || "Benign skip");
      } else {
        cats.fatal_code.count++;
        if (cats.fatal_code.samples.length < 3) cats.fatal_code.samples.push(a.action_reason || a.reason || "Code error");
      }
    } else {
      cats.benign.count++;
    }
  }

  const icons: Record<string, React.ReactNode> = {
    throttling: <Zap className="h-4 w-4 text-yellow-500" />,
    auth: <Ban className="h-4 w-4 text-destructive" />,
    gateway: <AlertTriangle className="h-4 w-4 text-orange-500" />,
    deployment: <Wrench className="h-4 w-4 text-orange-500" />,
    fatal_code: <Ban className="h-4 w-4 text-destructive" />,
    benign: <CheckCircle className="h-4 w-4 text-green-500" />,
  };

  const labels: Record<string, string> = {
    throttling: "SP-API Throttling (429)",
    auth: "Auth / Token Errors",
    gateway: "Gateway / Empty Invocation",
    deployment: "Deployment / Boot Failure",
    fatal_code: "Fatal Code Errors",
    benign: "Benign / Retryable",
  };

  return Object.entries(cats)
    .filter(([_, v]) => v.count > 0)
    .map(([key, v]) => ({
      label: labels[key],
      count: v.count,
      severity: v.severity,
      icon: icons[key],
      samples: v.samples,
    }))
    .sort((a, b) => b.count - a.count);
}

function diagnose(
  settings: any,
  errorActions: any[],
  lastWrite: any,
  lastEval: any,
  lastRun: any,
  assignments: any[],
): DiagnosisResult {
  const categories = categorizeErrors(errorActions);
  const totalErrors = categories.reduce((s, c) => s + c.count, 0);

  const throttlingCount = categories.find(c => c.label.includes("Throttling"))?.count || 0;
  const authCount = categories.find(c => c.label.includes("Auth"))?.count || 0;
  const gatewayCount = categories.find(c => c.label.includes("Gateway"))?.count || 0;
  const deployCount = categories.find(c => c.label.includes("Deployment"))?.count || 0;
  const fatalCount = categories.find(c => c.label.includes("Fatal"))?.count || 0;

  let rootCause = "No errors detected in the last 30 minutes.";
  let recommendedAction = "System is operating normally.";
  let canAutoRecover = false;

  if (totalErrors === 0) {
    rootCause = "No errors detected. System healthy.";
    recommendedAction = "No action needed.";
  } else if (throttlingCount > totalErrors * 0.5) {
    rootCause = `SP-API rate limiting caused ${throttlingCount} of ${totalErrors} errors. Amazon throttled requests — this is temporary and non-fatal.`;
    recommendedAction = "Auto-recover: Clear circuit breaker and resume. Throttling errors are transient.";
    canAutoRecover = true;
  } else if (authCount > 0 && authCount >= fatalCount) {
    rootCause = `Authentication failures detected (${authCount} errors). Token may be expired or credentials rotated.`;
    recommendedAction = "Check SP-API authorization. Re-authorize Amazon connection if needed.";
  } else if (gatewayCount > totalErrors * 0.5) {
    rootCause = `Gateway/invocation errors (${gatewayCount}). Edge functions may have experienced cold start failures.`;
    recommendedAction = "Try auto-recover first. If it persists, use Advanced → Redeploy Function.";
    canAutoRecover = true;
  } else if (deployCount > 0) {
    rootCause = `Deployment/boot failures detected (${deployCount}). A function may need redeployment.`;
    recommendedAction = "Use Advanced → Redeploy Function for the affected function.";
  } else if (fatalCount > 0) {
    rootCause = `Fatal code errors detected (${fatalCount}). A bug may be present in the evaluation logic.`;
    recommendedAction = "Keep Safe Mode ON. Review error samples below and fix the root cause.";
  } else {
    rootCause = `Mixed errors detected (${totalErrors} total). Mostly benign/retryable.`;
    recommendedAction = "Auto-recover: Clear circuit breaker and resume.";
    canAutoRecover = true;
  }

  // Determine write block reasons
  const writeBlockReasons: string[] = [];
  if (settings?.safe_mode_active) writeBlockReasons.push("Safe Mode is active — all writes paused");
  if ((settings?.writes_this_cycle || 0) >= 500) writeBlockReasons.push("Write budget exhausted (500/cycle cap reached)");
  if (throttlingCount > 0) writeBlockReasons.push(`SP-API throttling blocked ${throttlingCount} price checks`);
  if (authCount > 0) writeBlockReasons.push("Auth failures preventing API calls");

  // assignments query now only returns enabled ones (pre-filtered), so check count
  const enabledCount = assignments.length;
  if (enabledCount === 0) writeBlockReasons.push("No enabled repricer assignments");

  if (writeBlockReasons.length === 0 && totalErrors === 0) {
    writeBlockReasons.push("No blockers detected — writes should be flowing normally");
  }

  return {
    safeModeActive: settings?.safe_mode_active || false,
    safeModeReason: settings?.safe_mode_reason || null,
    safeModeActivatedAt: settings?.safe_mode_activated_at || null,
    autoResumeAt: settings?.safe_mode_auto_resume_at || null,
    errorCount: settings?.circuit_breaker_error_count || 0,
    writesThisCycle: settings?.writes_this_cycle || 0,
    categories,
    totalErrors,
    rootCause,
    recommendedAction,
    canAutoRecover,
    lastHealthyWrite: lastWrite?.created_at || null,
    lastSuccessfulEval: lastEval?.created_at || null,
    lastSchedulerRun: lastRun?.created_at || null,
    writeBlockReasons,
  };
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export default function SafeModeRecoveryPanel() {
  const { user } = useAuth();
  const [diagnosis, setDiagnosis] = useState<DiagnosisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSamples, setShowSamples] = useState(false);

  const runDiagnosis = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      const [settingsRes, errorsRes, lastWriteRes, lastEvalRes, lastRunRes, assignRes] = await Promise.all([
        (supabase as any).from("repricer_settings")
          .select("safe_mode_active, safe_mode_reason, safe_mode_activated_at, safe_mode_auto_resume_at, circuit_breaker_error_count, circuit_breaker_window_start, writes_this_cycle")
          .eq("user_id", user.id).maybeSingle(),
        supabase.from("repricer_price_actions")
          .select("action_type, action_reason, reason, created_at, asin, sku")
          .eq("user_id", user.id)
          .gte("created_at", thirtyMinAgo)
          .in("action_type", ["eval_error", "price_change_failed", "safe_mode_activated"])
          .order("created_at", { ascending: false })
          .limit(200),
        // Last healthy write = last successful price_change or price_changed
        supabase.from("repricer_price_actions")
          .select("created_at")
          .eq("user_id", user.id)
          .eq("success", true)
          .in("action_type", ["price_change", "price_changed", "price_and_minmax_change"])
          .order("created_at", { ascending: false })
          .limit(1),
        // Last evaluate = priority_eval, anomaly_eval_only, or no_change (all represent evaluations)
        supabase.from("repricer_price_actions")
          .select("created_at")
          .eq("user_id", user.id)
          .in("action_type", ["priority_eval", "anomaly_eval_only", "no_change", "price_change", "blocked_by_profit_guard"])
          .order("created_at", { ascending: false })
          .limit(1),
        // Last scheduler run = any recent action (proves scheduler ran)
        supabase.from("repricer_price_actions")
          .select("created_at")
          .eq("user_id", user.id)
          .in("action_type", ["priority_eval", "no_change", "price_change", "anomaly_eval_only", "eval_error"])
          .order("created_at", { ascending: false })
          .limit(1),
        // Enabled assignments count (no fulfillable_quantity - column doesn't exist)
        supabase.from("repricer_assignments")
          .select("is_enabled")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .limit(1),
      ]);

      const d = diagnose(
        settingsRes.data,
        errorsRes.data || [],
        lastWriteRes.data?.[0] || null,
        lastEvalRes.data?.[0] || null,
        lastRunRes.data?.[0] || null,
        assignRes.data || [],
      );
      setDiagnosis(d);
    } catch (e) {
      console.error("Diagnosis error:", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    runDiagnosis();
    const __unsub = onMonitorRefresh(runDiagnosis);
    return () => __unsub();
  }, [runDiagnosis]);

  const handleAutoRecover = async () => {
    if (!user) return;
    setRecovering(true);
    try {
      await (supabase as any).from("repricer_settings").update({
        safe_mode_active: false,
        safe_mode_reason: null,
        safe_mode_activated_at: null,
        safe_mode_auto_resume_at: null,
        circuit_breaker_error_count: 0,
        circuit_breaker_window_start: null,
      }).eq("user_id", user.id);
      toast.success("Circuit breaker reset — repricer resumed");
      await runDiagnosis();
    } catch (e: any) {
      toast.error("Recovery failed: " + e.message);
    } finally {
      setRecovering(false);
    }
  };

  const handleResetBreakerOnly = async () => {
    if (!user) return;
    try {
      await (supabase as any).from("repricer_settings").update({
        circuit_breaker_error_count: 0,
        circuit_breaker_window_start: null,
      }).eq("user_id", user.id);
      toast.success("Circuit breaker error count reset");
      await runDiagnosis();
    } catch (e: any) {
      toast.error("Reset failed: " + e.message);
    }
  };

  if (loading && !diagnosis) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center justify-center gap-2">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span className="text-sm text-muted-foreground">Running diagnosis…</span>
        </CardContent>
      </Card>
    );
  }

  if (!diagnosis) return null;

  const isSafe = !diagnosis.safeModeActive;
  const autoResumeMin = diagnosis.autoResumeAt
    ? Math.max(0, Math.round((new Date(diagnosis.autoResumeAt).getTime() - Date.now()) / 60000))
    : null;

  return (
    <Card className={!isSafe ? "border-destructive bg-destructive/5" : "border-green-500/30"}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          {isSafe
            ? <ShieldCheck className="h-5 w-5 text-green-500" />
            : <ShieldAlert className="h-5 w-5 text-destructive animate-pulse" />
          }
          Safe Mode Recovery
          <Badge variant={isSafe ? "secondary" : "destructive"} className="ml-1">
            {isSafe ? "Healthy" : "SAFE MODE ACTIVE"}
          </Badge>
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={runDiagnosis} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status Row */}
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div className="bg-muted/50 rounded-md p-2">
            <div className="text-muted-foreground mb-0.5">Last Healthy Write</div>
            <div className="font-medium flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {timeAgo(diagnosis.lastHealthyWrite)}
            </div>
          </div>
          <div className="bg-muted/50 rounded-md p-2">
            <div className="text-muted-foreground mb-0.5">Last Evaluate</div>
            <div className="font-medium flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {timeAgo(diagnosis.lastSuccessfulEval)}
            </div>
          </div>
          <div className="bg-muted/50 rounded-md p-2">
            <div className="text-muted-foreground mb-0.5">Last Scheduler Run</div>
            <div className="font-medium flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {timeAgo(diagnosis.lastSchedulerRun)}
            </div>
          </div>
        </div>

        {/* Root Cause */}
        <div className="bg-muted/50 rounded-md p-3">
          <div className="text-xs text-muted-foreground mb-1 font-medium">Root Cause</div>
          <p className="text-sm">{diagnosis.rootCause}</p>
        </div>

        {/* Recommended Action */}
        <div className={`rounded-md p-3 ${diagnosis.canAutoRecover ? "bg-green-500/10 border border-green-500/20" : "bg-yellow-500/10 border border-yellow-500/20"}`}>
          <div className="text-xs text-muted-foreground mb-1 font-medium">Recommended Action</div>
          <p className="text-sm">{diagnosis.recommendedAction}</p>
        </div>

        {/* Error Breakdown */}
        {diagnosis.categories.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Error Breakdown (last 30 min) — {diagnosis.totalErrors} total
            </div>
            <div className="space-y-1.5">
              {diagnosis.categories.map((cat) => (
                <div key={cat.label} className="flex items-center justify-between text-sm bg-muted/30 rounded px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    {cat.icon}
                    <span>{cat.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={cat.severity === "fatal" ? "destructive" : cat.severity === "warning" ? "outline" : "secondary"}
                      className="text-xs"
                    >
                      {cat.count}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
            {/* Error samples toggle */}
            <Button
              variant="ghost"
              size="sm"
              className="text-xs mt-1 h-6 px-2"
              onClick={() => setShowSamples(!showSamples)}
            >
              {showSamples ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
              {showSamples ? "Hide" : "Show"} error samples
            </Button>
            {showSamples && (
              <div className="mt-2 space-y-2">
                {diagnosis.categories.filter(c => c.samples.length > 0).map(cat => (
                  <div key={cat.label}>
                    <div className="text-xs font-medium text-muted-foreground">{cat.label}:</div>
                    {cat.samples.map((s, i) => (
                      <pre key={i} className="text-xs bg-muted/40 rounded p-1.5 mt-1 overflow-x-auto whitespace-pre-wrap break-all">
                        {s.slice(0, 200)}
                      </pre>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Why writes are 0 */}
        <div className="bg-muted/50 rounded-md p-3">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Why Writes May Be 0</div>
          <ul className="space-y-1">
            {diagnosis.writeBlockReasons.map((reason, i) => (
              <li key={i} className="text-sm flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-yellow-500" />
                {reason}
              </li>
            ))}
          </ul>
        </div>

        {/* Safe Mode Details */}
        {!isSafe && (
          <div className="bg-destructive/10 rounded-md p-3 text-sm space-y-1">
            <div className="font-medium text-destructive">Safe Mode Reason:</div>
            <p>{diagnosis.safeModeReason}</p>
            {autoResumeMin !== null && autoResumeMin > 0 && (
              <p className="text-xs text-muted-foreground">Auto-resume in {autoResumeMin} min</p>
            )}
            <p className="text-xs text-muted-foreground">
              Errors in window: {diagnosis.errorCount} · Writes this cycle: {diagnosis.writesThisCycle}
            </p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            onClick={handleAutoRecover}
            disabled={recovering}
            size="sm"
            variant={diagnosis.canAutoRecover ? "default" : "outline"}
            className={diagnosis.canAutoRecover ? "bg-green-600 hover:bg-green-700 text-white" : ""}
          >
            {recovering ? <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" /> : <Zap className="h-3.5 w-3.5 mr-1" />}
            Auto Recover Now
          </Button>
          <Button onClick={handleResetBreakerOnly} size="sm" variant="outline">
            Reset Breaker Only
          </Button>
          <Button onClick={runDiagnosis} size="sm" variant="outline" disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh Diagnosis
          </Button>

          {/* Advanced toggle */}
          <Button
            variant="ghost"
            size="sm"
            className="text-xs ml-auto"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
            Advanced
          </Button>
        </div>

        {/* Advanced Section */}
        {showAdvanced && (
          <div className="border-t border-border pt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              ⚠️ Advanced actions — use only if auto-recovery doesn't resolve the issue.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={() => {
                  window.open(
                    "https://supabase.com/dashboard/project/mstibdszibcheodvnprm/functions",
                    "_blank"
                  );
                }}
              >
                <Wrench className="h-3 w-3 mr-1" />
                Redeploy Functions (Supabase Dashboard)
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
