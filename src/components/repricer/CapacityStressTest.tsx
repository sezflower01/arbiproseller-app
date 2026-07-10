import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import {
  Server, Zap, Database, Clock, AlertTriangle, CheckCircle2, XCircle,
  Activity, HardDrive, Cpu, Users, BarChart3, Flame, Gauge
} from "lucide-react";

/* ─── Preset scenarios ─── */
interface StressPreset {
  label: string;
  desc: string;
  totalListings: number;
  userCount: number;
  hotPct: number;
  warmPct: number;
  dispatchablePct: number;
  competitorMovementPct: number;
}

const PRESETS: Record<string, StressPreset> = {
  normal: {
    label: "Normal Day",
    desc: "Average activity, low HOT ratio",
    totalListings: 500000,
    userCount: 500,
    hotPct: 5,
    warmPct: 20,
    dispatchablePct: 45,
    competitorMovementPct: 10,
  },
  busy: {
    label: "Busy Day",
    desc: "More HOT items, increased competitor movement",
    totalListings: 500000,
    userCount: 500,
    hotPct: 15,
    warmPct: 35,
    dispatchablePct: 50,
    competitorMovementPct: 25,
  },
  stress: {
    label: "Worst Case",
    desc: "HOT-heavy, bursty demand, many active users",
    totalListings: 500000,
    userCount: 500,
    hotPct: 30,
    warmPct: 40,
    dispatchablePct: 55,
    competitorMovementPct: 40,
  },
  enterprise: {
    label: "Enterprise (10K Users)",
    desc: "10,000 users × 1,000 ASINs each — enterprise scale proof",
    totalListings: 10000000,
    userCount: 10000,
    hotPct: 5,
    warmPct: 20,
    dispatchablePct: 45,
    competitorMovementPct: 10,
  },
};

/* ─── Architecture constants ─── */
const ARCH = {
  edgeFnTimeoutSec: 150,
  edgeFnConcurrency: 25,      // Micro plan
  edgeFnConcurrencyPro: 100,  // Pro plan
  edgeFnConcurrencyXL: 500,   // XL compute
  dbConnectionsMicro: 60,
  dbConnectionsPro: 200,
  dbConnectionsXL: 500,
  dispatchBatchSize: 10,
  dispatchBatchGapMs: 500,
  evalAvgMs: 800,              // avg edge function eval time
  fetchAvgMs: 1200,            // avg SP-API fetch time
  dbReadsPerEval: 4,
  dbWritesPerPriceChange: 3,
  hotCapPerHour: 8,            // CAP_HOT_UNRESOLVED
  warmCadenceMin: 30,
  coldCadenceMin: 360,
  cronIntervalSec: 120,
  maxUsersPerCycle: 50,        // sequential user processing limit
  basicModeSpeedup: 3,        // basic evals are 3x faster
};

/* ─── Simulation engine ─── */
interface SimResults {
  // Tier counts
  hotCount: number;
  warmCount: number;
  coldCount: number;
  dispatchableHot: number;

  // Throughput
  evalsPerMinute: number;
  fetchesPerMinute: number;
  writesPerMinute: number;
  priceChangesPerMinute: number;

  // Freshness
  hotP50Min: number;
  hotP90Min: number;
  fullCycleMin: number;

  // DB load
  dbReadsPerMinute: number;
  dbWritesPerMinute: number;
  dbConnectionsNeeded: number;

  // Edge Function load
  efConcurrencyNeeded: number;
  efInvocationsPerHour: number;

  // Verdicts
  hotP90Safe: boolean;
  dbSafe: boolean;
  efSafe: boolean;
  overallSafe: boolean;
  bottleneck: string;
  recommendation: string;
  requiredTier: string;
}

