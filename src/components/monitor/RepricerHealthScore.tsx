import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trophy, Heart, Zap, BarChart3, Shield, Database, Settings, ChevronDown, ChevronUp, Activity } from "lucide-react";
import type { FreshnessMetrics } from "./RepricerCommandBlock";
import type { MonitorData, QuotaTimeWindow } from "@/hooks/use-monitor-data";
import type { BlockerBuckets } from "./MonitorCommandBar";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/* ── Extra diagnostic signals fetched once ── */
interface SeverityTiers { healthy: number; breach: number; severe: number; critical: number }
interface DiagnosticSignals {
  hotSeverity: SeverityTiers;
  hotSeverityDispatchable: SeverityTiers;
  tailTrend: "improving" | "stable" | "degrading";
  hotSlots: number;
  hotTotal: number;
  dispatchableHotCount: number;
  spApiThrottled: number;
  writeRate: number; // %
  noOfferPct: number; // % of ASINs with zero SP-API offers
  uniqueEvaluatedAsins24h: number;
  uniqueChangedAsins24h: number;
  totalWrites24h: number;
}

const EMPTY_DIAG: DiagnosticSignals = {
  hotSeverity: { healthy: 0, breach: 0, severe: 0, critical: 0 },
  hotSeverityDispatchable: { healthy: 0, breach: 0, severe: 0, critical: 0 },
  tailTrend: "stable",
  hotSlots: 0,
  hotTotal: 0,
  dispatchableHotCount: 0,
  spApiThrottled: 0,
  writeRate: 0,
  noOfferPct: 0,
  uniqueEvaluatedAsins24h: 0,
  uniqueChangedAsins24h: 0,
  totalWrites24h: 0,
};

interface Props {
  data: MonitorData;
  freshnessData?: FreshnessMetrics;
  missingMinCount: number;
  writes24h: number;
  blockerBuckets: BlockerBuckets;
  quotaTimeWindow?: QuotaTimeWindow;
}

interface CategoryScore {
  label: string;
  score: number;
  weight: number;
  icon: React.ReactNode;
  detail: string;
}

/** Operational KPI metrics for the strip below the score */
interface OperationalKPIs {
  dispatchableHotRatio: number; // 0-100%
  activationRate: number;       // unique changed ASINs / unique evaluated ASINs * 100
  actionableEligibleRate: number; // eligible not held by stable protections
  protectionWeight: number; // % of eligible held by guards
  uniqueEvaluated: number;
  uniqueChanged: number;
  totalWrites: number;
  writesPerChanged: number; // avg writes per changed ASIN
}

function clamp(v: number, min = 0, max = 10) {
  return Math.max(min, Math.min(max, v));
}

