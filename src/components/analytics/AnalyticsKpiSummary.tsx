import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface KpiData {
  avg_recovery_hours: number | null;
  write_success_rate: number | null;
  hot_p90: number | null;
  profit_guard_count: number;
  floor_pressure_count: number;
  bb_win_rate: number | null;
  total_writes_24h: number;
  total_evals_24h: number;
}

const KPI_QUERIES = {
  write_rate: `SELECT
    COUNT(*) FILTER (WHERE action_type = 'price_changed' AND success = true) AS writes,
    COUNT(*) AS total,
    ROUND(100.0 * COUNT(*) FILTER (WHERE action_type = 'price_changed' AND success = true) / NULLIF(COUNT(*), 0), 1) AS write_pct,
    COUNT(*) FILTER (WHERE action_type = 'blocked_by_profit_guard') AS profit_guard,
    COUNT(*) FILTER (WHERE action_type IN ('no_change') AND reason ILIKE '%min_price%') AS floor_blocks
  FROM repricer_price_actions
  WHERE user_id = auth.uid() AND created_at >= NOW() - INTERVAL '24 hours'`,

  bb_status: `SELECT
    COUNT(*) FILTER (WHERE last_buybox_status IN ('winning', 'owned')) AS winning,
    COUNT(*) FILTER (WHERE last_buybox_status = 'losing') AS losing,
    COUNT(*) AS total,
    ROUND(100.0 * COUNT(*) FILTER (WHERE last_buybox_status IN ('winning', 'owned')) / NULLIF(COUNT(*), 0), 1) AS win_pct
  FROM repricer_assignments
  WHERE is_enabled = true AND rule_id IS NOT NULL`,

  recovery: `SELECT
    ROUND(AVG(CASE WHEN buybox_lost_at IS NOT NULL AND last_applied_at > buybox_lost_at
      THEN EXTRACT(EPOCH FROM (last_applied_at - buybox_lost_at)) / 3600 ELSE NULL END)::numeric, 1) AS avg_hours
  FROM repricer_assignments
  WHERE buybox_lost_at IS NOT NULL AND is_enabled = true AND last_buybox_status IN ('winning', 'owned')`,

  hot_freshness: `SELECT hot_p90_minutes
  FROM repricer_monitor_snapshots
  WHERE user_id = auth.uid() AND captured_at >= NOW() - INTERVAL '1 hour'
  ORDER BY captured_at DESC LIMIT 1`,
};

export default function AnalyticsKpiSummary() {
  const [data, setData] = useState<KpiData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchKpis = async () => {
    setLoading(true);
    try {
      const results = await Promise.all(
        Object.entries(KPI_QUERIES).map(async ([key, sql]) => {
          const { data, error } = await supabase.rpc("run_analytics_query" as any, { query_text: sql });
          if (error) {
            console.error(`[KPI] ${key} error:`, error);
            return [key, null];
          }
          const rows = Array.isArray(data) ? data : data ? [data] : [];
          return [key, rows[0] || null];
        })
      );

      const r = Object.fromEntries(results);

      setData({
        write_success_rate: r.write_rate?.write_pct ?? null,
        total_writes_24h: r.write_rate?.writes ?? 0,
        total_evals_24h: r.write_rate?.total ?? 0,
        profit_guard_count: r.write_rate?.profit_guard ?? 0,
        floor_pressure_count: r.write_rate?.floor_blocks ?? 0,
        bb_win_rate: r.bb_status?.win_pct ?? null,
        avg_recovery_hours: r.recovery?.avg_hours ?? null,
        hot_p90: r.hot_freshness?.hot_p90_minutes ?? null,
      });
    } catch (err) {
      console.error("[KPI] fetch failed:", err);
      toast.error("Failed to load KPIs");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKpis();
  }, []);

  const kpis = data
    ? [
        { label: "Write Rate (24h)", value: data.write_success_rate != null ? `${data.write_success_rate}%` : "—", sub: `${data.total_writes_24h} / ${data.total_evals_24h}` },
        { label: "BB Win Rate", value: data.bb_win_rate != null ? `${data.bb_win_rate}%` : "—", sub: "enabled + rule" },
        { label: "Avg Recovery", value: data.avg_recovery_hours != null ? `${data.avg_recovery_hours}h` : "—", sub: "BB loss → win" },
        { label: "HOT p90", value: data.hot_p90 != null ? `${data.hot_p90}m` : "—", sub: "freshness" },
        { label: "Profit Guard", value: String(data.profit_guard_count), sub: "blocks (24h)" },
        { label: "Floor Pressure", value: String(data.floor_pressure_count), sub: "min_price blocks" },
      ]
    : [];

  return (
    <div className="space-y-3 mb-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">KPI Summary (24h)</h3>
        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={fetchKpis} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh
        </Button>
      </div>
      {data ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {kpis.map((k) => (
            <Card key={k.label} className="border-border/40">
              <CardContent className="p-3 text-center">
                <div className="text-lg font-bold">{k.value}</div>
                <div className="text-[10px] text-muted-foreground font-medium">{k.label}</div>
                <div className="text-[9px] text-muted-foreground/60">{k.sub}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading KPIs...
        </div>
      ) : null}
    </div>
  );
}
