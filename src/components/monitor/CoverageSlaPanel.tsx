import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { RefreshCw, ShieldAlert, ChevronDown, Clock, Eye } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

// SLA thresholds in minutes
const SLA_THRESHOLDS = {
  HOT: 5,
  WARM: 20,
  COLD: 60,
} as const;

interface TierSla {
  tier: "HOT" | "WARM" | "COLD";
  totalCount: number;
  violationCount: number;
  oldestMinutes: number | null;
  violatingAsins: Array<{
    asin: string;
    sku: string;
    ageMinutes: number;
    lastSkipReason: string | null;
    lastSkipLane: string | null;
    lastSkipDetails: string | null;
  }>;
}

interface SkipReasonSummary {
  reason: string;
  count: number;
  lanes: string[];
}

export default function CoverageSlaPanel() {
  const { user } = useAuth();
  const [tiers, setTiers] = useState<TierSla[]>([]);
  const [skipSummary, setSkipSummary] = useState<SkipReasonSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTier, setExpandedTier] = useState<string | null>(null);

  const fetchSla = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      // Fetch all active assignments with skip data
      const [assignmentsRes, inventoryRes, alertsRes, salesRes] = await Promise.all([
        supabase
          .from("repricer_assignments")
          .select("id, asin, sku, marketplace, is_enabled, is_priority, rule_id, status, min_price_override, last_sp_api_check_at, last_skip_reason, last_skip_lane, last_skip_details, last_evaluation_attempt_at, last_buybox_status, last_buybox_price, last_applied_price, last_price_change_at")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .not("rule_id", "is", null)
          .in("status", ["active"]),
        supabase
          .from("inventory")
          .select("sku, available, reserved, inbound")
          .eq("user_id", user.id),
        supabase
          .from("bb_price_alerts")
          .select("asin")
          .eq("user_id", user.id)
          .eq("dismissed", false)
          .gte("created_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()),
        supabase
          .from("asin_sales_daily")
          .select("asin")
          .eq("user_id", user.id)
          .gte("date", new Date().toISOString().split("T")[0])
          .gt("units", 0),
      ]);

      const assignments = assignmentsRes.data || [];
      const inventoryItems = inventoryRes.data || [];
      const alertedAsins = new Set((alertsRes.data || []).map((a: any) => a.asin));
      const soldTodayAsins = new Set((salesRes.data || []).map((s: any) => s.asin));

      // Stock map
      const stockMap = new Map<string, boolean>();
      for (const inv of inventoryItems) {
        const hasStock = (inv.available || 0) > 0 || (inv.reserved || 0) > 0;
        stockMap.set(inv.sku, hasStock);
      }

      // Classify into tiers using v5 compound logic (mirrors cron-trigger)
      const hotItems: typeof assignments = [];
      const warmItems: typeof assignments = [];
      const coldItems: typeof assignments = [];

      const toCents = (v: number | null | undefined) => Math.round((v ?? 0) * 100);
      const fifteenMinAgo = Date.now() - 15 * 60 * 1000;

      for (const a of assignments) {
        // Setup-incomplete filter
        if (!a.min_price_override || a.min_price_override <= 0) {
          coldItems.push(a);
          continue;
        }
        if (a.marketplace !== "US") {
          coldItems.push(a);
          continue;
        }
        const hasStock = stockMap.get(a.sku) ?? false;
        if (!hasStock) {
          coldItems.push(a);
          continue;
        }

        // v5 compound HOT classification
        const starred = !!a.is_priority;
        const bbAlert = alertedAsins.has(a.asin);
        const losingBb = !!(a.last_buybox_status && a.last_buybox_status !== "winning");
        let aboveBbGap = 0;
        if (a.last_applied_price && a.last_buybox_price) {
          const gap = toCents(a.last_applied_price) - toCents(a.last_buybox_price);
          if (gap > 0) aboveBbGap = gap;
        }
        const recentChange = a.last_price_change_at && new Date(a.last_price_change_at).getTime() > fifteenMinAgo;
        const sold = soldTodayAsins.has(a.asin);

        const isHot = starred || bbAlert ||
          (losingBb && aboveBbGap >= 5) ||
          (aboveBbGap >= 10) ||
          (losingBb && sold) ||
          (!!recentChange && losingBb);

        if (isHot) {
          hotItems.push(a);
        } else {
          warmItems.push(a);
        }
      }

      // Build SLA data per tier
      const buildTierSla = (
        items: typeof assignments,
        tier: "HOT" | "WARM" | "COLD",
        thresholdMin: number
      ): TierSla => {
        const now = Date.now();
        const withAge = items.map((a) => {
          // Use the most recent touch: either SP-API check or evaluation attempt (heartbeat)
          const lastCheck = a.last_sp_api_check_at ? new Date(a.last_sp_api_check_at).getTime() : 0;
          const lastAttempt = a.last_evaluation_attempt_at ? new Date(a.last_evaluation_attempt_at).getTime() : 0;
          const latestTouch = Math.max(lastCheck, lastAttempt);
          const ageMinutes = latestTouch ? (now - latestTouch) / 60000 : Infinity;
          return { ...a, ageMinutes };
        });

        const violations = withAge
          .filter((a) => a.ageMinutes > thresholdMin)
          .sort((a, b) => b.ageMinutes - a.ageMinutes);

        const oldestMinutes = withAge.length > 0
          ? Math.max(...withAge.map((a) => a.ageMinutes === Infinity ? 999 : a.ageMinutes))
          : null;

        return {
          tier,
          totalCount: items.length,
          violationCount: violations.length,
          oldestMinutes: oldestMinutes !== null ? Math.round(oldestMinutes) : null,
          violatingAsins: violations.slice(0, 10).map((a) => ({
            asin: a.asin,
            sku: a.sku,
            ageMinutes: Math.round(a.ageMinutes === Infinity ? 999 : a.ageMinutes),
            lastSkipReason: a.last_skip_reason,
            lastSkipLane: a.last_skip_lane,
            lastSkipDetails: a.last_skip_details,
          })),
        };
      };

      const tierData = [
        buildTierSla(hotItems, "HOT", SLA_THRESHOLDS.HOT),
        buildTierSla(warmItems, "WARM", SLA_THRESHOLDS.WARM),
        buildTierSla(coldItems, "COLD", SLA_THRESHOLDS.COLD),
      ];
      setTiers(tierData);

      // Skip reason aggregation
      const reasonMap = new Map<string, { count: number; lanes: Set<string> }>();
      for (const a of assignments) {
        if (a.last_skip_reason) {
          const existing = reasonMap.get(a.last_skip_reason);
          if (existing) {
            existing.count++;
            if (a.last_skip_lane) existing.lanes.add(a.last_skip_lane);
          } else {
            reasonMap.set(a.last_skip_reason, {
              count: 1,
              lanes: new Set(a.last_skip_lane ? [a.last_skip_lane] : []),
            });
          }
        }
      }

      setSkipSummary(
        Array.from(reasonMap.entries())
          .map(([reason, { count, lanes }]) => ({
            reason,
            count,
            lanes: Array.from(lanes),
          }))
          .sort((a, b) => b.count - a.count)
      );
    } catch (err) {
      console.error("Coverage SLA fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchSla();
    const __unsub = onMonitorRefresh(fetchSla);
    return () => __unsub();
  }, [fetchSla]);

  const totalViolations = tiers.reduce((sum, t) => sum + t.violationCount, 0);
  const isHealthy = totalViolations === 0;

  const tierColors = {
    HOT: { bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-600" },
    WARM: { bg: "bg-yellow-500/10", border: "border-yellow-500/30", text: "text-yellow-600" },
    COLD: { bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-600" },
  };

  const skipReasonLabels: Record<string, string> = {
    LOCKED_BY_OTHER_LANE: "🔒 Locked",
    SP_API_BUDGET_LOW: "📊 Budget Low",
    SAFE_MODE_ACTIVE: "🛡️ Safe Mode",
    QUEUE_PAUSED: "⏸️ Queue Paused",
    NO_STOCK: "📦 No Stock",
    NO_RULE: "📋 No Rule",
    INACTIVE_LISTING: "🚫 Inactive",
    INTERVAL_NOT_REACHED: "⏱️ Interval",
    LOW_PRIORITY_BACKLOG: "📉 Backlog",
    ANOMALY_BLOCK: "⚠️ Anomaly",
    MARKET_STABLE: "✅ Stable",
    MARKET_STABLE_HEARTBEAT: "💚 BB Heartbeat",
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Loading coverage SLA data...
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <ShieldAlert className={`h-5 w-5 ${isHealthy ? "text-green-500" : "text-red-500"}`} />
          Coverage SLA
          {!isHealthy && (
            <Badge variant="destructive" className="ml-2">
              {totalViolations} violations
            </Badge>
          )}
          {isHealthy && (
            <Badge className="ml-2 bg-green-500/20 text-green-700 border-green-500/30">
              All OK
            </Badge>
          )}
        </CardTitle>
        <Button variant="outline" size="sm" onClick={fetchSla} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Tier SLA cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {tiers.map((tier) => {
            const colors = tierColors[tier.tier];
            const threshold = SLA_THRESHOLDS[tier.tier];
            const compliancePercent = tier.totalCount > 0
              ? Math.round(((tier.totalCount - tier.violationCount) / tier.totalCount) * 100)
              : 100;
            const hasViolations = tier.violationCount > 0;

            return (
              <Collapsible
                key={tier.tier}
                open={expandedTier === tier.tier}
                onOpenChange={(open) => setExpandedTier(open ? tier.tier : null)}
              >
                <div className={`rounded-lg border ${colors.border} ${colors.bg} p-3`}>
                  <CollapsibleTrigger className="w-full text-left">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`font-bold text-sm ${colors.text}`}>
                          {tier.tier}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          ≤{threshold}m SLA
                        </span>
                      </div>
                      <ChevronDown className={`h-4 w-4 transition-transform ${expandedTier === tier.tier ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>

                  <div className="mt-2 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span>{tier.totalCount - tier.violationCount}/{tier.totalCount} compliant</span>
                      <span className={`font-bold ${hasViolations ? "text-red-600" : "text-green-600"}`}>
                        {compliancePercent}%
                      </span>
                    </div>
                    <Progress
                      value={compliancePercent}
                      className={`h-2 ${hasViolations ? "[&>div]:bg-red-500" : "[&>div]:bg-green-500"}`}
                    />
                    {tier.oldestMinutes !== null && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Oldest: {tier.oldestMinutes >= 999 ? "Never checked" : `${tier.oldestMinutes}m ago`}
                      </div>
                    )}
                    {hasViolations && (
                      <Badge variant="destructive" className="text-[10px]">
                        {tier.violationCount} ASINs exceed {threshold}m
                      </Badge>
                    )}
                  </div>

                  <CollapsibleContent>
                    {tier.violatingAsins.length > 0 && (
                      <div className="mt-3 border-t pt-2">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-xs">ASIN</TableHead>
                              <TableHead className="text-xs">Age</TableHead>
                              <TableHead className="text-xs">Skip Reason</TableHead>
                              <TableHead className="text-xs">Lane</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {tier.violatingAsins.map((a) => (
                              <TableRow key={a.asin}>
                                <TableCell className="font-mono text-xs py-1">{a.asin}</TableCell>
                                <TableCell className="text-xs py-1">
                                  <Badge variant={a.ageMinutes > threshold * 2 ? "destructive" : "outline"} className="text-[10px]">
                                    {a.ageMinutes >= 999 ? "Never" : `${a.ageMinutes}m`}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-xs py-1">
                                  {a.lastSkipReason ? (
                                    <span title={a.lastSkipDetails || ""}>
                                      {skipReasonLabels[a.lastSkipReason] || a.lastSkipReason}
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="text-xs py-1 text-muted-foreground">
                                  {a.lastSkipLane || "—"}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })}
        </div>

        {/* Skip Reason Summary */}
        {skipSummary.length > 0 && (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-medium flex items-center gap-1.5">
              <Eye className="h-4 w-4" />
              Active Skip Reasons
            </div>
            <div className="flex flex-wrap gap-2">
              {skipSummary.map((s) => {
                const isHealthy = s.reason === 'MARKET_STABLE';
                return (
                  <Badge
                    key={s.reason}
                    variant="outline"
                    className={`text-xs ${isHealthy ? "border-green-500/40 bg-green-500/10 text-green-700" : ""}`}
                    title={`Lanes: ${s.lanes.join(", ")}${isHealthy ? " — healthy skip, market unchanged" : ""}`}
                  >
                    {skipReasonLabels[s.reason] || s.reason}: {s.count}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
