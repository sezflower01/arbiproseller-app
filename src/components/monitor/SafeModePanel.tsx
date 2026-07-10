import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldAlert, ShieldCheck, Activity, Lock, Database, CheckCircle, XCircle, Clock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import KeyMetricsSnapshot from "./KeyMetricsSnapshot";
import { useMonitorData } from "@/hooks/use-monitor-data";
import { getReconciliationWindowStartIso, isDisplayableReconciliationMismatch, summarizeReconciliation } from "@/lib/reconciliationMetrics";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

interface HardeningStatus {
  safe_mode_active: boolean;
  safe_mode_reason: string | null;
  safe_mode_activated_at: string | null;
  safe_mode_auto_resume_at: string | null;
  circuit_breaker_error_count: number;
  circuit_breaker_last_trigger: string | null;
  writes_this_cycle: number;
}

interface AnomalyItem {
  asin: string;
  sku: string;
  anomaly_score: number;
  anomaly_flags: string[];
  oscillation_count: number;
  bb_loss_after_raise_count: number;
}

interface ReconciliationStats {
  matched: number;
  mismatch: number;
  pending: number;
  failed: number;
  pending_timeout: number;
}

interface MismatchItem {
  id: string;
  asin: string;
  sku: string;
  marketplace: string;
  intended_price: number;
  verified_live_price: number;
  reconciliation_reason: string;
  verified_at: string;
}