function runSimulation(
  totalListings: number,
  userCount: number,
  hotPct: number,
  warmPct: number,
  dispatchablePct: number,
  competitorMovementPct: number
): SimResults {
  const coldPct = 100 - hotPct - warmPct;
  const hotCount = Math.round(totalListings * hotPct / 100);
  const warmCount = Math.round(totalListings * warmPct / 100);
  const coldCount = Math.round(totalListings * coldPct / 100);
  const dispatchableHot = Math.round(hotCount * dispatchablePct / 100);

  // With hybrid mode, ~35% of stuck HOT items switch to Basic (3x faster)
  const stuckHot = hotCount - dispatchableHot;
  const basicModeHot = Math.round(stuckHot * 0.6);
  const effectiveSmartEvals = dispatchableHot;

  // HOT evals per hour per item = CAP_HOT_UNRESOLVED = 8
  // But with sequential user processing, we can only process maxUsersPerCycle per cron
  const cyclesPerHour = 3600 / ARCH.cronIntervalSec; // 30 cycles/hr
  const usersPerHour = Math.min(userCount, ARCH.maxUsersPerCycle * cyclesPerHour);
  const userCoverageRatio = usersPerHour / userCount;

  // Effective evals per hour accounting for user coverage
  const hotEvalsPerHour = dispatchableHot * Math.min(ARCH.hotCapPerHour, cyclesPerHour) * userCoverageRatio;
  const warmEvalsPerHour = warmCount * (60 / ARCH.warmCadenceMin) * userCoverageRatio;
  const coldEvalsPerHour = coldCount * (60 / ARCH.coldCadenceMin) * userCoverageRatio;
  const basicEvalsPerHour = basicModeHot * 2 * userCoverageRatio; // basic items checked ~2x/hr

  const totalEvalsPerHour = hotEvalsPerHour + warmEvalsPerHour + coldEvalsPerHour + basicEvalsPerHour;
  const evalsPerMinute = totalEvalsPerHour / 60;

  // Each smart eval needs a fetch; basic evals skip fetch
  const smartEvalsPerHour = hotEvalsPerHour + warmEvalsPerHour + coldEvalsPerHour;
  const fetchesPerMinute = smartEvalsPerHour / 60;

  // Price change rate (% of evals that result in price change)
  const changeRate = competitorMovementPct / 100 * 0.6; // ~60% of competitor movement leads to change
  const priceChangesPerMinute = evalsPerMinute * changeRate;
  const writesPerMinute = priceChangesPerMinute * ARCH.dbWritesPerPriceChange;

  // DB load
  const dbReadsPerMinute = evalsPerMinute * ARCH.dbReadsPerEval;
  const dbWritesPerMinuteTotal = writesPerMinute + evalsPerMinute * 0.5; // metadata updates
  const dbConnectionsNeeded = Math.ceil(evalsPerMinute * ARCH.evalAvgMs / 60000 * ARCH.dbReadsPerEval * 0.3);

  // Edge Function concurrency
  const avgEvalDurationSec = ARCH.evalAvgMs / 1000;
  const efConcurrencyNeeded = Math.ceil(evalsPerMinute * avgEvalDurationSec / 60);
  const efInvocationsPerHour = totalEvalsPerHour;

  // HOT freshness estimation
  // With sequential dispatcher processing N users, each HOT item gets checked every:
  // (users / maxUsersPerCycle) * cronInterval / hotCapPerHour
  const effectiveCycleTime = (userCount / ARCH.maxUsersPerCycle) * ARCH.cronIntervalSec / 60; // minutes
  const hotItemsPerUser = dispatchableHot / userCount;

  // p50: best case - item checked on every available cycle
  const hotP50Min = userCoverageRatio >= 1
    ? Math.max(5, hotItemsPerUser / (ARCH.dispatchBatchSize * 2) * 2)
    : Math.max(5, effectiveCycleTime * 0.5 + hotItemsPerUser / ARCH.dispatchBatchSize);

  // p90: worst case items that get delayed
  const hotP90Min = userCoverageRatio >= 1
    ? Math.max(10, hotItemsPerUser / ARCH.dispatchBatchSize * 3)
    : Math.max(15, effectiveCycleTime * 1.5 + hotItemsPerUser / ARCH.dispatchBatchSize * 2);

  // Full cycle time (how long to check every item once)
  const fullCycleMin = totalListings / Math.max(1, evalsPerMinute);

  // Verdicts
  const hotP90Safe = hotP90Min <= 30;
  const dbSafe = dbConnectionsNeeded <= ARCH.dbConnectionsPro;
  const efSafe = efConcurrencyNeeded <= ARCH.edgeFnConcurrencyPro;
  const overallSafe = hotP90Safe && dbSafe && efSafe;

  // Determine bottleneck
  let bottleneck = "None — system within capacity";
  if (!overallSafe) {
    const issues: string[] = [];
    if (!hotP90Safe) issues.push(`HOT p90 ~${Math.round(hotP90Min)}m exceeds 30m target`);
    if (!dbSafe) issues.push(`DB needs ~${dbConnectionsNeeded} connections (Pro: ${ARCH.dbConnectionsPro})`);
    if (!efSafe) issues.push(`Edge Functions need ~${efConcurrencyNeeded} concurrent (Pro: ${ARCH.edgeFnConcurrencyPro})`);
    bottleneck = issues.join(" · ");
  }

  // Required tier
  let requiredTier = "Micro ($10/mo)";
  if (efConcurrencyNeeded > ARCH.edgeFnConcurrency || dbConnectionsNeeded > ARCH.dbConnectionsMicro) {
    requiredTier = "Pro + Large Compute ($75/mo)";
  }
  if (efConcurrencyNeeded > ARCH.edgeFnConcurrencyPro || dbConnectionsNeeded > ARCH.dbConnectionsPro) {
    requiredTier = "Pro + XL Compute ($200/mo)";
  }
  if (efConcurrencyNeeded > ARCH.edgeFnConcurrencyXL || dbConnectionsNeeded > ARCH.dbConnectionsXL) {
    requiredTier = "Dedicated Infrastructure (custom)";
  }
  if (userCount > 2000 || totalListings > 1000000) {
    requiredTier = "Horizontal Sharding Required";
  }

  // Recommendation
  let recommendation = "Current architecture handles this load comfortably.";
  if (!hotP90Safe && !dbSafe) {
    recommendation = "Requires horizontal dispatcher sharding + database upgrade. Consider queue-based architecture (SQS/BullMQ).";
  } else if (!hotP90Safe) {
    recommendation = "Sequential dispatcher is the bottleneck. Needs parallel user processing or dispatcher sharding.";
  } else if (!dbSafe) {
    recommendation = "Database connection pool is saturated. Upgrade compute tier or add read replicas.";
  } else if (!efSafe) {
    recommendation = "Edge Function concurrency limit reached. Upgrade to higher compute tier or move to dedicated servers.";
  }

  return {
    hotCount, warmCount, coldCount, dispatchableHot,
    evalsPerMinute, fetchesPerMinute, writesPerMinute, priceChangesPerMinute,
    hotP50Min, hotP90Min, fullCycleMin,
    dbReadsPerMinute, dbWritesPerMinute: dbWritesPerMinuteTotal, dbConnectionsNeeded,
    efConcurrencyNeeded, efInvocationsPerHour,
    hotP90Safe, dbSafe, efSafe, overallSafe,
    bottleneck, recommendation, requiredTier,
  };
}

