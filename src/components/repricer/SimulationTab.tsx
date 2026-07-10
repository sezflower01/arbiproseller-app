import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FlaskConical, Plus, Trash2, Loader2, AlertTriangle, Trophy, Heart, Zap, BarChart3, Shield, Database, Settings, ChevronDown, ChevronUp, Brain } from "lucide-react";
import CapacityStressTest from "./CapacityStressTest";
import ProductionValidationPanel from "./ProductionValidationPanel";

type Scenario = "normal" | "hot_heavy" | "high_competition" | "profit_guard" | "no_competitors" | "stale_stress";

const SCENARIO_LABELS: Record<Scenario, string> = {
  normal: "Normal Catalog Mix",
  hot_heavy: "HOT Heavy Load",
  high_competition: "High Competition",
  profit_guard: "Profit Guard Heavy",
  no_competitors: "No Competitors",
  stale_stress: "Stale / Recovery Stress",
};

const SCENARIO_DESCRIPTIONS: Record<Scenario, string> = {
  normal: "5% HOT, 20% WARM, 75% COLD — realistic distribution",
  hot_heavy: "30% HOT, 40% WARM, 30% COLD — stress test HOT lane",
  high_competition: "15% HOT, 50% WARM, 35% COLD — many competitive lowers",
  profit_guard: "5% HOT, 15% WARM, 80% COLD — most blocked by profit guards",
  no_competitors: "3% HOT, 10% WARM, 87% COLD — most have no competitors",
  stale_stress: "25% HOT (half stale), 25% WARM, 50% COLD — tests stale detection",
};

interface SimRun {
  id: string;
  name: string | null;
  scenario: string;
  item_count: number;
  created_at: string;
}

function getScenarioDistribution(scenario: Scenario, count: number) {
  let hotPct: number, warmPct: number;
  switch (scenario) {
    case "hot_heavy":        hotPct = 0.30; warmPct = 0.40; break;
    case "high_competition": hotPct = 0.15; warmPct = 0.50; break;
    case "profit_guard":     hotPct = 0.05; warmPct = 0.15; break;
    case "no_competitors":   hotPct = 0.03; warmPct = 0.10; break;
    case "stale_stress":     hotPct = 0.25; warmPct = 0.25; break;
    default:                 hotPct = 0.05; warmPct = 0.20; break;
  }
  const hot = Math.round(count * hotPct);
  const warm = Math.round(count * warmPct);
  const cold = count - hot - warm;
  const blocked = Math.round(hot * 0.55 + warm * 0.05);
  const dispatchable = count - blocked;
  return { hot, warm, cold, blocked, dispatchable };
}

function generateFakeAsin(index: number): string {
  return `SIM${String(index).padStart(7, "0")}`;
}

function buildSimItems(runId: string, userId: string, count: number, scenario: Scenario) {
  const items: any[] = [];
  const tiers = getTierDistribution(scenario, count);
  let idx = Date.now();

  for (const item of tiers) {
    idx++;
    const asin = generateFakeAsin(idx % 10000000);
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60000).toISOString();

    items.push({
      run_id: runId,
      user_id: userId,
      asin,
      marketplace: "US",
      tier: item.tier,
      is_dispatchable: item.dispatchable,
      block_reason: item.blockReason || null,
      is_bb_owner: item.bbOwner,
      current_price: +(15 + Math.random() * 85).toFixed(2),
      bb_price: item.bbPrice,
      next_competitor_price: item.nextComp,
      min_price: +(10 + Math.random() * 20).toFixed(2),
      max_price: +(60 + Math.random() * 140).toFixed(2),
      last_evaluated_at: item.lastEval ? minutesAgo(item.lastEval) : null,
      became_hot_at: item.tier === "HOT" ? minutesAgo(item.hotAge || 10) : null,
      eval_result: item.evalResult,
      constraint_reason: item.constraint || null,
    });
  }
  return items;
}

