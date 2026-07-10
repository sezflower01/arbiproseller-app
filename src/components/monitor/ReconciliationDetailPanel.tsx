import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RefreshCw, CheckCircle, XCircle, Clock, AlertTriangle, TrendingDown, Shield } from "lucide-react";
import {
  getReconciliationWindowStartIso,
  getReconciliationIntendedPrice,
  getReconciliationLivePrice,
  getReconciliationAbsoluteDelta,
  isEffectiveReconciliationMatch,
  extractRootCause,
  isMarketDrivenMismatch,
} from "@/lib/reconciliationMetrics";
import { formatPrice, getMarketplaceConfig } from "@/lib/marketplaceCurrency";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

interface MismatchCategory {
  key: string;
  label: string;
  count: number;
  severity: "high" | "medium" | "low";
  isMarketDriven: boolean;
}

interface DeltaRange {
  label: string;
  count: number;
  pct: number;
}

interface FailedBreakdown {
  marketplace: string;
  reason: string;
  count: number;
}

interface ExtractionStats {
  marketplace: string;
  total: number;
  succeeded: number;
  rate: number;
}

interface ReconDetailData {
  totalReconciled: number;
  matched: number;
  mismatch: number;
  marketDriven: number;
  systemMismatch: number;
  failed: number;
  pending: number;
  recheck: number;
  matchRate: number;
  systemAccuracy: number;
  recoveredByRecheck: number;
  mismatchCategories: MismatchCategory[];
  deltaRanges: DeltaRange[];
  failedBreakdown: FailedBreakdown[];
  legacyBacklog: { total: number; noRootCause: number; rechecking: number; drainRate: number; etaMinutes: number | null };
  extractionStats: ExtractionStats[];
  topMismatches: Array<{
    asin: string;
    sku: string;
    marketplace: string;
    intended: number;
    live: number;
    delta: number;
    pctDelta: number;
    reason: string;
    rootCause: string | null;
    isMarketDriven: boolean;
  }>;
}

const MARKET_DRIVEN_CAUSES = new Set([
  "COMPETITOR_UNDERCUT", "COMPETITOR_REACTION", "EXTERNAL_PRICE_CHANGE",
  "AMAZON_PRICE_FLOOR", "AMAZON_STEP_ENFORCEMENT",
]);

function classifyMismatchReason(reason: string | null | undefined, rootCause: string | null | undefined): { key: string; isMarketDriven: boolean } {
  // Prefer recon_root_cause column, then parse from reason text
  const cause = rootCause || reason?.match(/\[([A-Z_]+)\]/)?.[1] || null;
  if (cause) {
    const normalized = cause.toUpperCase();
    const keyMap: Record<string, string> = {
      FX_ROUNDING: "fx_rounding",
      AMAZON_ROUNDING: "amazon_rounding",
      FEED_DELAY: "feed_delay",
      COMPETITOR_REACTION: "competitor_reaction",
      COMPETITOR_UNDERCUT: "competitor_reaction",
      EXTERNAL_PRICE_CHANGE: "external_price_change",
      AMAZON_PRICE_FLOOR: "amazon_price_floor",
      AMAZON_STEP_ENFORCEMENT: "amazon_step",
      STALE_READBACK: "stale_read",
      SKU_MAPPING: "sku_mapping",
    };
    const key = keyMap[normalized] || normalized.toLowerCase();
    return { key, isMarketDriven: MARKET_DRIVEN_CAUSES.has(normalized) };
  }
  
  // Fallback: parse from reason text
  const r = (reason || "").toLowerCase();
  if (r.includes("fx_rounding") || r.includes("fx rounding")) return { key: "fx_rounding", isMarketDriven: false };
  if (r.includes("rounding") || r.includes("amazon_rounding")) return { key: "amazon_rounding", isMarketDriven: false };
  if (r.includes("feed_delay") || r.includes("propagation") || r.includes("pending")) return { key: "feed_delay", isMarketDriven: false };
  if (r.includes("competitor") || r.includes("reaction") || r.includes("competitor_undercut")) return { key: "competitor_reaction", isMarketDriven: true };
  if (r.includes("external_price")) return { key: "external_price_change", isMarketDriven: true };
  if (r.includes("price_floor") || r.includes("amazon_price_floor")) return { key: "amazon_price_floor", isMarketDriven: true };
  if (r.includes("step_enforcement") || r.includes("amazon_step")) return { key: "amazon_step", isMarketDriven: true };
  if (r.includes("mapping") || r.includes("sku") || r.includes("wrong_asin")) return { key: "sku_mapping", isMarketDriven: false };
  if (r.includes("stale") || r.includes("old_read")) return { key: "stale_read", isMarketDriven: false };
  if (r.includes("rejected") || r.includes("amazon_rejected")) return { key: "amazon_rejected", isMarketDriven: false };
  if (r.includes("intended") || r.includes("wrong_intended")) return { key: "wrong_intended", isMarketDriven: false };
  return { key: "unknown", isMarketDriven: false };
}

