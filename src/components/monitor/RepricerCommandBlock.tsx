import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Heart, Zap, BarChart3, Shield, Activity, AlertTriangle, Ban,
  CheckCircle, Target, Send, Globe, Search,
} from "lucide-react";
import type { MonitorData } from "@/hooks/use-monitor-data";
import type { BlockerBuckets } from "./MonitorCommandBar";
import type { HotStaleAsin } from "./EligibleFreshnessPanel";

interface HotBlockedBreakdown {
  throttled: number;
  noData: number;
  dailyCap: number;
  inactive: number;
  bbOwnerStable: number;
  floorHeld: number;
  rotatingBb: number;
  noGap: number;
  other: number;
}

export interface FreshnessMetrics {
  hotP50: number;
  hotP90: number;
  hotCount: number;
  warmP50: number;
  warmCount: number;
  hotSlaBreachCount: number;
  hotEvaluatedButBlockedCount: number;
  hotTrulyStalCount: number;
  hotDispatchableP90: number;
  hotDispatchableP50: number;
  hotDispatchableCount: number;
  hotBlockedCount: number;
  hotBlockedBreakdown: HotBlockedBreakdown;
  hotStaleAsins: HotStaleAsin[];
}

interface Props {
  data: MonitorData;
  freshnessData?: FreshnessMetrics;
  stalledCount: number;
  missingMinCount: number;
  writes24h: number;
  blockerBuckets: BlockerBuckets;
}

type SectionStatus = "green" | "amber" | "red";

function statusBorder(s: SectionStatus) {
  return s === "green" ? "border-green-500/30" : s === "amber" ? "border-amber-500/30" : "border-destructive/30";
}
function statusBg(s: SectionStatus) {
  return s === "green" ? "bg-green-500/5" : s === "amber" ? "bg-amber-500/5" : "bg-destructive/5";
}
function statusDot(s: SectionStatus) {
  return s === "green" ? "bg-green-500" : s === "amber" ? "bg-amber-500" : "bg-destructive";
}
function statusText(s: SectionStatus) {
  return s === "green" ? "text-green-600 dark:text-green-400" : s === "amber" ? "text-amber-600 dark:text-amber-400" : "text-destructive";
}

