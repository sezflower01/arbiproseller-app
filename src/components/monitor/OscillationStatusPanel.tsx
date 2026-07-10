import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Shield, Zap, TrendingUp, Clock, AlertTriangle, ShieldCheck, ShieldAlert, Pause } from "lucide-react";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

const TIME_FILTERS: Record<string, { label: string; ms: number }> = {
  "1h": { label: "Last 1h", ms: 3600000 },
  "4h": { label: "Last 4h", ms: 14400000 },
  "12h": { label: "Last 12h", ms: 43200000 },
  "24h": { label: "Last 24h", ms: 86400000 },
  "7d": { label: "Last 7d", ms: 604800000 },
  "30d": { label: "Last 30d", ms: 2592000000 },
  all: { label: "All time", ms: 0 },
};

interface OscillationAssignment {
  id: string;
  asin: string;
  sku: string;
  marketplace: string;
  oscillation_state: string | null;
  oscillation_detected_at: string | null;
  oscillation_reaction_count: number;
  oscillation_cooldown_until: string | null;
  oscillation_last_mode_used: string | null;
  oscillation_last_reason: string | null;
  oscillation_count: number;
  anomaly_score: number;
  last_stable_price: number | null;
  bb_loss_after_raise_count: number;
  last_buybox_status: string | null;
  buybox_lost_at: string | null;
  last_applied_price: number | null;
  min_price_override: number | null;
  last_recommended_price: number | null;
  last_recommendation_reason: string | null;
  last_ack_result: string | null;
  last_ack_reason: string | null;
}

interface AckData {
  asin: string;
  marketplace: string;
  buybox_price: number | null;
  lowest_fba_price: number | null;
  my_price: number | null;
  recommended_price: number | null;
  result: string | null;
  reason: string | null;
  constraint_applied: string | null;
}

/** Derive effective state from raw oscillation_state */
function getEffectiveState(state: string | null, reason: string | null): string {
  switch (state) {
    case "safety_cooldown": {
      if (reason?.includes("GAP_TOO_WIDE") || reason?.includes("gap_guard") || reason?.includes("gap_")) {
        if (reason?.includes("delta_too_small_streak")) return "Cooldown: No Meaningful Change";
        if (reason?.includes("no_bb_progress")) return "Cooldown: No BB Progress";
        return "Cooldown: Gap Too Wide";
      }
      if (reason?.includes("delta_too_small_streak")) return "Cooldown: No Meaningful Change";
      if (reason?.includes("no_bb_progress")) return "Cooldown: No BB Progress";
      if (reason?.includes("FUTILE_WAR") || reason?.includes("futile_war")) return "Cooldown: Futile War";
      if (reason?.includes("REACTION_CAP") || reason?.includes("reaction_cap")) return "Cooldown: Reaction Cap";
      return "Cooldown: Safety Guard";
    }
    case "cooldown": return "Cooldown";
    case "bb_loss_cooldown": return "Cooldown: BB Loss";
    case "reaction_limit_cooldown": return "Cooldown: Limit Reached";
    case "blocked": return "Blocked";
    case "reacting": return "Reacting";
    case "competing": return "Competing";
    default: return state || "Unknown";
  }
}

/** Derive guard status from state */
function getGuardStatus(state: string | null): { label: string; variant: "active" | "guarded" | "cooling" | "suppressed" } {
  switch (state) {
    case "safety_cooldown":
      return { label: "Temporarily Suppressed", variant: "suppressed" };
    case "cooldown":
    case "bb_loss_cooldown":
    case "reaction_limit_cooldown":
      return { label: "Cooling Down", variant: "cooling" };
    case "blocked":
      return { label: "Blocked", variant: "suppressed" };
    case "reacting":
      return { label: "Guarded", variant: "guarded" };
    case "competing":
      return { label: "Active", variant: "active" };
    default:
      return { label: "Unknown", variant: "active" };
  }
}

