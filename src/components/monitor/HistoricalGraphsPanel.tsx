import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LineChart, Activity, ShieldAlert, RefreshCw, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  Bar,
} from "recharts";

type TimeRange = "6h" | "24h" | "7d";

interface Snapshot {
  captured_at: string;
  hot_p50_minutes: number;
  hot_p90_minutes: number;
  hot_truly_stale: number;
  hot_dispatchable: number;
  hot_blocked: number;
  evals_1h: number;
  writes_1h: number;
  evals_24h: number;
  writes_24h: number;
  coverage_pct: number;
  constraint_profit_guard: number;
  constraint_min_bound: number;
  constraint_market_stable: number;
  constraint_other: number;
  health_score: number;
  bb_winning: number;
  bb_losing: number;
}

export default function HistoricalGraphsPanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<TimeRange>("24h");

  const copyAllData = () => {
    if (chartData.length === 0) return;
    const header = "Time\tp50\tp90\tTruly Stale\tEvals/h\tWrites/h\tCoverage%\tProfit Guard\tMin Bound\tMarket Stable\tOther\tHealth\tBB Win\tBB Lose";
    const rows = chartData.map(d =>
      `${d.time}\t${d.hotP50}\t${d.hotP90}\t${d.stale}\t${d.evals}\t${d.writes}\t${d.coverage}\t${d.profitGuard}\t${d.minBound}\t${d.marketStable}\t${d.other}\t${d.health}\t${d.bbWin}\t${d.bbLose}`
    );
    navigator.clipboard.writeText([header, ...rows].join("\n"));
    toast({ title: "Copied", description: `${chartData.length} data points copied to clipboard` });
  };

  const fetchSnapshots = async () => {
    if (!user) return;
    setLoading(true);

    const hoursMap: Record<TimeRange, number> = { "6h": 6, "24h": 24, "7d": 168 };
    const since = new Date(Date.now() - hoursMap[range] * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("repricer_monitor_snapshots" as any)
      .select("*")
      .eq("user_id", user.id)
      .gte("captured_at", since)
      .order("captured_at", { ascending: true })
      .limit(2000);

    if (!error && data) {
      setSnapshots(data as unknown as Snapshot[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchSnapshots();
  }, [user, range]);

  const chartData = useMemo(() => {
    return snapshots.map((s) => {
      const d = new Date(s.captured_at);
      const label =
        range === "7d"
          ? `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`
          : `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
      return {
        time: label,
        hotP50: s.hot_p50_minutes,
        hotP90: s.hot_p90_minutes,
        stale: s.hot_truly_stale,
        evals: s.evals_1h,
        writes: s.writes_1h,
        coverage: s.coverage_pct,
        profitGuard: s.constraint_profit_guard,
        minBound: s.constraint_min_bound,
        marketStable: s.constraint_market_stable,
        other: s.constraint_other,
        health: s.health_score,
        bbWin: s.bb_winning,
        bbLose: s.bb_losing,
      };
    });
  }, [snapshots, range]);

  if (loading && snapshots.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Loading historical data…
        </CardContent>
      </Card>
    );
  }

  if (snapshots.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <LineChart className="h-4 w-4 text-primary" />
            Historical Graphs
          </CardTitle>
        </CardHeader>
        <CardContent className="text-center text-muted-foreground py-6">
          No snapshot data yet. Graphs will appear once the 5-minute cron starts collecting data.
        </CardContent>
      </Card>
    );
  }

  const ranges: TimeRange[] = ["6h", "24h", "7d"];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <LineChart className="h-5 w-5 text-primary" />
          Historical Monitor Graphs
          <span className="text-xs text-muted-foreground font-normal ml-2">
            5-min snapshots · {snapshots.length} points
          </span>
        </h2>
        <div className="flex items-center gap-2">
          {ranges.map((r) => (
            <Button
              key={r}
              variant={range === r ? "default" : "outline"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={copyAllData}>
            <Copy className="h-3.5 w-3.5 mr-1" />
            Copy Data
          </Button>
          <Button variant="ghost" size="sm" className="h-7" onClick={fetchSnapshots}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* HOT Freshness */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4 text-red-400" />
            HOT Freshness (minutes)
            <span className="text-xs font-normal text-muted-foreground ml-auto">
              Lower is better · SLA target &lt; 30m
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend />
              <Area
                type="monotone"
                dataKey="hotP50"
                name="p50"
                stroke="hsl(var(--primary))"
                fill="hsl(var(--primary) / 0.15)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="hotP90"
                name="p90"
                stroke="#f97316"
                fill="rgba(249,115,22,0.1)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="stale"
                name="Truly Stale"
                stroke="#ef4444"
                fill="rgba(239,68,68,0.1)"
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Eval/Write Throughput */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-400" />
            Eval / Write Throughput (per hour)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend />
              <Area
                type="monotone"
                dataKey="evals"
                name="Evals/h"
                stroke="hsl(var(--primary))"
                fill="hsl(var(--primary) / 0.1)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="writes"
                name="Writes/h"
                stroke="#10b981"
                fill="rgba(16,185,129,0.1)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Constraint Pressure */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-400" />
            Constraint Pressure (24h cumulative at snapshot time)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend />
              <Bar dataKey="profitGuard" name="Profit Guard" stackId="a" fill="#ef4444" />
              <Bar dataKey="minBound" name="Min Bound" stackId="a" fill="#3b82f6" />
              <Bar dataKey="marketStable" name="Market Stable" stackId="a" fill="#10b981" />
              <Bar dataKey="other" name="Other" stackId="a" fill="#6b7280" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