function computeScores(
  data: MonitorData,
  fm: FreshnessMetrics | undefined,
  missingMin: number,
  writes: number,
  diag: DiagnosticSignals,
  blockerBucketsArg?: BlockerBuckets,
  quotaTimeWindow?: QuotaTimeWindow,
): { categories: CategoryScore[]; kpis: OperationalKPIs } {
  const q = data.quotaHealth;
  const windowKey = quotaTimeWindow === "1h" ? "h1" : quotaTimeWindow === "4h" ? "h4" : quotaTimeWindow === "12h" ? "h12" : "h24";
  const quotaErrorsInWindow = q.quotaErrorWindows?.[windowKey] ?? q.quotaErrors24h;

  // ── A. System Health (20%) ──
  let sys = 10;
  if (quotaErrorsInWindow > 5) sys -= Math.min(3, (quotaErrorsInWindow - 5) * 0.3);
  const validRate = q.totalSnapshots > 0 ? ((q.totalSnapshots - q.emptySnapshots) / q.totalSnapshots) * 100 : 100;
  if (validRate < 90) sys -= 2.5;
  else if (validRate < 93) sys -= 1.3;
  else if (validRate < 95) sys -= 1;
  else if (validRate < 98) sys -= 0.5;
  if (q.emptySnapshotPercent > 10) sys -= 1.5;
  else if (q.emptySnapshotPercent > 5) sys -= 0.5;
  if (!data.schedulerHealthy && writes < 50) sys -= 3;
  if (diag.spApiThrottled > 50) sys -= 2;
  else if (diag.spApiThrottled > 20) sys -= 1;
  const quotaPressureHidden = quotaErrorsInWindow > 30 && (diag.dispatchableHotCount === 0);
  if (quotaPressureHidden) sys -= 0.5;
  const sysDetail = (() => {
    if (quotaPressureHidden) return `Quota friction (${quotaErrorsInWindow} errors) — masked by low HOT demand`;
    if (sys >= 9.5) return "Running reliably";
    if (sys >= 7.5) return diag.spApiThrottled > 10 ? `Minor throttling (${diag.spApiThrottled} skips)` : "Minor issues detected";
    if (sys >= 6) return "Needs improvement";
    return "Needs attention";
  })();

  // ── B. HOT Responsiveness (20%) ──
  let hot = 10;
  const trulyStal = fm?.hotTrulyStalCount ?? 0;
  const hotP90 = fm?.hotDispatchableP90 ?? fm?.hotP90 ?? 0;
  const hotP50 = fm?.hotDispatchableP50 ?? fm?.hotP50 ?? 0;
  if (trulyStal > 0) hot -= Math.min(3, trulyStal * 1.5);
  if (hotP90 > 60) hot -= 2;
  else if (hotP90 > 30) hot -= 1;
  if (hotP50 > 15) hot -= 0.5;
  const dispatchableSeverity = {
    critical: diag.hotSeverityDispatchable?.critical ?? diag.hotSeverity.critical,
    severe: diag.hotSeverityDispatchable?.severe ?? diag.hotSeverity.severe,
    breach: diag.hotSeverityDispatchable?.breach ?? diag.hotSeverity.breach,
  };
  if (dispatchableSeverity.critical > 0) hot -= Math.min(3, dispatchableSeverity.critical * 2);
  if (dispatchableSeverity.severe > 0) hot -= Math.min(2, dispatchableSeverity.severe * 1);
  if (dispatchableSeverity.breach > 0) hot -= Math.min(1, dispatchableSeverity.breach * 0.3);
  if (diag.tailTrend === "improving") hot += 0.3;
  if (diag.tailTrend === "degrading") hot -= 0.5;
  const effectiveHotTotal = (fm?.hotCount ?? 0) > 0 ? fm!.hotCount : diag.hotTotal;
  const effectiveDispatchableHot = (fm?.hotCount ?? 0) > 0
    ? (fm?.hotDispatchableCount ?? (fm!.hotCount - (fm?.hotBlockedCount ?? 0)))
    : diag.dispatchableHotCount ?? (diag.hotTotal - (fm?.hotBlockedCount ?? 0));
  const dispatchableHot = effectiveDispatchableHot;
  if (dispatchableHot > 0 && diag.hotSlots === 0) hot -= 0.5;
  const isResponsive = trulyStal === 0 && hotP90 <= 30;
  if (effectiveHotTotal > 0 && dispatchableHot === 0 && !isResponsive) {
    hot = Math.min(hot, 8.0);
  } else if (effectiveHotTotal > 2 && dispatchableHot / effectiveHotTotal < 0.2 && !isResponsive) {
    hot = Math.min(hot, 8.5);
  } else if (effectiveHotTotal > 2 && dispatchableHot / effectiveHotTotal < 0.3 && !isResponsive) {
    hot = Math.min(hot, 9.0);
  }

  const hotDetail = (() => {
    if (effectiveHotTotal > 0 && dispatchableHot === 0) {
      const quotaNote = quotaErrorsInWindow > 30 ? ` — ${quotaErrorsInWindow} quota errors untested under real load` : "";
      return `${effectiveHotTotal} HOT item(s) all guard-blocked — score is not stress-tested${quotaNote}`;
    }
    if (trulyStal === 0 && hotP90 <= 30 && diag.hotSeverity.critical === 0) {
      return diag.tailTrend === "improving" ? "Improving — reacting quickly" : "Reacting quickly to urgent listings";
    }
    if (trulyStal > 0) return `${trulyStal} urgent item(s) missed`;
    if (diag.hotSeverity.critical > 0) return `${diag.hotSeverity.critical} critical HOT item(s)`;
    if (hotP90 > 30 && hotP90 <= 60) return `Reacting quickly, minor delays on some listings (p90 ${Math.round(hotP90)}m)`;
    return "Responding but could be faster";
  })();

  // ── C. Coverage (15%) ──
  let cov = 10;
  const eligCovPct = q.eligibleAssignments > 0
    ? (q.checkedEligibleToday / q.eligibleAssignments) * 100 : 100;
  if (eligCovPct < 70) cov -= 3;
  else if (eligCovPct < 80) cov -= 2;
  else if (eligCovPct < 90) cov -= 0.5;
  const eligCovRounded = Math.round(eligCovPct);
  const covDetail = eligCovPct >= 90
    ? `Excellent catalog coverage (${eligCovRounded}%)`
    : eligCovPct >= 80
    ? `Good coverage (${eligCovRounded}%), some items pending`
    : `Low coverage (${eligCovRounded}%), many items not checked`;

  // ── D. Data Quality (10%) ──
  let dq = 10;
  if (q.emptySnapshotPercent > 10) dq -= 3;
  else if (q.emptySnapshotPercent > 5) dq -= 2;
  else if (q.emptySnapshotPercent > 2) dq -= 1;
  if (validRate < 90) dq -= 2;
  else if (validRate < 95) dq -= 1.5;
  else if (validRate < 98) dq -= 0.5;
  if (diag.noOfferPct > 50) dq -= 1.5;
  else if (diag.noOfferPct > 30) dq -= 0.5;
  const dqDetail = dq >= 9.5
    ? "Clean data for good decisions"
    : dq >= 7
    ? "Minor data gaps — reduce empty snapshots for better decisions"
    : diag.noOfferPct > 30
    ? `${Math.round(diag.noOfferPct)}% ASINs missing competitor data`
    : "Some data gaps detected";

  // ── E. Profit Protection (10%) ──
  const totalConstraints = (data.quotaHealth as any).constrainedCount ?? 0;
  const bucketTotal = blockerBucketsArg
    ? (blockerBucketsArg.profitGuard + blockerBucketsArg.minFloor + blockerBucketsArg.bbOwnerHold + blockerBucketsArg.noCompetitors + blockerBucketsArg.cooldown + blockerBucketsArg.deltaTooSmall)
    : 0;
  const effectiveConstraints = Math.max(totalConstraints, bucketTotal);
  let prot = 10;
  if (diag.writeRate > 0 && diag.writeRate < 5 && writes < 10) prot -= 2;
  else if (diag.writeRate > 0 && diag.writeRate < 5 && writes < 20) prot -= 1;
  if (effectiveConstraints > 300 && writes < 5) prot -= 0.5;
  const protDetail = prot >= 9.5
    ? "Protecting profit appropriately"
    : prot >= 9
    ? "Strong protection — slightly defensive posture"
    : diag.writeRate < 5
    ? `Low write rate (${diag.writeRate.toFixed(0)}%) — mostly constrained`
    : "Review constraint balance";

  // ── F. Strategy Balance (5%) ──
  let strat = 10;
  if (missingMin > 0) strat -= Math.min(4, missingMin * 1);
  if (missingMin === 0 && effectiveConstraints > 300 && writes < 5) strat -= 0.5;
  const stratDetail = missingMin > 0
    ? `${missingMin} item(s) missing min price`
    : strat >= 9.5
    ? "Setup complete, strategy well balanced"
    : strat >= 8.5
    ? "Setup complete — slightly defensive posture"
    : "Setup complete — heavily constrained by rules";

  // ── G. Optimization Activity (20%) ──
  // Uses proper activation rate: unique changed ASINs / unique evaluated ASINs (same 24h window)
  let optAct = 10;
  const uniqueEval = diag.uniqueEvaluatedAsins24h;
  const uniqueChanged = diag.uniqueChangedAsins24h;
  const totalWrites = diag.totalWrites24h;
  const activationRate = uniqueEval > 0 ? (uniqueChanged / uniqueEval) * 100 : 0;
  const writesPerChanged = uniqueChanged > 0 ? totalWrites / uniqueChanged : 0;
  const dispatchableRatio = effectiveHotTotal > 0 ? (dispatchableHot / effectiveHotTotal) * 100 : 100;

  // Activation rate scoring — what % of evaluated ASINs actually got a price change
  if (activationRate < 5) optAct -= 4;
  else if (activationRate < 15) optAct -= 2.5;
  else if (activationRate < 25) optAct -= 1.5;
  else if (activationRate < 40) optAct -= 0.5;

  // Absolute write volume — even with good activation, few writes = limited activity
  if (totalWrites < 20) optAct -= 2;
  else if (totalWrites < 50) optAct -= 1;
  else if (totalWrites < 100) optAct -= 0.5;

  // Dispatchable HOT ratio — how much of your fast lane is actionable
  if (effectiveHotTotal > 0) {
    if (dispatchableRatio < 10) optAct -= 1.5;
    else if (dispatchableRatio < 30) optAct -= 1;
    else if (dispatchableRatio < 50) optAct -= 0.5;
  }

  // If heavy "No Competitors" + "BB Owner Hold" dominate constraints, optimization is limited by market
  const noCompetitors = blockerBucketsArg?.noCompetitors ?? 0;
  const bbOwnerHold = blockerBucketsArg?.bbOwnerHold ?? 0;
  const protectionHeavy = noCompetitors + bbOwnerHold;
  if (q.eligibleAssignments > 0 && protectionHeavy / q.eligibleAssignments > 0.4) optAct -= 1;
  else if (q.eligibleAssignments > 0 && protectionHeavy / q.eligibleAssignments > 0.25) optAct -= 0.5;

  const optActDetail = (() => {
    if (uniqueEval === 0) return "No evaluations yet today";
    const rateStr = `${Math.round(activationRate)}% activation`;
    const volStr = `${totalWrites} writes, ${uniqueChanged}/${uniqueEval} ASINs changed`;
    if (optAct >= 9) return `Strong output — ${rateStr}, ${volStr}`;
    if (optAct >= 7) return `Moderate activity — ${rateStr}, ${volStr}`;
    if (optAct >= 5) return `Low activity — ${rateStr}, ${volStr}`;
    return `Very low output — ${rateStr}, mostly guard-blocked`;
  })();

  // ── Compute KPIs ──
  const actionableEligible = q.eligibleAssignments - protectionHeavy;
  const actionableEligibleRate = q.eligibleAssignments > 0
    ? (actionableEligible / q.eligibleAssignments) * 100 : 100;
  const protectionWeightPct = q.eligibleAssignments > 0
    ? (protectionHeavy / q.eligibleAssignments) * 100 : 0;

  const kpis: OperationalKPIs = {
    dispatchableHotRatio: effectiveHotTotal > 0 ? Math.round(dispatchableRatio) : 100,
    activationRate: Math.round(activationRate * 10) / 10,
    actionableEligibleRate: Math.round(actionableEligibleRate),
    protectionWeight: Math.round(protectionWeightPct),
    uniqueEvaluated: uniqueEval,
    uniqueChanged,
    totalWrites,
    writesPerChanged: Math.round(writesPerChanged * 100) / 100,
  };

  const categories: CategoryScore[] = [
    { label: "System Health",           score: clamp(sys),    weight: 0.20, icon: <Heart className="h-3.5 w-3.5" />,    detail: sysDetail },
    { label: "HOT Responsiveness",      score: clamp(hot),    weight: 0.20, icon: <Zap className="h-3.5 w-3.5" />,      detail: hotDetail },
    { label: "Optimization Activity",   score: clamp(optAct), weight: 0.20, icon: <Activity className="h-3.5 w-3.5" />, detail: optActDetail },
    { label: "Coverage",                score: clamp(cov),    weight: 0.15, icon: <BarChart3 className="h-3.5 w-3.5" />, detail: covDetail },
    { label: "Data Quality",            score: clamp(dq),     weight: 0.10, icon: <Database className="h-3.5 w-3.5" />,  detail: dqDetail },
    { label: "Profit Protection",       score: clamp(prot),   weight: 0.10, icon: <Shield className="h-3.5 w-3.5" />,    detail: protDetail },
    { label: "Strategy Balance",        score: clamp(strat),  weight: 0.05, icon: <Settings className="h-3.5 w-3.5" />,  detail: stratDetail },
  ];

  return { categories, kpis };
}

