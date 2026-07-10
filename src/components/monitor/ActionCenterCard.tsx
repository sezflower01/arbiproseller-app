import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import {
  TrendingUp,
  Shield,
  AlertTriangle,
  Package,
  Sparkles,
  ArrowRight,
} from "lucide-react";

interface ActionStat {
  label: string;
  value: string;
  tone: "good" | "warn" | "bad" | "neutral";
  icon: any;
  detail?: string;
  /** When true, render value as a calm qualitative line instead of a big metric */
  qualitative?: boolean;
}

const fmt$ = (n: number) =>
  `$${Math.round(n).toLocaleString()}`;

export default function ActionCenterCard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<ActionStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [urgentCount, setUrgentCount] = useState(0);
  const [fbaBlocked, setFbaBlocked] = useState(0);
  const [freshness, setFreshness] = useState<{ tone: "good" | "warn"; label: string } | null>(null);

  useEffect(() => {
    const load = async () => {
      if (!user) return;
      try {
        const [scores, summary, fbaInv, fbaCl, lastComputed] = await Promise.all([
          supabase
            .from("repricer_opportunity_scores")
            .select("score,priority_bucket,expected_impact_usd,suggested_action")
            .eq("user_id", user.id),
          supabase
            .from("repricer_executive_snapshots")
            .select("*")
            .eq("user_id", user.id)
            .order("snapshot_date", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("inventory")
            .select("asin", { count: "exact", head: true })
            .eq("user_id", user.id)
            .eq("fba_blocked", true),
          supabase
            .from("created_listings")
            .select("asin", { count: "exact", head: true })
            .eq("user_id", user.id)
            .eq("fba_blocked", true),
          supabase
            .from("repricer_opportunity_scores")
            .select("computed_at")
            .eq("user_id", user.id)
            .order("computed_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);
        const opps = scores.data ?? [];
        const urgent = opps.filter((o: any) => o.priority_bucket === "urgent");
        const high = opps.filter((o: any) => o.priority_bucket === "high");
        setUrgentCount(urgent.length + high.length);
        setFbaBlocked((fbaInv.count ?? 0) + (fbaCl.count ?? 0));

        // Freshness: how recent is the latest opportunity scoring pass?
        const lastTs = lastComputed.data?.computed_at
          ? new Date(lastComputed.data.computed_at).getTime()
          : null;
        const ageMin = lastTs ? (Date.now() - lastTs) / 60000 : null;
        if (ageMin == null) {
          setFreshness({ tone: "warn", label: "Initial review still building." });
        } else if (ageMin <= 90) {
          setFreshness({ tone: "good", label: "Reviewed recently across your active listings." });
        } else if (ageMin <= 240) {
          setFreshness({ tone: "good", label: "Last reviewed within the last few hours." });
        } else {
          setFreshness({ tone: "warn", label: "Some updates are still processing." });
        }

        const recoverable = opps
          .filter((o: any) =>
            String(o.suggested_action || "")
              .toLowerCase()
              .includes("recapture") ||
            String(o.suggested_action || "")
              .toLowerCase()
              .includes("recovery"),
          )
          .reduce(
            (s: number, o: any) => s + Number(o.expected_impact_usd ?? 0),
            0,
          );
        const projectedMonthly = recoverable * 4.3; // weekly impact → monthly proxy

        const aging = opps.filter((o: any) =>
          String(o.suggested_action || "")
            .toLowerCase()
            .includes("liquidation"),
        ).length;

        const upwardRecovery = opps.filter((o: any) =>
          String(o.suggested_action || "")
            .toLowerCase()
            .includes("price increase") ||
          String(o.suggested_action || "")
            .toLowerCase()
            .includes("upward"),
        ).length;

        const protectedCount = Math.round(
          Number(summary.data?.revenue_protected ?? 0),
        );

        const next: ActionStat[] = [
          projectedMonthly > 0
            ? {
                label: "Recoverable revenue (monthly)",
                value: fmt$(projectedMonthly),
                tone: "good",
                icon: TrendingUp,
                detail: "From Buy Box recovery opportunities",
              }
            : {
                label: "Buy Box recovery",
                value: "No major opportunities detected",
                tone: "good",
                icon: TrendingUp,
                detail: "Pricing is currently stable.",
                qualitative: true,
              },
          aging > 0
            ? {
                label: "Products getting stale",
                value: String(aging),
                tone: "warn",
                icon: Package,
                detail: "Worth a clearance plan",
              }
            : {
                label: "Inventory aging",
                value: "Nothing requiring intervention",
                tone: "good",
                icon: Package,
                detail: "No stale inventory today.",
                qualitative: true,
              },
          protectedCount > 0
            ? {
                label: "Margin protected by your floor",
                value: fmt$(protectedCount),
                tone: "good",
                icon: Shield,
                detail: "We held price instead of chasing competitors",
              }
            : {
                label: "Margin floor",
                value: "Floors are holding",
                tone: "good",
                icon: Shield,
                detail: "Your floors are protecting margin effectively.",
                qualitative: true,
              },
          upwardRecovery > 0
            ? {
                label: "Products ready to raise price",
                value: String(upwardRecovery),
                tone: "good",
                icon: TrendingUp,
                detail: "Stable Buy Box and healthy sales",
              }
            : {
                label: "Upward pricing",
                value: "No safe raises right now",
                tone: "neutral",
                icon: TrendingUp,
                detail: "We'll surface raises when the Buy Box is comfortable.",
                qualitative: true,
              },
        ];
        setStats(next);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [user]);

  if (loading)
    return (
      <Card>
        <CardContent className="p-6 flex justify-center">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </CardContent>
      </Card>
    );

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/10 to-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Action center
          </CardTitle>
          <Button asChild size="sm" variant="default">
            <Link to="/tools/repricer/operator-queue">
              {urgentCount > 0
                ? `${urgentCount} need attention`
                : "Open queue"}
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Link>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          What we suggest you focus on next.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {stats.map((s) => {
            const Icon = s.icon;
            const toneCls =
              s.tone === "good"
                ? "text-emerald-400"
                : s.tone === "warn"
                  ? "text-amber-400"
                  : s.tone === "bad"
                    ? "text-red-400"
                    : "text-foreground";
            return (
              <div
                key={s.label}
                className="rounded-lg border border-border/60 bg-card/40 p-3"
              >
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                  {s.label}
                </div>
                {s.qualitative ? (
                  <div className={`mt-1 text-sm font-medium leading-snug ${toneCls}`}>
                    {s.value}
                  </div>
                ) : (
                  <div className={`mt-1 text-2xl font-bold ${toneCls}`}>
                    {s.value}
                  </div>
                )}
                {s.detail && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {s.detail}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* FBA-flagged calm summary — grouped with other actions */}
        {fbaBlocked > 0 && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-300 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-amber-100">
                {fbaBlocked} product{fbaBlocked === 1 ? "" : "s"} currently restricted from FBA
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Most are approval-related and do not require urgent action. Review when convenient.
              </div>
            </div>
            <Button asChild size="sm" variant="outline" className="border-amber-500/40 text-amber-100 hover:bg-amber-500/10">
              <Link to="/tools/fba-eligibility-issues">Review</Link>
            </Button>
          </div>
        )}

        {/* Subtle data-freshness reassurance */}
        {freshness && (
          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                freshness.tone === "good" ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            {freshness.label}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