function Metric({ label, value, sub, warn }: { label: string; value: string | number; sub?: string; warn?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className={`text-lg font-bold ${warn ? "text-destructive" : "text-foreground"}`}>{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function SectionTitle({ icon, title, status }: { icon: React.ReactNode; title: string; status: SectionStatus }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
      <span className={`w-2 h-2 rounded-full ${statusDot(status)}`} />
      <span className={`text-[10px] font-medium ${statusText(status)}`}>
        {status === "green" ? "Good" : status === "amber" ? "Watch" : "Alert"}
      </span>
    </div>
  );
}

export default function RepricerCommandBlock({ data, freshnessData, stalledCount, missingMinCount, writes24h, blockerBuckets }: Props) {
  const q = data.quotaHealth;

  // === System Status ===
  const systemOperational = writes24h > 50;
  const systemStatus: SectionStatus = data.schedulerHealthy
    ? (q.quotaErrors24h > 5 ? "amber" : "green")
    : systemOperational ? "amber" : "red";
  const systemLabel = data.schedulerHealthy
    ? (q.quotaErrors24h > 5 ? "Caution" : "Healthy")
    : systemOperational ? "Operational" : "Degraded";

  const eligibleCovPct = q.eligibleAssignments > 0
    ? Math.round((q.checkedEligibleToday / q.eligibleAssignments) * 100) : 0;

  // === HOT Reality ===
  const hotTotal = freshnessData?.hotCount ?? 0;
  const hotDisp = freshnessData?.hotDispatchableCount ?? hotTotal;
  const hotBlocked = freshnessData?.hotBlockedCount ?? 0;
  const hotDispP90 = freshnessData?.hotDispatchableP90 ?? freshnessData?.hotP90 ?? 0;
  const hotDispP50 = freshnessData?.hotDispatchableP50 ?? freshnessData?.hotP50 ?? 0;
  const trulyStal = freshnessData?.hotTrulyStalCount ?? 0;
  const bb = freshnessData?.hotBlockedBreakdown;
  const hotStatus: SectionStatus = hotDispP90 <= 30 ? "green" : trulyStal > 0 ? (hotDispP90 > 120 ? "red" : "amber") : "amber";

  // === Throughput ===
  const writesStatus: SectionStatus = writes24h > 0 ? "green" : q.totalActions > 0 ? "amber" : "red";

  // === Data Health ===
  const emptyPct = q.emptySnapshotPercent;
  const dataStatus: SectionStatus = emptyPct <= 5 ? "green" : emptyPct <= 20 ? "amber" : "red";

  // === Constraints ===
  const constraintEntries = [
    { label: "Min Floor", count: blockerBuckets.minFloor, icon: "🛡️" },
    { label: "Profit Guard", count: blockerBuckets.profitGuard, icon: "💰" },
    { label: "BB Owner Hold", count: blockerBuckets.bbOwnerHold, icon: "📊" },
    { label: "No Competitors", count: blockerBuckets.noCompetitors, icon: "👁" },
    { label: "Cooldown", count: blockerBuckets.cooldown, icon: "⏳" },
    { label: "Delta Too Small", count: blockerBuckets.deltaTooSmall, icon: "📏" },
  ].filter(c => c.count > 0).sort((a, b) => b.count - a.count);
  const topConstraint = constraintEntries[0];

  // === Actions ===
  const actions: { label: string; severity: "red" | "amber" | "info"; count: number }[] = [];
  if (trulyStal > 0) actions.push({ label: "HOT items stale >30m", severity: "red", count: trulyStal });
  if (missingMinCount > 0) actions.push({ label: "Missing min_price", severity: "red", count: missingMinCount });
  if (q.quotaErrors24h > 5) actions.push({ label: "Quota errors (24h)", severity: "amber", count: q.quotaErrors24h });

  // === Human summary ===
  const summaryParts: string[] = [];
  if (writes24h > 0) summaryParts.push(`${writes24h} writes in 24h`);
  if (trulyStal > 0) summaryParts.push(`${trulyStal} HOT stale`);
  if (missingMinCount > 0) summaryParts.push(`${missingMinCount} missing min`);
  if (summaryParts.length === 0) summaryParts.push("System running normally");

  // Derive overall status from score-aligned logic:
  // If no actions and system+hot are green → green, otherwise use existing logic
  const hasRealActions = actions.length > 0;
  const overallStatus: SectionStatus =
    systemStatus === "red" || hotStatus === "red" ? "red"
    : hasRealActions ? "amber"
    : systemStatus === "amber" || hotStatus === "amber" ? "amber"
    : "green";

  return (
    <Card className={`border-2 ${statusBorder(overallStatus)} ${statusBg(overallStatus)}`}>
      <CardContent className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            <span className="text-base font-bold text-foreground">Repricer Command Block</span>
          </div>
          <Badge variant={overallStatus === "green" ? "secondary" : "outline"} className={`text-xs ${statusText(overallStatus)}`}>
            {overallStatus === "green" ? "✅ All Good" : overallStatus === "amber" ? "🟠 Needs Attention" : "🔴 Action Required"}
          </Badge>
        </div>

        {/* Summary sentence */}
        <p className="text-sm text-muted-foreground">{summaryParts.join(" · ")}</p>

        <Separator />

        {/* Row 1: System + Coverage + Writes */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* System Status */}
          <div className={`rounded-lg border p-3 space-y-2 ${statusBorder(systemStatus)} ${statusBg(systemStatus)}`}>
            <SectionTitle icon={<Heart className="h-4 w-4 text-muted-foreground" />} title="System" status={systemStatus} />
            <div className="grid grid-cols-2 gap-3">
              <Metric label="State" value={systemLabel} />
              <Metric label="Elig Coverage (today)" value={`${eligibleCovPct}%`} sub={`${q.checkedEligibleToday}/${q.eligibleAssignments} eligible`} />
            </div>
          </div>

          {/* Throughput */}
          <div className={`rounded-lg border p-3 space-y-2 ${statusBorder(writesStatus)} ${statusBg(writesStatus)}`}>
            <SectionTitle icon={<Send className="h-4 w-4 text-muted-foreground" />} title="Throughput" status={writesStatus} />
            <div className="grid grid-cols-3 gap-2">
              <Metric label="Writes (24h)" value={writes24h} />
              <Metric label="Evals (today)" value={q.skusEvaluatedToday} />
              <Metric label="Quota Err (24h)" value={q.quotaErrors24h} warn={q.quotaErrors24h > 5} />
            </div>
          </div>

          {/* Data Health */}
          <div className={`rounded-lg border p-3 space-y-2 ${statusBorder(dataStatus)} ${statusBg(dataStatus)}`}>
            <SectionTitle icon={<Globe className="h-4 w-4 text-muted-foreground" />} title="Data Health" status={dataStatus} />
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Empty Snapshots" value={`${emptyPct}%`} sub={`${q.emptySnapshots}/${q.totalSnapshots}`} />
              <Metric label="Valid Rate" value={emptyPct <= 100 ? `${100 - emptyPct}%` : "—"} />
            </div>
          </div>
        </div>

        <Separator />

        {/* Row 2: HOT Reality (full width - most important) */}
        <div className={`rounded-lg border p-3 space-y-3 ${statusBorder(hotStatus)} ${statusBg(hotStatus)}`}>
          <SectionTitle icon={<Zap className="h-4 w-4 text-muted-foreground" />} title="HOT Reality" status={hotStatus} />
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            <Metric label="HOT Total" value={hotTotal} />
            <Metric label="Dispatchable" value={hotDisp} />
            <Metric label="Blocked" value={hotBlocked} warn={hotBlocked > 0} />
            <Metric label="Disp p50" value={`${hotDispP50}m`} />
            <Metric label="Disp p90" value={`${hotDispP90}m`} warn={hotDispP90 > 30} />
            <Metric label="Truly Stale" value={trulyStal} warn={trulyStal > 0} />
          </div>

          {/* Blocked breakdown */}
          {bb && hotBlocked > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {bb.throttled > 0 && <Badge variant="outline" className="text-[10px] gap-1">⛔ Throttled: {bb.throttled}</Badge>}
              {bb.noData > 0 && <Badge variant="outline" className="text-[10px] gap-1">📭 No Data: {bb.noData}</Badge>}
              {bb.dailyCap > 0 && <Badge variant="outline" className="text-[10px] gap-1">🔒 Daily Cap: {bb.dailyCap}</Badge>}
              {bb.inactive > 0 && <Badge variant="outline" className="text-[10px] gap-1">🚫 Inactive: {bb.inactive}</Badge>}
              {bb.bbOwnerStable > 0 && <Badge variant="outline" className="text-[10px] gap-1">👑 BB Owner (stable): {bb.bbOwnerStable}</Badge>}
              {bb.floorHeld > 0 && <Badge variant="outline" className="text-[10px] gap-1">🛡️ Floor/Lowest: {bb.floorHeld}</Badge>}
              {bb.rotatingBb > 0 && <Badge variant="outline" className="text-[10px] gap-1">🔄 Rotating BB: {bb.rotatingBb}</Badge>}
              {bb.noGap > 0 && <Badge variant="outline" className="text-[10px] gap-1">👁 No Gap: {bb.noGap}</Badge>}
              {bb.other > 0 && <Badge variant="outline" className="text-[10px] gap-1">❓ Other: {bb.other}</Badge>}
            </div>
          )}

          {/* Stale HOT Trace */}
          {freshnessData?.hotStaleAsins && freshnessData.hotStaleAsins.length > 0 && (
            <div className="pt-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Stale HOT Trace</span>
              </div>
              {freshnessData.hotStaleAsins.slice(0, 5).map(s => (
                <div key={s.asin} className="flex items-center gap-2 text-xs bg-muted/30 rounded px-2 py-1">
                  <span className="font-mono font-bold text-foreground">{s.asin}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-destructive font-medium">{s.ageMin}m stale</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground truncate">Last: {s.lastCheck}</span>
                  <Badge variant="outline" className="text-[9px] ml-auto shrink-0">{s.reason}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <Separator />

        {/* Row 3: Constraints + Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Constraint Summary */}
          <div className="rounded-lg border p-3 space-y-2 border-border bg-muted/20">
            <SectionTitle icon={<Shield className="h-4 w-4 text-muted-foreground" />} title="Constraints" status="green" />
            {constraintEntries.length > 0 ? (
              <div className="space-y-1">
                {constraintEntries.map(c => (
                  <div key={c.label} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{c.icon} {c.label}</span>
                    <span className="font-bold text-foreground">{c.count}</span>
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground pt-1">
                  Dominant: <span className="font-medium text-foreground">{topConstraint?.label}</span> — profit protection active
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No constraints blocking changes.</p>
            )}
          </div>

          {/* Action Needed */}
          <div className={`rounded-lg border p-3 space-y-2 ${actions.length > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-green-500/30 bg-green-500/5"}`}>
            <SectionTitle
              icon={<AlertTriangle className="h-4 w-4 text-muted-foreground" />}
              title="Action Needed"
              status={actions.some(a => a.severity === "red") ? "red" : actions.length > 0 ? "amber" : "green"}
            />
            {actions.length > 0 ? (
              <div className="space-y-1.5">
                {actions.map(a => (
                  <div key={a.label} className="flex items-center gap-2 text-xs">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.severity === "red" ? "bg-destructive" : "bg-amber-500"}`} />
                    <span className="text-foreground font-medium">{a.count}</span>
                    <span className="text-muted-foreground">{a.label}</span>
                    <Badge variant="outline" className={`text-[9px] ml-auto ${a.severity === "red" ? "text-destructive border-destructive/30" : "text-amber-600 border-amber-500/30"}`}>
                      {a.severity === "red" ? "FIX" : "WATCH"}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs">
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                <span className="text-muted-foreground">No urgent system issue — optimization is optional.</span>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
