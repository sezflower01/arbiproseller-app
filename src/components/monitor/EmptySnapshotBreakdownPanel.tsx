import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Database, RefreshCw, Loader2, AlertTriangle, Lightbulb, TrendingDown, ShieldCheck, Clock, BarChart3 } from "lucide-react";
import { useEmptySnapshotBreakdown } from "@/hooks/use-coverage-breakdown";
import { useFallbackAnalysis } from "@/hooks/use-fallback-analysis";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function EmptySnapshotBreakdownPanel() {
  const data = useEmptySnapshotBreakdown();
  const fb = useFallbackAnalysis();

  if (data.loading && fb.loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const emptyPct = data.totalSnapshots > 0 ? Math.round((data.totalEmpty / data.totalSnapshots) * 100) : 0;
  const recoveryPct = data.totalEmpty > 0 ? Math.round((data.recoveredCount / data.totalEmpty) * 100) : 0;
  const persistentCount = data.persistentEmptyCount;

  // Generate recommendations
  const recommendations: { icon: React.ReactNode; text: string; severity: "critical" | "warning" | "info" }[] = [];

  if (emptyPct > 20) {
    recommendations.push({
      icon: <AlertTriangle className="h-4 w-4 text-destructive" />,
      text: `${emptyPct}% empty snapshots is high. Many ASINs are being checked but returning no market data, wasting SP-API quota.`,
      severity: "critical",
    });
  }

  if (persistentCount > 5) {
    recommendations.push({
      icon: <TrendingDown className="h-4 w-4 text-yellow-600" />,
      text: `${persistentCount} ASINs are persistently empty (never recovered). Consider deprioritizing them to COLD lane or skipping them to save quota.`,
      severity: "warning",
    });
  }

  if (recoveryPct > 60) {
    recommendations.push({
      icon: <Lightbulb className="h-4 w-4 text-green-600" />,
      text: `${recoveryPct}% of empty-snapshot ASINs later recovered on retry — delayed rechecks are effective.`,
      severity: "info",
    });
  } else if (data.totalEmpty > 10 && recoveryPct < 30) {
    recommendations.push({
      icon: <AlertTriangle className="h-4 w-4 text-yellow-600" />,
      text: `Only ${recoveryPct}% of empty snapshots recover on retry. Consider using last-known-good market state for evaluation.`,
      severity: "warning",
    });
  }

  // Check marketplace-specific issues
  const intlHighEmpty = data.byMarketplace.filter(m => m.marketplace !== "US" && m.pct > 40 && m.total > 5);
  if (intlHighEmpty.length > 0) {
    recommendations.push({
      icon: <AlertTriangle className="h-4 w-4 text-destructive" />,
      text: `International markets (${intlHighEmpty.map(m => m.marketplace).join(", ")}) have very high empty rates (${intlHighEmpty.map(m => `${m.pct}%`).join(", ")}). Verify SP-API marketplace routing.`,
      severity: "critical",
    });
  }

  // Fallback safety recommendation
  if (fb.safetyBreakdown.aggressive > 0 && fb.fallbackEvalCount > 0) {
    const aggPct = Math.round((fb.safetyBreakdown.aggressive / fb.fallbackEvalCount) * 100);
    if (aggPct > 20) {
      recommendations.push({
        icon: <AlertTriangle className="h-4 w-4 text-yellow-600" />,
        text: `${aggPct}% of fallback-based evaluations resulted in aggressive price moves. Consider tightening fallback constraints to be more conservative.`,
        severity: "warning",
      });
    }
  }

  const totalEvals = fb.liveEvalCount + fb.fallbackEvalCount + fb.skippedCount;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Database className="h-5 w-5 text-primary" />
          Empty Snapshot Analysis
          <Badge variant="outline" className="ml-auto text-xs">Last 24h</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="p-3 rounded-lg border bg-muted/30 text-center">
            <div className={`text-2xl font-bold ${emptyPct > 20 ? "text-destructive" : emptyPct > 10 ? "text-yellow-600" : "text-green-600"}`}>
              {emptyPct}%
            </div>
            <div className="text-xs text-muted-foreground">Empty Rate</div>
            <div className="text-xs text-muted-foreground">{data.totalEmpty} / {data.totalSnapshots}</div>
          </div>
          <div className="p-3 rounded-lg border bg-muted/30 text-center">
            <div className={`text-2xl font-bold ${recoveryPct > 50 ? "text-green-600" : "text-yellow-600"}`}>
              {recoveryPct}%
            </div>
            <div className="text-xs text-muted-foreground">Recovery Rate</div>
            <div className="text-xs text-muted-foreground">{data.recoveredCount} recovered</div>
          </div>
          <div className="p-3 rounded-lg border bg-muted/30 text-center">
            <div className={`text-2xl font-bold ${persistentCount > 10 ? "text-destructive" : persistentCount > 3 ? "text-yellow-600" : "text-green-600"}`}>
              {persistentCount}
            </div>
            <div className="text-xs text-muted-foreground">Persistent Empty</div>
            <div className="text-xs text-muted-foreground">Never recovered</div>
          </div>
          <div className="p-3 rounded-lg border bg-muted/30 text-center">
            <div className="text-2xl font-bold text-primary">
              {fb.fallbackEvalCount}
            </div>
            <div className="text-xs text-muted-foreground">LKG Fallback Evals</div>
            <div className="text-xs text-muted-foreground">
              {totalEvals > 0 ? Math.round((fb.fallbackEvalCount / totalEvals) * 100) : 0}% of total
            </div>
          </div>
        </div>

        {/* Recommendations */}
        {recommendations.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-1.5">
              <Lightbulb className="h-4 w-4" />
              Recommendations
            </h4>
            {recommendations.map((rec, i) => (
              <div key={i} className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
                rec.severity === "critical" ? "border-destructive/30 bg-destructive/5" :
                rec.severity === "warning" ? "border-yellow-500/30 bg-yellow-50/50 dark:bg-yellow-950/20" :
                "border-green-500/30 bg-green-50/50 dark:bg-green-950/20"
              }`}>
                {rec.icon}
                <span>{rec.text}</span>
              </div>
            ))}
          </div>
        )}

        <Tabs defaultValue="breakdown" className="w-full">
          <TabsList className="w-full grid grid-cols-4">
            <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
            <TabsTrigger value="recovery">Recovery</TabsTrigger>
            <TabsTrigger value="fallback">Fallback</TabsTrigger>
            <TabsTrigger value="safety">Safety</TabsTrigger>
          </TabsList>

          {/* === TAB 1: Breakdown (existing content) === */}
          <TabsContent value="breakdown" className="space-y-4">
            {/* By Source */}
            {data.bySource.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">By Source / Path</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Empty</TableHead>
                      <TableHead className="text-right">Empty %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.bySource.map(r => (
                      <TableRow key={r.source}>
                        <TableCell className="font-mono text-xs">{r.source}</TableCell>
                        <TableCell className="text-right">{r.total}</TableCell>
                        <TableCell className="text-right">{r.empty}</TableCell>
                        <TableCell className={`text-right font-bold ${r.pct > 30 ? "text-destructive" : r.pct > 15 ? "text-yellow-600" : "text-green-600"}`}>
                          {r.pct}%
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* By Marketplace */}
            {data.byMarketplace.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">By Marketplace</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Marketplace</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Empty</TableHead>
                      <TableHead className="text-right">Empty %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byMarketplace.map(r => (
                      <TableRow key={r.marketplace}>
                        <TableCell>{r.marketplace}</TableCell>
                        <TableCell className="text-right">{r.total}</TableCell>
                        <TableCell className="text-right">{r.empty}</TableCell>
                        <TableCell className={`text-right font-bold ${r.pct > 30 ? "text-destructive" : r.pct > 15 ? "text-yellow-600" : "text-green-600"}`}>
                          {r.pct}%
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Top Empty ASINs */}
            {data.topEmptyAsins.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Top ASINs with Empty Snapshots</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ASIN</TableHead>
                      <TableHead className="text-right">Empty</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Empty %</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.topEmptyAsins.map(r => {
                      const pct = Math.round((r.emptyCount / r.totalCount) * 100);
                      const isPersistent = r.emptyCount === r.totalCount;
                      return (
                        <TableRow key={r.asin}>
                          <TableCell className="font-mono text-xs">{r.asin}</TableCell>
                          <TableCell className="text-right">{r.emptyCount}</TableCell>
                          <TableCell className="text-right">{r.totalCount}</TableCell>
                          <TableCell className={`text-right font-bold ${pct > 50 ? "text-destructive" : "text-yellow-600"}`}>
                            {pct}%
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge variant={isPersistent ? "destructive" : "outline"} className="text-xs">
                              {isPersistent ? "Persistent" : "Intermittent"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* === TAB 2: Recovery by Marketplace === */}
          <TabsContent value="recovery" className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              <div className="text-sm">
                <span className="font-medium">{data.recoveredCount}</span>
                <span className="text-muted-foreground"> of {data.totalEmpty} empty-snapshot ASINs later succeeded on a subsequent fetch</span>
              </div>
            </div>

            {fb.marketplaceRecovery.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Recovery Rate by Marketplace</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Marketplace</TableHead>
                      <TableHead className="text-right">Empty ASINs</TableHead>
                      <TableHead className="text-right">Recovered</TableHead>
                      <TableHead className="text-right">Persistent</TableHead>
                      <TableHead className="text-right">Recovery %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fb.marketplaceRecovery.map(r => (
                      <TableRow key={r.marketplace}>
                        <TableCell>{r.marketplace}</TableCell>
                        <TableCell className="text-right">{r.totalEmpty}</TableCell>
                        <TableCell className="text-right text-green-600 font-medium">{r.recovered}</TableCell>
                        <TableCell className="text-right">
                          <span className={r.persistent > 0 ? "text-destructive font-medium" : "text-muted-foreground"}>
                            {r.persistent}
                          </span>
                        </TableCell>
                        <TableCell className={`text-right font-bold ${r.recoveryPct > 50 ? "text-green-600" : r.recoveryPct > 25 ? "text-yellow-600" : "text-destructive"}`}>
                          {r.recoveryPct}%
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Persistent vs Intermittent by Marketplace */}
            {fb.persistentByMarketplace.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Persistent vs Intermittent by Marketplace</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {fb.persistentByMarketplace.map(m => (
                    <div key={m.marketplace} className="p-3 rounded-lg border bg-muted/30">
                      <div className="text-sm font-medium mb-1">{m.marketplace}</div>
                      <div className="flex justify-between text-xs">
                        <span className="text-destructive">Persistent: {m.persistent}</span>
                        <span className="text-green-600">Intermittent: {m.intermittent}</span>
                      </div>
                      {(m.persistent + m.intermittent) > 0 && (
                        <div className="mt-1.5 h-2 rounded-full bg-muted overflow-hidden flex">
                          <div
                            className="h-full bg-destructive/70"
                            style={{ width: `${Math.round((m.persistent / (m.persistent + m.intermittent)) * 100)}%` }}
                          />
                          <div
                            className="h-full bg-green-500/70"
                            style={{ width: `${Math.round((m.intermittent / (m.persistent + m.intermittent)) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          {/* === TAB 3: Fallback Usage === */}
          <TabsContent value="fallback" className="space-y-4">
            {/* Outcome comparison */}
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                <BarChart3 className="h-4 w-4" />
                Outcome Comparison
              </h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data Source</TableHead>
                    <TableHead className="text-right">Total Evals</TableHead>
                    <TableHead className="text-right">Actions Taken</TableHead>
                    <TableHead className="text-right">Action Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fb.outcomes.map(o => (
                    <TableRow key={o.source}>
                      <TableCell className="capitalize font-medium">
                        {o.source === "live" ? "🟢 Live Snapshot" : o.source === "fallback" ? "🟡 LKG Fallback" : "⚪ Skipped"}
                      </TableCell>
                      <TableCell className="text-right">{o.total}</TableCell>
                      <TableCell className="text-right">{o.actioned}</TableCell>
                      <TableCell className={`text-right font-bold ${o.actionRate > 30 ? "text-green-600" : o.actionRate > 10 ? "text-yellow-600" : "text-muted-foreground"}`}>
                        {o.actionRate}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Fallback age distribution */}
            {fb.ageBuckets.length > 0 && fb.fallbackEvalCount > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                  <Clock className="h-4 w-4" />
                  Fallback Age Distribution
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {fb.ageBuckets.map(b => (
                    <div key={b.label} className="p-3 rounded-lg border bg-muted/30 text-center">
                      <div className={`text-xl font-bold ${b.pct > 40 ? "text-primary" : "text-muted-foreground"}`}>
                        {b.count}
                      </div>
                      <div className="text-xs text-muted-foreground">{b.label}</div>
                      <div className="text-xs text-muted-foreground">{b.pct}%</div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Shows how old the cached snapshot was when used as fallback. Lower age = more reliable pricing decisions.
                </p>
              </div>
            )}
          </TabsContent>

          {/* === TAB 4: Safety Indicator === */}
          <TabsContent value="safety" className="space-y-4">
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4" />
                Fallback Decision Safety
              </h4>
              {fb.fallbackEvalCount > 0 ? (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-4 rounded-lg border bg-green-50/50 dark:bg-green-950/20 border-green-500/30 text-center">
                      <div className="text-2xl font-bold text-green-600">{fb.safetyBreakdown.conservative}</div>
                      <div className="text-xs text-muted-foreground mt-1">Conservative</div>
                      <div className="text-xs text-green-600">Price lowered / held</div>
                    </div>
                    <div className="p-4 rounded-lg border bg-muted/30 text-center">
                      <div className="text-2xl font-bold text-muted-foreground">{fb.safetyBreakdown.neutral}</div>
                      <div className="text-xs text-muted-foreground mt-1">Neutral</div>
                      <div className="text-xs text-muted-foreground">No direction signal</div>
                    </div>
                    <div className="p-4 rounded-lg border bg-yellow-50/50 dark:bg-yellow-950/20 border-yellow-500/30 text-center">
                      <div className="text-2xl font-bold text-yellow-600">{fb.safetyBreakdown.aggressive}</div>
                      <div className="text-xs text-muted-foreground mt-1">Aggressive</div>
                      <div className="text-xs text-yellow-600">Price raised on stale data</div>
                    </div>
                  </div>
                  {fb.fallbackEvalCount > 0 && (
                    <div className="mt-3 h-3 rounded-full bg-muted overflow-hidden flex">
                      <div
                        className="h-full bg-green-500"
                        style={{ width: `${Math.round((fb.safetyBreakdown.conservative / fb.fallbackEvalCount) * 100)}%` }}
                      />
                      <div
                        className="h-full bg-muted-foreground/30"
                        style={{ width: `${Math.round((fb.safetyBreakdown.neutral / fb.fallbackEvalCount) * 100)}%` }}
                      />
                      <div
                        className="h-full bg-yellow-500"
                        style={{ width: `${Math.round((fb.safetyBreakdown.aggressive / fb.fallbackEvalCount) * 100)}%` }}
                      />
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    Tracks whether fallback-based evaluations resulted in conservative (safe), neutral, or aggressive (risky) price moves. High aggressive % on stale data is a warning sign.
                  </p>
                </>
              ) : (
                <div className="p-4 rounded-lg border bg-muted/30 text-center text-sm text-muted-foreground">
                  No fallback evaluations detected today. All evaluations used live snapshots.
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
