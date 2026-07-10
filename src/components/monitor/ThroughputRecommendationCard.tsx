import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Lightbulb, ArrowUp, ArrowDown, Minus, AlertTriangle, CheckCircle, Gauge } from "lucide-react";
import type { QuotaHealthData } from "@/hooks/use-monitor-data";
import { useCoverageBreakdown, useEmptySnapshotBreakdown } from "@/hooks/use-coverage-breakdown";

interface Props {
  quotaHealth: QuotaHealthData;
}

interface Recommendation {
  id: string;
  icon: typeof ArrowUp;
  title: string;
  description: string;
  severity: "critical" | "warning" | "info" | "ok";
}

export default function ThroughputRecommendationCard({ quotaHealth }: Props) {
  const coverage = useCoverageBreakdown();
  const snapshots = useEmptySnapshotBreakdown();

  if (coverage.loading || snapshots.loading) return null;

  const recommendations: Recommendation[] = [];
  const activeAsins = quotaHealth.uniqueActiveAsins || quotaHealth.activeAssignments;
  const eligibleAsins = quotaHealth.uniqueEligibleAsins || quotaHealth.eligibleAssignments;
  const checkedEligibleAsins = quotaHealth.uniqueEligibleAsinsCheckedToday || quotaHealth.uniqueAsinsChecked;

  // 1. Coverage bottleneck
  const coveragePct = quotaHealth.uniqueEligibleCoveragePercent || quotaHealth.uniqueCoveragePercent || quotaHealth.coveragePercent;
  if (coveragePct < 50) {
    recommendations.push({
      id: "coverage_critical",
      icon: AlertTriangle,
      title: "Coverage Bottleneck — Critical",
      description: `Only ${coveragePct}% of eligible ASINs checked today. ${Math.max(eligibleAsins - checkedEligibleAsins, 0)} ASINs are still waiting.`,
      severity: "critical",
    });
  } else if (coveragePct < 70) {
    recommendations.push({
      id: "coverage_warning",
      icon: ArrowUp,
      title: "Coverage Below Target",
      description: `${coveragePct}% unique ASIN coverage is below the 70% target. ${Math.max(eligibleAsins - checkedEligibleAsins, 0)} eligible ASINs still waiting.`,
      severity: "warning",
    });
  } else {
    recommendations.push({
      id: "coverage_ok",
      icon: CheckCircle,
      title: "Coverage Healthy",
      description: `${coveragePct}% of eligible ASINs checked today. On track.`,
      severity: "ok",
    });
  }

  // 2. Empty snapshot bottleneck
  const emptyPct = quotaHealth.emptySnapshotPercent;
  if (emptyPct > 25) {
    recommendations.push({
      id: "empty_critical",
      icon: AlertTriangle,
      title: "Empty Snapshot Bottleneck — Critical",
      description: `${emptyPct}% of snapshots have no market data. The repricer is partially blind. Check SP-API response quality and consider retry logic.`,
      severity: "critical",
    });
  } else if (emptyPct > 15) {
    recommendations.push({
      id: "empty_warning",
      icon: ArrowDown,
      title: "Empty Snapshots Elevated",
      description: `${emptyPct}% empty snapshot rate. Target is below 15%. ${snapshots.recoveredCount} ASINs later succeeded on retry.`,
      severity: "warning",
    });
  } else {
    recommendations.push({
      id: "empty_ok",
      icon: CheckCircle,
      title: "Snapshot Quality Healthy",
      description: `${emptyPct}% empty rate is within acceptable range.`,
      severity: "ok",
    });
  }

  // 3. Pacing safety assessment
  if (quotaHealth.quotaErrors24h === 0 && coveragePct < 70) {
    recommendations.push({
      id: "pacing_safe",
      icon: ArrowUp,
      title: "Safe to Increase Pacing",
      description: `Zero 429/quota errors detected with only ${coveragePct}% coverage. Current pacing appears too conservative. You can safely increase the SP-API calls/min cap by 2-3 to improve throughput.`,
      severity: "info",
    });
  } else if (quotaHealth.quotaErrors24h > 5) {
    recommendations.push({
      id: "pacing_unsafe",
      icon: AlertTriangle,
      title: "Not Safe to Increase Pacing",
      description: `${quotaHealth.quotaErrors24h} quota/429 errors in 24h. Reduce batch size or increase stagger delays before increasing throughput.`,
      severity: "critical",
    });
  } else if (quotaHealth.quotaErrors24h > 0) {
    recommendations.push({
      id: "pacing_caution",
      icon: Minus,
      title: "Pacing at Limit",
      description: `${quotaHealth.quotaErrors24h} minor quota errors. Current pacing is near the threshold. Monitor before increasing.`,
      severity: "warning",
    });
  }

  // 4. Rotation fairness
  if (coverage.repeatedlyChecked > 0 && coverage.neverCheckedToday > coverage.totalActive * 0.3) {
    recommendations.push({
      id: "fairness",
      icon: AlertTriangle,
      title: "Rotation Imbalance",
      description: `${coverage.repeatedlyChecked} ASINs checked multiple times while ${coverage.neverCheckedToday} haven't been checked at all. HOT-tier may be starving WARM/COLD rotation.`,
      severity: "warning",
    });
  }

  // 4b. International starvation detection
  const intlMarkets = quotaHealth.marketplaceBreakdown.filter(m => m.marketplace !== 'US' && m.active > 0);
  const starvedIntl = intlMarkets.filter(m => m.coveragePct < 10);
  if (starvedIntl.length > 0) {
    const intlActive = starvedIntl.reduce((s, m) => s + m.active, 0);
    recommendations.push({
      id: "intl_starvation",
      icon: AlertTriangle,
      title: "International Assignments Not Evaluated",
      description: `${starvedIntl.map(m => m.marketplace).join(', ')} have ${intlActive} active assignments with <10% coverage. Low overall coverage is likely caused by international SKUs in the denominator but not being checked.`,
      severity: "critical",
    });
  }

  // 5. Estimated max safe throughput
  const avgCallMs = quotaHealth.avgCycleDurationMs || 2700;
  const currentCap = 20; // Default after this update
  const chainsPerCycle = 8;
  const execWindowSec = 140;
  const callsPerChainPerMinute = Math.floor(60000 / Math.max(avgCallMs + 1000, 2000)); // +1s stagger for HOT
  const maxChecksPerCycle = Math.min(callsPerChainPerMinute * (execWindowSec / 60), currentCap * (execWindowSec / 60)) * chainsPerCycle;
  const cyclesPerDay = 24 * 60 / 5; // ~every 5 minutes
  const estimatedDailyMax = Math.round(maxChecksPerCycle * cyclesPerDay);
  const checksPerSku = activeAsins > 0 ? (estimatedDailyMax / activeAsins).toFixed(1) : '0';

  recommendations.push({
    id: "throughput_estimate",
    icon: Gauge,
    title: "Estimated Max Throughput",
    description: `At avg ${(avgCallMs / 1000).toFixed(1)}s/call with ${chainsPerCycle} chains: ~${maxChecksPerCycle.toFixed(0)} checks/cycle, ~${estimatedDailyMax.toLocaleString()} checks/day. That's ~${checksPerSku}× coverage per day for ${activeAsins} active ASINs.`,
    severity: "info",
  });

  const severityColor = {
    critical: "border-destructive/50 bg-destructive/10",
    warning: "border-yellow-500/50 bg-yellow-500/10",
    info: "border-blue-500/50 bg-blue-500/10",
    ok: "border-green-500/50 bg-green-500/10",
  };
  const severityText = {
    critical: "text-destructive",
    warning: "text-yellow-600",
    info: "text-blue-600",
    ok: "text-green-600",
  };

  const hasCritical = recommendations.some(r => r.severity === "critical");
  const hasWarning = recommendations.some(r => r.severity === "warning");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Lightbulb className="h-5 w-5 text-primary" />
          Throughput Recommendations
          <Badge
            variant="outline"
            className={`ml-auto text-xs ${hasCritical ? "border-destructive text-destructive" : hasWarning ? "border-yellow-500 text-yellow-600" : "border-green-500 text-green-600"}`}
          >
            {hasCritical ? "Action Needed" : hasWarning ? "Attention" : "Healthy"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {recommendations.map(r => (
          <div key={r.id} className={`flex items-start gap-3 p-3 rounded-lg border ${severityColor[r.severity]}`}>
            <r.icon className={`h-4 w-4 shrink-0 mt-0.5 ${severityText[r.severity]}`} />
            <div className="text-sm">
              <span className={`font-medium ${severityText[r.severity]}`}>{r.title}</span>
              <p className="text-muted-foreground text-xs mt-0.5">{r.description}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
