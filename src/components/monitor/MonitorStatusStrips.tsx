import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CheckCircle, AlertTriangle, Info } from "lucide-react";
import type { MonitorData } from "@/hooks/use-monitor-data";

interface Props {
  data: MonitorData;
  freshnessData?: { hotP50: number; hotP90: number; hotCount: number; warmP50: number; warmCount: number; hotSlaBreachCount: number; hotEvaluatedButBlockedCount?: number; hotTrulyStalCount?: number; hotDispatchableP90?: number; hotDispatchableCount?: number; hotBlockedCount?: number };
  writes24h?: number;
}

function Strip({ label, text, status, tooltip }: { label: string; text: string; status: "ok" | "warn" | "error"; tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs border cursor-help ${
          status === "ok"
            ? "border-green-500/15 bg-green-500/5"
            : status === "warn"
            ? "border-amber-500/20 bg-amber-500/5"
            : "border-destructive/20 bg-destructive/5"
        }`}>
          {status === "ok" ? (
            <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
          ) : (
            <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${status === "warn" ? "text-amber-500" : "text-destructive"}`} />
          )}
          <span className="font-medium text-foreground whitespace-nowrap">{label}:</span>
          <span className="text-muted-foreground">{text}</span>
          <Info className="h-3 w-3 text-muted-foreground/40 ml-auto shrink-0" />
        </div>
      </TooltipTrigger>
      <TooltipContent className="text-xs max-w-[300px]">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export default function MonitorStatusStrips({ data, freshnessData, writes24h = 0 }: Props) {
  const q = data.quotaHealth;
  const inactiveCount = q.totalAssignments - q.activeAssignments;
  const bucketSum = q.eligibleAssignments + q.disabledCount + q.noUsListingCount + q.noRuleCount + inactiveCount;
  const bucketValid = bucketSum === q.totalAssignments;

  const eligibleCovPct = q.eligibleAssignments > 0
    ? Math.round((q.checkedEligibleToday / q.eligibleAssignments) * 100)
    : 0;

  return (
    <div className="space-y-1.5">
      <Strip
        label="Universe"
        text={`${q.totalAssignments} total · ${q.eligibleAssignments} eligible · ${q.disabledCount} disabled · ${q.noRuleCount} no rule · bucket math ${bucketValid ? "✓" : "✗"}`}
        status={bucketValid ? "ok" : "error"}
        tooltip={`Eligible: ${q.eligibleAssignments}, Disabled: ${q.disabledCount}, Orphan: ${q.noUsListingCount}, No Rule: ${q.noRuleCount}, Inactive: ${inactiveCount}. Sum = ${bucketSum} (expected ${q.totalAssignments})`}
      />
      <Strip
        label="Coverage"
        text={`Eligible ${eligibleCovPct}% (${q.checkedEligibleToday}/${q.eligibleAssignments}) · Unique ASIN ${q.uniqueEligibleCoveragePercent}% (${q.uniqueEligibleAsinsCheckedToday}/${q.uniqueEligibleAsins})`}
        status={eligibleCovPct >= 80 ? "ok" : eligibleCovPct >= 50 ? "warn" : "error"}
        tooltip="Eligible Coverage = Checked Eligible Today / Eligible. Unique = deduplicated by ASIN."
      />
      {freshnessData && (() => {
        const trulyStal = freshnessData.hotTrulyStalCount ?? 0;
        const blocked = freshnessData.hotEvaluatedButBlockedCount ?? 0;
        const breachDetail = freshnessData.hotSlaBreachCount > 0
          ? blocked > 0 && trulyStal === 0
            ? `${freshnessData.hotSlaBreachCount} >30m (all evaluated, blocked by rules)`
            : trulyStal > 0 && blocked > 0
            ? `${trulyStal} truly stale, ${blocked} blocked by rules`
            : `${freshnessData.hotSlaBreachCount} HOT >30m`
          : `0 HOT >30m`;
        const dispP90 = freshnessData.hotDispatchableP90 ?? freshnessData.hotP90;
        const dispCount = freshnessData.hotDispatchableCount ?? freshnessData.hotCount;
        const blockedHot = freshnessData.hotBlockedCount ?? 0;
        const status = dispP90 <= 30 ? "ok" as const
          : trulyStal > 0 ? (dispP90 > 120 ? "error" as const : "warn" as const)
          : "warn" as const;
        return (
          <Strip
            label="Freshness"
            text={`HOT p50 ${freshnessData.hotP50}m · disp p90 ${dispP90}m${blockedHot > 0 ? ` (${blockedHot} blocked)` : ''} · ${breachDetail} · WARM p50 ${freshnessData.warmP50}m (${freshnessData.warmCount})`}
            status={status}
            tooltip={`${freshnessData.hotCount} HOT total (${dispCount} dispatchable, ${blockedHot} blocked by throttle/no-data/inactive). SLA uses dispatchable p90 only. WARM: ${freshnessData.warmCount}.`}
          />
        );
      })()}
      <Strip
        label="Health"
        text={`${writes24h} writes (24h) · ${q.skusEvaluatedToday} evals today · ${q.quotaErrors24h} quota errors · ${data.feedsSubmitted} feeds`}
        status={data.schedulerHealthy && writes24h > 0 ? "ok" : "warn"}
        tooltip={`${writes24h} confirmed price changes in 24h. Scheduler ${data.schedulerHealthy ? "healthy" : "stale"}. Last run: ${data.lastRunTime || "never"}`}
      />
    </div>
  );
}
