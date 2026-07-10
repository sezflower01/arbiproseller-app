import { Badge } from "@/components/ui/badge";
import type { MonitorData } from "@/hooks/use-monitor-data";
import type { BlockerBuckets } from "./MonitorCommandBar";

interface Props {
  data: MonitorData;
  freshnessData?: { hotP50: number; hotP90: number; hotCount: number; hotSlaBreachCount: number; hotEvaluatedButBlockedCount?: number; hotTrulyStalCount?: number; hotDispatchableP90?: number; hotDispatchableCount?: number; hotBlockedCount?: number };
  stalledCount?: number;
  missingMinCount?: number;
  writes24h?: number;
  blockerBuckets?: BlockerBuckets;
}

export default function MonitorSmartSummary({
  data, freshnessData, stalledCount = 0, missingMinCount = 0, writes24h = 0, blockerBuckets,
}: Props) {
  const q = data.quotaHealth;
  const eligibleCovPct = q.eligibleAssignments > 0
    ? Math.round((q.checkedEligibleToday / q.eligibleAssignments) * 100)
    : 0;
  const uniqueCovPct = q.uniqueEligibleCoveragePercent;

  // === Group issues into 3 categories ===

  // 1. System Issues — things that indicate the engine is unhealthy
  // If writes are flowing (>50), scheduler timestamp staleness is cosmetic, not a system issue.
  const systemOperational = writes24h > 50;
  const systemIssues: string[] = [];
  if (!data.schedulerHealthy && !systemOperational) systemIssues.push("⚠ Scheduler stale");
  if (q.quotaErrors24h > 5) systemIssues.push(`${q.quotaErrors24h} quota errors in 24h`);
  if (eligibleCovPct < 80) systemIssues.push(`rotation weak at ${eligibleCovPct}% eligible coverage`);
  if (uniqueCovPct < 70) systemIssues.push(`only ${uniqueCovPct}% unique ASIN coverage`);

  // Separate truly stale from evaluated-but-blocked
  const hotTrulyStal = freshnessData?.hotTrulyStalCount ?? 0;
  const hotBlockedCount = freshnessData?.hotEvaluatedButBlockedCount ?? 0;
  if (hotTrulyStal > 0) {
    systemIssues.push(`${hotTrulyStal} HOT items truly stale (not evaluated recently)`);
  }

  // 2. Profit Protections — intentional guards protecting margin
  const profitProtections: string[] = [];
  if (blockerBuckets) {
    if (blockerBuckets.profitGuard > 0) profitProtections.push(`Profit Guard (${blockerBuckets.profitGuard})`);
    if (blockerBuckets.minFloor > 0) profitProtections.push(`Min Floor (${blockerBuckets.minFloor})`);
  } else {
    if (data.profitGuardBlocks > 0) profitProtections.push(`Profit Guard (${data.profitGuardBlocks})`);
  }
  if (missingMinCount > 0) profitProtections.push(`Missing Min (${missingMinCount})`);

  // 3. Market Constraints — external market conditions preventing moves
  const marketConstraints: string[] = [];
  if (hotBlockedCount > 0) {
    marketConstraints.push(`${hotBlockedCount} HOT items evaluated but blocked by rules`);
  }
  if (blockerBuckets) {
    if (blockerBuckets.bbOwnerHold > 0) marketConstraints.push(`BB Owner Hold (${blockerBuckets.bbOwnerHold})`);
    if (blockerBuckets.noCompetitors > 0) marketConstraints.push(`No Competitors (${blockerBuckets.noCompetitors})`);
    if (blockerBuckets.deltaTooSmall > 0) marketConstraints.push(`Delta Too Small (${blockerBuckets.deltaTooSmall})`);
    if (blockerBuckets.cooldown > 0) marketConstraints.push(`Cooldown (${blockerBuckets.cooldown})`);
  } else {
    if (stalledCount > 0) marketConstraints.push(`Constrained (${stalledCount})`);
  }

  const isHealthy = data.schedulerHealthy && eligibleCovPct >= 80 && writes24h > 0 &&
    (freshnessData?.hotSlaBreachCount || 0) === 0 &&
    systemIssues.length === 0 && profitProtections.length === 0 && marketConstraints.length === 0;

  // Build grouped summary
  const parts: string[] = [];

  // Always lead with writes
  parts.push(writes24h > 0 ? `${writes24h} writes in 24h` : "0 writes in 24h");

  if (systemIssues.length > 0) {
    parts.push(`🔴 System: ${systemIssues.join(", ")}`);
  }
  if (profitProtections.length > 0) {
    parts.push(`🟡 Profit Guards: ${profitProtections.join(", ")}`);
  }
  if (marketConstraints.length > 0) {
    parts.push(`🔵 Market: ${marketConstraints.join(", ")}`);
  }

  if (isHealthy) {
    parts.length = 0;
    parts.push("System stable", `${writes24h} writes in 24h`);
  }

  const summary = parts.join(" · ") + ".";

  // Determine severity level — only "System Issue" if truly broken (no writes + scheduler stale)
  const isTrulyBroken = !data.schedulerHealthy && !systemOperational && writes24h === 0;
  const severityLabel = isHealthy ? "✅ All Good" : isTrulyBroken ? "🔴 System Issue" : systemIssues.length > 0 ? "🟠 Needs Review" : "⚡ Attention";

  // Build human-readable top-level sentence
  const hotStaleCount = freshnessData?.hotSlaBreachCount || 0;
  const constrainedCount = profitProtections.length + marketConstraints.length;
  const humanSentence = isHealthy
    ? "Your repricer is running smoothly. All items are being checked and prices are being updated normally."
    : isTrulyBroken
    ? "Your repricer engine appears to be down. No writes are landing and the scheduler is stale. Investigate immediately."
    : systemIssues.length > 0
    ? `System is active but has ${systemIssues.length} issue${systemIssues.length > 1 ? "s" : ""} to watch.${hotStaleCount > 0 ? ` ${hotStaleCount} urgent HOT item${hotStaleCount > 1 ? "s are" : " is"} delayed.` : ""}${constrainedCount > 0 ? " Many other items are held normally by your profit rules or market conditions." : ""}`
    : `System is operational with ${writes24h} price updates.${profitProtections.length > 0 ? " Profit rules are protecting your margins." : ""}${marketConstraints.length > 0 ? " Some items are held by market conditions (normal)." : ""}`;

  return (
    <div className={`rounded-lg border p-3 text-sm space-y-2 ${
      isHealthy
        ? "border-green-500/20 bg-green-500/5"
        : isTrulyBroken
        ? "border-destructive/20 bg-destructive/5"
        : systemIssues.length > 0
        ? "border-amber-500/20 bg-amber-500/10"
        : "border-amber-500/20 bg-amber-500/5"
    }`}>
      <div className="flex items-start gap-2">
        <Badge variant={isHealthy ? "secondary" : "outline"} className="shrink-0 text-[10px]">
          {severityLabel}
        </Badge>
        <p className="text-muted-foreground leading-relaxed">{summary}</p>
      </div>
      <p className="text-foreground font-medium text-sm leading-relaxed">{humanSentence}</p>
    </div>
  );
}
