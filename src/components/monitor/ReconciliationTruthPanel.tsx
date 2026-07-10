import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { RefreshCw, Search, Loader2 } from "lucide-react";
import { formatPrice, getMarketplaceConfig } from "@/lib/marketplaceCurrency";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

interface TruthRow {
  asin: string;
  sku: string;
  marketplace: string;
  intendedPrice: number;
  submittedPrice: number | null;
  livePrice: number | null;
  delta: number;
  rootCause: string;
  severity: string;
  retryCount: number;
  converged: boolean;
  convergenceTimeSec: number | null;
  status: string;
  method: string;
  createdAt: string;
}

interface AggregateStats {
  totalReconciled: number;
  matched: number;
  mismatchSevere: number;
  mismatchModerate: number;
  mismatchMinor: number;
  delayedResolved: number;
  rechecking: number;
  failed: number;
  trueMatchRate: number;
  severeRate: number;
  avgConvergenceSec: number;
  rootCauseCounts: Record<string, number>;
}

export default function ReconciliationTruthPanel() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<TruthRow[]>([]);
  const [stats, setStats] = useState<AggregateStats | null>(null);

  const fetchData = async () => {
    if (!user) return;
    setLoading(true);

    try {
      const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data: actions } = await supabase
        .from("repricer_price_actions")
        .select("asin, sku, marketplace, intended_price, new_price, verified_live_price, reconciliation_status, reconciliation_reason, recon_retry_count, recon_severity, recon_root_cause, recon_converged_at, recon_first_check_at, recon_last_check_at, recon_price_submitted, update_method, created_at")
        .eq("user_id", user.id)
        .in("action_type", ["price_change", "price_and_minmax_change"])
        .eq("success", true)
        .gte("created_at", windowStart)
        .not("reconciliation_status", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);

      const raw = actions || [];
      
      // Build truth rows
      const truthRows: TruthRow[] = raw.map((a: any) => {
        const intended = Number(a.intended_price || a.new_price || 0);
        const live = a.verified_live_price ? Number(a.verified_live_price) : null;
        const submitted = a.recon_price_submitted ? Number(a.recon_price_submitted) : null;
        const delta = live !== null ? live - intended : 0;
        const converged = !!a.recon_converged_at;
        
        let convergenceTimeSec: number | null = null;
        if (a.recon_converged_at && a.created_at) {
          convergenceTimeSec = Math.round((new Date(a.recon_converged_at).getTime() - new Date(a.created_at).getTime()) / 1000);
        }

        return {
          asin: a.asin,
          sku: a.sku || "—",
          marketplace: a.marketplace || "US",
          intendedPrice: intended,
          submittedPrice: submitted,
          livePrice: live,
          delta,
          rootCause: a.recon_root_cause || extractLegacyRootCause(a.reconciliation_reason),
          severity: a.recon_severity || inferSeverity(Math.abs(delta), intended),
          retryCount: a.recon_retry_count || 0,
          converged,
          convergenceTimeSec,
          status: a.reconciliation_status,
          method: a.update_method || "—",
          createdAt: a.created_at,
        };
      });

      setRows(truthRows);

      // Aggregate stats
      const matched = truthRows.filter(r => r.status === "matched").length;
      const severe = truthRows.filter(r => r.status === "mismatch" && r.severity === "severe").length;
      const moderate = truthRows.filter(r => r.status === "mismatch" && r.severity === "moderate").length;
      const minor = truthRows.filter(r => r.status === "mismatch" && r.severity === "minor").length;
      const delayedResolved = truthRows.filter(r => r.status === "matched" && r.retryCount > 0).length;
      const rechecking = truthRows.filter(r => r.status === "recheck").length;
      const failed = truthRows.filter(r => r.status === "failed").length;

      const countedTotal = matched + severe + moderate + minor + failed;
      const trueMatchRate = countedTotal > 0 ? Math.round((matched / countedTotal) * 100) : 100;
      const severeRate = countedTotal > 0 ? Math.round((severe / countedTotal) * 100) : 0;

      const convergenceTimes = truthRows
        .filter(r => r.convergenceTimeSec !== null && r.status === "matched")
        .map(r => r.convergenceTimeSec!);
      const avgConvergence = convergenceTimes.length > 0
        ? Math.round(convergenceTimes.reduce((s, v) => s + v, 0) / convergenceTimes.length)
        : 0;

      // Root cause distribution
      const rootCauseCounts: Record<string, number> = {};
      for (const r of truthRows) {
        if (r.status === "mismatch" || r.status === "recheck") {
          rootCauseCounts[r.rootCause] = (rootCauseCounts[r.rootCause] || 0) + 1;
        }
      }

      setStats({
        totalReconciled: countedTotal,
        matched,
        mismatchSevere: severe,
        mismatchModerate: moderate,
        mismatchMinor: minor,
        delayedResolved,
        rechecking,
        failed,
        trueMatchRate,
        severeRate,
        avgConvergenceSec: avgConvergence,
        rootCauseCounts,
      });
    } catch (err) {
      console.error("Reconciliation truth error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const __unsub = onMonitorRefresh(fetchData);
    return () => __unsub();
  }, [user]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!stats) return null;

  const severeRows = rows
    .filter(r => (r.status === "mismatch" && r.severity === "severe") || r.status === "recheck")
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 15);

  const rootCauseEntries = Object.entries(stats.rootCauseCounts).sort(([, a], [, b]) => b - a);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Search className="h-5 w-5 text-primary" />
          Reconciliation Truth
          <Badge variant="outline" className="text-xs">{stats.trueMatchRate}% true match</Badge>
          {stats.severeRate > 0 && (
            <Badge variant="destructive" className="text-xs">{stats.severeRate}% severe</Badge>
          )}
        </CardTitle>
        <Button variant="outline" size="sm" onClick={fetchData}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Aggregate stats grid */}
        <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2">
          <StatBox label="Matched" value={stats.matched} color="text-green-600" />
          <StatBox label="Severe" value={stats.mismatchSevere} color="text-destructive" />
          <StatBox label="Moderate" value={stats.mismatchModerate} color="text-yellow-600" />
          <StatBox label="Minor" value={stats.mismatchMinor} color="text-muted-foreground" />
          <StatBox label="Delayed OK" value={stats.delayedResolved} color="text-blue-600" />
          <StatBox label="Rechecking" value={stats.rechecking} color="text-amber-500" />
          <StatBox label="Failed" value={stats.failed} color="text-destructive" />
          <StatBox label="Avg Converge" value={`${stats.avgConvergenceSec}s`} color="text-foreground" />
          <StatBox label="Total" value={stats.totalReconciled} color="text-foreground" />
        </div>

        {/* Root cause breakdown */}
        {rootCauseEntries.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Mismatch Root Causes</h4>
            <div className="flex flex-wrap gap-2">
              {rootCauseEntries.map(([cause, count]) => (
                <Badge key={cause} variant="outline" className="text-xs font-mono">
                  {cause}: {count}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Severe/recheck detail table */}
        {severeRows.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Severe Mismatches & Pending Rechecks</h4>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ASIN</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead className="text-right">Intended</TableHead>
                    <TableHead className="text-right">Live</TableHead>
                    <TableHead className="text-right">Delta</TableHead>
                    <TableHead>Root Cause</TableHead>
                    <TableHead>Retries</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {severeRows.map((r, i) => {
                    const cfg = getMarketplaceConfig(r.marketplace);
                    const pctDelta = r.intendedPrice > 0 ? (Math.abs(r.delta) / r.intendedPrice * 100) : 0;
                    return (
                    <TableRow key={`${r.asin}-${i}`}>
                      <TableCell className="font-mono text-xs">{r.asin}</TableCell>
                      <TableCell>
                        <span className="text-xs">{cfg.flag} {r.marketplace}</span>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPrice(r.intendedPrice, r.marketplace)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {r.livePrice !== null ? formatPrice(r.livePrice, r.marketplace) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={pctDelta > 5 ? "text-destructive font-bold" : "text-yellow-600"}>
                          {pctDelta.toFixed(1)}%
                        </span>
                        <span className="text-[9px] text-muted-foreground ml-1">{cfg.currency}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {r.rootCause}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">{r.retryCount}/3</TableCell>
                      <TableCell>
                        <Badge 
                          variant={r.status === "recheck" ? "outline" : "destructive"} 
                          className="text-[10px]"
                        >
                          {r.status === "recheck" ? "RECHECKING" : "MISMATCH"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          Rolling 24h • 3-stage delayed verification (+2m/+5m/+10m) • Only "severe" mismatches after all retries count as true failures
        </p>
      </CardContent>
    </Card>
  );
}

function StatBox({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="p-2 rounded-lg border bg-muted/30 text-center">
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

function extractLegacyRootCause(reason: string | null): string {
  if (!reason) return "UNKNOWN";
  const match = reason.match(/\[([A-Z_]+)\]/);
  return match ? match[1] : "UNKNOWN";
}

function inferSeverity(absDelta: number, intended: number): string {
  if (absDelta <= 0.05) return "minor";
  const pct = intended > 0 ? (absDelta / intended) * 100 : 0;
  if (absDelta <= 1.0 && pct <= 1.5) return "moderate";
  return "severe";
}