function scoreColor(s: number) {
  if (s >= 9.5) return "text-green-600 dark:text-green-400";
  if (s >= 8.5) return "text-green-600 dark:text-green-400";
  if (s >= 7) return "text-amber-600 dark:text-amber-400";
  if (s >= 5) return "text-orange-600 dark:text-orange-400";
  return "text-destructive";
}

function scoreLabel(s: number) {
  if (s >= 9.5) return { text: "Excellent", emoji: "🟢" };
  if (s >= 8.5) return { text: "Strong", emoji: "🟢" };
  if (s >= 7) return { text: "Needs Tuning", emoji: "🟡" };
  if (s >= 5) return { text: "Needs Attention", emoji: "🟠" };
  return { text: "Critical", emoji: "🔴" };
}

function progressColor(s: number) {
  if (s >= 9.5) return "bg-green-500";
  if (s >= 8.5) return "bg-green-500";
  if (s >= 7) return "bg-amber-500";
  if (s >= 5) return "bg-orange-500";
  return "bg-destructive";
}

function scoreSummary(s: number, isConstrained?: boolean): string {
  if (s >= 9.5 && !isConstrained) return "Your repricer is running reliably, reacting quickly, and actively optimizing. No action needed.";
  if (s >= 9.5 && isConstrained) return "System is healthy but mostly guard-blocked — high score reflects protection, not active optimization.";
  if (s >= 8.5 && isConstrained) return "System is protected and stable, but low write output limits optimization potential.";
  if (s >= 8.5) return "Your repricer is performing well. Minor improvements possible but overall strong.";
  if (s >= 7) return "System is healthy but optimization output is limited — review write volume and guard balance.";
  if (s >= 5) return "Several areas need attention. Review the breakdown below to improve.";
  return "Your repricer needs immediate attention. Check the areas marked in red.";
}

