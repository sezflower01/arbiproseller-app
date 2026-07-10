import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronUp, AlertTriangle, Ban, Clock, ShieldCheck, TrendingDown, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

interface BlockerBucket {
  label: string;
  icon: React.ReactNode;
  count: number;
  sampleAsins: string[];
  color: string;
}

interface WriteStats {
  totalEvaluated: number;
  totalChanged: number;
  totalBlocked: number;
  totalNoChange: number;
  buckets: BlockerBucket[];
  loading: boolean;
}

function classifyReason(result: string, reason: string, constraint: string | null): string {
  if (!reason) return "unknown";
  const r = reason.toLowerCase();
  const c = (constraint || "").toLowerCase();

  if (r.includes("cooldown") || r.includes("monopoly cooldown")) return "cooldown";
  if (r.includes("buy box owner protection") || r.includes("buy box suppressed")) return "bb_owner_hold";
  if (r.includes("price change too small") || r.includes("delta too small")) return "delta_too_small";
  if (r.includes("at floor") || r.includes("micro-step blocked by floor") || c.includes("min_price")) return "min_floor";
  if (r.includes("no eligible competitors")) return "no_competitors";
  if (r.includes("not buy box eligible")) return "not_bb_eligible";
  if (r.includes("market_stable")) return "market_stable";
  if (r.includes("profit guard") || c.includes("profit_guard") || c.includes("roi_guard")) return "profit_guard";
  if (r.includes("safeguard") || r.includes("clamped to min")) return "safeguard_clamp";
  if (result === "changed") return "changed";
  return "other";
}

const BUCKET_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  delta_too_small: { label: "Delta Too Small", icon: <TrendingDown className="h-4 w-4" />, color: "text-orange-500" },
  min_floor: { label: "At Min Floor", icon: <Ban className="h-4 w-4" />, color: "text-red-500" },
  cooldown: { label: "Cooldown Active", icon: <Clock className="h-4 w-4" />, color: "text-blue-500" },
  bb_owner_hold: { label: "BB Owner Hold", icon: <ShieldCheck className="h-4 w-4" />, color: "text-green-500" },
  no_competitors: { label: "No Competitors", icon: <AlertTriangle className="h-4 w-4" />, color: "text-yellow-500" },
  not_bb_eligible: { label: "Not BB Eligible", icon: <Ban className="h-4 w-4" />, color: "text-muted-foreground" },
  market_stable: { label: "Market Stable", icon: <ShieldCheck className="h-4 w-4" />, color: "text-emerald-500" },
  profit_guard: { label: "Profit Guard", icon: <AlertTriangle className="h-4 w-4" />, color: "text-red-600" },
  safeguard_clamp: { label: "Safeguard Clamp", icon: <Ban className="h-4 w-4" />, color: "text-amber-600" },
  changed: { label: "✅ Price Changed", icon: <RefreshCw className="h-4 w-4" />, color: "text-green-600" },
  other: { label: "Other", icon: <AlertTriangle className="h-4 w-4" />, color: "text-muted-foreground" },
};

