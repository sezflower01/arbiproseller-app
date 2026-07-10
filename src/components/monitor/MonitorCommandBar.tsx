import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Heart, Target, Send, Zap, AlertTriangle, Pause, Ban, Shield,
} from "lucide-react";
import type { MonitorData } from "@/hooks/use-monitor-data";

export interface BlockerBuckets {
  profitGuard: number;
  minFloor: number;
  noCompetitors: number;
  deltaTooSmall: number;
  cooldown: number;
  bbOwnerHold: number;
}

interface Props {
  data: MonitorData;
  freshnessData?: { hotP50: number; hotP90: number; hotCount: number; hotSlaBreachCount: number; hotEvaluatedButBlockedCount?: number; hotTrulyStalCount?: number; hotDispatchableP90?: number; hotDispatchableCount?: number; hotBlockedCount?: number };
  stalledCount?: number;
  missingMinCount?: number;
  writes24h?: number;
  blockerBuckets?: BlockerBuckets;
  onCardClick?: (section: string) => void;
}

type StatusColor = "green" | "amber" | "red";

function statusClass(color: StatusColor) {
  return color === "green"
    ? "border-green-500/30 bg-green-500/10"
    : color === "amber"
    ? "border-amber-500/30 bg-amber-500/10"
    : "border-destructive/30 bg-destructive/10";
}

function dotClass(color: StatusColor) {
  return color === "green" ? "bg-green-500" : color === "amber" ? "bg-amber-500" : "bg-destructive";
}