/* ─── Component ─── */
export default function CapacityStressTest() {
  const [activePreset, setActivePreset] = useState<string | null>("normal");
  const [totalListings, setTotalListings] = useState(500000);
  const [userCount, setUserCount] = useState(500);
  const [hotPct, setHotPct] = useState(5);
  const [warmPct, setWarmPct] = useState(20);
  const [dispatchablePct, setDispatchablePct] = useState(45);
  const [competitorMovementPct, setCompetitorMovementPct] = useState(10);
  const [results, setResults] = useState<SimResults | null>(null);

  const applyPreset = (key: string) => {
    const p = PRESETS[key];
    setActivePreset(key);
    setTotalListings(p.totalListings);
    setUserCount(p.userCount);
    setHotPct(p.hotPct);
    setWarmPct(p.warmPct);
    setDispatchablePct(p.dispatchablePct);
    setCompetitorMovementPct(p.competitorMovementPct);
  };

  const handleRun = () => {
    setResults(runSimulation(totalListings, userCount, hotPct, warmPct, dispatchablePct, competitorMovementPct));
  };

  const fmtNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0);
  const fmtMin = (n: number) => n >= 60 ? `${(n / 60).toFixed(1)}h` : `${Math.round(n)}m`;

  return (
    <div className="space-y-6">
      {/* Presets */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(PRESETS).map(([key, preset]) => (
          <Button
            key={key}
            variant={activePreset === key ? "default" : "outline"}
            size="sm"
            onClick={() => applyPreset(key)}
            className="gap-1.5"
          >
            {key === "stress" && <Flame className="h-3.5 w-3.5" />}
            {key === "busy" && <Activity className="h-3.5 w-3.5" />}
            {key === "normal" && <Gauge className="h-3.5 w-3.5" />}
            {key === "enterprise" && <Users className="h-3.5 w-3.5" />}
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Input controls */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Server className="h-5 w-5" />
              Capacity Parameters
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Total Active Listings</label>
                <Input
                  type="number"
                  value={totalListings}
                  onChange={e => { setTotalListings(Number(e.target.value)); setActivePreset(null); }}
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Active Users</label>
                <Input
                  type="number"
                  value={userCount}
                  onChange={e => { setUserCount(Number(e.target.value)); setActivePreset(null); }}
                  className="mt-1"
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-muted-foreground">HOT %</span>
                <span className="font-semibold text-destructive">{hotPct}%</span>
              </div>
              <Slider
                value={[hotPct]}
                onValueChange={v => { setHotPct(v[0]); setActivePreset(null); }}
                min={1} max={50} step={1}
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-muted-foreground">WARM %</span>
                <span className="font-semibold text-orange-500">{warmPct}%</span>
              </div>
              <Slider
                value={[warmPct]}
                onValueChange={v => { setWarmPct(v[0]); setActivePreset(null); }}
                min={5} max={60} step={1}
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-muted-foreground">COLD %</span>
                <span className="font-semibold text-muted-foreground">{Math.max(0, 100 - hotPct - warmPct)}%</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden flex">
                <div className="bg-destructive" style={{ width: `${hotPct}%` }} />
                <div className="bg-orange-500" style={{ width: `${warmPct}%` }} />
                <div className="bg-muted-foreground/20" style={{ width: `${Math.max(0, 100 - hotPct - warmPct)}%` }} />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-muted-foreground">Dispatchable HOT %</span>
                <span className="font-semibold">{dispatchablePct}%</span>
              </div>
              <Slider
                value={[dispatchablePct]}
                onValueChange={v => { setDispatchablePct(v[0]); setActivePreset(null); }}
                min={10} max={80} step={5}
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-muted-foreground">Competitor Movement %</span>
                <span className="font-semibold">{competitorMovementPct}%</span>
              </div>
              <Slider
                value={[competitorMovementPct]}
                onValueChange={v => { setCompetitorMovementPct(v[0]); setActivePreset(null); }}
                min={5} max={60} step={5}
              />
            </div>

            <Button onClick={handleRun} className="w-full gap-2" size="lg">
              <Cpu className="h-4 w-4" />
              Run Capacity Simulation
            </Button>
          </CardContent>
        </Card>

        {/* Architecture constants card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <HardDrive className="h-5 w-5" />
              Architecture Assumptions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
              {[
                ["Edge Fn Timeout", `${ARCH.edgeFnTimeoutSec}s`],
                ["EF Concurrency (Micro)", String(ARCH.edgeFnConcurrency)],
                ["EF Concurrency (Pro)", String(ARCH.edgeFnConcurrencyPro)],
                ["EF Concurrency (XL)", String(ARCH.edgeFnConcurrencyXL)],
                ["DB Connections (Micro)", String(ARCH.dbConnectionsMicro)],
                ["DB Connections (Pro)", String(ARCH.dbConnectionsPro)],
                ["Dispatch Batch", `${ARCH.dispatchBatchSize} / ${ARCH.dispatchBatchGapMs}ms`],
                ["Avg Eval Duration", `${ARCH.evalAvgMs}ms`],
                ["Avg Fetch Duration", `${ARCH.fetchAvgMs}ms`],
                ["DB Reads/Eval", String(ARCH.dbReadsPerEval)],
                ["DB Writes/Change", String(ARCH.dbWritesPerPriceChange)],
                ["HOT Cap/Hr", `${ARCH.hotCapPerHour}`],
                ["WARM Cadence", `${ARCH.warmCadenceMin}m`],
                ["COLD Cadence", `${ARCH.coldCadenceMin}m`],
                ["Cron Interval", `${ARCH.cronIntervalSec}s`],
                ["Users/Cycle", String(ARCH.maxUsersPerCycle)],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono text-xs font-semibold">{value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Results */}
      {results && (
        <div className="space-y-4">
          {/* Overall verdict */}
          <Card className={results.overallSafe ? "border-emerald-500/50 bg-emerald-500/5" : "border-destructive/50 bg-destructive/5"}>
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                {results.overallSafe
                  ? <CheckCircle2 className="h-6 w-6 text-emerald-500 shrink-0 mt-0.5" />
                  : <XCircle className="h-6 w-6 text-destructive shrink-0 mt-0.5" />}
                <div>
                  <h3 className="font-bold text-lg">
                    {results.overallSafe ? "✅ Model Predicts Architecture Can Handle This Load" : "❌ Model Predicts Architecture Cannot Handle This Load"}
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">{results.recommendation}</p>
                  <p className="text-[10px] text-muted-foreground mt-1 italic">This is a theoretical prediction — validate with Production Validation panel above.</p>
                  <div className="flex items-center gap-2 mt-2">
                    <Badge variant="outline" className="text-xs">Required: {results.requiredTier}</Badge>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Metrics grid */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* HOT Freshness */}
            <Card>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Zap className="h-4 w-4 text-destructive" />
                  HOT Freshness
                  {results.hotP90Safe
                    ? <Badge variant="secondary" className="text-emerald-600 bg-emerald-500/10 text-[10px]">PASS</Badge>
                    : <Badge variant="destructive" className="text-[10px]">FAIL</Badge>}
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="rounded-md bg-muted p-2">
                    <div className="text-lg font-bold">{fmtMin(results.hotP50Min)}</div>
                    <div className="text-[10px] text-muted-foreground">p50</div>
                  </div>
                  <div className={`rounded-md p-2 ${results.hotP90Safe ? "bg-emerald-500/10" : "bg-destructive/10"}`}>
                    <div className="text-lg font-bold">{fmtMin(results.hotP90Min)}</div>
                    <div className="text-[10px] text-muted-foreground">p90 (target &lt;30m)</div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground text-center">
                  Full cycle: {fmtMin(results.fullCycleMin)}
                </div>
              </CardContent>
            </Card>

            {/* Throughput */}
            <Card>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Activity className="h-4 w-4 text-primary" />
                  Throughput
                </div>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Evals/min</span>
                    <span className="font-mono font-semibold">{fmtNum(results.evalsPerMinute)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Fetches/min</span>
                    <span className="font-mono font-semibold">{fmtNum(results.fetchesPerMinute)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Price changes/min</span>
                    <span className="font-mono font-semibold">{fmtNum(results.priceChangesPerMinute)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">EF invocations/hr</span>
                    <span className="font-mono font-semibold">{fmtNum(results.efInvocationsPerHour)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* DB Load */}
            <Card>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Database className="h-4 w-4 text-orange-500" />
                  Database Load
                  {results.dbSafe
                    ? <Badge variant="secondary" className="text-emerald-600 bg-emerald-500/10 text-[10px]">SAFE</Badge>
                    : <Badge variant="destructive" className="text-[10px]">OVER</Badge>}
                </div>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Reads/min</span>
                    <span className="font-mono font-semibold">{fmtNum(results.dbReadsPerMinute)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Writes/min</span>
                    <span className="font-mono font-semibold">{fmtNum(results.dbWritesPerMinute)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Connections needed</span>
                    <span className="font-mono font-semibold">{results.dbConnectionsNeeded}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Edge Functions */}
            <Card>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Cpu className="h-4 w-4 text-violet-500" />
                  Edge Functions
                  {results.efSafe
                    ? <Badge variant="secondary" className="text-emerald-600 bg-emerald-500/10 text-[10px]">SAFE</Badge>
                    : <Badge variant="destructive" className="text-[10px]">OVER</Badge>}
                </div>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Concurrency needed</span>
                    <span className="font-mono font-semibold">{results.efConcurrencyNeeded}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">vs Pro limit</span>
                    <span className="font-mono font-semibold">{ARCH.edgeFnConcurrencyPro}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">vs XL limit</span>
                    <span className="font-mono font-semibold">{ARCH.edgeFnConcurrencyXL}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Tier distribution */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-3 text-sm font-medium">
                <Users className="h-4 w-4" />
                Load Distribution
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center text-sm">
                <div className="rounded-md bg-destructive/10 p-3">
                  <div className="text-xs text-muted-foreground">🔴 HOT</div>
                  <div className="text-lg font-bold text-destructive">{results.hotCount.toLocaleString()}</div>
                </div>
                <div className="rounded-md bg-orange-500/10 p-3">
                  <div className="text-xs text-muted-foreground">🟠 WARM</div>
                  <div className="text-lg font-bold text-orange-500">{results.warmCount.toLocaleString()}</div>
                </div>
                <div className="rounded-md bg-muted p-3">
                  <div className="text-xs text-muted-foreground">⚪ COLD</div>
                  <div className="text-lg font-bold">{results.coldCount.toLocaleString()}</div>
                </div>
                <div className="rounded-md bg-primary/10 p-3">
                  <div className="text-xs text-muted-foreground">✅ Dispatchable HOT</div>
                  <div className="text-lg font-bold text-primary">{results.dispatchableHot.toLocaleString()}</div>
                </div>
                <div className="rounded-md bg-muted p-3">
                  <div className="text-xs text-muted-foreground">👥 Users</div>
                  <div className="text-lg font-bold">{userCount.toLocaleString()}</div>
                </div>
              </div>
              {!results.overallSafe && (
                <div className="mt-3 flex items-start gap-2 p-3 rounded-md bg-destructive/5 border border-destructive/20">
                  <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  <div className="text-sm">
                    <span className="font-semibold">Bottleneck: </span>
                    <span className="text-muted-foreground">{results.bottleneck}</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