export default function SafeModePanel() {
  const { user } = useAuth();
  const monitorData = useMonitorData();
  const [status, setStatus] = useState<HardeningStatus | null>(null);
  const [anomalies, setAnomalies] = useState<AnomalyItem[]>([]);
  const [activeLocks, setActiveLocks] = useState(0);
  const [reconciliation, setReconciliation] = useState<ReconciliationStats>({ matched: 0, mismatch: 0, pending: 0, failed: 0, pending_timeout: 0 });
  const [mismatches, setMismatches] = useState<MismatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reconciling, setReconciling] = useState(false);

  useEffect(() => {
    if (!user) return;
    fetchData();
    const __unsub = onMonitorRefresh(fetchData);
    return () => __unsub();
  }, [user]);

  const fetchData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const twentyFourHoursAgo = getReconciliationWindowStartIso();
      
      const [settingsRes, anomalyRes, locksRes, reconciliationRes] = await Promise.all([
        (supabase as any)
          .from("repricer_settings")
          .select("safe_mode_active, safe_mode_reason, safe_mode_activated_at, safe_mode_auto_resume_at, circuit_breaker_error_count, circuit_breaker_last_trigger, circuit_breaker_window_start, writes_this_cycle")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("repricer_assignments")
          .select("asin, sku, anomaly_score, anomaly_flags, oscillation_count, bb_loss_after_raise_count")
          .eq("user_id", user.id)
          .gt("anomaly_score", 0)
          .order("anomaly_score", { ascending: false })
          .limit(10),
        (supabase as any)
          .from("repricer_asin_locks")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id),
        supabase
          .from("repricer_price_actions")
          .select("id, asin, sku, marketplace, intended_price, new_price, verified_live_price, reconciliation_reason, reconciliation_status, verified_at")
          .eq("user_id", user.id)
          .gte("created_at", twentyFourHoursAgo)
          .not("reconciliation_status", "is", null)
          .order("verified_at", { ascending: false }),
      ]);
      
      const reconciliationRows = (reconciliationRes.data || []) as Array<MismatchItem & { new_price?: number | null; reconciliation_status: string | null }>;
      const reconciliationSummary = summarizeReconciliation(reconciliationRows as any[]);

      setStatus(settingsRes.data || null);
      setAnomalies((anomalyRes.data as AnomalyItem[]) || []);
      setActiveLocks(locksRes.count || 0);
      setReconciliation({
        matched: reconciliationSummary.matched,
        mismatch: reconciliationSummary.mismatch,
        pending: reconciliationSummary.pending,
        failed: reconciliationSummary.failed,
        pending_timeout: reconciliationSummary.pendingTimeout,
      });
      setMismatches(
        reconciliationRows
          .filter((row) => isDisplayableReconciliationMismatch(row as any))
          .slice(0, 10) as MismatchItem[]
      );
    } catch (e) {
      console.error("Hardening panel error:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleDeactivateSafeMode = async () => {
    if (!user) return;
    await (supabase as any).from("repricer_settings").update({
      safe_mode_active: false,
      safe_mode_reason: null,
      safe_mode_activated_at: null,
      safe_mode_auto_resume_at: null,
      circuit_breaker_error_count: 0,
    }).eq("user_id", user.id);
    toast.success("Safe mode deactivated");
    fetchData();
  };

  const handleRunReconciliation = async () => {
    if (!user) return;
    setReconciling(true);
    try {
      const result = await (await import("@/lib/edgeFunctionClient")).invokeEdgeFunction({
        functionName: "repricer-reconcile",
        body: { user_id: user.id },
      });
      if (!result.ok) throw new Error(result.errorMessage || "Reconciliation failed");
      toast.success(`Reconciliation: ${result.data.matched} matched, ${result.data.mismatched} mismatched, ${result.data.failed} failed`);
      fetchData();
    } catch (e: any) {
      toast.error(`Reconciliation failed: ${e.message}`);
    } finally {
      setReconciling(false);
    }
  };

  if (loading && !status) return null;

  const isSafe = !status?.safe_mode_active;
  const autoResumeIn = status?.safe_mode_auto_resume_at
    ? Math.max(0, Math.round((new Date(status.safe_mode_auto_resume_at).getTime() - Date.now()) / 60000))
    : null;
  
  const totalReconciled = reconciliation.matched + reconciliation.mismatch + reconciliation.failed;
  const matchRate = totalReconciled > 0 ? Math.round((reconciliation.matched / totalReconciled) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Circuit Breaker / Safe Mode */}
      <Card className={!isSafe ? "border-destructive" : ""}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            {isSafe ? <ShieldCheck className="h-5 w-5 text-green-500" /> : <ShieldAlert className="h-5 w-5 text-destructive" />}
            Circuit Breaker
            <Badge variant={isSafe ? "secondary" : "destructive"}>
              {isSafe ? "Normal" : "SAFE MODE"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {!isSafe && (
            <div className="space-y-2">
              <p className="text-sm text-destructive font-medium">{status?.safe_mode_reason}</p>
              {autoResumeIn !== null && autoResumeIn > 0 && (
                <p className="text-xs text-muted-foreground">Auto-resume in {autoResumeIn} min</p>
              )}
              <Button size="sm" variant="outline" onClick={handleDeactivateSafeMode}>
                Override — Resume Now
              </Button>
            </div>
          )}
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>Errors in window: {(() => {
              const windowStart = (status as any)?.circuit_breaker_window_start;
              if (windowStart && (Date.now() - new Date(windowStart).getTime()) > 30 * 60 * 1000) return 0;
              return status?.circuit_breaker_error_count || 0;
            })()}</span>
            <span>Writes this cycle: {status?.writes_this_cycle || 0}</span>
          </div>
          {status?.circuit_breaker_last_trigger && (
            <p className="text-xs text-muted-foreground">Last trigger: {status.circuit_breaker_last_trigger}</p>
          )}
        </CardContent>
      </Card>

      {/* Key Metrics Before vs Now */}
      <KeyMetricsSnapshot data={monitorData} />

      {/* Active Locks & Write Budget */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Lock className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Active Locks</span>
            </div>
            <div className="text-2xl font-bold">{activeLocks}</div>
            <p className="text-xs text-muted-foreground">ASINs being processed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Database className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Write Budget</span>
            </div>
            <div className="text-2xl font-bold">{Math.max(0, 500 - (status?.writes_this_cycle || 0))}</div>
            <p className="text-xs text-muted-foreground">Remaining this cycle</p>
          </CardContent>
        </Card>
      </div>

      {/* Post-Apply Reconciliation */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-primary" />
            Post-Apply Reconciliation
            <Badge variant="outline" className="text-xs">{matchRate}% match rate</Badge>
            <div className="ml-auto">
              <Button size="sm" variant="outline" onClick={handleRunReconciliation} disabled={reconciling}>
                <RefreshCw className={`h-3 w-3 mr-1 ${reconciling ? 'animate-spin' : ''}`} />
                Verify Now
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-5 gap-2 text-center text-xs">
            <div>
              <div className="text-lg font-bold text-green-500">{reconciliation.matched}</div>
              <div className="text-muted-foreground">Matched</div>
            </div>
            <div>
              <div className="text-lg font-bold text-destructive">{reconciliation.mismatch}</div>
              <div className="text-muted-foreground">Mismatch</div>
            </div>
            <div>
              <div className="text-lg font-bold text-yellow-500">{reconciliation.pending}</div>
              <div className="text-muted-foreground">Pending</div>
            </div>
            <div>
              <div className="text-lg font-bold text-muted-foreground">{reconciliation.failed}</div>
              <div className="text-muted-foreground">Failed</div>
            </div>
            <div>
              <div className="text-lg font-bold text-muted-foreground">{reconciliation.pending_timeout}</div>
              <div className="text-muted-foreground">Timed Out</div>
            </div>
          </div>

          {/* Mismatch details */}
          {mismatches.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs font-medium text-destructive">Recent Mismatches:</p>
              {mismatches.map((m) => (
                <div key={m.id} className="flex items-center justify-between text-xs border-b border-border pb-1">
                  <div>
                    <span className="font-mono">{m.asin}</span>
                    <span className="text-muted-foreground ml-1">{m.sku}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      intended ${m.intended_price?.toFixed(2)} → live ${m.verified_live_price?.toFixed(2)}
                    </span>
                    <XCircle className="h-3 w-3 text-destructive" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Anomaly Detection */}
      {anomalies.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-5 w-5 text-yellow-500" />
              Anomaly Detection
              <Badge variant="outline">{anomalies.length} flagged</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {anomalies.map((a) => (
                <div key={a.asin} className="flex items-center justify-between text-sm border-b border-border pb-2">
                  <div>
                    <span className="font-mono">{a.asin}</span>
                    <span className="text-xs text-muted-foreground ml-2">{a.sku}</span>
                    {(a.bb_loss_after_raise_count || 0) > 0 && (
                      <Badge variant="outline" className="ml-2 text-xs text-destructive">
                        BB lost {a.bb_loss_after_raise_count}x after raise
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {(a.anomaly_flags as string[])?.map((flag: string) => (
                      <Badge key={flag} variant="outline" className="text-xs">
                        {flag.replace(/_/g, " ")}
                      </Badge>
                    ))}
                    <Badge variant={a.anomaly_score >= 50 ? "destructive" : "secondary"}>
                      {a.anomaly_score}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
