// Strategic KPIs — replaces vanity metrics ("price changes") with
// commercial outcomes: profitable BB, recovery success, decision quality.

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Award, Shield, Activity } from "lucide-react";

type KPI = {
  profitable_bb: number;
  unprofitable_bb: number;
  total_bb_scored: number;
  outcome_success_rate: number | null;
  decision_churn_avg: number;
  protected_listings: number;
};

export default function StrategicKPICard() {
  const { user } = useAuth();
  const [k, setK] = useState<KPI | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      if (!user) return;
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const [bbq, outcomes, mi, assigns] = await Promise.all([
        supabase
          .from("repricer_buybox_quality")
          .select("classification")
          .eq("user_id", user.id)
          .limit(20000),
        supabase
          .from("repricer_action_outcomes")
          .select("outcome_label")
          .eq("user_id", user.id)
          .gte("evaluated_at", since30)
          .limit(20000),
        supabase
          .from("repricer_marketplace_intelligence")
          .select("decision_churn_score")
          .eq("user_id", user.id)
          .limit(50),
        supabase
          .from("repricer_assignments")
          .select("min_price_override,is_enabled,status")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .neq("status", "DISABLED")
          .limit(50000),
      ]);
      const profit = (bbq.data ?? []).filter(
        (r: any) => r.classification === "profitable_winner",
      ).length;
      const unprof = (bbq.data ?? []).filter(
        (r: any) => r.classification === "unprofitable_winner",
      ).length;
      const total = (bbq.data ?? []).length;
      const totalOc = (outcomes.data ?? []).length;
      const goodOc = (outcomes.data ?? []).filter(
        (r: any) =>
          r.outcome_label === "successful" || r.outcome_label === "partial",
      ).length;
      const churns = (mi.data ?? [])
        .map((r: any) => Number(r.decision_churn_score ?? 0))
        .filter((n) => !isNaN(n));
      const churnAvg =
        churns.length > 0 ? churns.reduce((a, b) => a + b, 0) / churns.length : 0;
      const protected_ = (assigns.data ?? []).filter(
        (r: any) => Number(r.min_price_override ?? 0) > 0,
      ).length;
      setK({
        profitable_bb: profit,
        unprofitable_bb: unprof,
        total_bb_scored: total,
        outcome_success_rate: totalOc > 0 ? goodOc / totalOc : null,
        decision_churn_avg: churnAvg,
        protected_listings: protected_,
      });
      setLoading(false);
    };
    load();
  }, [user]);

  const tile = (
    icon: any,
    label: string,
    value: string,
    sub: string,
    tone: "good" | "neutral" | "warn" = "neutral",
  ) => {
    const Icon = icon;
    const toneCls =
      tone === "good"
        ? "text-emerald-400"
        : tone === "warn"
          ? "text-amber-400"
          : "text-foreground";
    return (
      <div className="rounded-lg border border-border/60 bg-card/40 p-3">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <div className={`text-xl font-bold ${toneCls}`}>{value}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          Strategic KPIs
          <Badge variant="outline" className="text-[10px]">
            outcome-based
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading || !k ? (
          <div className="flex justify-center py-4">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {tile(
              Award,
              "Profitable Buy Box",
              k.total_bb_scored > 0
                ? `${Math.round((k.profitable_bb / k.total_bb_scored) * 100)}%`
                : "—",
              `${k.profitable_bb} of ${k.total_bb_scored} scored`,
              k.profitable_bb > k.unprofitable_bb ? "good" : "neutral",
            )}
            {tile(
              Activity,
              "Recovery success (30d)",
              k.outcome_success_rate != null
                ? `${Math.round(k.outcome_success_rate * 100)}%`
                : "—",
              "successful + partial actions",
              (k.outcome_success_rate ?? 0) >= 0.6 ? "good" : "neutral",
            )}
            {tile(
              Shield,
              "Protected listings",
              `${k.protected_listings}`,
              "manual floors active",
              "neutral",
            )}
            {tile(
              Activity,
              "Decision churn",
              `${Math.round(k.decision_churn_avg * 100)}%`,
              "lower is better",
              k.decision_churn_avg > 0.4 ? "warn" : "good",
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