interface TierItem {
  tier: string;
  dispatchable: boolean;
  blockReason?: string;
  bbOwner: boolean;
  bbPrice: number | null;
  nextComp: number | null;
  lastEval: number | null;
  hotAge?: number;
  evalResult: string;
  constraint?: string;
}

function getTierDistribution(scenario: Scenario, count: number): TierItem[] {
  const items: TierItem[] = [];
  let hotPct: number, warmPct: number;

  switch (scenario) {
    case "hot_heavy":        hotPct = 0.30; warmPct = 0.40; break;
    case "high_competition": hotPct = 0.15; warmPct = 0.50; break;
    case "profit_guard":     hotPct = 0.05; warmPct = 0.15; break;
    case "no_competitors":   hotPct = 0.03; warmPct = 0.10; break;
    case "stale_stress":     hotPct = 0.25; warmPct = 0.25; break;
    default:                 hotPct = 0.05; warmPct = 0.20; break;
  }

  const hotCount = Math.round(count * hotPct);
  const warmCount = Math.round(count * warmPct);
  const coldCount = count - hotCount - warmCount;

  for (let i = 0; i < hotCount; i++) {
    const r = Math.random();
    const isStale = scenario === "stale_stress" && i < hotCount * 0.5;
    if (r < 0.3) {
      items.push({ tier: "HOT", dispatchable: false, blockReason: "bb_owner_stable", bbOwner: true, bbPrice: +(20 + Math.random() * 30).toFixed(2) as any, nextComp: null, lastEval: isStale ? 120 + Math.random() * 200 : 5 + Math.random() * 20, evalResult: "no_change", constraint: "BB Owner Hold" });
    } else if (r < 0.55) {
      items.push({ tier: "HOT", dispatchable: false, blockReason: "floor_lowest", bbOwner: false, bbPrice: +(18 + Math.random() * 20).toFixed(2) as any, nextComp: +(19 + Math.random() * 20).toFixed(2) as any, lastEval: isStale ? 90 + Math.random() * 150 : 8 + Math.random() * 15, evalResult: "no_change", constraint: "Min Floor" });
    } else if (r < 0.8) {
      items.push({ tier: "HOT", dispatchable: true, bbOwner: false, bbPrice: +(22 + Math.random() * 30).toFixed(2) as any, nextComp: +(21 + Math.random() * 28).toFixed(2) as any, lastEval: isStale ? 60 + Math.random() * 120 : 3 + Math.random() * 12, hotAge: 5 + Math.random() * 30, evalResult: "competitive_lower" });
    } else {
      items.push({ tier: "HOT", dispatchable: false, blockReason: "cooldown", bbOwner: false, bbPrice: +(25 + Math.random() * 25).toFixed(2) as any, nextComp: +(24 + Math.random() * 24).toFixed(2) as any, lastEval: 2 + Math.random() * 8, evalResult: "no_change", constraint: "Cooldown" });
    }
  }

  for (let i = 0; i < warmCount; i++) {
    const r = Math.random();
    items.push({
      tier: "WARM", dispatchable: true, bbOwner: r < 0.3,
      bbPrice: +(20 + Math.random() * 40).toFixed(2) as any,
      nextComp: r < 0.4 ? null : +(19 + Math.random() * 38).toFixed(2) as any,
      lastEval: 10 + Math.random() * 120,
      evalResult: r < 0.2 ? "competitive_lower" : r < 0.4 ? "buy_box_raise" : "no_change",
      constraint: r < 0.15 ? "Profit Guard" : undefined,
    });
  }

  for (let i = 0; i < coldCount; i++) {
    const r = Math.random();
    items.push({
      tier: "COLD", dispatchable: true, bbOwner: r < 0.4,
      bbPrice: +(15 + Math.random() * 50).toFixed(2) as any,
      nextComp: r < 0.5 ? null : +(14 + Math.random() * 48).toFixed(2) as any,
      lastEval: 60 + Math.random() * 1380,
      evalResult: "no_change",
      constraint: r < 0.1 ? "No Competitors" : r < 0.2 ? "Min Floor" : undefined,
    });
  }

  return items;
}

