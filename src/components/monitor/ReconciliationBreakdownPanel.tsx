import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Scale, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  RECONCILIATION_ROUNDING_TOLERANCE,
  getEffectiveReconciliationStatus,
  getReconciliationIntendedPrice,
  getReconciliationWindowStartIso,
  summarizeReconciliation,
  isDisplayableReconciliationMismatch,
} from "@/lib/reconciliationMetrics";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

interface MismatchRow {
  asin: string;
  sku: string;
  marketplace: string;
  intended: number;
  live: number;
  delta: number;
  absDelta: number;
  updateMethod: string;
  createdAt: string;
}

interface MarketplaceSummary {
  marketplace: string;
  matched: number;
  mismatched: number;
  failed: number;
  total: number;
  matchRate: number;
}

interface SizeBucket {
  label: string;
  count: number;
}

export default function ReconciliationBreakdownPanel() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [mktSummaries, setMktSummaries] = useState<MarketplaceSummary[]>([]);
  const [sizeBuckets, setSizeBuckets] = useState<SizeBucket[]>([]);
  const [topMismatches, setTopMismatches] = useState<MismatchRow[]>([]);
  const [totals, setTotals] = useState({ matched: 0, mismatched: 0, failed: 0, timedOut: 0, recheck: 0 });

  const fetchData = async () => {
    if (!user) return;
    setLoading(true);

    const reconciliationWindowStart = getReconciliationWindowStartIso();

    try {
      const { data: actions } = await supabase
        .from("repricer_price_actions")
        .select("asin, sku, marketplace, new_price, intended_price, reconciliation_status, reconciliation_reason, verified_live_price, update_method, created_at")
        .eq("user_id", user.id)
        .in("action_type", ["price_change", "price_and_minmax_change"])
        .eq("success", true)
        .gte("created_at", reconciliationWindowStart)
        .not("reconciliation_status", "is", null);

      const rows = actions || [];
      const summary = summarizeReconciliation(rows as any[]);
      setTotals({
        matched: summary.matched,
        mismatched: summary.mismatch,
        failed: summary.failed,
        timedOut: summary.pendingTimeout,
        recheck: summary.recheck ?? 0,
      });

      // Marketplace summary
      const mktMap = new Map<string, { matched: number; mismatched: number; failed: number }>();
      for (const r of rows) {
        const mkt = r.marketplace || "US";
        if (!mktMap.has(mkt)) mktMap.set(mkt, { matched: 0, mismatched: 0, failed: 0 });
        const entry = mktMap.get(mkt)!;
        const effectiveStatus = getEffectiveReconciliationStatus(r as any);
        if (effectiveStatus === "matched") entry.matched++;
        else if (effectiveStatus === "mismatch") entry.mismatched++;
        else if (effectiveStatus === "failed") entry.failed++;
      }
      const summaries: MarketplaceSummary[] = [...mktMap.entries()].map(([mkt, s]) => {
        const total = s.matched + s.mismatched + s.failed;
        return {
          marketplace: mkt,
          ...s,
          total,
          matchRate: total > 0 ? Math.round((s.matched / total) * 100) : 100,
        };
      }).sort((a, b) => b.total - a.total);
      setMktSummaries(summaries);

      // Size buckets for effective mismatches only
      const mismatches = rows.filter(r => isDisplayableReconciliationMismatch(r as any));
      const buckets = { tiny: 0, small: 0, medium: 0, large: 0, huge: 0 };
      const mismatchRows: MismatchRow[] = [];

      for (const r of mismatches) {
        const intended = getReconciliationIntendedPrice(r as any) ?? 0;
        const live = Number(r.verified_live_price || 0);
        const delta = live - intended;
        const absDelta = Math.abs(delta);

        if (absDelta < RECONCILIATION_ROUNDING_TOLERANCE) buckets.tiny++;
        else if (absDelta < 0.50) buckets.small++;
        else if (absDelta < 2.00) buckets.medium++;
        else if (absDelta < 10.00) buckets.large++;
        else buckets.huge++;

        mismatchRows.push({
          asin: r.asin,
          sku: r.sku || "—",
          marketplace: r.marketplace || "US",
          intended,
          live,
          delta,
          absDelta,
          updateMethod: r.update_method || "—",
          createdAt: r.created_at,
        });
      }

      setSizeBuckets([
        { label: "< $0.15 (tolerance)", count: buckets.tiny },
        { label: "$0.15 – $0.50", count: buckets.small },
        { label: "$0.50 – $2.00", count: buckets.medium },
        { label: "$2.00 – $10.00", count: buckets.large },
        { label: "> $10.00 (suspicious)", count: buckets.huge },
      ]);

      // Top mismatches sorted by absolute delta
      setTopMismatches(mismatchRows.sort((a, b) => b.absDelta - a.absDelta).slice(0, 10));
    } catch (err) {
      console.error("Reconciliation breakdown error:", err);
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

  // Match rate: only verified (matched + mismatch). Failed = couldn't verify, not wrong.
  const verifiedTotal = totals.matched + totals.mismatched;
  const totalReconciled = totals.matched + totals.mismatched + totals.failed;
  const overallMatchRate = verifiedTotal > 0 ? Math.round((totals.matched / verifiedTotal) * 100) : 100;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Scale className="h-5 w-5 text-primary" />
          Post-Apply Reconciliation
          <Badge variant="outline" className="text-xs">{overallMatchRate}% match rate</Badge>
        </CardTitle>
        <Button variant="outline" size="sm" onClick={fetchData}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary stats */}
        <p className="text-xs text-muted-foreground">
          Rolling 24h window • {totalReconciled} reconciled actions • Only newly written actions are scored
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 rounded-lg border bg-green-500/10">
            <span className="text-xs text-muted-foreground">Matched</span>
            <div className="text-xl font-bold text-green-600">{totals.matched}</div>
          </div>
          <div className="p-3 rounded-lg border bg-yellow-500/10">
            <span className="text-xs text-muted-foreground">Mismatch</span>
            <div className="text-xl font-bold text-yellow-600">{totals.mismatched}</div>
          </div>
          <div className="p-3 rounded-lg border bg-red-500/10">
            <span className="text-xs text-muted-foreground">Failed</span>
            <div className="text-xl font-bold text-destructive">{totals.failed}</div>
          </div>
          <div className="p-3 rounded-lg border bg-muted/30">
            <span className="text-xs text-muted-foreground">Timed Out</span>
            <div className="text-xl font-bold text-muted-foreground">{totals.timedOut}</div>
          </div>
        </div>

        {/* By marketplace */}
        {mktSummaries.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">By Marketplace</h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Region</TableHead>
                  <TableHead className="text-right">Matched</TableHead>
                  <TableHead className="text-right">Mismatch</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Match %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mktSummaries.map(s => (
                  <TableRow key={s.marketplace}>
                    <TableCell className="font-medium">{s.marketplace}</TableCell>
                    <TableCell className="text-right">{s.matched}</TableCell>
                    <TableCell className="text-right">{s.mismatched > 0 ? <span className="text-yellow-600 font-bold">{s.mismatched}</span> : "0"}</TableCell>
                    <TableCell className="text-right">{s.failed > 0 ? <span className="text-destructive font-bold">{s.failed}</span> : "0"}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={s.matchRate >= 90 ? "outline" : "destructive"} className="text-xs">
                        {s.matchRate}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Mismatch size distribution */}
        {totals.mismatched > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Mismatch Size Distribution</h4>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {sizeBuckets.map(b => (
                <div key={b.label} className="p-2 rounded border bg-muted/30 text-center">
                  <div className="text-lg font-bold text-foreground">{b.count}</div>
                  <div className="text-[10px] text-muted-foreground">{b.label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Top mismatches */}
        {topMismatches.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Largest Mismatches</h4>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ASIN</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead className="text-right">Intended</TableHead>
                    <TableHead className="text-right">Live</TableHead>
                    <TableHead className="text-right">Delta</TableHead>
                    <TableHead>Method</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topMismatches.map((m, i) => (
                    <TableRow key={`${m.asin}-${i}`}>
                      <TableCell className="font-mono text-xs">{m.asin}</TableCell>
                      <TableCell>{m.marketplace}</TableCell>
                      <TableCell className="text-right">${m.intended.toFixed(2)}</TableCell>
                      <TableCell className="text-right">${m.live.toFixed(2)}</TableCell>
                      <TableCell className="text-right">
                        <span className={m.absDelta > 2 ? "text-destructive font-bold" : "text-yellow-600"}>
                          {m.delta > 0 ? "+" : ""}{m.delta.toFixed(2)}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">{m.updateMethod}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
