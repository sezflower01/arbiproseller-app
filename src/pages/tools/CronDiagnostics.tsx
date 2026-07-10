// Admin: Cron job diagnostics — proves overlap protection is working and shows
// last run, duration, status (success / failed / skipped_locked) for each job.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, AlertTriangle, TrendingUp, Activity, Database, Zap, ShieldAlert } from "lucide-react";
import ValidationPanel from "@/components/monitor/ValidationPanel";

// ---- Health helpers ----------------------------------------------------------
const HEALTH = {
  ok:   "bg-emerald-500/10 text-emerald-700 border-emerald-300",
  warn: "bg-amber-500/10  text-amber-700  border-amber-300",
  bad:  "bg-red-500/10    text-red-700    border-red-300",
} as const;
type HealthLevel = keyof typeof HEALTH;

function durationHealth(ms: number | null | undefined): HealthLevel {
  if (ms == null) return "ok";
  if (ms > 60_000) return "bad";
  if (ms > 15_000) return "warn";
  return "ok";
}
function failureHealth(failed: number, runs: number): HealthLevel {
  if (failed === 0) return "ok";
  if (runs > 0 && failed / runs > 0.1) return "bad";
  return "warn";
}
function vacuumHealth(iso: string | null): HealthLevel {
  if (!iso) return "warn";
  const ageDays = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (ageDays > 14) return "bad";
  if (ageDays > 7)  return "warn";
  return "ok";
}
function sizeHealth(bytes: number): HealthLevel {
  const gb = bytes / (1024 ** 3);
  if (gb > 2)   return "bad";
  if (gb > 0.5) return "warn";
  return "ok";
}
function dotClass(h: HealthLevel) {
  return h === "ok" ? "bg-emerald-500" : h === "warn" ? "bg-amber-500" : "bg-red-500";
}
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

// ---- Inline sparkline (no external lib) -------------------------------------
function Sparkline({ values, height = 32, className = "" }: { values: number[]; height?: number; className?: string }) {
  if (values.length === 0) return <div className={`h-${height/4} text-xs text-muted-foreground`}>—</div>;
  const w = Math.max(values.length * 4, 80);
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * w;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = values[values.length - 1];
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg width={w} height={height} className="overflow-visible">
        <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={pts} className="text-primary" />
        <polyline
          fill="hsl(var(--primary) / 0.12)" stroke="none"
          points={`0,${height} ${pts} ${w},${height}`}
        />
      </svg>
      <span className="text-xs tabular-nums text-muted-foreground">peak {max} · now {last}</span>
    </div>
  );
}

interface RunRow {
  id: string;
  job_name: string;
  status: "success" | "failed" | "skipped_locked" | "started";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  items_processed: number | null;
  error: string | null;
}

interface JobSummary {
  job_name: string;
  last_status: string;
  last_started_at: string;
  last_duration_ms: number | null;
  last_items: number | null;
  last_error: string | null;
  runs_24h: number;
  successes_24h: number;
  skipped_24h: number;
  failed_24h: number;
  p95_ms: number;
  max_ms: number;
  total_items: number;
}

interface LoadSnap {
  captured_at: string;
  active_connections: number;
  waiting_queries: number;
  avg_query_ms_5m: number | null;
}

interface ApiTokenRow {
  feature: string;
  count: number;
  window_start: string;
}


const STATUS_BADGE: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-700 border-emerald-300",
  failed: "bg-red-500/15 text-red-700 border-red-300",
  skipped_locked: "bg-amber-500/15 text-amber-700 border-amber-300",
  started: "bg-blue-500/15 text-blue-700 border-blue-300",
};

interface TableSize {
  table_name: string;
  estimated_rows: number;
  total_bytes: number;
  last_vacuum: string | null;
  last_analyze: string | null;
}