/* ── Simulated Score Calculator (from run metadata, not DB fetch) ── */
interface SimScoreCategory {
  label: string;
  score: number;
  weight: number;
  icon: React.ReactNode;
  detail: string;
}

function computeSimulatedScoresFromRuns(runs: SimRun[]): SimScoreCategory[] {
  if (runs.length === 0) return [];

  let totalItems = 0, totalHot = 0, totalWarm = 0;
  let staleStressHotDisp = 0;

  for (const run of runs) {
    const count = run.item_count;
    const sc = run.scenario as Scenario;
    totalItems += count;
    let hp: number, wp: number;
    switch (sc) {
      case "hot_heavy":        hp = 0.30; wp = 0.40; break;
      case "high_competition": hp = 0.15; wp = 0.50; break;
      case "profit_guard":     hp = 0.05; wp = 0.15; break;
      case "no_competitors":   hp = 0.03; wp = 0.10; break;
      case "stale_stress":     hp = 0.25; wp = 0.25; break;
      default:                 hp = 0.05; wp = 0.20; break;
    }
    const hot = Math.round(count * hp);
    totalHot += hot;
    totalWarm += Math.round(count * wp);
    if (sc === "stale_stress") {
      const dispHot = Math.round(hot * 0.25);
      staleStressHotDisp += Math.round(dispHot * 0.5);
    }
  }

  const dispatchableHot = Math.round(totalHot * 0.45);
  const clamp = (v: number) => Math.max(0, Math.min(10, v));

  // ═══════════════════════════════════════════════
  // Phase 2: Adaptive Hybrid Mode Simulation
  // ═══════════════════════════════════════════════
  // Model: ~55% of stuck HOT items auto-switch to Basic mode
  // Basic mode evals are ~3x faster (no AI calls, no external fetch)
  const stuckHotItems = Math.round(totalHot * 0.55); // blocked by floor/bb_owner/cooldown
  const basicModeItems = Math.round(stuckHotItems * 0.60); // 60% of stuck items meet auto-switch criteria
  const smartModeItems = totalItems - basicModeItems;
  // Basic items reduce effective dispatchable HOT load
  const effectiveDispatchableHot = Math.max(0, dispatchableHot - Math.round(basicModeItems * 0.3));
  const basicSpeedup = basicModeItems > 0 ? 0.35 : 0; // 35% faster overall when basic is active

  // ── System Health ──
  let sys = 10;
  if (totalItems > 10000) sys -= 0.8; // slightly better with hybrid
  else if (totalItems > 5000) sys -= 0.3;
  if (totalHot > 2000) sys -= 0.3;
  // Basic mode reduces system load
  if (basicModeItems > 100) sys += Math.min(0.5, basicModeItems * 0.001);
  const sysDetail = sys >= 9.5 ? "Running reliably" : sys >= 8 ? "Minor issues detected" : `Scale pressure (${totalItems.toLocaleString()} items)`;

  // ── HOT Responsiveness ── (major Phase 2 improvement)
  let hot = 10;
  let estP90 = 0;
  if (effectiveDispatchableHot <= 20) estP90 = 4;
  else if (effectiveDispatchableHot <= 50) estP90 = 10;
  else if (effectiveDispatchableHot <= 100) estP90 = 20;
  else if (effectiveDispatchableHot <= 300) estP90 = 35;
  else if (effectiveDispatchableHot <= 500) estP90 = 55;
  else if (effectiveDispatchableHot <= 1000) estP90 = 90;
  else estP90 = 140;

  // Apply basic mode speedup bonus
  estP90 = Math.round(estP90 * (1 - basicSpeedup));

  if (staleStressHotDisp > 0) hot -= Math.min(3, staleStressHotDisp * 0.015);
  if (estP90 > 60) hot -= 1.5;
  else if (estP90 > 30) hot -= 0.5;
  const estBreach = effectiveDispatchableHot > 100 ? Math.round(effectiveDispatchableHot * 0.10) : 0;
  const estSevere = effectiveDispatchableHot > 300 ? Math.round(effectiveDispatchableHot * 0.03) : 0;
  if (staleStressHotDisp > 0) hot -= Math.min(2, staleStressHotDisp * 0.008);
  if (estSevere > 0) hot -= Math.min(1.5, estSevere * 0.004);
  if (estBreach > 0) hot -= Math.min(0.8, estBreach * 0.002);

  const basicPct = totalItems > 0 ? Math.round((basicModeItems / totalItems) * 100) : 0;
  const hotDetail = staleStressHotDisp === 0 && estP90 <= 30
    ? `Reacting quickly to urgent listings${basicPct > 0 ? ` (${basicPct}% Basic mode)` : ""}`
    : staleStressHotDisp > 0
    ? `~${staleStressHotDisp} urgent item(s) at risk, ${basicPct}% on Basic mode`
    : `Responding with delays (est. p90 ~${Math.round(estP90)}m), ${basicPct}% Basic mode active`;

  // ── Coverage ── (slightly better with hybrid)
  let cov = 10;
  const basicBoost = basicModeItems > 0 ? 1.15 : 1; // Basic evals free up capacity
  const checksPerDay = Math.min(totalItems, 240 * 24 * 0.7 * basicBoost);
  const estCov = totalItems > 0 ? Math.min(100, (checksPerDay / totalItems) * 100) : 100;
  if (estCov < 80) cov -= 3;
  else if (estCov < 90) cov -= 2;
  else if (estCov < 95) cov -= 0.5;
  const covDetail = estCov >= 95 ? `Excellent catalog coverage (${Math.round(estCov)}%)`
    : estCov >= 80 ? `Good coverage (${Math.round(estCov)}%), some items pending`
    : `Low coverage (${Math.round(estCov)}%), many items not checked`;

  // ── Data Quality ──
  let dq = 10;
  const noCompItems = runs.filter(r => r.scenario === "no_competitors").reduce((s, r) => s + Math.round(r.item_count * 0.5), 0);
  const noCompPct = totalItems > 0 ? (noCompItems / totalItems) * 100 : 0;
  if (noCompPct > 50) dq -= 1.5;
  else if (noCompPct > 30) dq -= 0.5;
  const dqDetail = dq >= 9.5 ? "Clean data for good decisions" : `${Math.round(noCompPct)}% items missing competitor data`;

  // ── Profit Protection ──
  let prot = 10;
  const pgItems = runs.filter(r => r.scenario === "profit_guard").reduce((s, r) => s + r.item_count, 0);
  if (pgItems > totalItems * 0.5) prot -= 1;
  const estWriteRate = totalItems > 0 ? Math.min(30, (dispatchableHot * 0.6 / totalItems) * 100) : 15;
  if (estWriteRate < 5 && totalItems > 1000) prot -= 1;
  else if (estWriteRate < 10) prot -= 0.5;
  const protDetail = prot >= 9 ? "Protecting profit appropriately" : `Write rate estimated ~${estWriteRate.toFixed(0)}%`;

  // ── Setup Readiness ──
  const setup = 10;
  const setupDetail = "Setup complete, ready to reprice";

  return [
    { label: "System Health",       score: clamp(sys),   weight: 0.25, icon: <Heart className="h-3.5 w-3.5" />,      detail: sysDetail },
    { label: "HOT Responsiveness",  score: clamp(hot),   weight: 0.30, icon: <Zap className="h-3.5 w-3.5" />,        detail: hotDetail },
    { label: "Coverage",            score: clamp(cov),   weight: 0.15, icon: <BarChart3 className="h-3.5 w-3.5" />,   detail: covDetail },
    { label: "Data Quality",        score: clamp(dq),    weight: 0.10, icon: <Database className="h-3.5 w-3.5" />,    detail: dqDetail },
    { label: "Profit Protection",   score: clamp(prot),  weight: 0.10, icon: <Shield className="h-3.5 w-3.5" />,      detail: protDetail },
    { label: "Setup Readiness",     score: clamp(setup), weight: 0.10, icon: <Settings className="h-3.5 w-3.5" />,    detail: setupDetail },
  ];
}

