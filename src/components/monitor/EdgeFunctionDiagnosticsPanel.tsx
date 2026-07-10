import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw, Activity, AlertTriangle, CheckCircle2, XCircle, Copy, Target, Zap, ShieldAlert, Database } from "lucide-react";
import { getCallLog, getCallStats, getDiagnosticSummary, type CallLogEntry } from "@/lib/edgeFunctionClient";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";
import { toast } from "sonner";

export default function EdgeFunctionDiagnosticsPanel() {
  const [log, setLog] = useState<CallLogEntry[]>([]);
  const [stats15m, setStats15m] = useState(getCallStats(15));
  const [stats1h, setStats1h] = useState(getCallStats(60));
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setLog(getCallLog(50));
    setStats15m(getCallStats(15));
    setStats1h(getCallStats(60));
  }, [refreshKey]);

  useEffect(() => {
    // Manual-refresh only: panel re-reads on global Monitor "Refresh" click.
    const unsub = onMonitorRefresh(() => setRefreshKey((k) => k + 1));
    return () => unsub();
  }, []);

  const handleCopyDiagnostics = () => {
    const text = getDiagnosticSummary();
    navigator.clipboard.writeText(text);
    toast.success("Diagnostic summary copied to clipboard");
  };

  const categoryColor = (cat: string | null): "default" | "secondary" | "destructive" | "outline" => {
    switch (cat) {
      case "validation_skip": return "secondary";
      case "auth_error": return "destructive";
      case "transient_function_error": return "destructive";
      case "upstream_api_error": return "default";
      case "runtime_error": return "destructive";
      case "data_unavailable": return "secondary";
      default: return "outline";
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-primary" />
          Edge Function Diagnostics
        </h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleCopyDiagnostics}>
            <Copy className="h-3.5 w-3.5 mr-1" />
            Copy Diagnostics
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRefreshKey(k => k + 1)}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Root Cause Summary ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Target className="h-4 w-4" />
            Root Cause Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Dominant Failure (15m)</p>
              <p className="font-medium">
                {stats15m.dominantCategory
                  ? <Badge variant={categoryColor(stats15m.dominantCategory.category)}>{stats15m.dominantCategory.category} ({stats15m.dominantCategory.count})</Badge>
                  : <span className="text-muted-foreground">None</span>}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Dominant Failure (1h)</p>
              <p className="font-medium">
                {stats1h.dominantCategory
                  ? <Badge variant={categoryColor(stats1h.dominantCategory.category)}>{stats1h.dominantCategory.category} ({stats1h.dominantCategory.count})</Badge>
                  : <span className="text-muted-foreground">None</span>}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Top Failing Function</p>
              <p className="font-mono text-xs font-medium">
                {stats1h.topFailingFunction
                  ? `${stats1h.topFailingFunction.name} (${stats1h.topFailingFunction.failures})`
                  : "None"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Top Failing ASIN</p>
              <p className="font-mono text-xs font-medium">
                {stats1h.topFailingAsins[0]
                  ? `${stats1h.topFailingAsins[0].asin} (${stats1h.topFailingAsins[0].count}×)`
                  : "None"}
              </p>
            </div>
          </div>
          {/* Category breakdown percentages */}
          {Object.keys(stats1h.categoryPcts).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(stats1h.categoryPcts).map(([cat, pct]) => (
                <Badge key={cat} variant={categoryColor(cat)} className="text-xs">
                  {cat}: {pct}%
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Summary Cards (15m / 1h) ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[{ label: "Last 15 minutes", stats: stats15m }, { label: "Last 1 hour", stats: stats1h }].map(({ label, stats }) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4" />
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                  {stats.success} OK
                </span>
                <span className="flex items-center gap-1">
                  <XCircle className="h-3.5 w-3.5 text-destructive" />
                  {stats.failed} Failed
                </span>
                <span className="text-muted-foreground">
                  {stats.successRate}% success
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Retry Outcomes ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Retry Outcomes (1h)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-muted-foreground">Recovered by retry:</span>{" "}
              <span className="font-medium text-green-600 dark:text-green-400">{stats1h.retryOutcomes.recovered}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Still failed after retry:</span>{" "}
              <span className="font-medium text-destructive">{stats1h.retryOutcomes.stillFailed}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Retry effectiveness:</span>{" "}
              <span className="font-medium">
                {stats1h.retryOutcomes.recovered + stats1h.retryOutcomes.stillFailed > 0
                  ? `${Math.round((stats1h.retryOutcomes.recovered / (stats1h.retryOutcomes.recovered + stats1h.retryOutcomes.stillFailed)) * 100)}%`
                  : "N/A"}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Function Health Table ── */}
      {stats1h.functionHealth.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              Function Health (1h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Function</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Success %</TableHead>
                  <TableHead>Avg ms</TableHead>
                  <TableHead>p95 ms</TableHead>
                  <TableHead>Failures</TableHead>
                  <TableHead>Last Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats1h.functionHealth.map(f => (
                  <TableRow key={f.name}>
                    <TableCell className="font-mono text-xs">{f.name}</TableCell>
                    <TableCell>{f.total}</TableCell>
                    <TableCell>
                      <Badge variant={f.successRate >= 90 ? "secondary" : f.successRate >= 50 ? "default" : "destructive"} className="text-xs">
                        {f.successRate}%
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{f.avgDuration}</TableCell>
                    <TableCell className="text-xs">{f.p95Duration}</TableCell>
                    <TableCell>
                      {f.failCount > 0 ? <Badge variant="destructive" className="text-xs">{f.failCount}</Badge> : "0"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                      {f.lastError || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* ── Data Quality Blockers ── */}
      {stats1h.dataQualityBlockers.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4" />
              Data Quality Blockers (1h)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ASIN</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Missing Field</TableHead>
                  <TableHead>Blocked ×</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats1h.dataQualityBlockers.map((d, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs">{d.asin}</TableCell>
                    <TableCell className="font-mono text-xs">{d.sku || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs">{d.missingField}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="destructive" className="text-xs">{d.blockedCount}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* ── Top Failing ASINs ── */}
      {stats1h.topFailingAsins.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Top Failing ASINs (1h)</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ASIN</TableHead>
                  <TableHead>Failures</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Last Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats1h.topFailingAsins.map(a => (
                  <TableRow key={a.asin}>
                    <TableCell className="font-mono text-xs">{a.asin}</TableCell>
                    <TableCell>
                      <Badge variant="destructive" className="text-xs">{a.count}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={categoryColor(a.lastCategory)} className="text-xs">{a.lastCategory}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate">
                      {a.lastError}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* ── Last 50 Calls ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Last 50 Edge Function Calls</CardTitle>
        </CardHeader>
        <CardContent>
          {log.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No edge function calls recorded yet. Calls will appear here as they happen.
            </p>
          ) : (
            <div className="max-h-[400px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px]">Time</TableHead>
                    <TableHead>Function</TableHead>
                    <TableHead>ASIN</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Retries</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {log.map(entry => (
                    <TableRow key={entry.id} className={entry.ok ? "" : "bg-destructive/5"}>
                      <TableCell className="text-xs font-mono whitespace-nowrap">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {entry.functionName.replace("repricer-", "r-")}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {entry.asin || "—"}
                      </TableCell>
                      <TableCell>
                        {entry.ok ? (
                          <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 text-xs">
                            {entry.httpStatus}
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="text-xs">
                            {entry.httpStatus || "ERR"}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {entry.errorCategory ? (
                          <Badge variant={categoryColor(entry.errorCategory)} className="text-xs">
                            {entry.errorCategory}
                          </Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-center">
                        {entry.retryCount > 0 ? (
                          <span className={entry.recoveredByRetry ? "text-green-600 dark:text-green-400" : "text-destructive"}>
                            {entry.retryCount}{entry.recoveredByRetry ? "✓" : "✗"}
                          </span>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {entry.durationMs}ms
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                        {entry.errorMessage || "OK"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