const CATEGORY_LABELS: Record<string, string> = {
  fx_rounding: "FX/Currency Rounding",
  amazon_rounding: "Amazon Rounding",
  feed_delay: "Feed Propagation Delay",
  competitor_reaction: "Competitor Reaction",
  external_price_change: "External Price Change",
  sku_mapping: "SKU/ASIN Mapping Issue",
  stale_read: "Stale Live Read",
  amazon_rejected: "Amazon Rejected",
  wrong_intended: "Wrong Intended Price",
  amazon_price_floor: "Amazon Price Floor",
  amazon_step: "Amazon Step Enforcement",
  unknown: "Unclassified",
};

const CATEGORY_SEVERITY: Record<string, "high" | "medium" | "low"> = {
  fx_rounding: "low",
  amazon_rounding: "low",
  feed_delay: "low",
  competitor_reaction: "medium",
  external_price_change: "medium",
  sku_mapping: "high",
  stale_read: "medium",
  amazon_rejected: "high",
  wrong_intended: "high",
  amazon_price_floor: "low",
  amazon_step: "low",
  unknown: "medium",
};

export default function ReconciliationDetailPanel() {
  const { user } = useAuth();
  const [data, setData] = useState<ReconDetailData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const windowStart = getReconciliationWindowStartIso();
      const { data: rows } = await supabase
        .from("repricer_price_actions")
        .select("asin, sku, marketplace, reconciliation_status, reconciliation_reason, intended_price, new_price, verified_live_price, verified_at, recon_root_cause, recon_retry_count")
        .eq("user_id", user.id)
        .gte("created_at", windowStart)
        .not("reconciliation_status", "is", null)
        .order("verified_at", { ascending: false })
        .limit(600);

      const all = rows || [];

      let matched = 0, mismatch = 0, failed = 0, pending = 0, recheck = 0, marketDriven = 0, recoveredByRecheck = 0;
      const mismatchRows: typeof all = [];
      const failedRows: typeof all = [];

      for (const row of all) {
        if (isEffectiveReconciliationMatch(row as any)) {
          matched++;
          // Recovered by recheck: matched but had retries
          if ((row as any).recon_retry_count > 0) recoveredByRecheck++;
        } else if (row.reconciliation_status === "mismatch") {
          mismatch++;
          mismatchRows.push(row);
          if (isMarketDrivenMismatch(row as any)) marketDriven++;
        } else if (row.reconciliation_status === "failed") {
          failed++;
          failedRows.push(row);
        } else if (row.reconciliation_status === "pending" || row.reconciliation_status === "pending_timeout") {
          pending++;
        } else if (row.reconciliation_status === "recheck") {
          recheck++;
        }
      }

      const totalReconciled = matched + mismatch + failed;
      const matchRate = totalReconciled > 0 ? Math.round((matched / totalReconciled) * 100) : 100;
      const systemMismatch = mismatch - marketDriven;
      const systemDenom = totalReconciled - marketDriven;
      const systemAccuracy = systemDenom > 0 ? Math.round((matched / systemDenom) * 100) : 100;

      // Mismatch reason categories
      const catCounts: Record<string, { count: number; isMarketDriven: boolean }> = {};
      for (const row of mismatchRows) {
        const { key, isMarketDriven: isMD } = classifyMismatchReason(
          row.reconciliation_reason,
          (row as any).recon_root_cause
        );
        if (!catCounts[key]) catCounts[key] = { count: 0, isMarketDriven: isMD };
        catCounts[key].count++;
      }
      const mismatchCategories: MismatchCategory[] = Object.entries(catCounts)
        .map(([key, { count, isMarketDriven: isMD }]) => ({
          key,
          label: CATEGORY_LABELS[key] || key,
          count,
          severity: CATEGORY_SEVERITY[key] || "medium",
          isMarketDriven: isMD,
        }))
        .sort((a, b) => b.count - a.count);

      // Delta ranges
      const deltas = mismatchRows
        .map((r) => getReconciliationAbsoluteDelta(r as any))
        .filter((d): d is number => d !== null);

      const ranges = [
        { label: "≤ $0.01", count: deltas.filter((d) => d <= 0.01).length },
        { label: "≤ $0.10", count: deltas.filter((d) => d > 0.01 && d <= 0.1).length },
        { label: "≤ $1.00", count: deltas.filter((d) => d > 0.1 && d <= 1.0).length },
        { label: "> $1.00", count: deltas.filter((d) => d > 1.0).length },
      ];
      const deltaRanges: DeltaRange[] = ranges.map((r) => ({
        ...r,
        pct: deltas.length > 0 ? Math.round((r.count / deltas.length) * 100) : 0,
      }));

      // Top mismatches
      const topMismatches = mismatchRows.slice(0, 8).map((r) => {
        const intended = getReconciliationIntendedPrice(r as any) || 0;
        const live = getReconciliationLivePrice(r as any) || 0;
        const rootCause = extractRootCause(r as any);
        const marketplace = (r as any).marketplace || "US";
        return {
          asin: r.asin || "—",
          sku: r.sku || "—",
          marketplace,
          intended,
          live,
          delta: Math.abs(live - intended),
          pctDelta: intended > 0 ? Math.abs(live - intended) / intended * 100 : 0,
          reason: r.reconciliation_reason || "unknown",
          rootCause,
          isMarketDriven: rootCause ? MARKET_DRIVEN_CAUSES.has(rootCause) : false,
        };
      }).sort((a, b) => b.delta - a.delta);

      // Failed breakdown by marketplace + reason
      const failedMap: Record<string, number> = {};
      for (const row of failedRows) {
        const mp = (row as any).marketplace || "US";
        const reason = row.reconciliation_reason?.split(",")[0]?.trim() || "Unknown";
        const key = `${mp}|${reason}`;
        failedMap[key] = (failedMap[key] || 0) + 1;
      }
      const failedBreakdown: FailedBreakdown[] = Object.entries(failedMap)
        .map(([key, count]) => {
          const [marketplace, reason] = key.split("|");
          return { marketplace, reason, count };
        })
        .sort((a, b) => b.count - a.count);

      // Legacy backlog
      const noRootCause = mismatchRows.filter(r => !(r as any).recon_root_cause).length;

      // Drain rate: recovered per minute estimate based on recovered count over window
      // Window is 24h but we estimate from recovered count
      const drainRate = recoveredByRecheck > 0 ? Math.round((recoveredByRecheck / 60) * 10) / 10 : 0; // approx items/min over last hour
      const etaMinutes = drainRate > 0 ? Math.round((recheck + pending) / Math.max(drainRate, 0.1)) : null;

      // Extraction success rate by marketplace
      const extractionMap: Record<string, { total: number; succeeded: number }> = {};
      for (const row of all) {
        const mp = (row as any).marketplace || "US";
        if (!extractionMap[mp]) extractionMap[mp] = { total: 0, succeeded: 0 };
        extractionMap[mp].total++;
        if (row.reconciliation_status !== "failed" || !(row.reconciliation_reason || "").includes("extract")) {
          extractionMap[mp].succeeded++;
        }
      }
      const extractionStats: ExtractionStats[] = Object.entries(extractionMap)
        .map(([marketplace, { total, succeeded }]) => ({
          marketplace,
          total,
          succeeded,
          rate: total > 0 ? Math.round((succeeded / total) * 1000) / 10 : 100,
        }))
        .sort((a, b) => a.rate - b.rate);

      setData({
        totalReconciled,
        matched,
        mismatch,
        marketDriven,
        systemMismatch,
        failed,
        pending,
        recheck,
        matchRate,
        systemAccuracy,
        recoveredByRecheck,
        mismatchCategories,
        deltaRanges,
        failedBreakdown,
        legacyBacklog: { total: mismatch, noRootCause, rechecking: recheck, drainRate, etaMinutes },
        extractionStats,
        topMismatches,
      });
    } catch (e) {
      console.error("Recon detail error:", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetch();
    const __unsub = onMonitorRefresh(fetch);
    return () => __unsub();
  }, [fetch]);

  if (loading && !data) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-muted-foreground">Loading reconciliation details…</CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const sysColor = data.systemAccuracy >= 85 ? "text-green-500" : data.systemAccuracy >= 60 ? "text-yellow-500" : "text-destructive";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <CheckCircle className="h-5 w-5 text-primary" />
          Reconciliation Analysis
        </CardTitle>
        <Button variant="outline" size="sm" onClick={fetch} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Two accuracy metrics */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Shield className="h-3.5 w-3.5" />
              System Accuracy
            </div>
            <div className={`text-2xl font-bold ${sysColor}`}>{data.systemAccuracy}%</div>
            <div className="text-[10px] text-muted-foreground">
              Excludes {data.marketDriven} market-driven
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <TrendingDown className="h-3.5 w-3.5" />
              Raw Match Rate
            </div>
            <div className="text-2xl font-bold text-muted-foreground">{data.matchRate}%</div>
            <div className="text-[10px] text-muted-foreground">
              {data.matched}/{data.totalReconciled} reconciled
            </div>
          </div>
        </div>

        {/* Summary row */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center text-xs">
          <div>
            <div className="text-lg font-bold text-green-500">{data.matched}</div>
            <div className="text-muted-foreground">Matched</div>
          </div>
          <div>
            <div className="text-lg font-bold text-yellow-500">{data.marketDriven}</div>
            <div className="text-muted-foreground">Market</div>
          </div>
          <div>
            <div className="text-lg font-bold text-destructive">{data.systemMismatch}</div>
            <div className="text-muted-foreground">System</div>
          </div>
          <div>
            <div className="text-lg font-bold text-muted-foreground">{data.failed}</div>
            <div className="text-muted-foreground">Failed</div>
          </div>
          <div>
            <div className="text-lg font-bold text-blue-500">{data.recoveredByRecheck}</div>
            <div className="text-muted-foreground">Recovered</div>
          </div>
          <div>
            <div className="text-lg font-bold text-muted-foreground">{data.recheck + data.pending}</div>
            <div className="text-muted-foreground">In Progress</div>
          </div>
        </div>

        {/* System accuracy bar */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground">System Accuracy</span>
            <span className={`font-bold ${sysColor}`}>{data.systemAccuracy}%</span>
          </div>
          <Progress value={data.systemAccuracy} className="h-2" />
        </div>

        {/* Mismatch reason categories */}
        {data.mismatchCategories.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2">Mismatch Root Causes</div>
            <div className="space-y-1.5">
              {data.mismatchCategories.map((cat) => (
                <div key={cat.key} className="flex items-center justify-between text-sm bg-muted/30 rounded px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    {cat.isMarketDriven ? (
                      <TrendingDown className="h-3.5 w-3.5 text-yellow-500" />
                    ) : cat.severity === "high" ? (
                      <XCircle className="h-3.5 w-3.5 text-destructive" />
                    ) : cat.severity === "medium" ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
                    ) : (
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <span>{cat.label}</span>
                    {cat.isMarketDriven && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0">Market</Badge>
                    )}
                  </div>
                  <Badge
                    variant={cat.isMarketDriven ? "outline" : cat.severity === "high" ? "destructive" : "outline"}
                    className="text-xs"
                  >
                    {cat.count}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Delta ranges */}
        {data.mismatch > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2">Mismatch Size Distribution</div>
            <div className="grid grid-cols-4 gap-2 text-center">
              {data.deltaRanges.map((range) => (
                <div key={range.label} className="rounded border p-2">
                  <div className="text-lg font-bold">{range.count}</div>
                  <div className="text-[10px] text-muted-foreground">{range.label}</div>
                  <div className="text-[10px] text-muted-foreground">{range.pct}%</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Failed breakdown */}
        {data.failedBreakdown.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2">Failed Breakdown</div>
            <div className="space-y-1">
              {data.failedBreakdown.map((f, i) => {
                const cfg = getMarketplaceConfig(f.marketplace);
                return (
                  <div key={i} className="flex items-center justify-between text-xs bg-muted/20 rounded px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <XCircle className="h-3.5 w-3.5 text-destructive" />
                      <span className="text-[10px]">{cfg.flag}</span>
                      <span className="truncate max-w-[200px]">{f.reason}</span>
                    </div>
                    <Badge variant="destructive" className="text-xs">{f.count}</Badge>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {data.topMismatches.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Largest Mismatches (by native currency)
            </div>
            <div className="space-y-1">
              {data.topMismatches.map((m, i) => {
                const cfg = getMarketplaceConfig(m.marketplace);
                return (
                  <div key={i} className="flex items-center justify-between text-xs bg-muted/20 rounded px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px]">{cfg.flag}</span>
                      <span className="font-mono">{m.asin}</span>
                      {m.isMarketDriven && (
                        <TrendingDown className="h-3 w-3 text-yellow-500 shrink-0" />
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>{formatPrice(m.intended, m.marketplace)} → {formatPrice(m.live, m.marketplace)}</span>
                      <Badge
                        variant={m.isMarketDriven ? "outline" : m.pctDelta > 5 ? "destructive" : "outline"}
                        className="text-[10px]"
                      >
                        {m.pctDelta.toFixed(1)}%
                      </Badge>
                      <span className="text-[9px] text-muted-foreground">{cfg.currency}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Extraction Success Rate */}
        {data.extractionStats.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2">Price Extraction Success Rate</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {data.extractionStats.map((s) => {
                const cfg = getMarketplaceConfig(s.marketplace);
                const color = s.rate >= 98 ? "text-green-500" : s.rate >= 90 ? "text-yellow-500" : "text-destructive";
                return (
                  <div key={s.marketplace} className="rounded border p-2 text-center">
                    <div className="text-[10px] text-muted-foreground mb-0.5">{cfg.flag} {s.marketplace}</div>
                    <div className={`text-lg font-bold ${color}`}>{s.rate}%</div>
                    <div className="text-[10px] text-muted-foreground">{s.succeeded}/{s.total}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Legacy Backlog Progress */}
        {(data.legacyBacklog.noRootCause > 0 || data.legacyBacklog.rechecking > 0) && (
          <div className="rounded-lg border border-dashed p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">Legacy Backlog Cleanup</div>
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              <div>
                <div className="text-lg font-bold text-muted-foreground">{data.legacyBacklog.total}</div>
                <div className="text-muted-foreground">Total Mismatches</div>
              </div>
              <div>
                <div className="text-lg font-bold text-yellow-500">{data.legacyBacklog.noRootCause}</div>
                <div className="text-muted-foreground">No Root Cause</div>
              </div>
              <div>
                <div className="text-lg font-bold text-blue-500">{data.legacyBacklog.rechecking}</div>
                <div className="text-muted-foreground">Rechecking</div>
              </div>
              <div>
                <div className="text-lg font-bold text-green-500">
                  {data.legacyBacklog.drainRate > 0 ? `~${data.legacyBacklog.drainRate}/min` : "—"}
                </div>
                <div className="text-muted-foreground">Drain Rate</div>
              </div>
            </div>
            {data.legacyBacklog.etaMinutes !== null && (
              <div className="text-[10px] text-muted-foreground mt-2">
                Est. {data.legacyBacklog.etaMinutes < 60 
                  ? `${data.legacyBacklog.etaMinutes}m` 
                  : `${Math.round(data.legacyBacklog.etaMinutes / 60)}h ${data.legacyBacklog.etaMinutes % 60}m`} to clear backlog
              </div>
            )}
            <div className="text-[10px] text-muted-foreground mt-1">
              Records without root cause were finalized by old code. The recheck pipeline will re-process them.
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
