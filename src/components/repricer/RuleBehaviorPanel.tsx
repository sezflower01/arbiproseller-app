import React, { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw, ArrowUp, ArrowDown, Minus, ShieldAlert, Lock, CheckCircle,
  ChevronDown, ChevronRight, TrendingUp, Search, FlaskConical, AlertTriangle,
  XCircle, Clock, Zap, Activity, ArrowUpDown, ChevronsUpDown,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { format } from "date-fns";
import { toast } from "sonner";

/* ─── Decision category (what the rule WANTED to do) ─── */
type DecisionCategory =
  | "buybox_raise"
  | "competitive_lower"
  | "match_buybox"
  | "monopoly_raise"
  | "no_change"
  | "other";

/* ─── Blocker category (what PREVENTED or CONSTRAINED the action) ─── */
type BlockerCategory =
  | "none"
  | "missing_min_price"
  | "missing_market_data"
  | "oscillation_blocked"
  | "edge_function_error"
  | "price_change_too_small"
  | "daily_check_cap"
  | "market_stable_heartbeat"
  | "profit_guard"
  | "bound_clamped";

interface ClassifiedAction {
  id: string;
  asin: string;
  sku: string | null;
  marketplace: string;
  old_price: number | null;
  new_price: number | null;
  action_type: string;
  reason: string | null;
  rule_name: string | null;
  trigger_source: string;
  intelligence_factors: any;
  success: boolean | null;
  created_at: string;
  decision: DecisionCategory;
  decisionLabel: string;
  blocker: BlockerCategory;
  blockerLabel: string;
  isSetupIncomplete: boolean;
}

const DECISION_META: Record<DecisionCategory, { label: string; color: string; icon: any }> = {
  buybox_raise:      { label: "Buy Box Raise",     color: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30", icon: ArrowUp },
  monopoly_raise:    { label: "Monopoly Raise",    color: "bg-teal-500/10 text-teal-600 border-teal-500/30", icon: TrendingUp },
  competitive_lower: { label: "Competitive Lower", color: "bg-blue-500/10 text-blue-600 border-blue-500/30", icon: ArrowDown },
  match_buybox:      { label: "Match Buy Box",     color: "bg-violet-500/10 text-violet-600 border-violet-500/30", icon: CheckCircle },
  no_change:         { label: "No Change",         color: "bg-muted text-muted-foreground border-border", icon: Minus },
  other:             { label: "Other",             color: "bg-muted text-muted-foreground border-border", icon: Minus },
};

const BLOCKER_META: Record<BlockerCategory, { label: string; color: string; icon: any }> = {
  none:                   { label: "No Blocker",           color: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30", icon: CheckCircle },
  missing_min_price:      { label: "Missing Min Price",    color: "bg-orange-500/10 text-orange-600 border-orange-500/30", icon: AlertTriangle },
  missing_market_data:    { label: "Missing Market Data",  color: "bg-yellow-500/10 text-yellow-600 border-yellow-500/30", icon: XCircle },
  oscillation_blocked:    { label: "Oscillation Blocked",  color: "bg-red-500/10 text-red-600 border-red-500/30", icon: Activity },
  edge_function_error:    { label: "Edge Function Error",  color: "bg-red-500/10 text-red-600 border-red-500/30", icon: XCircle },
  price_change_too_small: { label: "Change Too Small",     color: "bg-muted text-muted-foreground border-border", icon: Minus },
  daily_check_cap:        { label: "Daily Cap Hit",        color: "bg-yellow-500/10 text-yellow-600 border-yellow-500/30", icon: Clock },
  market_stable_heartbeat:{ label: "BB Winner Heartbeat",  color: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30", icon: CheckCircle },
  profit_guard:           { label: "Profit Guard",         color: "bg-red-500/10 text-red-600 border-red-500/30", icon: ShieldAlert },
  bound_clamped:          { label: "Bound Clamped",        color: "bg-orange-500/10 text-orange-600 border-orange-500/30", icon: Lock },
};

function classifyDecision(a: any): DecisionCategory {
  const reason = (a.reason || "").toLowerCase();
  const actionType = (a.action_type || "").toLowerCase();
  const factors = a.intelligence_factors || {};
  const rc = factors.reason_codes || {};

  // Skip setup-incomplete items from decision classification — they aren't real decisions
  if (reason.includes("min price is required") || reason.includes("min price") && reason.includes("missing")) {
    return "other";
  }

  if (reason.includes("monopoly") || rc.monopoly_mode) return "monopoly_raise";
  if (reason.includes("match") || reason.includes("matching buybox") || reason.includes("match buy box")) return "match_buybox";
  if (reason.includes("raise") || reason.includes("shadow") || reason.includes("smart raise") || rc.raise_at_buybox) {
    if (a.new_price != null && a.old_price != null && a.new_price > a.old_price) return "buybox_raise";
  }

  // Classify any actual price drop as competitive lower (regardless of action_type)
  if (a.new_price != null && a.old_price != null && a.new_price < a.old_price) return "competitive_lower";
  // Classify any actual price raise as buybox raise
  if (a.new_price != null && a.old_price != null && a.new_price > a.old_price) return "buybox_raise";

  if (actionType === "no_change" || actionType === "priority_eval" || (a.new_price === a.old_price && actionType !== "price_change")) return "no_change";

  return "other";
}

function classifyBlocker(a: any): BlockerCategory {
  const reason = (a.reason || "").toLowerCase();
  const factors = a.intelligence_factors || {};
  const rc = factors.reason_codes || {};

  if (reason.includes("min price is required") || (reason.includes("min price") && reason.includes("missing"))) return "missing_min_price";
  if (reason.includes("edge function") || reason.includes("non-2xx")) return "edge_function_error";
  if (reason.includes("oscillation") || reason.includes("oscillation_blocked") || reason.includes("oscillation_paused")) return "oscillation_blocked";
  if (reason.includes("profit guard") || reason.includes("roi guard") || reason.includes("margin guard") || rc.profit_guard_blocked) return "profit_guard";
  if (reason.includes("market_stable_heartbeat") || reason.includes("heartbeat")) return "market_stable_heartbeat";
  if (reason.includes("daily_check_cap") || reason.includes("daily check cap")) return "daily_check_cap";
  if (reason.includes("price change too small") || reason.includes("change too small")) return "price_change_too_small";
  if (reason.includes("bb no-data guard") || reason.includes("no reliable bb")) return "missing_market_data";
  if (reason.includes("clamped to min") || reason.includes("clamped to max") || reason.includes("effective_floor")) return "bound_clamped";

  return "none";
}

function extractPriceFromReason(reason: string, patterns: RegExp[]): number | null {
  for (const pat of patterns) {
    const m = reason.match(pat);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

const BB_PATTERNS: RegExp[] = [
  /BB \(\$([0-9.]+)\)/i,
  /buy\s*box.*?\$([0-9.]+)/i,
  /keeping \$([0-9.]+) \(already winning\)/i,
  /BB owner.*?\$([0-9.]+)/i,
  /holding price.*?\$([0-9.]+)/i,
  /within \$[0-9.]+ of BB \(\$([0-9.]+)\)/i,
  /BB \$([0-9.]+)/i,
  /eligible competitors \(\$([0-9.]+)/i,
  /lowering toward lowest FBA \(\$([0-9.]+)\)/i,
  /Buy Box suppressed.*?lowest FBA \(\$([0-9.]+)\)/i,
];

const NEXT_COMP_PATTERNS: RegExp[] = [
  /Lowest FBA \(\$([0-9.]+)\)/i,
  /lowest FBA.*?\$([0-9.]+)/i,
  /next FBA \$([0-9.]+)/i,
  /lowest FBM \$([0-9.]+)/i,
  /lowest among eligible.*?\$([0-9.]+)/i,
  /toward lowest.*?\(\$([0-9.]+)\)/i,
  /Target \(\$([0-9.]+)\)/i,
  /Already lowest \(\$([0-9.]+)\)/i,
  /blocked by floor \(\$([0-9.]+)\)/i,
  /premium above lowest FBM \$([0-9.]+)/i,
];

function resolveBbPrice(f: any, reason: string): number | null {
  return f.buybox_price ?? f.bb_price ?? f.bb ?? f.buybox ?? f.buy_box_price
    ?? extractPriceFromReason(reason, BB_PATTERNS);
}

function resolveNextComp(f: any, reason: string): number | null {
  return f.next_competitor_price ?? f.next_eligible_price ?? f.lowest_fba_price ?? f.lowest_fba
    ?? extractPriceFromReason(reason, NEXT_COMP_PATTERNS);
}

function resolveOwnsBb(f: any, reason: string): boolean | null {
  const rc = f.reason_codes || {};
  let ownsBb = f.owns_buybox ?? rc.owns_buybox ?? null;
  if (ownsBb == null) {
    const r = reason.toLowerCase();
    if (r.includes("already winning") || r.includes("bb owner") || r.includes("holding price (bb owner)") || r.includes("holding price")) {
      ownsBb = true;
    }
  }
  return ownsBb;
}

function buildDecisionTrace(a: ClassifiedAction): string[] {
  const steps: string[] = [];
  const f = a.intelligence_factors || {};
  const rc = f.reason_codes || {};
  const reason = a.reason || "";

  const bbPrice = resolveBbPrice(f, reason);
  const nextComp = resolveNextComp(f, reason);

  const fbaSellers = f.fba_seller_count ?? f.fba_count ?? f.fba_competitor_count ?? f.fbaCompetitorCount;
  steps.push(`Step 1: Market Snapshot — BB: ${bbPrice != null ? `$${bbPrice}` : "N/A"}, Next Competitor: ${nextComp != null ? `$${nextComp}` : "N/A"}, FBA sellers: ${fbaSellers ?? "?"}`);

  const ownsBb = resolveOwnsBb(f, reason);
  steps.push(`Step 2: Buy Box Ownership — ${ownsBb ? "✅ You own the Buy Box" : "❌ You do NOT own the Buy Box"}`);

  const anchor = f.anchor_source || rc.anchor_source || "unknown";
  const anchorPrice = f.anchor_price;
  steps.push(`Step 3: Strategy — Anchor: ${anchor}${anchorPrice != null ? ` ($${anchorPrice})` : ""}, Decision: ${a.reason || a.action_type}`);

  const guards: string[] = [];
  if (rc.profit_guard_blocked) guards.push("❌ Profit guard BLOCKED");
  else guards.push("✅ Profit guard OK");
  if (a.old_price != null) guards.push(`Min: $${f.min_price ?? "—"} / Max: $${f.max_price ?? "—"}`);
  steps.push(`Step 4: Guard Checks — ${guards.join(", ")}`);

  if (a.blocker !== "none") {
    steps.push(`Step 4b: ⚠️ Blocker — ${a.blockerLabel}: ${a.reason || "unknown"}`);
  }

  // Detect computed target from reason (patterns like "→ $11.79" or "→ $24.12")
  const computedTargetMatch = reason.match(/→\s*\$([0-9.]+)/);
  const computedTarget = computedTargetMatch ? parseFloat(computedTargetMatch[1]) : null;
  const minPrice = f.min_price != null ? Number(f.min_price) : null;
  const maxPrice = f.max_price != null ? Number(f.max_price) : null;

  if (a.new_price != null && a.old_price != null) {
    const delta = a.new_price - a.old_price;
    const dir = delta > 0 ? "RAISE" : delta < 0 ? "DROP" : "NO CHANGE";
    
    // If NO CHANGE but a computed target exists that differs, explain why
    if (delta === 0 && computedTarget != null && Math.abs(computedTarget - a.old_price) >= 0.005) {
      const blockers: string[] = [];
      if (minPrice != null && computedTarget < minPrice) {
        blockers.push(`Min floor ($${minPrice.toFixed(2)}) blocked target ($${computedTarget.toFixed(2)})`);
      }
      if (maxPrice != null && computedTarget > maxPrice) {
        blockers.push(`Max ceiling ($${maxPrice.toFixed(2)}) blocked target ($${computedTarget.toFixed(2)})`);
      }
      if (blockers.length === 0) {
        blockers.push(`Computed target $${computedTarget.toFixed(2)} was not applied — likely clamped by safety guard or bound`);
      }
      steps.push(`Step 4b: 🛡️ Target Override — ${blockers.join("; ")}`);
    }
    
    steps.push(`Step 5: Final Action — ${dir} from $${a.old_price.toFixed(2)} → $${a.new_price.toFixed(2)} (Δ $${Math.abs(delta).toFixed(2)})`);
  } else {
    steps.push(`Step 5: Final Action — ${a.decisionLabel} (no price submitted)`);
  }

  return steps;
}

type SortField = "old_price" | "new_price" | "min_price" | "created_at" | null;
type SortDir = "asc" | "desc";

type ViewMode = "decisions" | "blockers" | "setup_incomplete";

export default function RuleBehaviorPanel() {
  const { user } = useAuth();
  const [actions, setActions] = useState<ClassifiedAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterDecision, setFilterDecision] = useState<string>("all");
  const [filterBlocker, setFilterBlocker] = useState<string>("all");
  const [filterRule, setFilterRule] = useState<string>("all");
  const [filterMarketplace, setFilterMarketplace] = useState<string>("all");
  const [filterBbOwnership, setFilterBbOwnership] = useState<string>("all");
  const [searchAsin, setSearchAsin] = useState("");
  
  const [daysBack, setDaysBack] = useState<string>("1");
  const [viewMode, setViewMode] = useState<ViewMode>("decisions");
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const fetchActions = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const since = new Date();
      since.setDate(since.getDate() - parseInt(daysBack));

      const { data, error } = await supabase
        .from("repricer_price_actions")
        .select("id, asin, sku, marketplace, old_price, new_price, action_type, reason, rule_name, trigger_source, intelligence_factors, success, created_at")
        .eq("user_id", user.id)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .limit(2000);

      if (error) throw error;

      const classified: ClassifiedAction[] = (data || []).map((a) => {
        const decision = classifyDecision(a);
        const blocker = classifyBlocker(a);
        const isSetupIncomplete = blocker === "missing_min_price";
        return {
          ...a,
          decision,
          decisionLabel: DECISION_META[decision].label,
          blocker,
          blockerLabel: BLOCKER_META[blocker].label,
          isSetupIncomplete,
        };
      });

      setActions(classified);
    } catch (err: any) {
      toast.error("Failed to load actions: " + err.message);
    } finally {
      setLoading(false);
    }
  }, [user, daysBack]);

  useEffect(() => { fetchActions(); }, [fetchActions]);

  const ruleNames = useMemo(() => {
    const set = new Set<string>();
    actions.forEach((a) => { if (a.rule_name) set.add(a.rule_name); });
    return Array.from(set).sort();
  }, [actions]);

  const marketplaces = useMemo(() => {
    const set = new Set<string>();
    actions.forEach((a) => { if (a.marketplace) set.add(a.marketplace); });
    return Array.from(set).sort();
  }, [actions]);

  // Split actions into three pools
  const { trueDecisions, blockedActions, setupIncomplete } = useMemo(() => {
    const setup: ClassifiedAction[] = [];
    const blocked: ClassifiedAction[] = [];
    const decisions: ClassifiedAction[] = [];
    actions.forEach((a) => {
      if (a.isSetupIncomplete) setup.push(a);
      else if (a.blocker !== "none") blocked.push(a);
      else decisions.push(a);
    });
    return { trueDecisions: decisions, blockedActions: blocked, setupIncomplete: setup };
  }, [actions]);

  // Get the active pool based on view mode
  const activePool = useMemo(() => {
    if (viewMode === "setup_incomplete") return setupIncomplete;
    if (viewMode === "blockers") return blockedActions;
    return trueDecisions;
  }, [viewMode, trueDecisions, blockedActions, setupIncomplete]);

  // Filter the active pool
  const filtered = useMemo(() => {
    return activePool.filter((a) => {
      if (viewMode === "decisions" && filterDecision !== "all" && a.decision !== filterDecision) return false;
      if (viewMode === "blockers" && filterBlocker !== "all" && a.blocker !== filterBlocker) return false;
      if (filterRule !== "all" && a.rule_name !== filterRule) return false;
      if (filterMarketplace !== "all" && a.marketplace !== filterMarketplace) return false;
      if (searchAsin && !a.asin.toLowerCase().includes(searchAsin.toLowerCase())) return false;
      if (filterBbOwnership !== "all") {
        const owns = a.intelligence_factors?.owns_buybox ?? a.intelligence_factors?.reason_codes?.owns_buybox;
        if (filterBbOwnership === "owned" && !owns) return false;
        if (filterBbOwnership === "not_owned" && owns) return false;
      }
      return true;
    });
  }, [activePool, filterDecision, filterBlocker, filterRule, filterMarketplace, searchAsin, filterBbOwnership, viewMode]);

  // Dedup per ASIN
  const dedupedFiltered = useMemo(() => {
    const seen = new Set<string>();
    const deduped = filtered.filter((a) => {
      const key = `${a.asin}-${a.marketplace}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!sortField) return deduped;
    return [...deduped].sort((a, b) => {
      let va: number, vb: number;
      if (sortField === "old_price") { va = a.old_price ?? 0; vb = b.old_price ?? 0; }
      else if (sortField === "new_price") { va = a.new_price ?? 0; vb = b.new_price ?? 0; }
      else if (sortField === "min_price") { const fa = a.intelligence_factors || {}; const fb = b.intelligence_factors || {}; va = fa.min_price ?? 0; vb = fb.min_price ?? 0; }
      else { va = new Date(a.created_at).getTime(); vb = new Date(b.created_at).getTime(); }
      return sortDir === "asc" ? va - vb : vb - va;
    });
  }, [filtered, sortField, sortDir]);

  // Decision counts (true decisions only)
  const decisionCounts = useMemo(() => {
    const counts: Record<string, number> = { all: trueDecisions.length };
    trueDecisions.forEach((a) => { counts[a.decision] = (counts[a.decision] || 0) + 1; });
    return counts;
  }, [trueDecisions]);

  // Blocker counts (blocked actions only)
  const blockerCounts = useMemo(() => {
    const counts: Record<string, number> = { all: blockedActions.length };
    blockedActions.forEach((a) => { counts[a.blocker] = (counts[a.blocker] || 0) + 1; });
    return counts;
  }, [blockedActions]);

  // Summary stats
  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }, [sortField]);

  const wastedPct = actions.length > 0 ? ((setupIncomplete.length / actions.length) * 100).toFixed(1) : "0";

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Rule Behavior Analysis</CardTitle>
            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 text-xs">NEW</Badge>
          </div>
          <Button variant="outline" size="sm" onClick={fetchActions} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Separates true rule decisions from system blockers and setup-incomplete items.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard
            label="True Decisions"
            value={trueDecisions.length}
            icon={<Zap className="h-4 w-4 text-emerald-500" />}
            sub="Rule acted"
            active={viewMode === "decisions"}
            onClick={() => setViewMode("decisions")}
          />
          <SummaryCard
            label="Blocked / Constrained"
            value={blockedActions.length}
            icon={<ShieldAlert className="h-4 w-4 text-red-500" />}
            sub="Rule wanted to act"
            active={viewMode === "blockers"}
            onClick={() => setViewMode("blockers")}
          />
          <SummaryCard
            label="Setup Incomplete"
            value={setupIncomplete.length}
            icon={<AlertTriangle className="h-4 w-4 text-orange-500" />}
            sub={`${wastedPct}% of evals wasted`}
            active={viewMode === "setup_incomplete"}
            onClick={() => setViewMode("setup_incomplete")}
            highlight={setupIncomplete.length > 100}
          />
          <SummaryCard
            label="Total Evaluations"
            value={actions.length}
            icon={<Activity className="h-4 w-4 text-primary" />}
            sub={`${daysBack === "1" ? "Today" : `${daysBack} days`}`}
          />
        </div>

        {/* Category badges — contextual */}
        {viewMode === "decisions" && (
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className={`cursor-pointer ${filterDecision === "all" ? "bg-primary/10 text-primary border-primary" : ""}`} onClick={() => setFilterDecision("all")}>
              All ({decisionCounts.all || 0})
            </Badge>
            {(Object.keys(DECISION_META) as DecisionCategory[]).map((cat) => {
              const meta = DECISION_META[cat];
              const count = decisionCounts[cat] || 0;
              return (
                <Badge key={cat} variant="outline" className={`cursor-pointer ${filterDecision === cat ? meta.color : ""}`} onClick={() => setFilterDecision(filterDecision === cat ? "all" : cat)}>
                  {meta.label} ({count})
                </Badge>
              );
            })}
          </div>
        )}
        {viewMode === "blockers" && (
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className={`cursor-pointer ${filterBlocker === "all" ? "bg-primary/10 text-primary border-primary" : ""}`} onClick={() => setFilterBlocker("all")}>
              All ({blockerCounts.all || 0})
            </Badge>
            {(Object.keys(BLOCKER_META) as BlockerCategory[]).filter(b => b !== "none" && b !== "missing_min_price").map((cat) => {
              const meta = BLOCKER_META[cat];
              const count = blockerCounts[cat] || 0;
              return (
                <Badge key={cat} variant="outline" className={`cursor-pointer ${filterBlocker === cat ? meta.color : ""}`} onClick={() => setFilterBlocker(filterBlocker === cat ? "all" : cat)}>
                  {meta.label} ({count})
                </Badge>
              );
            })}
          </div>
        )}
        {viewMode === "setup_incomplete" && (
          <div className="rounded-md border border-orange-500/30 bg-orange-500/5 p-3">
            <p className="text-sm font-medium text-orange-600">⚠️ {setupIncomplete.length} evaluations wasted on ASINs missing Min price</p>
            <p className="text-xs text-muted-foreground mt-1">These ASINs have rules assigned but no Min price set. The repricer evaluates them each cycle but cannot act. Set Min prices to unlock repricing.</p>
          </div>
        )}

        {/* Filters row */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative w-48">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search ASIN..." value={searchAsin} onChange={(e) => setSearchAsin(e.target.value)} className="pl-8 h-9 text-sm" />
          </div>
          <Select value={filterRule} onValueChange={setFilterRule}>
            <SelectTrigger className="w-44 h-9 text-sm"><SelectValue placeholder="All Rules" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Rules</SelectItem>
              {ruleNames.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterMarketplace} onValueChange={setFilterMarketplace}>
            <SelectTrigger className="w-32 h-9 text-sm"><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {marketplaces.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          {viewMode === "decisions" && (
            <Select value={filterBbOwnership} onValueChange={setFilterBbOwnership}>
              <SelectTrigger className="w-36 h-9 text-sm"><SelectValue placeholder="BB Ownership" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any BB</SelectItem>
                <SelectItem value="owned">BB Owned</SelectItem>
                <SelectItem value="not_owned">BB Not Owned</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Select value={daysBack} onValueChange={setDaysBack}>
            <SelectTrigger className="w-28 h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Today</SelectItem>
              <SelectItem value="3">3 Days</SelectItem>
              <SelectItem value="7">7 Days</SelectItem>
              <SelectItem value="14">14 Days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="text-xs text-muted-foreground">
          Showing {dedupedFiltered.length} unique ASINs ({filtered.length} total evaluations) — View: <span className="font-medium text-foreground">{viewMode === "decisions" ? "True Decisions" : viewMode === "blockers" ? "Blocked / Constrained" : "Setup Incomplete"}</span>
        </p>

        {/* Table */}
        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ASIN</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>{viewMode === "blockers" ? "Blocker" : "Decision"}</TableHead>
                <SortableHead field="old_price" label="Old Price" currentSort={sortField} dir={sortDir} onSort={handleSort} />
                <SortableHead field="new_price" label="New Price" currentSort={sortField} dir={sortDir} onSort={handleSort} />
                <SortableHead field="min_price" label="Min" currentSort={sortField} dir={sortDir} onSort={handleSort} />
                <TableHead className="text-right">BB Price</TableHead>
                <TableHead className="text-right">Next Comp.</TableHead>
                <TableHead>Reason</TableHead>
                <SortableHead field="created_at" label="Time" currentSort={sortField} dir={sortDir} onSort={handleSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {dedupedFiltered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                    {loading ? "Loading…" : "No evaluations found for the selected filters."}
                  </TableCell>
                </TableRow>
              ) : (
                dedupedFiltered.slice(0, 200).map((a) => {
                  const isBlockerView = viewMode === "blockers" || viewMode === "setup_incomplete";
                  const badgeMeta = isBlockerView ? BLOCKER_META[a.blocker] : DECISION_META[a.decision];
                  const badgeLabel = isBlockerView ? a.blockerLabel : a.decisionLabel;
                  const Icon = badgeMeta.icon;
                  const f = a.intelligence_factors || {};
                  const reason = a.reason || "";
                  const bbPrice = resolveBbPrice(f, reason);
                  const nextComp = resolveNextComp(f, reason);

                  return (
                    <React.Fragment key={a.id}>
                      <TableRow className="hover:bg-accent/50">
                        <TableCell className="font-mono text-xs">{a.asin}</TableCell>
                        <TableCell className="text-xs max-w-[120px] truncate">{a.rule_name || "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs ${badgeMeta.color}`}>
                            <Icon className="h-3 w-3 mr-1" />
                            {badgeLabel}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">{a.old_price != null ? `$${a.old_price.toFixed(2)}` : "—"}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold">{a.new_price != null ? `$${a.new_price.toFixed(2)}` : "—"}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{f.min_price != null ? `$${Number(f.min_price).toFixed(2)}` : "—"}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{bbPrice != null ? `$${bbPrice}` : "—"}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{nextComp != null ? `$${nextComp}` : "—"}</TableCell>
                        <TableCell className="text-xs max-w-[180px] truncate text-muted-foreground">{a.reason || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{format(new Date(a.created_at), "MMM d, HH:mm")}</TableCell>
                      </TableRow>
                      <TableRow className="bg-muted/30 border-b">
                        <TableCell colSpan={10} className="p-0">
                          <div className="px-6 py-3 space-y-1">
                            <div className="flex items-center gap-3 mb-1">
                              <p className="text-xs font-semibold text-foreground">
                                Decision Trace — {a.asin} ({a.rule_name || "No rule"})
                              </p>
                              {a.blocker !== "none" && (
                                <Badge variant="outline" className={`text-xs ${BLOCKER_META[a.blocker].color}`}>
                                  ⚠️ {a.blockerLabel}
                                </Badge>
                              )}
                            </div>
                            {buildDecisionTrace(a).map((step, i) => (
                              <p key={i} className="text-xs text-muted-foreground font-mono pl-2 border-l-2 border-primary/30 py-0.5">{step}</p>
                            ))}
                            {a.reason && (
                              <p className="text-xs mt-1 text-muted-foreground">
                                <span className="font-medium text-foreground">Full reason:</span> {a.reason}
                              </p>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    </React.Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Sortable Table Head ─── */
function SortableHead({ field, label, currentSort, dir, onSort }: {
  field: SortField; label: string; currentSort: SortField; dir: SortDir;
  onSort: (f: SortField) => void;
}) {
  const active = currentSort === field;
  return (
    <TableHead className="text-right cursor-pointer select-none hover:text-foreground" onClick={() => onSort(field)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" />
        )}
      </span>
    </TableHead>
  );
}

/* ─── Summary Card ─── */
function SummaryCard({ label, value, icon, sub, active, onClick, highlight }: {
  label: string; value: number; icon: React.ReactNode; sub: string;
  active?: boolean; onClick?: () => void; highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${onClick ? "cursor-pointer hover:bg-accent/50" : ""} ${active ? "border-primary bg-primary/5" : ""} ${highlight && !active ? "border-orange-500/50 bg-orange-500/5" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="text-xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}