/* ── Simulated Score Card ── */
function SimulatedScoreCard({ runs }: { runs: SimRun[] }) {
  const [showBreakdown, setShowBreakdown] = useState(true);

  const categories = computeSimulatedScoresFromRuns(runs);
  if (categories.length === 0 && runs.length === 0) return null;

  const finalScore = categories.length > 0
    ? categories.reduce((s, c) => s + c.score * c.weight, 0) / categories.reduce((s, c) => s + c.weight, 0)
    : 0;
  const finalRounded = +finalScore.toFixed(1);

  const label = finalRounded >= 9.5 ? "Excellent" : finalRounded >= 8.5 ? "Strong" : finalRounded >= 7.0 ? "Needs Tuning" : finalRounded >= 5.0 ? "Needs Attention" : "Critical";
  const color = finalRounded >= 8.5 ? "text-emerald-500" : finalRounded >= 7.0 ? "text-yellow-500" : finalRounded >= 5.0 ? "text-orange-500" : "text-destructive";
  const badgeColor = finalRounded >= 8.5 ? "🟢" : finalRounded >= 7.0 ? "🟡" : finalRounded >= 5.0 ? "🟠" : "🔴";
  const description = finalRounded >= 9.5
    ? "Your repricer is running reliably, reacting quickly, and protecting profit well. No action needed."
    : finalRounded >= 8.5
    ? "Your repricer is performing well. Minor improvements possible but overall strong."
    : finalRounded >= 7.0
    ? "Some areas need tuning. Review the breakdown below for specific improvements."
    : "Multiple areas need attention. Check the breakdown for priority fixes.";

  const totalSim = runs.reduce((s, r) => s + (r.item_count || 0), 0);

  // Compute Smart vs Basic distribution for display
  let simTotalHot = 0;
  for (const run of runs) {
    const sc = run.scenario as Scenario;
    let hp: number;
    switch (sc) {
      case "hot_heavy": hp = 0.30; break;
      case "high_competition": hp = 0.15; break;
      case "profit_guard": hp = 0.05; break;
      case "no_competitors": hp = 0.03; break;
      case "stale_stress": hp = 0.25; break;
      default: hp = 0.05; break;
    }
    simTotalHot += Math.round(run.item_count * hp);
  }
  const simStuckHot = Math.round(simTotalHot * 0.55);
  const simBasicCount = Math.round(simStuckHot * 0.60);
  const simSmartCount = totalSim - simBasicCount;
  const simSmartPct = totalSim > 0 ? Math.round((simSmartCount / totalSim) * 100) : 100;
  const simBasicPct = 100 - simSmartPct;

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10">
              <Trophy className={`h-6 w-6 ${color}`} />
            </div>
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-muted-foreground">Simulated Score</span>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {totalSim.toLocaleString()} ASINs
                </Badge>
              </div>
              <div className="flex items-baseline gap-2">
                <span className={`text-3xl font-bold ${color}`}>{finalRounded}</span>
                <span className="text-muted-foreground text-lg">/ 10</span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-sm">{badgeColor}</span>
                <span className={`text-sm font-medium ${color}`}>{label}</span>
              </div>
            </div>
          </div>
        </div>

        <p className="text-sm text-muted-foreground mt-3">{description}</p>

        {/* Adaptive Hybrid Mode Distribution */}
        {totalSim > 0 && simBasicCount > 0 && (
          <div className="mt-3 p-3 rounded-lg bg-muted/50 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Brain className="h-3 w-3" />
              Adaptive Hybrid Mode
            </div>
            <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
              <div className="bg-violet-500 transition-all" style={{ width: `${simSmartPct}%` }} title={`Smart: ${simSmartCount}`} />
              <div className="bg-amber-500 transition-all" style={{ width: `${simBasicPct}%` }} title={`Basic: ${simBasicCount}`} />
            </div>
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>🧠 Smart: {simSmartCount.toLocaleString()} ({simSmartPct}%)</span>
              <span>⚡ Basic: {simBasicCount.toLocaleString()} ({simBasicPct}%)</span>
            </div>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowBreakdown(!showBreakdown)}
          className="mt-2 gap-1 text-xs px-0 text-muted-foreground hover:text-foreground"
        >
          {showBreakdown ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {showBreakdown ? "Hide" : "Show"} breakdown
        </Button>

        {showBreakdown && categories.length > 0 && (
          <div className="mt-3 space-y-2.5">
            {categories.map((cat) => {
              const pct = (cat.score / 10) * 100;
              const barColor = cat.score >= 9 ? "bg-emerald-500" : cat.score >= 7 ? "bg-yellow-500" : cat.score >= 5 ? "bg-orange-500" : "bg-destructive";
              return (
                <div key={cat.label} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-1.5">
                      {cat.icon}
                      <span className="font-medium">{cat.label}</span>
                    </div>
                    <span className={cat.score >= 9 ? "text-emerald-500 font-semibold" : cat.score >= 7 ? "text-yellow-500 font-semibold" : "text-orange-500 font-semibold"}>
                      {cat.score.toFixed(1)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground">{cat.detail}</p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SimulationTab() {
  const { user } = useAuth();
  const [runs, setRuns] = useState<SimRun[]>([]);
  const [scenario, setScenario] = useState<Scenario>("normal");
  const [loading, setLoading] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("repricer_simulation_runs")
      .select("*")
      .order("created_at", { ascending: false });
    setRuns((data as SimRun[]) || []);
  }, [user]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  const totalSimulated = runs.reduce((s, r) => s + (r.item_count || 0), 0);

  const handleGenerate = async (count: number) => {
    if (!user) return;
    setLoading(true);
    setLoadingAction(`Adding ${count}`);
    try {
      const { data: run, error: runErr } = await supabase
        .from("repricer_simulation_runs")
        .insert({ user_id: user.id, name: `${count} ${SCENARIO_LABELS[scenario]}`, scenario, item_count: count })
        .select("id")
        .single();
      if (runErr) throw runErr;

      const simItems = buildSimItems(run.id, user.id, count, scenario);

      for (let i = 0; i < simItems.length; i += 500) {
        const batch = simItems.slice(i, i + 500);
        const { error } = await supabase.from("repricer_simulation_items").insert(batch);
        if (error) throw error;
      }

      toast.success(`Generated ${count} simulated ASINs (${SCENARIO_LABELS[scenario]})`);
      fetchRuns();
    } catch (err: any) {
      toast.error("Failed: " + err.message);
    } finally {
      setLoading(false);
      setLoadingAction(null);
    }
  };

  const handleClearRun = async (runId: string) => {
    try {
      await supabase.from("repricer_simulation_runs").delete().eq("id", runId);
      toast.success("Simulation run cleared");
      fetchRuns();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleClearAll = async () => {
    if (!user) return;
    try {
      await supabase.from("repricer_simulation_runs").delete().eq("user_id", user.id);
      toast.success("All simulation data cleared");
      fetchRuns();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  return (
    <div className="space-y-6">
      {/* Production Validation — Real Measured Data */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Production Validation — Measured Results
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Real measured performance from your production system. Use this to validate scaling assumptions with actual data.
          </p>
          <ProductionValidationPanel />
        </CardContent>
      </Card>

      {/* Capacity Simulation (theoretical model) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <FlaskConical className="h-5 w-5" />
            Capacity Simulation — Architecture Load Model
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Theoretical capacity model: evals/min, fetches, DB pressure, HOT freshness. This is a math simulation — not a live stress test.
          </p>
          <CapacityStressTest />
        </CardContent>
      </Card>

      <div className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
        <AlertTriangle className="h-5 w-5 text-yellow-500 mt-0.5 shrink-0" />
        <div className="text-sm">
          <p className="font-semibold text-foreground">ASIN Simulation Mode — No real Amazon changes will be made</p>
          <p className="text-muted-foreground mt-1">
            Below: generate simulated ASINs in the database to stress-test the monitor and scoring system under larger catalog sizes.
          </p>
        </div>
      </div>

      {/* Simulated Score Card */}
      <SimulatedScoreCard runs={runs} />

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FlaskConical className="h-5 w-5" />
              Generate Simulated ASINs
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1.5 block">Scenario Preset</label>
              <Select value={scenario} onValueChange={(v) => setScenario(v as Scenario)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(SCENARIO_LABELS) as Scenario[]).map((k) => (
                    <SelectItem key={k} value={k}>{SCENARIO_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">{SCENARIO_DESCRIPTIONS[scenario]}</p>
              <div className="mt-2 grid grid-cols-5 gap-1 text-xs text-center">
                {(() => {
                  const d = getScenarioDistribution(scenario, 1000);
                  const pct = (v: number) => `${(v / 10).toFixed(0)}%`;
                  return (<>
                    <div className="rounded bg-destructive/10 p-1.5">
                      <div className="font-semibold text-destructive">🔴 HOT</div>
                      <div>{pct(d.hot)}</div>
                    </div>
                    <div className="rounded bg-orange-500/10 p-1.5">
                      <div className="font-semibold text-orange-500">🟠 WARM</div>
                      <div>{pct(d.warm)}</div>
                    </div>
                    <div className="rounded bg-muted p-1.5">
                      <div className="font-semibold text-muted-foreground">⚪ COLD</div>
                      <div>{pct(d.cold)}</div>
                    </div>
                    <div className="rounded bg-primary/10 p-1.5">
                      <div className="font-semibold text-primary">✅ Disp</div>
                      <div>{pct(d.dispatchable)}</div>
                    </div>
                    <div className="rounded bg-muted p-1.5">
                      <div className="font-semibold text-muted-foreground">🚫 Block</div>
                      <div>{pct(d.blocked)}</div>
                    </div>
                  </>);
                })()}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[1000, 2000, 3000, 4000, 5000, 10000, 20000, 30000, 40000, 50000].map((n) => (
                <Button key={n} variant="outline" disabled={loading} onClick={() => handleGenerate(n)} className="gap-1">
                  {loading && loadingAction === `Adding ${n}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  +{n.toLocaleString()} ASINs
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Simulation Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total Simulated ASINs</span>
              <Badge variant={totalSimulated > 0 ? "default" : "secondary"} className="text-lg px-3">
                {totalSimulated.toLocaleString()}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Simulation Runs</span>
              <span className="font-medium">{runs.length}</span>
            </div>
            {runs.length > 0 && (
              <Button variant="destructive" size="sm" onClick={handleClearAll} className="w-full mt-2 gap-1">
                <Trash2 className="h-4 w-4" /> Clear All Simulation Data
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      {runs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Simulation Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {runs.map((run) => {
                const d = getScenarioDistribution(run.scenario as Scenario, run.item_count);
                return (
                  <div key={run.id} className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-1 flex-1">
                      <p className="text-sm font-medium">{run.name || "Unnamed"}</p>
                      <p className="text-xs text-muted-foreground">
                        {run.item_count.toLocaleString()} items · {SCENARIO_LABELS[run.scenario as Scenario] || run.scenario} · {new Date(run.created_at).toLocaleString()}
                      </p>
                      <div className="flex gap-2 text-xs">
                        <span className="text-destructive">🔴 {d.hot}</span>
                        <span className="text-orange-500">🟠 {d.warm}</span>
                        <span className="text-muted-foreground">⚪ {d.cold}</span>
                        <span className="text-primary">✅ {d.dispatchable}</span>
                        <span className="text-muted-foreground">🚫 {d.blocked}</span>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => handleClearRun(run.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}