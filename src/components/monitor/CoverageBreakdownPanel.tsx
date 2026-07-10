import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Clock, BarChart3, AlertTriangle, Loader2 } from "lucide-react";
import { useCoverageBreakdown } from "@/hooks/use-coverage-breakdown";

export default function CoverageBreakdownPanel() {
  const data = useCoverageBreakdown();

  if (data.loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const pct = (n: number) => data.totalActive > 0 ? Math.round((n / data.totalActive) * 100) : 0;
  const buckets = [
    { label: "Last 15m", value: data.checkedLast15m, pct: pct(data.checkedLast15m) },
    { label: "Last 1h", value: data.checkedLast1h, pct: pct(data.checkedLast1h) },
    { label: "Last 4h", value: data.checkedLast4h, pct: pct(data.checkedLast4h) },
    { label: "Last 24h", value: data.checkedLast24h, pct: pct(data.checkedLast24h) },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Clock className="h-5 w-5 text-primary" />
          Coverage Breakdown
          <Badge variant="outline" className="ml-auto text-xs">{data.totalActive} <span className="text-[10px]">active ASINs</span></Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Time-bucketed coverage */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {buckets.map(b => (
            <div key={b.label} className="p-3 rounded-lg border bg-muted/30">
              <span className="text-xs text-muted-foreground">{b.label}</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-xl font-bold text-foreground">{b.value}</span>
                <span className="text-xs text-muted-foreground">({b.pct}%)</span>
              </div>
              <Progress value={b.pct} className="h-1.5 mt-1" />
            </div>
          ))}
        </div>

        {/* Key metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="p-3 rounded-lg border bg-muted/30">
            <span className="text-xs text-muted-foreground">Never Checked Today</span>
            <div className="flex items-baseline gap-1 mt-1">
              <span className={`text-xl font-bold ${data.neverCheckedToday > data.totalActive * 0.5 ? "text-destructive" : "text-foreground"}`}>
                {data.neverCheckedToday}
              </span>
              <span className="text-xs text-muted-foreground">SKUs</span>
            </div>
          </div>
          <div className="p-3 rounded-lg border bg-muted/30">
            <span className="text-xs text-muted-foreground">Repeatedly Checked</span>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-xl font-bold text-foreground">{data.repeatedlyChecked}</span>
              <span className="text-xs text-muted-foreground">SKUs 2+×</span>
            </div>
          </div>
          {data.avgMinutesBetweenChecks !== null && (
            <div className="p-3 rounded-lg border bg-muted/30">
              <span className="text-xs text-muted-foreground">Avg Check Interval</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-xl font-bold text-foreground">~{data.avgMinutesBetweenChecks}</span>
                <span className="text-xs text-muted-foreground">min</span>
              </div>
            </div>
          )}
        </div>

        {/* Fairness warning */}
        {data.repeatedlyChecked > 0 && data.neverCheckedToday > data.totalActive * 0.3 && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10">
            <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <span className="font-medium text-yellow-600">Rotation imbalance detected.</span>
              <p className="text-muted-foreground text-xs mt-0.5">
                {data.repeatedlyChecked} SKUs have been checked multiple times while {data.neverCheckedToday} SKUs haven't been checked at all today. 
                HOT-tier items may be consuming too much of the SP-API budget.
              </p>
            </div>
          </div>
        )}

        {/* Top re-checked ASINs */}
        {data.topRechecked.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              Top Re-Checked ASINs (potential budget hogs)
            </h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ASIN</TableHead>
                  <TableHead className="text-right">Checks Today</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topRechecked.slice(0, 5).map(r => (
                  <TableRow key={r.asin}>
                    <TableCell className="font-mono text-xs">{r.asin}</TableCell>
                    <TableCell className="text-right font-bold">{r.checkCount}×</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