export default function WriteBlockDiagnosticsPanel() {
  const { user } = useAuth();
  const [timeRange, setTimeRange] = useState<"1h" | "today">("today");
  const [stats, setStats] = useState<WriteStats>({ totalEvaluated: 0, totalChanged: 0, totalBlocked: 0, totalNoChange: 0, buckets: [], loading: true });
  const [expandedBucket, setExpandedBucket] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const fetch = async () => {
      setStats(s => ({ ...s, loading: true }));
      const since = timeRange === "1h"
        ? new Date(Date.now() - 60 * 60 * 1000).toISOString()
        : new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

      const { data: acks } = await supabase
        .from("repricer_eval_acks")
        .select("result, reason, constraint_applied, asin")
        .eq("user_id", user.id)
        .gte("acked_at", since)
        .order("acked_at", { ascending: false })
        .limit(2000);

      if (!acks) { setStats(s => ({ ...s, loading: false })); return; }

      const bucketMap: Record<string, Set<string>> = {};
      let changed = 0, blocked = 0, noChange = 0;

      for (const ack of acks) {
        const bucket = classifyReason(ack.result || "", ack.reason || "", ack.constraint_applied);
        if (!bucketMap[bucket]) bucketMap[bucket] = new Set();
        bucketMap[bucket].add(ack.asin);

        if (ack.result === "changed") changed++;
        else if (ack.result === "blocked") blocked++;
        else noChange++;
      }

      const buckets: BlockerBucket[] = Object.entries(bucketMap)
        .map(([key, asins]) => ({
          label: BUCKET_CONFIG[key]?.label || key,
          icon: BUCKET_CONFIG[key]?.icon || <AlertTriangle className="h-4 w-4" />,
          count: asins.size,
          sampleAsins: Array.from(asins).slice(0, 10),
          color: BUCKET_CONFIG[key]?.color || "text-muted-foreground",
        }))
        .sort((a, b) => b.count - a.count);

      setStats({ totalEvaluated: acks.length, totalChanged: changed, totalBlocked: blocked, totalNoChange: noChange, buckets, loading: false });
    };
    fetch();
  }, [user, timeRange]);

  // Also fetch assignment-level skip reasons for items never reaching eval
  const [skipStats, setSkipStats] = useState<{ reason: string; count: number }[]>([]);
  useEffect(() => {
    if (!user) return;
    const fetchSkips = async () => {
      const { data } = await supabase
        .from("repricer_assignments")
        .select("last_skip_reason")
        .eq("user_id", user.id)
        .eq("status", "active")
        .eq("is_enabled", true)
        .not("last_skip_reason", "is", null);

      if (!data) return;
      const counts: Record<string, number> = {};
      for (const row of data) {
        const r = row.last_skip_reason || "unknown";
        counts[r] = (counts[r] || 0) + 1;
      }
      setSkipStats(Object.entries(counts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count));
    };
    fetchSkips();
  }, [user]);

  const writeRate = stats.totalEvaluated > 0
    ? ((stats.totalChanged / stats.totalEvaluated) * 100).toFixed(1)
    : "0";

  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Ban className="h-4 w-4 text-destructive" />
            Write-Block Diagnostics
          </CardTitle>
          <div className="flex gap-1">
            {(["1h", "today"] as const).map(t => (
              <Button
                key={t}
                variant={timeRange === t ? "default" : "outline"}
                size="sm"
                className="h-6 text-xs"
                onClick={() => setTimeRange(t)}
              >
                {t === "1h" ? "Last 1h" : "Today"}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats.loading ? (
          <div className="flex justify-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </div>
        ) : (
          <>
            {/* Summary stats */}
            <div className="grid grid-cols-4 gap-3">
              <div className="rounded-lg border bg-background p-3 text-center">
                <p className="text-2xl font-bold text-foreground">{stats.totalEvaluated}</p>
                <p className="text-xs text-muted-foreground">Evaluated</p>
              </div>
              <div className="rounded-lg border bg-background p-3 text-center">
                <p className="text-2xl font-bold text-green-600">{stats.totalChanged}</p>
                <p className="text-xs text-muted-foreground">Writes</p>
              </div>
              <div className="rounded-lg border bg-background p-3 text-center">
                <p className="text-2xl font-bold text-orange-500">{stats.totalNoChange}</p>
                <p className="text-xs text-muted-foreground">No Change</p>
              </div>
              <div className="rounded-lg border bg-background p-3 text-center">
                <p className="text-2xl font-bold text-foreground">{writeRate}%</p>
                <p className="text-xs text-muted-foreground">Write Rate</p>
              </div>
            </div>

            {/* Top Blocker */}
            {stats.buckets.length > 0 && stats.buckets[0].label !== "✅ Price Changed" && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
                <p className="text-sm font-medium text-destructive">
                  🔴 Top Blocker: <strong>{stats.buckets.filter(b => b.label !== "✅ Price Changed")[0]?.label}</strong>
                  {" "}— {stats.buckets.filter(b => b.label !== "✅ Price Changed")[0]?.count} ASINs affected
                </p>
              </div>
            )}

            {/* Blocker breakdown */}
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Blocker Breakdown (unique ASINs)</p>
              {stats.buckets.map((bucket) => (
                <Collapsible
                  key={bucket.label}
                  open={expandedBucket === bucket.label}
                  onOpenChange={(open) => setExpandedBucket(open ? bucket.label : null)}
                >
                  <CollapsibleTrigger asChild>
                    <button className="flex items-center justify-between w-full rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted/50 transition-colors">
                      <span className={`flex items-center gap-2 ${bucket.color}`}>
                        {bucket.icon}
                        {bucket.label}
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge variant="secondary" className="font-mono">{bucket.count}</Badge>
                        {expandedBucket === bucket.label ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      </span>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {bucket.sampleAsins.map(asin => (
                        <Badge key={asin} variant="outline" className="text-xs font-mono">
                          <a
                            href={`https://www.amazon.com/dp/${asin}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            {asin}
                          </a>
                        </Badge>
                      ))}
                      {bucket.count > 10 && (
                        <Badge variant="outline" className="text-xs text-muted-foreground">+{bucket.count - 10} more</Badge>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>

            {/* Pre-eval skip reasons (never reached evaluation) */}
            {skipStats.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Pre-Eval Skips (never evaluated)</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Skip Reason</TableHead>
                      <TableHead className="text-xs text-right">ASINs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {skipStats.map(({ reason, count }) => (
                      <TableRow key={reason}>
                        <TableCell className="text-xs font-mono py-1">{reason}</TableCell>
                        <TableCell className="text-xs text-right py-1">{count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
