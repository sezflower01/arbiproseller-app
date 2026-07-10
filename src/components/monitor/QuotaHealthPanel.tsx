import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Activity, AlertTriangle, BarChart3, Zap, Database, Target, CheckCircle, TrendingUp } from "lucide-react";
import type { QuotaHealthData } from "@/hooks/use-monitor-data";

interface Props {
  data: QuotaHealthData;
}

function StatusBadge({ value, thresholds }: { value: number; thresholds: { green: number; yellow: number } }) {
  const color = value <= thresholds.green 
    ? "bg-green-500" 
    : value <= thresholds.yellow 
      ? "bg-yellow-500" 
      : "bg-red-500";
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />;
}

function CoverageBadge({ percent }: { percent: number }) {
  const color = percent >= 90 ? "bg-green-500" : percent >= 70 ? "bg-yellow-500" : "bg-red-500";
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />;
}

export default function QuotaHealthPanel({ data }: Props) {
  const emptyStatus = data.emptySnapshotPercent <= 5 ? "green" : data.emptySnapshotPercent <= 20 ? "yellow" : "red";
  const quotaStatus = data.quotaErrors24h === 0 ? "green" : data.quotaErrors24h <= 5 ? "yellow" : "red";
  const coverageStatus = data.coveragePercent >= 90 ? "green" : data.coveragePercent >= 70 ? "yellow" : "red";
  const uniqueCoverageStatus = data.uniqueCoveragePercent >= 90 ? "green" : data.uniqueCoveragePercent >= 70 ? "yellow" : "red";

  // Classify "not checkable" using same model as EvaluationCoveragePanel
  const noUsListingCount = data.noUsListingCount ?? 0;
  const trueNoRuleCount = data.noRuleCount - noUsListingCount;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Activity className="h-5 w-5 text-primary" />
          Quota & API Health
          <Badge variant="outline" className="ml-auto text-xs">Last 24h</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Assignment Coverage — Dual KPI: Eligible first (operational), Active second (awareness) */}
        <div className="space-y-3">
          {/* Eligible coverage — PRIMARY operational metric */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                <span className="font-medium">Eligible Coverage</span>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-1">Primary</Badge>
                <Badge variant="outline" className="text-[10px] px-1 py-0">w/ rule + enabled</Badge>
              </div>
              <div className="flex items-center gap-2">
                <CoverageBadge percent={data.eligibleCoveragePercent} />
                <span className={`font-bold ${data.eligibleCoveragePercent >= 70 ? "text-green-600" : data.eligibleCoveragePercent >= 50 ? "text-yellow-600" : "text-destructive"}`}>
                  {data.eligibleCoveragePercent}%
                </span>
              </div>
            </div>
            <Progress value={data.eligibleCoveragePercent} className="h-2" />
            <div className="space-y-0.5 text-xs text-muted-foreground">
              <p>
                {data.uniqueEligibleAsinsCheckedToday} / {data.uniqueEligibleAsins} eligible ASINs checked today
              </p>
              <p>
                Raw eligible rows: {data.checkedEligibleToday} / {data.eligibleAssignments}
              </p>
            </div>
          </div>

          {/* Unique ASIN coverage — SECONDARY awareness metric */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium text-muted-foreground">Inventory-Wide Coverage</span>
                <Badge variant="outline" className="text-[10px] px-1 py-0 ml-1">all active ASINs</Badge>
              </div>
              <div className="flex items-center gap-2">
                <CoverageBadge percent={data.uniqueCoveragePercent} />
                <span className={`font-bold ${uniqueCoverageStatus === "red" ? "text-destructive" : uniqueCoverageStatus === "yellow" ? "text-yellow-600" : "text-green-600"}`}>
                  {data.uniqueCoveragePercent}%
                </span>
              </div>
            </div>
            <Progress value={data.uniqueCoveragePercent} className="h-1.5" />
            <div className="space-y-0.5 text-xs text-muted-foreground">
              <p>
                {data.uniqueAsinsChecked} / {data.uniqueActiveAsins} active ASINs checked by SP-API today
              </p>
              <p className="text-[10px]">
                Includes disabled items — lower % is expected. Use Eligible Coverage above for repricer health.
              </p>
            </div>
          </div>

          {/* Non-checkable breakdown — aligned with EvaluationCoveragePanel */}
          {(data.noRuleCount > 0 || data.disabledCount > 0) && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-muted bg-muted/30">
              <AlertTriangle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="text-sm">
                <span className="font-medium text-muted-foreground">
                  {data.activeAssignments - data.eligibleAssignments} Active but Not Checkable
                </span>
                <div className="text-muted-foreground text-xs mt-0.5 space-y-0.5">
                  {noUsListingCount > 0 && <div>• Discovery / orphan intl (no US listing): <strong>{noUsListingCount}</strong></div>}
                  {trueNoRuleCount > 0 && <div>• No rule assigned: <strong>{trueNoRuleCount}</strong></div>}
                  {data.disabledCount > 0 && <div>• Disabled: <strong>{data.disabledCount}</strong></div>}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Evaluation Breakdown - 5 columns */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <Database className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Unique ASINs Checked</span>
            </div>
            <span className="text-xl font-bold text-foreground">{data.uniqueAsinsChecked}</span>
            <span className="text-xs text-muted-foreground ml-1">of {data.uniqueActiveAsins}</span>
          </div>
          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <CheckCircle className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Checked Rows</span>
            </div>
            <span className="text-xl font-bold text-foreground">{data.checkedToday}</span>
            <span className="text-xs text-muted-foreground ml-1">of {data.activeAssignments}</span>
          </div>
          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">ASINs w/ Actions</span>
            </div>
            <span className="text-xl font-bold text-foreground">{data.skusEvaluatedToday}</span>
            <span className="text-xs text-muted-foreground ml-1">today</span>
          </div>
          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Price Changes</span>
            </div>
            <span className="text-xl font-bold text-foreground">{data.skusWithPriceChanges}</span>
            <span className="text-xs text-muted-foreground ml-1">SKUs</span>
          </div>
          <div className="p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-1.5 mb-1">
              <Zap className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Total Actions</span>
            </div>
            <span className="text-xl font-bold text-foreground">{data.totalActions}</span>
            <span className="text-xs text-muted-foreground ml-1">today</span>
          </div>
        </div>

        {/* Empty Snapshots */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Empty Snapshots (no pricing data)</span>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge value={data.emptySnapshotPercent} thresholds={{ green: 5, yellow: 20 }} />
              <span className={`font-bold ${emptyStatus === "red" ? "text-destructive" : emptyStatus === "yellow" ? "text-yellow-600" : "text-green-600"}`}>
                {data.emptySnapshotPercent}%
              </span>
            </div>
          </div>
          <Progress value={100 - data.emptySnapshotPercent} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {data.emptySnapshots} / {data.totalSnapshots} snapshots had no buybox or price data
            {data.cacheFallbackSaves > 0 && (
              <span className="ml-1 text-primary font-medium">
                · {data.cacheFallbackSaves} evaluations saved by cache fallback
              </span>
            )}
          </p>
        </div>

        {/* Quota Errors */}
        <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            <div>
              <span className="text-sm font-medium">Quota/429 Errors</span>
              <p className="text-xs text-muted-foreground">QuotaExceeded or throttle errors</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge value={data.quotaErrors24h} thresholds={{ green: 0, yellow: 5 }} />
            <span className={`text-2xl font-bold ${quotaStatus === "red" ? "text-destructive" : quotaStatus === "yellow" ? "text-yellow-600" : "text-green-600"}`}>
              {data.quotaErrors24h}
            </span>
          </div>
        </div>

        {/* Warnings */}
        {data.eligibleCoveragePercent < 70 && data.uniqueEligibleAsins > 0 && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10">
            <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <span className="font-medium text-yellow-600">Low eligible rotation coverage.</span>
              <p className="text-muted-foreground text-xs mt-0.5">
                Only {data.eligibleCoveragePercent}% of eligible ASINs have been checked today. 
                {data.uniqueEligibleAsins - data.uniqueEligibleAsinsCheckedToday} eligible ASINs are still waiting for evaluation.
              </p>
            </div>
          </div>
        )}
        {data.emptySnapshotPercent > 20 && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-destructive/50 bg-destructive/10">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="text-sm">
              <span className="font-medium text-destructive">High empty snapshot rate detected.</span>
              <p className="text-muted-foreground text-xs mt-0.5">
                {data.emptySnapshotPercent}% of snapshots have no offer data. This means the repricer is making decisions with limited market visibility. 
                Check SP-API throttling and consider reducing batch size or increasing pacing delays.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
