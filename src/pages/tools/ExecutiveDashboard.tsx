// Executive Simplicity Mode
// Investor-grade view. No technical wording. Reuses existing data only.

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  TrendingUp,
  AlertTriangle,
  Award,
  PackageX,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import AutomationTrustBadge from "@/components/monitor/AutomationTrustBadge";

type Insight = {
  id: string;
  headline: string;
  body: string;
  category: string;
  impact_tier: string;
  marketplace: string | null;
};

type Snapshot = {
  revenue_recovered_30d: number;
  revenue_at_risk: number;
  aged_units: number;
  aged_value: number;
  profitable_bb_pct: number | null;
  top_opportunities: { asin: string; impact: number; reason: string }[];
  top_risks: { asin: string; reason: string }[];
  insights: Insight[];
};

const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const snapshotKey = (uid: string) => `arbi.exec_snapshot.v1.${uid}`;

export default function ExecutiveDashboard() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);

  const compute = async (): Promise<Snapshot> => {
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
    // All queries are bounded — no unlimited reads on any table.
    const [outc, oppRows, bbq, inv, ins] = await Promise.all([
      supabase
        .from("repricer_action_outcomes")
        .select("revenue_delta_usd,outcome_label")
        .eq("user_id", user!.id)
        .gte("evaluated_at", since30)
        .limit(5000),
      supabase
        .from("repricer_opportunity_scores")
        .select(
          "asin,score,priority_bucket,expected_impact_usd,business_reason,confidence",
        )
        .eq("user_id", user!.id)
        .order("expected_impact_usd", { ascending: false })
        .limit(200),
      supabase
        .from("repricer_buybox_quality")
        .select("classification")
        .eq("user_id", user!.id)
        .limit(5000),
      supabase
        .from("inventory")
        .select("available,my_price,estimated_age_days")
        .eq("user_id", user!.id)
        .gt("available", 0)
        .gte("estimated_age_days", 90) // only what we actually need for aged calc
        .limit(5000),
      supabase
        .from("repricer_strategic_insights")
        .select("*")
        .eq("user_id", user!.id)
        .eq("suppressed", false)
        .is("acknowledged_at", null)
        .in("impact_tier", ["high", "medium"])
        .order("generated_at", { ascending: false })
        .limit(5),
    ]);

    const recovered = (outc.data ?? [])
      .filter(
        (r: any) =>
          r.outcome_label === "successful" || r.outcome_label === "partial",
      )
      .reduce(
        (acc: number, r: any) => acc + Math.max(0, Number(r.revenue_delta_usd ?? 0)),
        0,
      );

    const opps = (oppRows.data ?? []).filter(
      (r: any) =>
        Number(r.expected_impact_usd ?? 0) >= 25 && r.confidence !== "estimated",
    );
    const atRisk = opps
      .filter(
        (r: any) =>
          r.priority_bucket === "high" || r.priority_bucket === "critical",
      )
      .reduce(
        (acc: number, r: any) => acc + Number(r.expected_impact_usd ?? 0),
        0,
      );

    const aged = inv.data ?? [];
    const agedValue = aged.reduce(
      (acc: number, i: any) =>
        acc + Number(i.available ?? 0) * Number(i.my_price ?? 0),
      0,
    );

    const totalBb = (bbq.data ?? []).length;
    const profitable = (bbq.data ?? []).filter(
      (r: any) => r.classification === "profitable_winner",
    ).length;

    return {
      revenue_recovered_30d: Math.round(recovered),
      revenue_at_risk: Math.round(atRisk),
      aged_units: aged.reduce(
        (a: number, i: any) => a + Number(i.available ?? 0),
        0,
      ),
      aged_value: Math.round(agedValue),
      profitable_bb_pct:
        totalBb > 0 ? Math.round((profitable / totalBb) * 100) : null,
      top_opportunities: opps.slice(0, 5).map((r: any) => ({
        asin: r.asin,
        impact: Math.round(Number(r.expected_impact_usd ?? 0)),
        reason: r.business_reason ?? "",
      })),
      top_risks: opps
        .filter((r: any) => r.priority_bucket === "critical")
        .slice(0, 5)
        .map((r: any) => ({ asin: r.asin, reason: r.business_reason ?? "" })),
      insights: (ins.data as any[]) ?? [],
    };
  };

  const refresh = async (force = false) => {
    if (!user) return;
    // Try cache first
    if (!force) {
      try {
        const raw = localStorage.getItem(snapshotKey(user.id));
        if (raw) {
          const parsed = JSON.parse(raw);
          if (
            parsed?.computed_at &&
            Date.now() - parsed.computed_at < SNAPSHOT_TTL_MS
          ) {
            setData(parsed.snapshot);
            setCachedAt(parsed.computed_at);
            setLoading(false);
            return;
          }
        }
      } catch {
        /* ignore */
      }
    }
    setRefreshing(true);
    try {
      const snap = await compute();
      const computed_at = Date.now();
      setData(snap);
      setCachedAt(computed_at);
      try {
        localStorage.setItem(
          snapshotKey(user.id),
          JSON.stringify({ snapshot: snap, computed_at }),
        );
      } catch {
        /* ignore */
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const fmt = (n: number) =>
    n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

  return (
    <div className="container max-w-6xl mx-auto py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Business overview</h1>
          <p className="text-sm text-muted-foreground">
            A calm, plain-English read on how the business is performing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {cachedAt && (
            <span className="text-[11px] text-muted-foreground">
              Updated{" "}
              {Math.max(1, Math.round((Date.now() - cachedAt) / 60000))}m ago
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => refresh(true)}
            disabled={refreshing}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 mr-1 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <AutomationTrustBadge />
        </div>
      </div>

      {loading || !data ? (
        <Card>
          <CardContent className="flex justify-center py-10">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
                  <TrendingUp className="h-3.5 w-3.5" /> Revenue recovered (30d)
                </div>
                <div className="text-2xl font-bold text-emerald-400">
                  {data.revenue_recovered_30d > 0 ? fmt(data.revenue_recovered_30d) : "Building baseline"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {data.revenue_recovered_30d > 0
                    ? "Confirmed by validated outcomes"
                    : "Tracking validated outcomes as they accumulate"}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
                  <AlertTriangle className="h-3.5 w-3.5" /> Revenue at risk
                </div>
                <div className="text-2xl font-bold text-amber-400">
                  {data.revenue_at_risk > 0 ? fmt(data.revenue_at_risk) : "All clear"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {data.revenue_at_risk > 0
                    ? "Open opportunities worth acting on"
                    : "No material risks detected in current activity"}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
                  <Award className="h-3.5 w-3.5" /> Profitable Buy Box rate
                </div>
                <div className="text-2xl font-bold">
                  {data.profitable_bb_pct != null
                    ? `${data.profitable_bb_pct}%`
                    : "Learning"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {data.profitable_bb_pct != null
                    ? "Of listings we're tracking"
                    : "Building baseline from validated activity"}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
                  <PackageX className="h-3.5 w-3.5" /> Aged stock value
                </div>
                <div className="text-2xl font-bold">
                  {data.aged_value > 0 ? fmt(data.aged_value) : "Healthy"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {data.aged_value > 0
                    ? `${data.aged_units.toLocaleString()} units sitting 90+ days`
                    : "No aged stock requiring intervention today"}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Where to lean in</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.top_opportunities.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-2">
                    Pricing remains stable across your active catalog.
                  </div>
                ) : (
                  data.top_opportunities.map((o, i) => (
                    <div
                      key={i}
                      className="flex items-start justify-between gap-3 text-sm border-b border-border/40 pb-2 last:border-b-0"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-xs text-muted-foreground">
                          {o.asin}
                        </div>
                        <div className="text-xs">{o.reason}</div>
                      </div>
                      <Badge variant="outline" className="text-emerald-300">
                        +{fmt(o.impact)}
                      </Badge>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">What to watch</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.top_risks.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-2">
                    No significant risks detected in current inventory or pricing activity.
                  </div>
                ) : (
                  data.top_risks.map((r, i) => (
                    <div
                      key={i}
                      className="text-sm border-b border-border/40 pb-2 last:border-b-0"
                    >
                      <div className="font-mono text-xs text-muted-foreground">
                        {r.asin}
                      </div>
                      <div className="text-xs">{r.reason}</div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" /> Advisor summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.insights.length === 0 ? (
                <div className="text-sm text-muted-foreground py-2">
                  Current strategy performance remains stable. We'll surface guidance when a meaningful trend appears.
                </div>
              ) : (
                data.insights.map((i) => (
                  <div
                    key={i.id}
                    className="text-sm rounded-md border border-border/40 p-3"
                  >
                    <div className="font-semibold">{i.headline}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {i.body}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
