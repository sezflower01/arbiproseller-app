import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShieldCheck, CheckCircle, AlertTriangle, Info } from "lucide-react";
import type { QuotaHealthData } from "@/hooks/use-monitor-data";

interface Props {
  data: QuotaHealthData;
}

interface MetricFormula {
  label: string;
  formula: string;
  value: string;
  status: "ok" | "warn" | "error";
  detail: string;
}

export default function MetricValidationPanel({ data }: Props) {
  const inactiveCount = data.totalAssignments - data.activeAssignments;
  
  // Bucket sum from strict exclusive classification
  const bucketSum = data.eligibleAssignments + data.disabledCount + data.noUsListingCount + data.noRuleCount + inactiveCount;

  // Eligible coverage uses scoped numerator (checkedEligibleToday)
  const eligibleCovPct = data.eligibleAssignments > 0
    ? Math.round((data.checkedEligibleToday / data.eligibleAssignments) * 100)
    : 0;

  const checks: MetricFormula[] = [
    {
      label: "Eligible Coverage",
      formula: "Checked Eligible / Eligible × 100 (must be ≤ 100%)",
      value: `${data.checkedEligibleToday} / ${data.eligibleAssignments} = ${eligibleCovPct}%`,
      status: eligibleCovPct <= 100 ? "ok" : "error",
      detail: "Both numerator and denominator scoped to the same eligible set. Can never exceed 100%.",
    },
    {
      label: "Managed Coverage",
      formula: "Checked Today / Active × 100",
      value: `${data.checkedToday} / ${data.activeAssignments} = ${data.coveragePercent}%`,
      status: data.coveragePercent <= 100 ? "ok" : "warn",
      detail: "All active assignments checked today. Includes disabled/orphan in denominator.",
    },
    {
      label: "Bucket Sum = Total",
      formula: "Eligible + Disabled + Orphan + No Rule + Inactive = Total",
      value: `${data.eligibleAssignments} + ${data.disabledCount} + ${data.noUsListingCount} + ${data.noRuleCount} + ${inactiveCount} = ${bucketSum} (expected ${data.totalAssignments})`,
      status: bucketSum === data.totalAssignments ? "ok" : "error",
      detail: "Strict exclusive classification — every assignment in exactly one bucket. Must sum to total.",
    },
    {
      label: "Active = Eligible + Excluded",
      formula: "Active = Eligible + Disabled + Orphan + No Rule",
      value: `${data.activeAssignments} = ${data.eligibleAssignments + data.disabledCount + data.noUsListingCount + data.noRuleCount} (delta: ${data.activeAssignments - (data.eligibleAssignments + data.disabledCount + data.noUsListingCount + data.noRuleCount)})`,
      status: data.activeAssignments === (data.eligibleAssignments + data.disabledCount + data.noUsListingCount + data.noRuleCount) ? "ok" : "warn",
      detail: "Active assignments = sum of all active-status buckets (eligible + excluded categories).",
    },
    {
      label: "No Negative Denominators",
      formula: "Eligible ≥ 0 AND Active ≥ 0",
      value: `Eligible: ${data.eligibleAssignments}, Active: ${data.activeAssignments}`,
      status: data.eligibleAssignments >= 0 && data.activeAssignments >= 0 ? "ok" : "error",
      detail: "Denominators must never be negative. A negative value indicates a classification bug.",
    },
    {
      label: "Coverage ≤ 100%",
      formula: "Eligible Coverage ≤ 100% AND Managed Coverage ≤ 100%",
      value: `Eligible: ${eligibleCovPct}%, Managed: ${data.coveragePercent}%`,
      status: eligibleCovPct <= 100 && data.coveragePercent <= 100 ? "ok" : "error",
      detail: "Coverage exceeding 100% means numerator/denominator are misaligned.",
    },
  ];

  const failCount = checks.filter(c => c.status !== "ok").length;
  const allGood = failCount === 0;

  return (
    <Card className="border-primary/30 bg-background/95 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg text-primary">
          <ShieldCheck className="h-5 w-5 text-primary" />
          Metric Validation
          <Badge 
            variant="outline"
            className={`ml-auto text-xs ${allGood 
              ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400" 
              : "border-destructive/30 bg-destructive/10 text-destructive"}`}
          >
            {allGood ? "All checks pass ✓" : `${failCount} issue${failCount > 1 ? "s" : ""}`}
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Hard validation — ensures coverage metrics are mathematically correct and trustworthy
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {checks.map(c => (
          <Tooltip key={c.label}>
            <TooltipTrigger asChild>
              <div className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-help ${
                c.status === "ok"
                  ? "bg-green-500/5 border-green-500/15"
                  : c.status === "warn"
                    ? "bg-amber-500/10 border-amber-500/20"
                    : "bg-destructive/10 border-destructive/20"
              }`}>
                {c.status === "ok" ? (
                  <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className={`h-4 w-4 shrink-0 mt-0.5 ${c.status === "warn" ? "text-amber-500" : "text-destructive"}`} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{c.label}</span>
                    <Info className="h-3 w-3 text-primary/40" />
                  </div>
                  <div className="text-xs text-muted-foreground font-mono mt-0.5">{c.value}</div>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-xs max-w-[300px] space-y-1">
              <p className="font-medium">{c.formula}</p>
              <p>{c.detail}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </CardContent>
    </Card>
  );
}
