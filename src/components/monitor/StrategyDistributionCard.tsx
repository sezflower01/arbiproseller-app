import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { STRATEGY_META, strategyToneClasses, type StrategyState } from "@/lib/strategyMeta";
import { Brain } from "lucide-react";

const ORDER: StrategyState[] = [
  "profit_max",
  "buybox_defense",
  "competitive_recovery",
  "velocity_boost",
  "aged_pressure",
  "inventory_liquidation",
  "clearance",
];

export default function StrategyDistributionCard() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      const { data } = await supabase
        .from("repricer_strategy_states")
        .select("state")
        .eq("user_id", user.id)
        .gt("expires_at", new Date().toISOString())
        .limit(20000);
      if (cancelled) return;
      const c: Record<string, number> = {};
      (data ?? []).forEach((r: any) => { c[r.state] = (c[r.state] ?? 0) + 1; });
      setCounts(c);
      setTotal((data ?? []).length);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" />
          Pricing strategies in use
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : total === 0 ? (
          <div className="text-sm text-muted-foreground">
            Strategies will appear here after the next review cycle. Until then, every listing defaults to Profit Maximization.
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground mb-2">
              {total} listing{total === 1 ? "" : "s"} grouped by current strategy.
            </div>
            <div className="space-y-1.5">
              {ORDER.map((state) => {
                const n = counts[state] ?? 0;
                if (n === 0) return null;
                const meta = STRATEGY_META[state];
                const pct = Math.round((n / total) * 100);
                return (
                  <div key={state} className="flex items-center justify-between gap-2 text-sm">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={`px-1.5 py-0.5 rounded text-xs border ${strategyToneClasses(meta.tone)}`}>
                        {meta.short}
                      </span>
                      <span className="text-muted-foreground truncate text-xs">{meta.description}</span>
                    </div>
                    <span className="tabular-nums text-xs whitespace-nowrap">
                      <strong>{n}</strong> <span className="text-muted-foreground">({pct}%)</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
