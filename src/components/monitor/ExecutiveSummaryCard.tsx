import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  TrendingUp,
  TrendingDown,
  Shield,
  Target,
  Package,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Info,
} from "lucide-react";
import { useUiMode } from "@/contexts/UiModeContext";
import { STRATEGY_META, type StrategyState } from "@/lib/strategyMeta";

interface Summary {
  snapshot_date: string;
  buybox_control_pct: number;
  revenue_protected: number;
  revenue_missed: number;
  aged_inventory_value: number;
  asins_needing_action: number;
  recovered_products: number;
  total_active_asins: number;
  top_blockers: Array<{ reason: string; label: string; count: number }>;
  strategy_distribution: Record<string, number>;
  assumptions: Record<string, unknown>;
  confidence: "high" | "medium" | "estimated";
}

interface TrendRow extends Summary {
  // historical
}

const fmtMoney = (n: number) =>
  n == null
    ? "—"
    : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function Stat({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: any;
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad" | "neutral";
  hint?: string;
}) {
  const toneCls =
    tone === "good"
      ? "text-emerald-400"
      : tone === "warn"
      ? "text-amber-400"
      : tone === "bad"
      ? "text-red-400"
      : "text-foreground";
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold ${toneCls}`}>{value}</div>
      {hint && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

export default function ExecutiveSummaryCard() {
  const { user } = useAuth();
  const { mode } = useUiMode();
  const [today, setToday] = useState<Summary | null>(null);
  const [history, setHistory] = useState<TrendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      // Load last 30d history for trend
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      const { data: hist } = await supabase
        .from("repricer_executive_snapshots")
        .select("*")
        .eq("user_id", user.id)
        .gte("snapshot_date", since)
        .order("snapshot_date", { ascending: false });

      setHistory((hist ?? []) as any);

      // Live compute today
      const { data, error } = await supabase.functions.invoke(
        "repricer-executive-summary",
        { body: { persist: true } },
      );
      if (!error && data) setToday(data as Summary);
      else if (hist && hist.length) setToday(hist[0] as any);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (loading && !today) {
    return (
      <Card>
        <CardContent className="p-6 flex justify-center">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </CardContent>
      </Card>
    );
  }

  if (!today) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Your daily summary will appear here as soon as the repricer has activity to report on.
        </CardContent>
      </Card>
    );
  }

  const yesterday = history.find((r) => r.snapshot_date < today.snapshot_date);
  const week = history.find((r) => {
    const d = new Date(today.snapshot_date);
    d.setDate(d.getDate() - 7);
    return r.snapshot_date <= d.toISOString().slice(0, 10);
  });

  const delta = (cur: number, prev?: number) => {
    if (prev == null || prev === 0) return null;
    const d = ((cur - prev) / Math.abs(prev)) * 100;
    return Math.round(d * 10) / 10;
  };

  const bbDelta = delta(today.buybox_control_pct, yesterday?.buybox_control_pct);
  const protectedDelta = delta(
    today.revenue_protected,
    yesterday?.revenue_protected,
  );
  const missedDelta = delta(today.revenue_missed, yesterday?.revenue_missed);

  const TrendChip = ({ value }: { value: number | null }) => {
    if (value == null) return null;
    const up = value >= 0;
    const Icon = up ? TrendingUp : TrendingDown;
    return (
      <span
        className={`inline-flex items-center gap-0.5 text-[10px] ${
          up ? "text-emerald-400" : "text-red-400"
        }`}
      >
        <Icon className="h-3 w-3" />
        {Math.abs(value)}%
      </span>
    );
  };

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Target className="h-4 w-4 text-primary" />
              Today's summary
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Your business at a glance — {today.snapshot_date}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="text-[10px] uppercase tracking-wider"
            >
              {today.confidence}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              disabled={refreshing}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Hero metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Shield className="h-3.5 w-3.5" /> Buy Box Control
              </span>
              <TrendChip value={bbDelta} />
            </div>
            <div className="mt-1 text-2xl font-bold text-emerald-400">
              {today.buybox_control_pct}%
            </div>
            <div className="text-[11px] text-muted-foreground">
              of {today.total_active_asins} active listings
            </div>
          </div>

          <Stat
            icon={Shield}
            label="Margin protected"
            value={fmtMoney(today.revenue_protected)}
            tone="good"
            hint="Held at your floor instead of chasing"
          />
          <Stat
            icon={AlertTriangle}
            label="Revenue missed"
            value={fmtMoney(today.revenue_missed)}
            tone={today.revenue_missed > 0 ? "warn" : "neutral"}
            hint="While not winning the Buy Box"
          />
          <Stat
            icon={Package}
            label="Aged stock at risk"
            value={fmtMoney(today.aged_inventory_value)}
            tone={today.aged_inventory_value > 0 ? "warn" : "neutral"}
            hint="30+ days, value-weighted"
          />
        </div>

        {/* Secondary row */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <Stat
            icon={AlertTriangle}
            label="Products needing attention"
            value={String(today.asins_needing_action)}
            tone={today.asins_needing_action > 0 ? "warn" : "good"}
          />
          <Stat
            icon={TrendingUp}
            label="Recovered today"
            value={String(today.recovered_products)}
            tone="good"
          />
          <Stat
            icon={Target}
            label="Active strategies"
            value={String(Object.keys(today.strategy_distribution).length)}
          />
        </div>

        {/* Top blockers + strategy distribution */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="rounded-lg border border-border/60 bg-card/40 p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              What's holding listings back
            </div>
            {today.top_blockers.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                Nothing significant in the last 24 hours.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {today.top_blockers.map((b) => (
                  <li
                    key={b.reason}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-foreground">{b.label}</span>
                    <Badge variant="secondary">{b.count}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-border/60 bg-card/40 p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Active strategies <span className="text-muted-foreground/70">(listings per strategy)</span>
            </div>
            {Object.keys(today.strategy_distribution).length === 0 ? (
              <div className="text-xs text-muted-foreground">
                Strategies will appear after the next review cycle.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {Object.entries(today.strategy_distribution)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 6)
                  .map(([state, count]) => {
                    const meta =
                      STRATEGY_META[state as StrategyState] ?? null;
                    return (
                      <li
                        key={state}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="text-foreground">
                          {meta?.label ?? state}
                        </span>
                        <Badge variant="secondary">{count}</Badge>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>
        </div>

        {/* Trend mini-strip */}
        {history.length >= 2 && (
          <div className="rounded-lg border border-border/60 bg-card/40 p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Trend
            </div>
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div>
                <div className="text-muted-foreground">vs Yesterday</div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span>BB</span>
                  <TrendChip value={bbDelta} />
                </div>
                <div className="flex items-center gap-2">
                  <span>Protected</span>
                  <TrendChip value={protectedDelta} />
                </div>
                <div className="flex items-center gap-2">
                  <span>Missed</span>
                  <TrendChip value={missedDelta} />
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">vs 7 days ago</div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span>BB</span>
                  <TrendChip
                    value={delta(
                      today.buybox_control_pct,
                      week?.buybox_control_pct,
                    )}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span>Protected</span>
                  <TrendChip
                    value={delta(
                      today.revenue_protected,
                      week?.revenue_protected,
                    )}
                  />
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">30-day points</div>
                <div className="mt-0.5 text-foreground">
                  {history.length} snapshots stored
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Advanced details */}
        {mode === "advanced" && (
          <Collapsible open={showDetails} onOpenChange={setShowDetails}>
            <CollapsibleTrigger asChild>
              <button className="w-full flex items-center justify-between rounded-md border border-border bg-card/50 px-3 py-2 text-xs hover:bg-card/80 transition-colors">
                <span className="flex items-center gap-2 text-muted-foreground">
                  {showDetails ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <Info className="h-3.5 w-3.5" />
                  Calculation method & assumptions
                </span>
                <span className="text-[10px] uppercase tracking-wider">
                  {showDetails ? "Hide" : "Show"}
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <pre className="text-[11px] leading-relaxed text-muted-foreground bg-muted/30 rounded-md p-3 overflow-x-auto whitespace-pre-wrap">
{JSON.stringify(today.assumptions, null, 2)}
              </pre>
              <p className="text-[11px] text-muted-foreground mt-2">
                Estimates are deliberately conservative. Revenue impact uses
                fractional-unit/day caps (0.25–0.5 unit/day) to avoid
                exaggerating. Confidence label reflects sample size of recent
                evaluations.
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}