export default function MonitorCommandBar({
  data,
  freshnessData,
  stalledCount = 0,
  missingMinCount = 0,
  writes24h = 0,
  blockerBuckets,
  onCardClick,
}: Props) {
  const q = data.quotaHealth;

  // Health = system-only: scheduler + quota. Profit guards and market constraints are NOT system failures.
  // If writes are flowing (>50 in 24h), the system is operational even if the scheduler timestamp is stale.
  const systemOperational = writes24h > 50;
  const healthColor: StatusColor = data.schedulerHealthy
    ? (q.quotaErrors24h > 5 ? "amber" : "green")
    : systemOperational ? "amber" : data.lastRunTime ? "amber" : "red";

  const eligibleCovPct = q.eligibleAssignments > 0
    ? Math.round((q.checkedEligibleToday / q.eligibleAssignments) * 100)
    : 0;
  const covColor: StatusColor = eligibleCovPct >= 80 ? "green" : eligibleCovPct >= 50 ? "amber" : "red";

  // Writes 24h — uses actual eval ack count instead of today-only price_actions
  const writesColor: StatusColor = writes24h > 0 ? "green" : q.totalActions > 0 ? "amber" : "red";

  const hotP90Raw = freshnessData?.hotP90 ?? 0;
  const hotP90 = freshnessData?.hotDispatchableP90 ?? hotP90Raw;
  const hotBlocked = freshnessData?.hotBlockedCount ?? 0;
  const trulyStal = freshnessData?.hotTrulyStalCount ?? 0;
  // If all breaching items were recently evaluated but blocked by rules, downgrade to amber (not a real delay)
  const freshColor: StatusColor = hotP90 <= 30 ? "green" : trulyStal > 0 ? (hotP90 > 120 ? "red" : "amber") : "amber";

  const quotaColor: StatusColor = q.quotaErrors24h === 0 ? "green" : q.quotaErrors24h <= 10 ? "amber" : "red";

  // Constrained = total of all blocker buckets (replaces "Stalled")
  // Constrained items are NORMAL — rules/market preventing changes. Only red if >80% of eligible is stuck.
  const constrainedTotal = stalledCount;
  const constrainedPct = q.eligibleAssignments > 0 ? (constrainedTotal / q.eligibleAssignments) * 100 : 0;
  const constrainedColor: StatusColor = constrainedPct <= 30 ? "green" : constrainedPct <= 60 ? "amber" : "red";

  const missingColor: StatusColor = missingMinCount === 0 ? "green" : missingMinCount <= 10 ? "amber" : "red";

  // Top blocker — from specific buckets instead of generic "Stalled"
  const blockers: { label: string; count: number; isProtection: boolean }[] = [];
  if (blockerBuckets) {
    if (blockerBuckets.profitGuard > 0) blockers.push({ label: "Profit Guard", count: blockerBuckets.profitGuard, isProtection: true });
    if (blockerBuckets.bbOwnerHold > 0) blockers.push({ label: "BB Owner Hold", count: blockerBuckets.bbOwnerHold, isProtection: true });
    if (blockerBuckets.deltaTooSmall > 0) blockers.push({ label: "Delta Too Small", count: blockerBuckets.deltaTooSmall, isProtection: true });
    if (blockerBuckets.minFloor > 0) blockers.push({ label: "Min Floor", count: blockerBuckets.minFloor, isProtection: true });
    if (blockerBuckets.noCompetitors > 0) blockers.push({ label: "No Competitors", count: blockerBuckets.noCompetitors, isProtection: true });
    if (blockerBuckets.cooldown > 0) blockers.push({ label: "Cooldown", count: blockerBuckets.cooldown, isProtection: true });
  } else {
    if (data.profitGuardBlocks > 0) blockers.push({ label: "Profit Guard", count: data.profitGuardBlocks, isProtection: true });
    if (missingMinCount > 0) blockers.push({ label: "Missing Min", count: missingMinCount, isProtection: false });
    if (stalledCount > 0) blockers.push({ label: "Constrained", count: stalledCount, isProtection: true });
  }
  blockers.sort((a, b) => b.count - a.count);
  const topBlocker = blockers[0] ?? null;
  // Protection constraints (profit guard, min floor, BB hold, no competitors) = green. Only "Missing Min" = amber/red.
  const blockerColor: StatusColor = !topBlocker ? "green" : topBlocker.isProtection ? "green" : topBlocker.count <= 5 ? "amber" : "red";

  // Constrained tooltip breakdown
  const constrainedTooltipParts: string[] = [];
  if (blockerBuckets) {
    if (blockerBuckets.profitGuard > 0) constrainedTooltipParts.push(`Profit Guard: ${blockerBuckets.profitGuard}`);
    if (blockerBuckets.bbOwnerHold > 0) constrainedTooltipParts.push(`BB Owner Hold: ${blockerBuckets.bbOwnerHold}`);
    if (blockerBuckets.deltaTooSmall > 0) constrainedTooltipParts.push(`Delta Too Small: ${blockerBuckets.deltaTooSmall}`);
    if (blockerBuckets.minFloor > 0) constrainedTooltipParts.push(`Min Floor: ${blockerBuckets.minFloor}`);
    if (blockerBuckets.noCompetitors > 0) constrainedTooltipParts.push(`No Competitors: ${blockerBuckets.noCompetitors}`);
    if (blockerBuckets.cooldown > 0) constrainedTooltipParts.push(`Cooldown: ${blockerBuckets.cooldown}`);
  }

  const cards = [
    {
      key: "health",
      label: "Health",
      value: data.schedulerHealthy
        ? (q.quotaErrors24h > 5 ? "Caution" : "Healthy")
        : systemOperational ? "Operational" : "Degraded",
      color: healthColor,
      icon: <Heart className="h-3.5 w-3.5" />,
      tooltip: data.schedulerHealthy
        ? q.quotaErrors24h > 5
          ? `Scheduler running but ${q.quotaErrors24h} quota errors — may impact throughput`
          : "Scheduler ran <60m ago — system healthy"
        : systemOperational
        ? `Scheduler timestamp stale but ${writes24h} writes in 24h — system operational`
        : writes24h > 0
        ? `Scheduler stale but ${writes24h} writes landed — may be recovering`
        : "Scheduler stale — no recent activity",
      explain: data.schedulerHealthy
        ? "Your repricer engine is running normally."
        : systemOperational
        ? "The scheduler timestamp looks old, but prices are still being updated. No action needed."
        : "The engine hasn't run recently. Check if there's a system issue.",
      action: data.schedulerHealthy ? "none" as const : systemOperational ? "none" as const : "fix" as const,
    },
    {
      key: "coverage",
      label: "Eligible Coverage",
      value: `${eligibleCovPct}%`,
      color: covColor,
      icon: <Target className="h-3.5 w-3.5" />,
      tooltip: `${q.checkedEligibleToday} / ${q.eligibleAssignments} eligible checked today`,
      explain: eligibleCovPct >= 80
        ? "Most of your eligible items have been checked today. Good rotation."
        : `Only ${eligibleCovPct}% of eligible items checked — some products may not get updated today.`,
      action: eligibleCovPct >= 80 ? "none" as const : "review" as const,
    },
    {
      key: "writes",
      label: "Writes 24h",
      value: `${writes24h}`,
      color: writesColor,
      icon: <Send className="h-3.5 w-3.5" />,
      tooltip: `${writes24h} confirmed price changes in last 24h (${q.skusWithPriceChanges} unique ASINs today)`,
      explain: writes24h > 0
        ? `${writes24h} prices were actually changed in the last 24 hours. The system is actively repricing.`
        : "No price changes were made. This could mean all prices are optimal, or the system is paused.",
      action: "none" as const,
    },
    {
      key: "freshness",
      label: "HOT p50 / p90",
      value: freshnessData ? `${freshnessData.hotP50}m / ${hotP90}m${hotBlocked > 0 ? ` (${hotBlocked}⛔)` : ''}` : "—",
      color: freshColor,
      icon: <Zap className="h-3.5 w-3.5" />,
      tooltip: freshnessData
        ? `${freshnessData.hotCount} HOT total (${freshnessData.hotDispatchableCount ?? freshnessData.hotCount} dispatchable, ${hotBlocked} blocked). Disp p90=${hotP90}m.`
        : "Loading...",
      explain: freshnessData
        ? hotP90 <= 30
          ? "Your most urgent items are being checked quickly. No delays."
          : (() => {
              const blocked = freshnessData.hotEvaluatedButBlockedCount ?? 0;
              const trulyStal = freshnessData.hotTrulyStalCount ?? 0;
              if (blocked > 0 && trulyStal === 0) {
                return `${blocked} urgent items were recently evaluated but blocked by rules (profit guard, min floor, etc.) — no price change needed. The system is working correctly.`;
              }
              if (blocked > 0 && trulyStal > 0) {
                return `${trulyStal} urgent items are truly delayed and need attention. ${blocked} others were evaluated but blocked by rules — those are normal.`;
              }
              return hotP90 > 300
                ? `10% of urgent items haven't been evaluated in ${Math.round(hotP90 / 60)} hours — review urgently.`
                : `10% of urgent items haven't been evaluated in ${hotP90} minutes. The system is prioritizing them but may be constrained.`;
            })()
        : "Loading freshness data...",
      action: trulyStal > 0 && hotP90 > 300 ? "fix" as const : trulyStal > 0 && hotP90 > 120 ? "review" as const : "none" as const,
    },
    {
      key: "quota",
      label: "Quota Errors",
      value: `${q.quotaErrors24h}`,
      color: quotaColor,
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      tooltip: `${q.quotaErrors24h} quota/throttle errors in 24h`,
      explain: q.quotaErrors24h === 0
        ? "No API errors. Amazon is accepting all requests."
        : q.quotaErrors24h <= 5
        ? "A few temporary API limits from Amazon. The system retries automatically."
        : "Amazon is throttling requests more than usual. The system will recover, but updates may be slower.",
      action: q.quotaErrors24h > 5 ? "review" as const : "none" as const,
    },
    {
      key: "constrained",
      label: "Constrained (asgn)",
      value: `${constrainedTotal}`,
      color: constrainedColor,
      icon: <Pause className="h-3.5 w-3.5" />,
      tooltip: constrainedTooltipParts.length > 0
        ? `${constrainedTotal} assignments constrained · ${constrainedTooltipParts.join(" · ")}`
        : `${constrainedTotal} assignments where no action is possible after constraints`,
      explain: constrainedTotal === 0
        ? "All items can be freely repriced. No constraints blocking changes."
        : "These items were evaluated but the system decided not to change their price — usually because of profit rules or market conditions. This is normal.",
      action: "none" as const,
    },
    {
      key: "missingMin",
      label: "Missing Min (asgn)",
      value: `${missingMinCount}`,
      color: missingColor,
      icon: <Ban className="h-3.5 w-3.5" />,
      tooltip: `${missingMinCount} assignments without min_price — skipped by scheduler`,
      explain: missingMinCount === 0
        ? "All items have a minimum price set. Good to go."
        : `${missingMinCount} items cannot be repriced because no minimum price is set. Fix this so they can be included.`,
      action: missingMinCount > 0 ? "fix" as const : "none" as const,
    },
    {
      key: "blocker",
      label: "Top Constraint",
      value: topBlocker ? `${topBlocker.label} (${topBlocker.count})` : "None",
      color: blockerColor,
      icon: <Shield className="h-3.5 w-3.5" />,
      tooltip: topBlocker
        ? `${topBlocker.label}: ${topBlocker.count} evals constrained in 24h — ${
            ["Profit Guard", "Min Floor", "Missing Min"].includes(topBlocker.label) ? "💰 profit protection"
            : ["BB Owner Hold", "No Competitors", "Delta Too Small", "Cooldown"].includes(topBlocker.label) ? "📊 market condition"
            : "system constraint"
          }`
        : "No active constraints",
      explain: !topBlocker
        ? "No constraints are blocking price changes right now."
        : ["Profit Guard", "Min Floor"].includes(topBlocker.label)
        ? `"${topBlocker.label}" is protecting your profit on ${topBlocker.count} items. This is your rules working correctly.`
        : ["BB Owner Hold", "No Competitors"].includes(topBlocker.label)
        ? `"${topBlocker.label}" on ${topBlocker.count} items — this is normal market behavior, not a problem.`
        : `"${topBlocker.label}" is the most common reason prices aren't changing right now.`,
      action: !topBlocker ? "none" as const : ["Missing Min"].includes(topBlocker.label) ? "fix" as const : "none" as const,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((card) => (
        <Tooltip key={card.key}>
          <TooltipTrigger asChild>
            <Card
              className={`cursor-pointer transition-all hover:scale-[1.02] border ${statusClass(card.color)}`}
              onClick={() => onCardClick?.(card.key)}
            >
              <CardContent className="p-2.5">
                <div className="flex items-center gap-1.5 mb-1">
                  {card.icon}
                  <span className="text-[10px] text-muted-foreground truncate font-medium uppercase tracking-wider">
                    {card.label}
                  </span>
                  <span className={`w-2 h-2 rounded-full ml-auto shrink-0 ${dotClass(card.color)}`} />
                  <span className={`text-[9px] font-medium ${card.color === "green" ? "text-green-600 dark:text-green-400" : card.color === "amber" ? "text-amber-600 dark:text-amber-400" : "text-destructive"}`}>
                    {card.color === "green" ? "Green" : card.color === "amber" ? "Yellow" : "Red"}
                  </span>
                </div>
                <div className="text-sm font-bold text-foreground truncate">{card.value}</div>
                <p className="text-[10px] text-muted-foreground leading-tight mt-1 line-clamp-2">{card.explain}</p>
                {card.action === "fix" && (
                  <span className="text-[9px] font-semibold text-destructive mt-0.5 block">⚠ Fix needed</span>
                )}
                {card.action === "review" && (
                  <span className="text-[9px] font-semibold text-amber-600 dark:text-amber-400 mt-0.5 block">👀 Worth reviewing</span>
                )}
              </CardContent>
            </Card>
          </TooltipTrigger>
          <TooltipContent className="text-xs max-w-xs">{card.tooltip}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