/** Parse reason string into readable guard reasons */
function parseGuardReason(reason: string | null): string {
  if (!reason) return "—";
  return reason
    .split(",")
    .map((r) => r.trim())
    .map((r) => {
      if (r.startsWith("gap_") && r.includes("pct")) return "Gap Too Wide";
      if (r.startsWith("futile_war")) return "Futile War";
      if (r.startsWith("reaction_cap")) return "Reaction Cap";
      if (r.startsWith("delta_too_small_streak")) return "No Meaningful Change";
      if (r.startsWith("no_bb_progress")) return "No BB Progress";
      switch (r) {
        case "GAP_TOO_WIDE":
        case "gap_guard": return "Gap Too Wide";
        case "FUTILE_WAR":
        case "futile_war": return "Futile War";
        case "REACTION_CAP":
        case "reaction_cap": return "Reaction Cap";
        case "OSCILLATION_DETECTED": return "Oscillation Detected";
        case "RAPID_PRICE_INSTABILITY": return "Rapid Instability";
        case "score_threshold": return "Score Threshold";
        default: return r;
      }
    })
    .join(", ");
}

/** Derive loss reason from ack data, guard state, and pricing */
function deriveLossReason(
  item: OscillationAssignment,
  ack: AckData | undefined,
): string {
  // Priority 1: Guard-based reasons
  const state = item.oscillation_state;
  const reason = item.oscillation_last_reason;
  if (state === "safety_cooldown") {
    if (reason?.includes("delta_too_small_streak")) return "No Meaningful Change Cooldown";
    if (reason?.includes("no_bb_progress")) return "No BB Progress Cooldown";
    if (reason?.includes("gap_") || reason?.includes("GAP")) return "Gap Too Wide";
    if (reason?.includes("futile_war") || reason?.includes("FUTILE")) return "Futile War Cooldown";
    if (reason?.includes("reaction_cap") || reason?.includes("REACTION_CAP")) return "Reaction Cap Cooldown";
    return "Safety Cooldown";
  }
  if (state === "blocked") return "Oscillation Blocked";
  if (state === "bb_loss_cooldown") return "BB Loss Cooldown";
  if (state === "reaction_limit_cooldown") return "Reaction Limit";

  // Priority 2: From latest ack/eval
  const ackReason = item.last_ack_reason || ack?.reason || "";
  const ackConstraint = ack?.constraint_applied || "";
  
  if (ackConstraint === "floor_hold" || ackReason.includes("floor")) return "Hit Min Floor";
  if (ackConstraint === "profit_guard" || ackReason.includes("profit")) return "Profit Guard Blocked";
  if (ackConstraint === "delta_too_small" || ackReason.includes("Delta too small")) return "Delta Too Small";
  if (ackConstraint === "already_optimal") return "Already Optimal";
  if (ackReason.includes("FBM") && ackReason.includes("ignored")) return "FBM Ignored";
  if (ackReason.includes("No FBA") || ackReason.includes("No offers")) return "No Valid Undercut Path";
  if (ackReason.includes("No Buy Box")) return "Missing Market Data";
  
  // Priority 3: From recommendation reason
  const recReason = item.last_recommendation_reason || "";
  if (recReason.includes("Floor applied")) return "Hit Min Floor";
  if (recReason.includes("Ceiling applied")) return "Hit Max Ceiling";
  if (recReason.includes("Min profit guard")) return "Profit Guard Blocked";
  if (recReason.includes("min_change_threshold") || recReason.includes("below threshold")) return "Delta Too Small";
  if (recReason.includes("Safeguard")) return "Safeguard Clamped";

  // Priority 4: Infer from BB status
  if (item.last_buybox_status === "losing" || item.last_buybox_status !== "owned") {
    if (item.oscillation_reaction_count >= 10) return "High Reaction, Still Losing";
    return "Competing (No BB)";
  }

  return "—";
}