function headroomLabel(quotaErrors: number, dispatchableHot: number, eligiblePct: number): { text: string; color: string } | null {
  if (quotaErrors < 20) return null;
  if (dispatchableHot === 0 && quotaErrors > 30) {
    return { text: `⚠️ Headroom untested — ${quotaErrors} quota errors but 0 actionable HOT`, color: "text-amber-600 dark:text-amber-400" };
  }
  if (quotaErrors > 50 && eligiblePct < 95) {
    return { text: `⚠️ Capacity pressure — ${quotaErrors} quota errors affecting rotation`, color: "text-amber-600 dark:text-amber-400" };
  }
  if (quotaErrors > 30) {
    return { text: `Quota friction: ${quotaErrors} errors/24h — monitor if HOT demand increases`, color: "text-muted-foreground" };
  }
  return null;
}

function KpiStrip({ kpis }: { kpis: OperationalKPIs }) {
  const items = [
    { label: "Activation", value: `${kpis.activationRate}%`, hint: `${kpis.uniqueChanged} changed / ${kpis.uniqueEvaluated} evaluated ASINs (24h)` },
    { label: "Writes", value: `${kpis.totalWrites}`, hint: `${kpis.totalWrites} total writes, ${kpis.writesPerChanged} avg per changed ASIN` },
    { label: "Disp. HOT", value: `${kpis.dispatchableHotRatio}%`, hint: "Dispatchable / Total HOT" },
    { label: "Actionable", value: `${kpis.actionableEligibleRate}%`, hint: "Eligible not in stable hold (No-Comp / BB-Owner)" },
  ];
  return (
    <div className="grid grid-cols-4 gap-2 rounded-lg border border-border bg-muted/30 p-2">
      {items.map((item) => (
        <div key={item.label} className="text-center" title={item.hint}>
          <div className="text-[10px] text-muted-foreground font-medium">{item.label}</div>
          <div className="text-sm font-bold tabular-nums text-foreground">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export default function RepricerHealthScore({ data, freshnessData, missingMinCount, writes24h, blockerBuckets, quotaTimeWindow }: Props) {
  const { user } = useAuth();
  const [diag, setDiag] = useState<DiagnosticSignals>(EMPTY_DIAG);
  const [showBreakdown, setShowBreakdown] = useState(true);
  const [stableScore, setStableScore] = useState<number | null>(null);

  const fetchDiagnostics = useCallback(async () => {
    if (!user) return;
    try {
      const now = Date.now();
      const fifteenMinAgo = now - 15 * 60 * 1000;
      const toCents = (v: number | null | undefined) => Math.round((v ?? 0) * 100);

      const [assignRes, invRes, alertRes, ackRes, dispatchRes, snapRes, ack24hRes] = await Promise.all([
        supabase
          .from("repricer_assignments")
          .select("asin, sku, marketplace, last_sp_api_check_at, last_evaluated_at, is_priority, last_buybox_status, last_price_change_at, last_applied_price, last_buybox_price, min_price_override, rule_id, last_skip_reason")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .eq("status", "active")
          .eq("marketplace", "US")
          .not("min_price_override", "is", null)
          .gt("min_price_override", 0),
        supabase
          .from("inventory")
          .select("sku, available")
          .eq("user_id", user.id),
        supabase
          .from("bb_price_alerts")
          .select("asin")
          .eq("user_id", user.id)
          .eq("dismissed", false)
          .eq("acted", false),
        supabase
          .from("repricer_eval_acks")
          .select("result")
          .eq("user_id", user.id)
          .gte("acked_at", new Date(now - 60 * 60 * 1000).toISOString())
          .limit(2000),
        supabase
          .from("repricer_dispatch_metrics")
          .select("total_dispatched, total_evaluated, total_applied, top_reasons")
          .eq("user_id", user.id)
          .order("cycle_started_at", { ascending: false })
          .limit(1),
        supabase
          .from("repricer_competitor_snapshots")
          .select("asin, offers_count")
          .eq("user_id", user.id)
          .eq("marketplace", "US")
          .gte("fetched_at", new Date(now - 24 * 60 * 60 * 1000).toISOString())
          .limit(500),
        // 24h eval acks with ASIN for proper activation rate
        supabase
          .from("repricer_eval_acks")
          .select("asin, result")
          .eq("user_id", user.id)
          .gte("acked_at", new Date(now - 24 * 60 * 60 * 1000).toISOString())
          .limit(5000),
      ]);

      const stockMap = new Map<string, boolean>();
      for (const inv of invRes.data || []) stockMap.set(inv.sku, (inv.available || 0) > 0);
      const alertedAsins = new Set((alertRes.data || []).map((a: any) => a.asin));

      let healthy = 0, breach = 0, severe = 0, critical = 0, hotTotal = 0;
      let dHealthy = 0, dBreach = 0, dSevere = 0, dCritical = 0, dispatchableHotCount = 0;
      for (const a of assignRes.data || []) {
        if (!(stockMap.get(a.sku) ?? false)) continue;
        const starred = !!a.is_priority;
        const bbAlert = alertedAsins.has(a.asin);
        const losingBb = !!(a.last_buybox_status && a.last_buybox_status !== "winning");
        let aboveBbGap = 0;
        if (a.last_applied_price && a.last_buybox_price) {
          const gap = toCents(a.last_applied_price) - toCents(a.last_buybox_price);
          if (gap > 0) aboveBbGap = gap;
        }
        const recentChange = a.last_price_change_at && new Date(a.last_price_change_at).getTime() > fifteenMinAgo;
        const isHot = starred || bbAlert || (losingBb && aboveBbGap >= 5) || (!!recentChange && losingBb);
        if (!isHot) continue;
        hotTotal++;

        const isBbOwner = a.last_buybox_status === "winning";
        const skipReason = (a.last_skip_reason || "").toLowerCase();
        const isFloorHeld = skipReason.includes("floor") || skipReason.includes("lowest") || skipReason.includes("min_price") || skipReason.includes("already winning");
        const isBlocked = isBbOwner || isFloorHeld;

        const evalTs = a.last_evaluated_at ? new Date(a.last_evaluated_at).getTime() : 0;
        const spTs = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
        const ageMin = Math.max(evalTs, spTs) ? (now - Math.max(evalTs, spTs)) / 60000 : 9999;
        const isAbandoned = ageMin > 1440;
        if (ageMin >= 120 && !isAbandoned) critical++;
        else if (ageMin >= 60 && !isAbandoned) severe++;
        else if (ageMin >= 20) breach++;
        else if (!isAbandoned) healthy++;

        if (!isBlocked && !isAbandoned) {
          dispatchableHotCount++;
          if (ageMin >= 120) dCritical++;
          else if (ageMin >= 60) dSevere++;
          else if (ageMin >= 20) dBreach++;
          else dHealthy++;
        }
      }

      let spApiThrottled = 0;
      for (const a of assignRes.data || []) {
        if ((a.last_skip_reason || "").toLowerCase().includes("throttl")) spApiThrottled++;
      }

      const acks = ackRes.data || [];
      const changedCount = acks.filter((a: any) => a.result === "changed").length;
      const writeRate = acks.length > 0 ? (changedCount / acks.length) * 100 : 0;

      let hotSlots = 0;
      if (dispatchRes.data && dispatchRes.data.length > 0) {
        const reasons = (dispatchRes.data[0] as any).top_reasons || {};
        for (const [key, val] of Object.entries(reasons)) {
          if (key.includes("hot_") || key === "starred" || key === "bb_alert" || key === "losing_bb" || key.includes("cooldown_expired")) {
            hotSlots += val as number;
          }
        }
      }

      const tailTrend: "improving" | "stable" | "degrading" = "stable";

      const snaps = snapRes.data || [];
      const seenAsins = new Map<string, boolean>();
      for (const s of snaps) {
        if (!seenAsins.has((s as any).asin)) {
          seenAsins.set((s as any).asin, ((s as any).offers_count ?? 0) > 0);
        }
      }
      const totalSnapped = seenAsins.size;
      const noOfferCount = [...seenAsins.values()].filter(v => !v).length;
      const noOfferPct = totalSnapped > 0 ? (noOfferCount / totalSnapped) * 100 : 0;

      // Compute proper activation metrics from 24h acks
      const acks24h = ack24hRes.data || [];
      const evaluatedSet24h = new Set<string>();
      const changedSet24h = new Set<string>();
      let totalWrites24hCount = 0;
      for (const a of acks24h) {
        const asin = (a as any).asin;
        if (asin) evaluatedSet24h.add(asin);
        if ((a as any).result === "changed") {
          totalWrites24hCount++;
          if (asin) changedSet24h.add(asin);
        }
      }

      setDiag({
        hotSeverity: { healthy, breach, severe, critical },
        hotSeverityDispatchable: { healthy: dHealthy, breach: dBreach, severe: dSevere, critical: dCritical },
        tailTrend,
        hotSlots,
        hotTotal,
        dispatchableHotCount,
        spApiThrottled,
        writeRate,
        noOfferPct,
        uniqueEvaluatedAsins24h: evaluatedSet24h.size,
        uniqueChangedAsins24h: changedSet24h.size,
        totalWrites24h: totalWrites24hCount,
      });
    } catch (e) {
      console.error("Health score diagnostics error:", e);
    }
  }, [user]);

  useEffect(() => { fetchDiagnostics(); }, [fetchDiagnostics]);

  const { categories, kpis } = computeScores(data, freshnessData, missingMinCount, writes24h, diag, blockerBuckets, quotaTimeWindow);
  const rawScore = Math.round(categories.reduce((sum, c) => sum + c.score * c.weight, 0) * 10) / 10;

  // Stabilize displayed score — only update if change exceeds 0.3 to prevent jitter
  useEffect(() => {
    setStableScore(prev => {
      if (prev === null) return rawScore;
      return Math.abs(rawScore - prev) >= 0.3 ? rawScore : prev;
    });
  }, [rawScore]);

  const finalScore = stableScore ?? rawScore;

  const fmHotTotal = (freshnessData?.hotCount ?? 0) > 0 ? freshnessData!.hotCount : diag.hotTotal;
  const fmDispatchable = (freshnessData?.hotCount ?? 0) > 0
    ? (freshnessData?.hotDispatchableCount ?? (freshnessData!.hotCount - (freshnessData?.hotBlockedCount ?? 0)))
    : diag.dispatchableHotCount;
  const allHotBlocked = fmHotTotal > 0 && fmDispatchable === 0;
  const mostHotBlocked = fmHotTotal > 2 && fmDispatchable / fmHotTotal < 0.3;

  const isConstrainedState = allHotBlocked || mostHotBlocked || (diag.writeRate < 5 && writes24h < 10 && data.quotaHealth.eligibleAssignments > 50);
  const label = scoreLabel(finalScore);

  return (
    <Card className="border-primary/20 bg-background/95 shadow-sm">
      <CardContent className="p-4 space-y-4">
        {/* Header with big score */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Trophy className="h-5 w-5 text-primary" />
            <span className="text-base font-bold text-foreground">Repricer Score</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-3xl font-black tabular-nums ${scoreColor(finalScore)}`}>
              {finalScore.toFixed(1)}
            </span>
            <span className="text-lg text-muted-foreground font-medium">/ 10</span>
          </div>
        </div>

        {/* Label badge + summary */}
        <div className="flex items-start gap-2">
          <Badge
            variant="outline"
            className={`text-xs font-semibold shrink-0 ${scoreColor(finalScore)} border-current/30`}
          >
            {label.emoji} {isConstrainedState ? "Healthy & Protected" : label.text}
          </Badge>
          <span className="text-xs text-muted-foreground">{scoreSummary(finalScore, isConstrainedState)}</span>
        </div>

        {/* Operational KPI strip */}
        <KpiStrip kpis={kpis} />

        {/* Operating headroom warning */}
        {(() => {
          const eligPct = data.quotaHealth.eligibleAssignments > 0
            ? (data.quotaHealth.checkedEligibleToday / data.quotaHealth.eligibleAssignments) * 100 : 100;
          const hw = headroomLabel(data.quotaHealth.quotaErrorWindows?.[quotaTimeWindow === "1h" ? "h1" : quotaTimeWindow === "4h" ? "h4" : quotaTimeWindow === "12h" ? "h12" : "h24"] ?? data.quotaHealth.quotaErrors24h, fmDispatchable, eligPct);
          if (!hw) return null;
          return (
            <div className={`text-[11px] px-2.5 py-1.5 rounded-md border border-amber-500/20 bg-amber-50/50 dark:bg-amber-950/20 ${hw.color}`}>
              {hw.text}
            </div>
          );
        })()}

        {/* Toggle breakdown */}
        <button
          onClick={() => setShowBreakdown(!showBreakdown)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {showBreakdown ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {showBreakdown ? "Hide breakdown" : "Show breakdown"}
        </button>

        {/* Category breakdown */}
        {showBreakdown && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {categories.map((cat) => (
              <div key={cat.label} className="flex items-center gap-3 rounded-lg border border-border p-2.5">
                <div className="shrink-0 text-muted-foreground">{cat.icon}</div>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">{cat.label}</span>
                    <span className={`text-xs font-bold tabular-nums ${scoreColor(cat.score)}`}>
                      {cat.score.toFixed(1)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${progressColor(cat.score)}`}
                      style={{ width: `${cat.score * 10}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">{cat.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