const MONITORED_TABLES = [
  "repricer_opportunity_scores",
  "repricer_action_outcomes",
  "repricer_adaptations_log",
  "repricer_buybox_quality",
  "repricer_competitor_profiles",
  "repricer_strategic_insights",
  "repricer_price_actions",
  "repricer_operator_actions",
  "repricer_assignments",
  "inventory",
  "sales_orders",
  "cron_run_history",
];

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

interface RetentionMeta {
  table_name: string;
  retention_days: number;
  oldest_raw: string | null;
  rows_over_retention: number;
  last_prune_at: string | null;
  last_prune_status: string | null;
  next_prune_at: string | null;
  prune_active: boolean;
}

export default function CronDiagnostics() {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [sizes, setSizes] = useState<TableSize[]>([]);
  const [loadSnaps, setLoadSnaps] = useState<LoadSnap[]>([]);
  const [apiStorm, setApiStorm] = useState<ApiTokenRow[]>([]);
  const [retention, setRetention] = useState<RetentionMeta[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const since1h = new Date(Date.now() - 3600 * 1000).toISOString();
    const [hist, sz, snap, storm, ret] = await Promise.all([
      supabase
        .from("cron_run_history")
        .select(
          "id,job_name,status,started_at,finished_at,duration_ms,items_processed,error",
        )
        .gte("started_at", since24)
        .order("started_at", { ascending: false })
        .limit(500),
      supabase.rpc("admin_table_size_estimates", {
        table_names: MONITORED_TABLES,
      }),
      supabase
        .from("system_load_snapshot")
        .select("captured_at,active_connections,waiting_queries,avg_query_ms_5m")
        .gte("captured_at", since1h)
        .order("captured_at", { ascending: true })
        .limit(120),
      supabase
        .from("api_token_recent_consumption")
        .select("feature,count,window_start")
        .gte("window_start", since1h)
        .limit(2000),
      supabase.rpc("admin_retention_status" as any),
    ]);
    if (!hist.error && hist.data) setRows(hist.data as RunRow[]);
    if (!sz.error && sz.data) setSizes(sz.data as TableSize[]);
    if (!snap.error && snap.data) setLoadSnaps(snap.data as LoadSnap[]);
    if (!storm.error && storm.data) setApiStorm(storm.data as ApiTokenRow[]);
    if (!ret.error && Array.isArray(ret.data)) setRetention(ret.data as RetentionMeta[]);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);


  const summaries: JobSummary[] = useMemo(() => {
    const byJob = new Map<string, RunRow[]>();
    rows.forEach((r) => {
      const arr = byJob.get(r.job_name) ?? [];
      arr.push(r);
      byJob.set(r.job_name, arr);
    });
    return Array.from(byJob.entries())
      .map(([job_name, list]) => {
        const last = list[0];
        const durations = list
          .map((r) => r.duration_ms ?? 0)
          .filter((n) => n > 0)
          .sort((a, b) => a - b);
        const totalItems = list.reduce((s, r) => s + (r.items_processed ?? 0), 0);
        return {
          job_name,
          last_status: last.status,
          last_started_at: last.started_at,
          last_duration_ms: last.duration_ms,
          last_items: last.items_processed,
          last_error: last.error,
          runs_24h: list.length,
          successes_24h: list.filter((r) => r.status === "success").length,
          skipped_24h: list.filter((r) => r.status === "skipped_locked").length,
          failed_24h: list.filter((r) => r.status === "failed").length,
          p95_ms: Math.round(quantile(durations, 0.95)),
          max_ms: durations[durations.length - 1] ?? 0,
          total_items: totalItems,
        };
      })
      .sort((a, b) => a.job_name.localeCompare(b.job_name));
  }, [rows]);

  // Queue depth proxy: items_processed per worker run, ordered chronologically.
  const queueSeries = useMemo(() => {
    const pick = (job: string) =>
      rows
        .filter((r) => r.job_name === job)
        .slice(0, 60)
        .reverse()
        .map((r) => r.items_processed ?? 0);
    return {
      inventory: pick("inventory-refresh-worker-1m"),
      listing: pick("listing-validation-worker-1m"),
    };
  }, [rows]);

  // Slowest jobs (top 5 by p95)
  const slowest = useMemo(
    () => [...summaries].sort((a, b) => b.p95_ms - a.p95_ms).slice(0, 5),
    [summaries],
  );

  const totalSkipped = summaries.reduce((s, j) => s + j.skipped_24h, 0);
  const totalFailed = summaries.reduce((s, j) => s + j.failed_24h, 0);

  // ---- Database health (system_load_snapshot, last hour) -------------------
  const dbHealth = useMemo(() => {
    if (loadSnaps.length === 0) return null;
    const latest = loadSnaps[loadSnaps.length - 1];
    const connSeries = loadSnaps.map((s) => s.active_connections ?? 0);
    const waitSeries = loadSnaps.map((s) => s.waiting_queries ?? 0);
    const avgSeries = loadSnaps.map((s) => Math.round(Number(s.avg_query_ms_5m ?? 0)));
    const connMax = Math.max(...connSeries);
    const connPct = (latest.active_connections / 60) * 100;
    const connH: HealthLevel = connPct > 80 ? "bad" : connPct > 60 ? "warn" : "ok";
    const waitH: HealthLevel = latest.waiting_queries > 5 ? "bad" : latest.waiting_queries > 0 ? "warn" : "ok";
    const avgH: HealthLevel = (latest.avg_query_ms_5m ?? 0) > 500 ? "bad" : (latest.avg_query_ms_5m ?? 0) > 200 ? "warn" : "ok";
    return { latest, connSeries, waitSeries, avgSeries, connMax, connPct, connH, waitH, avgH };
  }, [loadSnaps]);

  // ---- API storm detection (top features last hour) ------------------------
  const apiStormTop = useMemo(() => {
    const agg = new Map<string, number>();
    apiStorm.forEach((r) => agg.set(r.feature, (agg.get(r.feature) ?? 0) + (r.count ?? 0)));
    return Array.from(agg.entries())
      .map(([feature, count]) => ({ feature, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [apiStorm]);
  const apiStormTotal = apiStormTop.reduce((s, r) => s + r.count, 0);

  // ---- Critical warnings ---------------------------------------------------
  const retentionByTable = useMemo(() => {
    const m = new Map<string, RetentionMeta>();
    retention.forEach((r) => m.set(r.table_name, r));
    return m;
  }, [retention]);

  const warnings = useMemo(() => {
    const list: { level: HealthLevel; title: string; detail: string }[] = [];
    sizes.forEach((s) => {
      const gb = s.total_bytes / (1024 ** 3);
      if (gb <= 1) return;

      // Retention-aware demotion: if a managed prune job exists, oldest raw row
      // is within retention window, and last prune succeeded — this is
      // expected dead-tuple reuse, not an emergency. Show as info "watch /
      // stable" instead of critical. Stays critical only if: oldest row older
      // than retention, table still growing past 2 GB, or prune is failing.
      const ret = retentionByTable.get(s.table_name);
      const oldestAgeDays = ret?.oldest_raw
        ? (Date.now() - new Date(ret.oldest_raw).getTime()) / 86400000
        : null;
      const retentionHealthy =
        !!ret &&
        ret.prune_active &&
        ret.last_prune_status === "succeeded" &&
        oldestAgeDays !== null &&
        oldestAgeDays <= (ret.retention_days + 1);

      if (retentionHealthy && gb <= 2) {
        list.push({
          level: "ok",
          title: `Watch / stable: ${s.table_name}`,
          detail: `${Math.round(s.estimated_rows).toLocaleString()} rows · ${fmtBytes(s.total_bytes)} · ${ret!.retention_days}d retention active · oldest ${oldestAgeDays!.toFixed(1)}d · last prune ${ret!.last_prune_at ? new Date(ret!.last_prune_at).toLocaleString() : "—"}`,
        });
      } else {
        list.push({
          level: gb > 2 ? "bad" : "warn",
          title: `Large table: ${s.table_name}`,
          detail: `${Math.round(s.estimated_rows).toLocaleString()} rows · ${fmtBytes(s.total_bytes)} · archive recommended`,
        });
      }
    });
    const overdue = sizes.filter((s) => !s.last_analyze).map((s) => s.table_name);
    if (overdue.length > 0) list.push({
      level: "bad",
      title: "ANALYZE overdue",
      detail: overdue.join(", "),
    });
    if (dbHealth && dbHealth.connH === "bad") list.push({
      level: "bad",
      title: "High DB connection pressure",
      detail: `${dbHealth.latest.active_connections}/60 connections in use`,
    });
    return list;
  }, [sizes, dbHealth, retentionByTable]);

  const criticalCount = warnings.filter((w) => w.level === "bad").length;
  const watchCount = warnings.filter((w) => w.level !== "bad").length;


  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Cron Diagnostics</h1>
          <p className="text-sm text-muted-foreground">
            Proof of cron overlap protection. Last 24h of wrapped scheduled jobs.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="ml-2">Refresh</span>
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Jobs tracked</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold">{summaries.length}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Overlaps prevented (24h)</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold text-amber-700">{totalSkipped}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Failures (24h)</CardTitle></CardHeader>
          <CardContent className={`text-2xl font-semibold ${totalFailed ? "text-red-700" : "text-emerald-700"}`}>{totalFailed}</CardContent></Card>
      </div>

      {/* Warnings banner (critical = red, watch/stable = amber/emerald) */}
      {warnings.length > 0 && (
        <Card className={criticalCount > 0 ? "border-red-300 bg-red-500/5" : "border-amber-300 bg-amber-500/5"}>
          <CardHeader className="pb-2">
            <CardTitle className={`text-base flex items-center gap-2 ${criticalCount > 0 ? "text-red-700" : "text-amber-700"}`}>
              <ShieldAlert className="h-4 w-4" />
              {criticalCount > 0
                ? `Critical warnings (${criticalCount})`
                : `Watch / stable (${watchCount})`}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className={`inline-block h-2 w-2 rounded-full mt-1.5 ${dotClass(w.level)}`} />
                <div>
                  <div className="font-medium">{w.title}</div>
                  <div className="text-xs text-muted-foreground">{w.detail}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Database health (system_load_snapshot, last hour) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            Database health (last hour)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!dbHealth ? (
            <div className="text-sm text-muted-foreground">No load snapshots yet — capture-system-load-1m must be running.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <span className={`inline-block h-2 w-2 rounded-full ${dotClass(dbHealth.connH)}`} />
                  Connections
                </div>
                <div className="text-2xl font-semibold tabular-nums">
                  {dbHealth.latest.active_connections} <span className="text-sm text-muted-foreground font-normal">/ 60</span>
                </div>
                <Sparkline values={dbHealth.connSeries} />
              </div>
              <div>
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <span className={`inline-block h-2 w-2 rounded-full ${dotClass(dbHealth.waitH)}`} />
                  Waiting queries
                </div>
                <div className="text-2xl font-semibold tabular-nums">{dbHealth.latest.waiting_queries}</div>
                <Sparkline values={dbHealth.waitSeries} />
              </div>
              <div>
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <span className={`inline-block h-2 w-2 rounded-full ${dotClass(dbHealth.avgH)}`} />
                  Avg query (5m)
                </div>
                <div className="text-2xl font-semibold tabular-nums">
                  {Math.round(Number(dbHealth.latest.avg_query_ms_5m ?? 0))}<span className="text-sm text-muted-foreground font-normal"> ms</span>
                </div>
                <Sparkline values={dbHealth.avgSeries} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* API storm detector */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-600" />
            API storm — top features (last hour)
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">total {apiStormTotal.toLocaleString()}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {apiStormTop.length === 0 ? (
            <div className="text-sm text-muted-foreground">No token consumption recorded in the last hour.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-4">Feature</th>
                  <th className="py-2 pr-4 text-right">Calls / hr</th>
                  <th className="py-2 pr-4">Share</th>
                </tr>
              </thead>
              <tbody>
                {apiStormTop.map((r) => {
                  const pct = apiStormTotal ? (r.count / apiStormTotal) * 100 : 0;
                  const h: HealthLevel = r.count > 30000 ? "bad" : r.count > 10000 ? "warn" : "ok";
                  return (
                    <tr key={r.feature} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${dotClass(h)}`} />
                        {r.feature}
                      </td>
                      <td className="py-2 pr-4 tabular-nums text-right">{r.count.toLocaleString()}</td>
                      <td className="py-2 pr-4 min-w-[160px]">
                        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className={`h-full ${h === "bad" ? "bg-red-500" : h === "warn" ? "bg-amber-500" : "bg-emerald-500"}`}
                            style={{ width: `${pct.toFixed(1)}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{pct.toFixed(1)}%</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>


      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Inventory refresh queue (per-minute drain)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Sparkline values={queueSeries.inventory} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Listing validation queue (per-minute drain)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Sparkline values={queueSeries.listing} />
          </CardContent>
        </Card>
      </div>

      {/* Slowest jobs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            Slowest jobs (24h)
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-4">Job</th>
                <th className="py-2 pr-4 text-right">p95</th>
                <th className="py-2 pr-4 text-right">Worst</th>
                <th className="py-2 pr-4 text-right">Items / 24h</th>
                <th className="py-2 pr-4 text-right">Failures</th>
              </tr>
            </thead>
            <tbody>
              {slowest.map((j) => {
                const h = durationHealth(j.p95_ms);
                return (
                  <tr key={j.job_name} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${dotClass(h)}`} />
                      {j.job_name}
                    </td>
                    <td className="py-2 pr-4 tabular-nums text-right">{(j.p95_ms / 1000).toFixed(2)}s</td>
                    <td className="py-2 pr-4 tabular-nums text-right">{(j.max_ms / 1000).toFixed(2)}s</td>
                    <td className="py-2 pr-4 tabular-nums text-right">{j.total_items.toLocaleString()}</td>
                    <td className={`py-2 pr-4 tabular-nums text-right ${j.failed_24h ? "text-red-700" : ""}`}>{j.failed_24h}</td>
                  </tr>
                );
              })}
              {!loading && slowest.length === 0 && (
                <tr><td colSpan={5} className="py-4 text-center text-muted-foreground text-xs">No data.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Table growth + bottleneck prediction */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Table growth & bottleneck pressure
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-4">Table</th>
                <th className="py-2 pr-4 text-right">Rows (est.)</th>
                <th className="py-2 pr-4 text-right">Size</th>
                <th className="py-2 pr-4">Headroom to 2 GB</th>
                <th className="py-2 pr-4">Last vacuum</th>
                <th className="py-2 pr-4">Last analyze</th>
              </tr>
            </thead>
            <tbody>
              {sizes
                .slice()
                .sort((a, b) => b.total_bytes - a.total_bytes)
                .map((s) => {
                  const sH = sizeHealth(s.total_bytes);
                  const vH = vacuumHealth(s.last_vacuum);
                  const aH = vacuumHealth(s.last_analyze);
                  const ceiling = 2 * 1024 ** 3;
                  const pct = Math.min(100, (s.total_bytes / ceiling) * 100);
                  return (
                    <tr key={s.table_name} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${dotClass(sH)}`} />
                        {s.table_name}
                      </td>
                      <td className="py-2 pr-4 tabular-nums text-right">
                        {Math.round(s.estimated_rows).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 tabular-nums text-right">{fmtBytes(s.total_bytes)}</td>
                      <td className="py-2 pr-4 min-w-[160px]">
                        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className={`h-full ${sH === "bad" ? "bg-red-500" : sH === "warn" ? "bg-amber-500" : "bg-emerald-500"}`}
                            style={{ width: `${pct.toFixed(1)}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{pct.toFixed(1)}% of 2 GB</div>
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        <span className={`inline-flex items-center gap-1.5 ${vH === "bad" ? "text-red-700" : vH === "warn" ? "text-amber-700" : "text-muted-foreground"}`}>
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass(vH)}`} />
                          {s.last_vacuum ? new Date(s.last_vacuum).toLocaleString() : "never"}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        <span className={`inline-flex items-center gap-1.5 ${aH === "bad" ? "text-red-700" : aH === "warn" ? "text-amber-700" : "text-muted-foreground"}`}>
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass(aH)}`} />
                          {s.last_analyze ? new Date(s.last_analyze).toLocaleString() : "never"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              {!loading && sizes.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-muted-foreground text-xs">
                    No size data — admin role required.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Per-job status (last 24h)</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-4">Job</th>
                <th className="py-2 pr-4">Last run</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Last</th>
                <th className="py-2 pr-4">p95</th>
                <th className="py-2 pr-4">Worst</th>
                <th className="py-2 pr-4">Items</th>
                <th className="py-2 pr-4">Runs</th>
                <th className="py-2 pr-4">OK</th>
                <th className="py-2 pr-4">Skipped</th>
                <th className="py-2 pr-4">Failed</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((j) => {
                const dH = durationHealth(j.p95_ms);
                const fH = failureHealth(j.failed_24h, j.runs_24h);
                const overall: HealthLevel = fH === "bad" || dH === "bad" ? "bad" : (fH === "warn" || dH === "warn" ? "warn" : "ok");
                return (
                  <tr key={j.job_name} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${dotClass(overall)}`} />
                      {j.job_name}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {new Date(j.last_started_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant="outline" className={STATUS_BADGE[j.last_status] ?? ""}>
                        {j.last_status}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 tabular-nums">
                      {j.last_duration_ms != null ? `${(j.last_duration_ms / 1000).toFixed(2)}s` : "—"}
                    </td>
                    <td className={`py-2 pr-4 tabular-nums ${dH === "bad" ? "text-red-700" : dH === "warn" ? "text-amber-700" : ""}`}>
                      {(j.p95_ms / 1000).toFixed(2)}s
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{(j.max_ms / 1000).toFixed(2)}s</td>
                    <td className="py-2 pr-4 tabular-nums">{j.last_items ?? "—"}</td>
                    <td className="py-2 pr-4 tabular-nums">{j.runs_24h}</td>
                    <td className="py-2 pr-4 tabular-nums text-emerald-700">{j.successes_24h}</td>
                    <td className="py-2 pr-4 tabular-nums text-amber-700">{j.skipped_24h}</td>
                    <td className={`py-2 pr-4 tabular-nums ${fH === "bad" ? "text-red-700 font-semibold" : "text-red-700"}`}>{j.failed_24h}</td>
                  </tr>
                );
              })}
              {!loading && summaries.length === 0 && (
                <tr><td colSpan={11} className="py-6 text-center text-muted-foreground text-sm">
                  No wrapped runs in the last 24h yet.
                </td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-4">Started</th>
                <th className="py-2 pr-4">Job</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Duration</th>
                <th className="py-2 pr-4">Items</th>
                <th className="py-2 pr-4">Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((r) => {
                const dH = durationHealth(r.duration_ms);
                return (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {new Date(r.started_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{r.job_name}</td>
                    <td className="py-2 pr-4">
                      <Badge variant="outline" className={STATUS_BADGE[r.status] ?? ""}>{r.status}</Badge>
                    </td>
                    <td className={`py-2 pr-4 tabular-nums text-xs ${dH === "bad" ? "text-red-700" : dH === "warn" ? "text-amber-700" : ""}`}>
                      {r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(2)}s` : "—"}
                    </td>
                    <td className="py-2 pr-4 tabular-nums text-xs">{r.items_processed ?? "—"}</td>
                    <td className="py-2 pr-4 text-xs text-red-700 max-w-md truncate">{r.error ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <ValidationPanel />
    </div>
  );
}