export default function OscillationStatusPanel() {
  const { user } = useAuth();
  const [items, setItems] = useState<OscillationAssignment[]>([]);
  const [acks, setAcks] = useState<Map<string, AckData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [timeFilter, setTimeFilter] = useState("all");

  const filterMs = TIME_FILTERS[timeFilter]?.ms ?? 0;

  const filteredItems = useMemo(() => {
    if (timeFilter === "all" || filterMs === 0) return items;
    const cutoff = Date.now() - filterMs;
    return items.filter((i) => {
      const ts = i.oscillation_detected_at || i.oscillation_cooldown_until;
      return ts && new Date(ts).getTime() >= cutoff;
    });
  }, [items, timeFilter, filterMs]);

  // Trend counts (always computed from full items list)
  const trendCounts = useMemo(() => {
    const now = Date.now();
    const count = (ms: number) =>
      items.filter((i) => {
        const ts = i.oscillation_detected_at || i.oscillation_cooldown_until;
        return ts && new Date(ts).getTime() >= now - ms;
      }).length;
    return { h1: count(3600000), h24: count(86400000), d7: count(604800000) };
  }, [items]);

  useEffect(() => {
    if (!user) return;
    const fetchData = async () => {
      setLoading(true);
      const { data } = await supabase
        .from("repricer_assignments")
        .select("id, asin, sku, marketplace, oscillation_state, oscillation_detected_at, oscillation_reaction_count, oscillation_cooldown_until, oscillation_last_mode_used, oscillation_last_reason, oscillation_count, anomaly_score, last_stable_price, bb_loss_after_raise_count, last_buybox_status, buybox_lost_at, last_applied_price, min_price_override, last_recommended_price, last_recommendation_reason, last_ack_result, last_ack_reason")
        .eq("user_id", user.id)
        .eq("is_enabled", true)
        .not("oscillation_state", "is", null)
        .neq("oscillation_state", "none")
        .order("anomaly_score", { ascending: false })
        .order("oscillation_detected_at", { ascending: false })
        .limit(200);
      
      const oscItems = (data as OscillationAssignment[]) || [];
      setItems(oscItems);

      // Fetch ack data for pricing context
      if (oscItems.length > 0) {
        const asinList = [...new Set(oscItems.map(i => i.asin))];
        // Batch fetch acks (up to 200 unique ASINs)
        const { data: ackData } = await supabase
          .from("repricer_eval_acks")
          .select("asin, marketplace, buybox_price, lowest_fba_price, my_price, recommended_price, result, reason, constraint_applied")
          .eq("user_id", user.id)
          .in("asin", asinList.slice(0, 200));
        
        const ackMap = new Map<string, AckData>();
        (ackData || []).forEach((a: any) => {
          ackMap.set(`${a.asin}:${a.marketplace}`, a);
        });
        setAcks(ackMap);
      }

      setLoading(false);
    };
    fetchData();
    const __unsub = onMonitorRefresh(fetchData);
    return () => __unsub();
  }, [user]);

  const getModeIcon = (mode: string | null) => {
    switch (mode) {
      case "safe": return <Shield className="h-3.5 w-3.5 text-green-500" />;
      case "balanced": return <Zap className="h-3.5 w-3.5 text-yellow-500" />;
      case "aggressive": return <TrendingUp className="h-3.5 w-3.5 text-red-500" />;
      default: return <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  const getEffectiveStateBadge = (state: string | null, reason: string | null) => {
    const effective = getEffectiveState(state, reason);
    if (effective.startsWith("Cooldown")) {
      return <Badge className="bg-yellow-500 text-white text-xs whitespace-nowrap">{effective}</Badge>;
    }
    switch (effective) {
      case "Blocked": return <Badge variant="destructive" className="text-xs">{effective}</Badge>;
      case "Reacting": return <Badge className="bg-blue-500 text-white text-xs">{effective}</Badge>;
      case "Competing": return <Badge className="bg-red-500 text-white text-xs">{effective}</Badge>;
      default: return <Badge variant="outline" className="text-xs">{effective}</Badge>;
    }
  };

  const getGuardBadge = (state: string | null) => {
    const guard = getGuardStatus(state);
    const colorMap = {
      active: "bg-green-500 text-white",
      guarded: "bg-blue-500 text-white",
      cooling: "bg-yellow-500 text-white",
      suppressed: "bg-orange-500 text-white",
    };
    const iconMap = {
      active: <ShieldCheck className="h-3 w-3" />,
      guarded: <ShieldAlert className="h-3 w-3" />,
      cooling: <Pause className="h-3 w-3" />,
      suppressed: <ShieldAlert className="h-3 w-3" />,
    };
    return (
      <Badge className={`${colorMap[guard.variant]} text-xs gap-1 whitespace-nowrap`}>
        {iconMap[guard.variant]}
        {guard.label}
      </Badge>
    );
  };

  const getCooldownRemaining = (until: string | null) => {
    if (!until) return null;
    const diff = new Date(until).getTime() - Date.now();
    if (diff <= 0) return "Expired";
    const mins = Math.ceil(diff / 60000);
    return `${mins}m left`;
  };

  const fmt = (v: number | null | undefined) => v != null ? `$${v.toFixed(2)}` : "—";

  const activeCount = filteredItems.filter((i) => i.oscillation_state === "competing").length;
  const guardedCount = filteredItems.filter((i) =>
    ["safety_cooldown", "cooldown", "bb_loss_cooldown", "reaction_limit_cooldown", "blocked"].includes(i.oscillation_state || "")
  ).length;

  // Buy Box ownership counts
  const ownedCount = filteredItems.filter((i) =>
    i.last_buybox_status === "owned" || i.last_buybox_status === "winning"
  ).length;
  const holdingCount = filteredItems.filter((i) =>
    (i.last_buybox_status === "owned" || i.last_buybox_status === "winning") &&
    deriveLossReason(i, acks.get(`${i.asin}:${i.marketplace}`)) === "Already Optimal"
  ).length;
  const losingCount = filteredItems.filter((i) =>
    i.last_buybox_status !== "owned" && i.last_buybox_status !== "winning"
  ).length;

  // Loss reason summary
  const lossReasonCounts = new Map<string, number>();
  filteredItems.forEach((item) => {
    const ack = acks.get(`${item.asin}:${item.marketplace}`);
    const reason = deriveLossReason(item, ack);
    if (reason !== "—") {
      lossReasonCounts.set(reason, (lossReasonCounts.get(reason) || 0) + 1);
    }
  });
  const sortedReasons = [...lossReasonCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Top 5 most frequent losers
  const loserFrequency = new Map<string, number>();
  filteredItems.forEach((i) => {
    loserFrequency.set(i.asin, (loserFrequency.get(i.asin) || 0) + i.oscillation_reaction_count);
  });
  const topLosers = [...loserFrequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-orange-500" />
            Oscillation Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-orange-500" />
            Oscillation Status
            {filteredItems.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                <Badge variant="outline" className="text-xs">{filteredItems.length} total</Badge>
                <Badge className="bg-green-600 text-white text-xs">{ownedCount} owned</Badge>
                {holdingCount > 0 && (
                  <Badge className="bg-emerald-500 text-white text-xs">{holdingCount} holding</Badge>
                )}
                <Badge variant="destructive" className="text-xs">{losingCount} losing</Badge>
                <Badge className="bg-blue-500 text-white text-xs">{activeCount} competing</Badge>
                {guardedCount > 0 && (
                  <Badge className="bg-yellow-500 text-white text-xs">{guardedCount} guarded</Badge>
                )}
              </div>
            )}
          </CardTitle>
          <Select value={timeFilter} onValueChange={setTimeFilter}>
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(TIME_FILTERS).map(([key, { label }]) => (
                <SelectItem key={key} value={key} className="text-xs">{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {/* BB Ownership Summary with percentages and bar */}
        {filteredItems.length > 0 && (() => {
          const total = filteredItems.length;
          const pct = (n: number) => total > 0 ? Math.round((n / total) * 100) : 0;
          const controlPct = pct(ownedCount);
          const losePct = pct(losingCount);
          const battlePct = pct(activeCount);
          const guardPct = pct(guardedCount);
          const efficiencyScore = controlPct - losePct;
          // Repeat losers (10+ reactions, still not winning)
          const repeatLosers = filteredItems
            .filter((i) => i.oscillation_reaction_count >= 10 && i.last_buybox_status !== "owned" && i.last_buybox_status !== "winning")
            .sort((a, b) => b.oscillation_reaction_count - a.oscillation_reaction_count)
            .slice(0, 5);
          return (
            <div className="mb-3 space-y-2">
              <div className="flex flex-wrap gap-3 text-xs">
                <span className="text-muted-foreground font-medium">BB Status:</span>
                <span className="text-green-600 font-semibold">Owned: {ownedCount} ({pct(ownedCount)}%)</span>
                <span className="text-emerald-500 font-semibold">Holding: {holdingCount} ({pct(holdingCount)}%)</span>
                <span className="font-bold text-green-700">Control: {ownedCount} ({controlPct}%) ✅</span>
                <span className="text-destructive font-semibold">Losing: {losingCount} ({losePct}%)</span>
              </div>
              {/* Rates row */}
              <div className="flex flex-wrap gap-3 text-xs">
                <span className="text-muted-foreground font-medium">Rates:</span>
                <span>Battle: <strong className="text-blue-500">{battlePct}%</strong></span>
                <span>Guard: <strong className="text-yellow-600">{guardPct}%</strong></span>
                <span>Efficiency: <strong className={efficiencyScore >= 0 ? "text-green-600" : "text-destructive"}>{efficiencyScore > 0 ? "+" : ""}{efficiencyScore}</strong></span>
              </div>
              {/* Visual bar */}
              <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-muted">
                {controlPct > 0 && <div className="bg-green-600 transition-all" style={{ width: `${controlPct}%` }} />}
                {losePct > 0 && <div className="bg-destructive transition-all" style={{ width: `${losePct}%` }} />}
              </div>
              <div className="text-xs text-muted-foreground">
                Control Rate: <strong className="text-green-600">{controlPct}%</strong> · Loss Rate: <strong className="text-destructive">{losePct}%</strong>
              </div>
              {/* Repeat losers */}
              {repeatLosers.length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <span className="text-muted-foreground font-medium">Never Recovering:</span>
                  {repeatLosers.map((r) => (
                    <Badge key={r.id} variant="destructive" className="text-xs font-mono">
                      {r.asin}: {r.oscillation_reaction_count} rxn
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* BB Recovery Time */}
        {(() => {
          const fmtDuration = (mins: number) => {
            if (mins < 60) return `${mins}m`;
            if (mins < 1440) return `${Math.round(mins / 60)}h`;
            return `${(mins / 1440).toFixed(1)}d`;
          };
          const losingWithTimestamp = filteredItems.filter((i) =>
            i.buybox_lost_at && (i.last_buybox_status !== "owned" && i.last_buybox_status !== "winning")
          );
          const recoveredItems = filteredItems.filter((i) =>
            i.buybox_lost_at && (i.last_buybox_status === "owned" || i.last_buybox_status === "winning")
          );
          const avgRecoveryMin = recoveredItems.length > 0
            ? Math.round(recoveredItems.reduce((sum, i) => sum + (Date.now() - new Date(i.buybox_lost_at!).getTime()) / 60000, 0) / recoveredItems.length)
            : null;
          const avgLostMin = losingWithTimestamp.length > 0
            ? Math.round(losingWithTimestamp.reduce((sum, i) => sum + (Date.now() - new Date(i.buybox_lost_at!).getTime()) / 60000, 0) / losingWithTimestamp.length)
            : null;
          return (losingWithTimestamp.length > 0 || recoveredItems.length > 0) ? (
            <div className="mb-3 flex flex-wrap gap-3 text-xs">
              <span className="text-muted-foreground font-medium">BB Recovery:</span>
              {recoveredItems.length > 0 && (
                <span className="text-green-600">Recovered: {recoveredItems.length} (avg {fmtDuration(avgRecoveryMin!)} since loss)</span>
              )}
              {losingWithTimestamp.length > 0 && (
                <span className="text-destructive">Still losing: {losingWithTimestamp.length} (avg {fmtDuration(avgLostMin!)})</span>
              )}
            </div>
          ) : null;
        })()}

        {/* Loss Trend Summary */}
        <div className="mb-3 flex flex-wrap gap-3 text-xs">
          <span className="text-muted-foreground font-medium">Loss Trend:</span>
          <span>1h: <strong>{trendCounts.h1}</strong></span>
          <span>24h: <strong>{trendCounts.h24}</strong></span>
          <span>7d: <strong>{trendCounts.d7}</strong></span>
        </div>

        {/* Loss Reason Summary */}
        {sortedReasons.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            <span className="text-xs text-muted-foreground font-medium mr-1">Loss Reasons:</span>
            {sortedReasons.slice(0, 8).map(([reason, count]) => (
              <Badge key={reason} variant="outline" className="text-xs">
                {reason}: {count}
              </Badge>
            ))}
          </div>
        )}

        {/* Top Losers */}
        {topLosers.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            <span className="text-xs text-muted-foreground font-medium mr-1">Top Losers:</span>
            {topLosers.map(([asin, rxn]) => (
              <Badge key={asin} variant="outline" className="text-xs font-mono">
                {asin}: {rxn} rxn
              </Badge>
            ))}
          </div>
        )}

        {filteredItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">No ASINs in oscillation state for this time range. ✅</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground text-xs">
                  <th className="text-left py-2 px-1.5">ASIN</th>
                  <th className="text-left py-2 px-1.5">Mkt</th>
                  <th className="text-left py-2 px-1.5">Mode</th>
                  <th className="text-left py-2 px-1.5">State</th>
                  <th className="text-left py-2 px-1.5">Guard</th>
                  <th className="text-left py-2 px-1.5">Last BB</th>
                  <th className="text-left py-2 px-1.5">Loss Reason</th>
                  <th className="text-right py-2 px-1.5">My $</th>
                  <th className="text-right py-2 px-1.5">BB $</th>
                  <th className="text-right py-2 px-1.5">Low FBA</th>
                  <th className="text-right py-2 px-1.5">Floor</th>
                  <th className="text-right py-2 px-1.5">Target</th>
                  <th className="text-center py-2 px-1.5">Rxn</th>
                  <th className="text-left py-2 px-1.5">Cooldown</th>
                  <th className="text-center py-2 px-1.5">Score</th>
                  <th className="text-left py-2 px-1.5">Guard Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const ack = acks.get(`${item.asin}:${item.marketplace}`);
                  const myPrice = ack?.my_price ?? item.last_applied_price;
                  const bbPrice = ack?.buybox_price;
                  const lowestFba = ack?.lowest_fba_price;
                  const targetPrice = ack?.recommended_price ?? item.last_recommended_price;
                  const lossReason = deriveLossReason(item, ack);

                  return (
                    <tr key={item.id} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="py-1.5 px-1.5 font-mono text-xs">{item.asin}</td>
                      <td className="py-1.5 px-1.5 text-xs">{item.marketplace}</td>
                      <td className="py-1.5 px-1.5">
                        <div className="flex items-center gap-1">
                          {getModeIcon(item.oscillation_last_mode_used)}
                          <span className="text-xs capitalize">{item.oscillation_last_mode_used || "—"}</span>
                        </div>
                      </td>
                      <td className="py-1.5 px-1.5">
                        {getEffectiveStateBadge(item.oscillation_state, item.oscillation_last_reason)}
                      </td>
                      <td className="py-1.5 px-1.5">
                        {getGuardBadge(item.oscillation_state)}
                      </td>
                      <td className="py-1.5 px-1.5 text-xs">
                        {item.last_buybox_status === "owned" || item.last_buybox_status === "winning" ? (
                          <Badge className="bg-green-500/20 text-green-700 text-xs">Owned</Badge>
                        ) : (
                          <span className="text-orange-600 font-medium">{item.last_buybox_status || "—"}</span>
                        )}
                      </td>
                      <td className="py-1.5 px-1.5">
                        <Badge
                          variant="outline"
                          className={`text-xs whitespace-nowrap ${
                            lossReason.includes("Floor") || lossReason.includes("Guard")
                              ? "border-amber-400 text-amber-700"
                              : lossReason.includes("Cooldown") || lossReason.includes("Blocked")
                              ? "border-orange-400 text-orange-700"
                              : lossReason.includes("High Reaction")
                              ? "border-red-400 text-red-700"
                              : ""
                          }`}
                        >
                          {lossReason}
                        </Badge>
                      </td>
                      <td className="py-1.5 px-1.5 text-xs text-right font-mono">{fmt(myPrice)}</td>
                      <td className="py-1.5 px-1.5 text-xs text-right font-mono">{fmt(bbPrice)}</td>
                      <td className="py-1.5 px-1.5 text-xs text-right font-mono">{fmt(lowestFba)}</td>
                      <td className="py-1.5 px-1.5 text-xs text-right font-mono">{fmt(item.min_price_override)}</td>
                      <td className="py-1.5 px-1.5 text-xs text-right font-mono">{fmt(targetPrice)}</td>
                      <td className="py-1.5 px-1.5 text-center">{item.oscillation_reaction_count}</td>
                      <td className="py-1.5 px-1.5">
                        {item.oscillation_cooldown_until ? (
                          <span className="flex items-center gap-1 text-xs">
                            <Clock className="h-3 w-3" />
                            {getCooldownRemaining(item.oscillation_cooldown_until)}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="py-1.5 px-1.5 text-center">
                        <Badge variant={item.anomaly_score >= 50 ? "destructive" : "outline"} className="text-xs">
                          {item.anomaly_score}
                        </Badge>
                      </td>
                      <td className="py-1.5 px-1.5 text-xs text-muted-foreground max-w-[180px] truncate">
                        {parseGuardReason(item.oscillation_last_reason)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
