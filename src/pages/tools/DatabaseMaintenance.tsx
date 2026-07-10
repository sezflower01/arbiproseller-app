import { useEffect, useState, useCallback } from 'react';
import { Helmet } from 'react-helmet-async';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useSubscription } from '@/hooks/use-subscription';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Database, RefreshCw, Trash2, AlertTriangle, ShieldAlert,
  CheckCircle2, Loader2, Copy, Activity, Clock, Settings, Cpu, X, TrendingUp, Sparkles, PlayCircle, XCircle, Gauge, PiggyBank,
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

type NightlyStatus = {
  job: { exists: boolean; jobid: number | null; schedule: string | null; active: boolean | null };
  last_parent: { action: string; status: string; started_at: string; finished_at: string | null; duration_ms: number | null; rows_affected: number | null; error_message: string | null; params: any } | null;
  last_cron_run: { runid: number; status: string; start_time: string; end_time: string; return_message: string } | null;
  last_error: { runid: number; start_time: string; return_message: string } | null;
  next_run_estimate: string;
  stale: boolean;
};

type Growth = {
  available: boolean;
  current_bytes: number;
  reference_bytes?: number;
  reference_hours_ago?: number;
  bytes_per_day?: number;
  projected_30d_bytes?: number;
  baseline_reset_at?: string | null;
  top_growers?: { table: string; delta_bytes: number; current_bytes: number }[];
  note?: string;
};
type Recommendations = Record<string, number>;

type TableStat = {
  schema: string; table: string; total_bytes: number;
  live_rows: number; dead_rows: number;
  last_vacuum: string | null; last_autovacuum: string | null;
  last_analyze: string | null; last_autoanalyze: string | null;
};
type Health = {
  total_db_bytes: number; tables: TableStat[];
  last_cleanup: { action: string; status: string; finished_at: string; rows_affected: number } | null;
};
type JobRow = {
  id: string; action: string; status: string; triggered_by_email: string | null;
  started_at: string; finished_at: string | null; duration_ms: number | null;
  rows_affected: number | null; before_total_bytes: number | null; after_total_bytes: number | null;
  error_message: string | null;
};
type Setting = {
  table_key: string; schema_name: string; table_name: string;
  retention_days: number; enabled: boolean; cleanup_rpc: string; description: string | null;
};
type AlertRow = { id: string; severity: 'info' | 'warn' | 'critical'; kind: string; message: string; created_at: string };
type Perf = {
  connections: { state: string | null; count: number }[];
  long_running_queries: { pid: number; state: string; duration_seconds: number; application_name: string; query: string }[];
  lock_waiters: { blocked_pid: number; blocking_pid: number; blocked_query: string; blocking_query: string }[];
  failed_cron_24h: { jobid: number; runid: number; status: string; start_time: string; end_time: string; return_message: string }[];
  refresh_queue_backlog: number;
  open_alerts: AlertRow[];
};
type HealthScore = { score: number; label: 'Excellent'|'Healthy'|'Warning'|'Critical'; db_bytes: number; open_critical: number; open_warn: number; max_bloat_pct: number; queue_backlog: number; failed_cron_24h: number };
type Savings = { total_reclaimed_bytes: number; total_rows_deleted: number; reclaimed_last_30d: number; reclaimed_by_vacuum_full: number; reclaimed_by_cleanup: number };
type SizeHistoryPoint = { captured_at: string; total_db_bytes: number };

const fmtBytes = (b?: number | null) => {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtNum = (n?: number | null) => (n == null ? '—' : n.toLocaleString());
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleString() : 'never');

const VACUUM_FULL_TABLES = [
  'public.fba_inbound_fees',
  'public.repricer_dispatch_metrics',
  'public.repricer_competitor_snapshots',
  'public.repricer_ai_decisions',
  'public.repricer_price_actions',
  'cron.job_run_details',
];

const buildVacuumScript = (tables: string[], full: boolean) => {
  const op = full ? 'VACUUM (FULL, ANALYZE)' : 'VACUUM (ANALYZE)';
  return [
    `-- ${full ? 'VACUUM FULL ANALYZE' : 'VACUUM ANALYZE'} — run during low traffic`,
    full
      ? `-- WARNING: VACUUM FULL locks each table while running. Do NOT paste this into Supabase SQL Editor; run it through psql/direct DB session only.`
      : `-- VACUUM ANALYZE is non-locking and safe to run anytime.`,
    `SET statement_timeout = '30min';`,
    '',
    `-- BEFORE`,
    `SELECT n.nspname || '.' || c.relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS size, s.n_live_tup, s.n_dead_tup`,
    `  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_stat_all_tables s ON s.relid=c.oid`,
    `  WHERE (n.nspname || '.' || c.relname) IN (${tables.map(t => `'${t}'`).join(', ')});`,
    '',
    ...tables.map(t => `${op} ${t};`),
    '',
    `-- AFTER`,
    `SELECT n.nspname || '.' || c.relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS size, s.n_live_tup, s.n_dead_tup`,
    `  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_stat_all_tables s ON s.relid=c.oid`,
    `  WHERE (n.nspname || '.' || c.relname) IN (${tables.map(t => `'${t}'`).join(', ')});`,
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS total_db_size;`,
  ].join('\n');
};

export default function DatabaseMaintenance() {
  const { isAdmin, loading: subLoading } = useSubscription();
  const navigate = useNavigate();

  const [health, setHealth] = useState<Health | null>(null);
  const [perf, setPerf] = useState<Perf | null>(null);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [pendingCleanup, setPendingCleanup] = useState<{ s: Setting; estimate: number | null; loading: boolean } | null>(null);
  const [growth, setGrowth] = useState<Growth | null>(null);
  const [recos, setRecos] = useState<Recommendations>({});
  const [nightly, setNightly] = useState<NightlyStatus | null>(null);
  const [runningNightly, setRunningNightly] = useState(false);
  const [healthScore, setHealthScore] = useState<HealthScore | null>(null);
  const [savings, setSavings] = useState<Savings | null>(null);
  const [sizeHistory, setSizeHistory] = useState<SizeHistoryPoint[]>([]);
  const [lastVacuumFull, setLastVacuumFull] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    const [h, p, s, j, g, r, n, hs, sv, sh, lv] = await Promise.all([
      supabase.rpc('get_database_health' as any),
      supabase.rpc('get_db_performance_snapshot' as any),
      supabase.from('database_maintenance_settings' as any).select('*').order('table_key'),
      supabase.from('database_maintenance_jobs' as any).select('*').order('created_at', { ascending: false }).limit(50),
      supabase.rpc('get_db_growth_stats' as any),
      supabase.rpc('get_recommended_retentions' as any),
      supabase.rpc('get_nightly_maintenance_status' as any),
      supabase.rpc('get_db_health_score' as any),
      supabase.rpc('get_cleanup_savings' as any),
      supabase.rpc('get_db_size_history' as any, { _days: 14 }),
      supabase.rpc('get_last_vacuum_full_per_table' as any),
    ]);
    if (h.error) toast.error(`Health: ${h.error.message}`);
    if (h.data) setHealth(h.data as Health);
    if (p.data) setPerf(p.data as Perf);
    if (s.data) setSettings(s.data as unknown as Setting[]);
    if (j.data) setJobs(j.data as unknown as JobRow[]);
    if (g.data) setGrowth(g.data as Growth);
    if (r.data) setRecos(r.data as Recommendations);
    if (n.data) setNightly(n.data as NightlyStatus);
    if (hs.data) setHealthScore(hs.data as HealthScore);
    if (sv.data) setSavings(sv.data as Savings);
    if (sh.data) setSizeHistory(sh.data as SizeHistoryPoint[]);
    if (lv.data) setLastVacuumFull(lv.data as Record<string, string>);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (subLoading) return;
    if (!isAdmin) { navigate('/tools'); return; }
    refresh();
  }, [isAdmin, subLoading, navigate, refresh]);

  const openConfirm = async (s: Setting) => {
    setPendingCleanup({ s, estimate: null, loading: true });
    const { data, error } = await supabase.rpc('estimate_cleanup' as any, { _table_key: s.table_key, _keep_days: s.retention_days });
    if (error) {
      toast.error(error.message);
      setPendingCleanup({ s, estimate: 0, loading: false });
      return;
    }
    setPendingCleanup({ s, estimate: (data as any)?.estimated_rows ?? 0, loading: false });
  };

  const runCleanup = async (s: Setting) => {
    setRunning(s.cleanup_rpc);
    setPendingCleanup(null);
    try {
      const { data, error } = await supabase.rpc(s.cleanup_rpc as any, { _keep_days: s.retention_days });
      if (error) throw error;
      const d = data as { rows_deleted: number; before_bytes: number; after_bytes: number };
      toast.success(`${s.table_key}: deleted ${fmtNum(d.rows_deleted)} rows (${fmtBytes(d.before_bytes)} → ${fmtBytes(d.after_bytes)})`);
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || 'Cleanup failed');
    } finally {
      setRunning(null);
    }
  };

  const runAllSafe = async () => {
    setRunning('all');
    try {
      for (const s of settings.filter(x => x.enabled)) {
        const { data, error } = await supabase.rpc(s.cleanup_rpc as any, { _keep_days: s.retention_days });
        if (error) { toast.error(`${s.table_key}: ${error.message}`); continue; }
        toast.success(`${s.table_key}: ${fmtNum((data as any)?.rows_deleted)} rows`);
      }
      try { await supabase.rpc('evaluate_health_alerts' as any); } catch { /* non-fatal */ }
      await refresh();
    } finally { setRunning(null); }
  };

  const recheckHealth = async () => {
    try {
      const { error } = await supabase.rpc('evaluate_health_alerts' as any);
      if (error) throw error;
      toast.success('Health re-evaluated — stale alerts cleared');
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to re-evaluate health');
    }
  };

  const saveSetting = async (s: Setting, patch: Partial<Setting>) => {
    const next = { ...s, ...patch };
    setSettings(prev => prev.map(x => x.table_key === s.table_key ? next : x));
    const { error } = await supabase.rpc('update_maintenance_setting' as any, {
      _table_key: s.table_key, _retention_days: next.retention_days, _enabled: next.enabled,
    });
    if (error) { toast.error(error.message); refresh(); }
    else toast.success(`Saved ${s.table_key}`);
  };

  const ackAlert = async (id: string) => {
    const { error } = await supabase.rpc('acknowledge_maintenance_alert' as any, { _id: id });
    if (error) toast.error(error.message);
    else { toast.success('Alert acknowledged'); refresh(); }
  };

  const runNightlyNow = async () => {
    setRunningNightly(true);
    try {
      const { data, error } = await supabase.rpc('run_nightly_maintenance_now' as any);
      if (error) throw error;
      const total = (data as any)?.total_deleted ?? 0;
      toast.success(`Nightly maintenance ran: ${fmtNum(total)} rows deleted`);
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || 'Nightly maintenance failed');
    } finally {
      setRunningNightly(false);
    }
  };

  const copyScript = (full: boolean, tables = VACUUM_FULL_TABLES) => {
    navigator.clipboard.writeText(buildVacuumScript(tables, full));
    toast.success(`${full ? 'VACUUM FULL' : 'VACUUM ANALYZE'} script copied`);
  };

  // One-click VACUUM FULL via edge function
  const ONE_CLICK_VACUUM_TABLES = ['public.repricer_price_actions', 'cron.job_run_details'] as const;
  const [vacuumJob, setVacuumJob] = useState<{ table: string; jobId: string; status: string } | null>(null);

  const runOneClickVacuum = async (table: string) => {
    if (confirmText !== 'CONFIRM VACUUM FULL') return;
    setVacuumJob({ table, jobId: '', status: 'starting' });
    try {
      const { data, error } = await supabase.functions.invoke('admin-vacuum-full', {
        body: { action: 'run', table, confirm: 'CONFIRM VACUUM FULL' },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const jobId = (data as any).job_id as string;
      setVacuumJob({ table, jobId, status: 'running' });
      toast.success(`VACUUM FULL started on ${table}`);
      // Poll
      const poll = async () => {
        const { data: s } = await supabase.functions.invoke('admin-vacuum-full', {
          body: { action: 'status', job_id: jobId },
        });
        const job = (s as any)?.job;
        if (!job) return setTimeout(poll, 3000);
        if (job.status === 'running') {
          setVacuumJob({ table, jobId, status: 'running' });
          return setTimeout(poll, 3000);
        }
        setVacuumJob({ table, jobId, status: job.status });
        if (job.status === 'completed') {
          toast.success(`VACUUM FULL done on ${table}: ${fmtBytes(job.before_total_bytes)} → ${fmtBytes(job.after_total_bytes)}`);
        } else if (job.status === 'failed') {
          toast.error(`VACUUM FULL failed on ${table}: ${job.error_message ?? 'unknown error'}`);
        }
        await refresh();
      };
      setTimeout(poll, 3000);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to start VACUUM FULL');
      setVacuumJob(null);
    }
  };

  if (subLoading || (!isAdmin && !subLoading)) return null;

  const totalDb = health?.total_db_bytes ?? 0;
  const dbColor = totalDb > 6 * 1024 ** 3 ? 'text-red-600' : totalDb > 4 * 1024 ** 3 ? 'text-amber-600' : 'text-green-600';

  return (
    <>
      <Helmet><title>Database Maintenance — Admin</title></Helmet>
      <Navbar />
      <div className="container mx-auto px-4 py-6 max-w-7xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Database className="h-6 w-6" /> Database Maintenance
            </h1>
            <p className="text-sm text-muted-foreground">
              Admin-only. Cleanup runs nightly at 03:30 UTC; VACUUM ANALYZE runs at 03:45 UTC (separate cron, single statement).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={recheckHealth} disabled={loading}>
              <Gauge className="h-4 w-4 mr-2" /> Recheck Health Now
            </Button>
            <Button variant="outline" onClick={refresh} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        </div>

        {/* Health Score + Cleanup Savings */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {healthScore && (() => {
            const cls =
              healthScore.label === 'Excellent' ? 'border-green-300 bg-green-50/40' :
              healthScore.label === 'Healthy' ? 'border-emerald-300 bg-emerald-50/30' :
              healthScore.label === 'Warning' ? 'border-amber-300 bg-amber-50/40' :
              'border-red-300 bg-red-50/40';
            const txt =
              healthScore.label === 'Excellent' ? 'text-green-700' :
              healthScore.label === 'Healthy' ? 'text-emerald-700' :
              healthScore.label === 'Warning' ? 'text-amber-700' : 'text-red-700';
            return (
              <Card className={cls}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Gauge className={`h-5 w-5 ${txt}`} /> Health Score
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-baseline gap-3">
                    <div className={`text-4xl font-bold ${txt}`}>{healthScore.score}</div>
                    <div className={`text-lg font-semibold ${txt}`}>{healthScore.label}</div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <div>DB size: <span className="font-medium text-foreground">{fmtBytes(healthScore.db_bytes)}</span></div>
                    <div>Worst bloat: <span className="font-medium text-foreground">{healthScore.max_bloat_pct}%</span></div>
                    <div>Open critical: <span className="font-medium text-foreground">{healthScore.open_critical}</span></div>
                    <div>Open warnings: <span className="font-medium text-foreground">{healthScore.open_warn}</span></div>
                    <div>Queue backlog: <span className="font-medium text-foreground">{fmtNum(healthScore.queue_backlog)}</span></div>
                    <div>Failed cron 24h: <span className="font-medium text-foreground">{healthScore.failed_cron_24h}</span></div>
                  </div>
                </CardContent>
              </Card>
            );
          })()}
          {savings && (
            <Card className="border-blue-300 bg-blue-50/30">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <PiggyBank className="h-5 w-5 text-blue-700" /> Cleanup Savings
                </CardTitle>
                <CardDescription>Disk reclaimed since maintenance system was enabled.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-blue-700">{fmtBytes(savings.total_reclaimed_bytes)}</div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <div>Last 30d: <span className="font-medium text-foreground">{fmtBytes(savings.reclaimed_last_30d)}</span></div>
                  <div>Rows deleted: <span className="font-medium text-foreground">{fmtNum(savings.total_rows_deleted)}</span></div>
                  <div>VACUUM FULL: <span className="font-medium text-foreground">{fmtBytes(savings.reclaimed_by_vacuum_full)}</span></div>
                  <div>Cleanup DELETEs: <span className="font-medium text-foreground">{fmtBytes(savings.reclaimed_by_cleanup)}</span></div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {perf?.open_alerts && perf.open_alerts.length > 0 && (
          <Card className="border-amber-300 bg-amber-50/40">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-amber-800 text-base">
                <AlertTriangle className="h-4 w-4" /> Open Alerts ({perf.open_alerts.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {perf.open_alerts.map(a => (
                <div key={a.id} className="flex items-start gap-2 text-sm">
                  <Badge variant={a.severity === 'critical' ? 'destructive' : 'secondary'}>{a.severity}</Badge>
                  <div className="flex-1">
                    <div>{a.message}</div>
                    <div className="text-xs text-muted-foreground">{a.kind} · {fmtDate(a.created_at)}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => ackAlert(a.id)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Nightly Automation Status */}
        <Card className={nightly?.stale ? 'border-red-300 bg-red-50/40' : 'border-green-300 bg-green-50/30'}>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  {nightly?.stale ? <XCircle className="h-5 w-5 text-red-600" /> : <CheckCircle2 className="h-5 w-5 text-green-600" />}
                  Nightly Automation Status
                </CardTitle>
                <CardDescription>
                  Cron <code className="text-xs">nightly-data-cleanup-0330</code> · schedule {nightly?.job?.schedule || '—'} UTC
                </CardDescription>
              </div>
              <Button onClick={runNightlyNow} disabled={runningNightly} size="sm">
                {runningNightly ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PlayCircle className="h-4 w-4 mr-2" />}
                Run Nightly Maintenance Now
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Last successful run</div>
              <div className="font-medium">{fmtDate(nightly?.last_parent?.finished_at)}</div>
              <div className="text-xs text-muted-foreground">{nightly?.last_parent?.action || '—'} · {nightly?.last_parent?.status || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Rows deleted</div>
              <div className="font-medium">{fmtNum(nightly?.last_parent?.rows_affected)}</div>
              <div className="text-xs text-muted-foreground">Duration: {nightly?.last_parent?.duration_ms != null ? `${(nightly.last_parent.duration_ms/1000).toFixed(1)}s` : '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Last cron attempt</div>
              <div className={`font-medium ${nightly?.last_cron_run?.status === 'failed' ? 'text-red-600' : ''}`}>
                {fmtDate(nightly?.last_cron_run?.start_time)}
              </div>
              <div className="text-xs text-muted-foreground">Status: {nightly?.last_cron_run?.status || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Next scheduled run</div>
              <div className="font-medium">{fmtDate(nightly?.next_run_estimate)}</div>
              <div className="text-xs text-muted-foreground">{nightly?.job?.active === false ? 'Cron DISABLED' : 'Cron active'}</div>
            </div>
            {nightly?.stale && (
              <div className="col-span-2 md:col-span-4">
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Nightly cleanup hasn't succeeded in over 24 hours</AlertTitle>
                  <AlertDescription>
                    Use "Run Nightly Maintenance Now" to test the orchestrator. If it succeeds here but fails on cron, check cron.job_run_details for jobid {nightly?.job?.jobid ?? '—'}.
                  </AlertDescription>
                </Alert>
              </div>
            )}
            {nightly?.last_error && (
              <div className="col-span-2 md:col-span-4 text-xs bg-red-50 border border-red-200 rounded p-2">
                <div className="font-semibold text-red-800">Last cron error · {fmtDate(nightly.last_error.start_time)}</div>
                <pre className="whitespace-pre-wrap break-words text-red-900 mt-1">{nightly.last_error.return_message}</pre>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Health */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5" /> Database Health</CardTitle>
            <CardDescription>
              Total DB size: <span className={`font-bold ${dbColor}`}>{fmtBytes(totalDb)}</span>
              {health?.last_cleanup && (<> · Last: <Badge variant="secondary">{health.last_cleanup.action}</Badge> {fmtDate(health.last_cleanup.finished_at)}</>)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left">
                  <th className="py-2 pr-3">Table</th>
                  <th className="py-2 pr-3 text-right">Size</th>
                  <th className="py-2 pr-3 text-right">Live</th>
                  <th className="py-2 pr-3 text-right">Dead</th>
                  <th className="py-2 pr-3 text-right">Bloat %</th>
                  <th className="py-2 pr-3">Last vacuum</th>
                  <th className="py-2 pr-3">Last VACUUM FULL</th>
                </tr></thead>
                <tbody>
                  {(health?.tables || []).map(t => {
                    const dead = t.dead_rows || 0; const live = t.live_rows || 0;
                    const ratio = live + dead > 0 ? (dead / (live + dead)) * 100 : 0;
                    const bloatColor = ratio > 50 ? 'text-red-600 font-semibold' : ratio > 20 ? 'text-amber-600' : 'text-muted-foreground';
                    const sizeColor = t.total_bytes > 500 * 1024 ** 2 ? 'text-red-600 font-semibold' : t.total_bytes > 100 * 1024 ** 2 ? 'text-amber-600' : '';
                    const tk = `${t.schema}.${t.table}`;
                    const lastVF = lastVacuumFull[tk];
                    return (
                      <tr key={tk} className="border-b">
                        <td className="py-2 pr-3 font-mono text-xs">{tk}</td>
                        <td className={`py-2 pr-3 text-right ${sizeColor}`}>{fmtBytes(t.total_bytes)}</td>
                        <td className="py-2 pr-3 text-right">{fmtNum(t.live_rows)}</td>
                        <td className="py-2 pr-3 text-right">{fmtNum(t.dead_rows)}</td>
                        <td className={`py-2 pr-3 text-right ${bloatColor}`}>{ratio.toFixed(1)}%</td>
                        <td className="py-2 pr-3 text-xs">{fmtDate(t.last_vacuum || t.last_autovacuum)}</td>
                        <td className="py-2 pr-3 text-xs">{lastVF ? fmtDate(lastVF) : <span className="text-muted-foreground">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Cpu className="h-5 w-5" /> Performance</CardTitle>
            <CardDescription>Live snapshot of connections, long queries, locks and the refresh queue.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 border rounded">
                <div className="text-xs text-muted-foreground">Active connections</div>
                <div className="text-xl font-semibold">{perf?.connections.reduce((a, b) => a + b.count, 0) ?? '—'}</div>
                <div className="text-xs text-muted-foreground">
                  {(perf?.connections || []).map(c => `${c.state || 'idle'}:${c.count}`).join(' · ')}
                </div>
              </div>
              <div className="p-3 border rounded">
                <div className="text-xs text-muted-foreground">Long-running (&gt;30s)</div>
                <div className={`text-xl font-semibold ${(perf?.long_running_queries.length ?? 0) > 0 ? 'text-amber-600' : ''}`}>{perf?.long_running_queries.length ?? 0}</div>
              </div>
              <div className="p-3 border rounded">
                <div className="text-xs text-muted-foreground">Lock waiters</div>
                <div className={`text-xl font-semibold ${(perf?.lock_waiters.length ?? 0) > 0 ? 'text-red-600' : ''}`}>{perf?.lock_waiters.length ?? 0}</div>
              </div>
              <div className="p-3 border rounded">
                <div className="text-xs text-muted-foreground">Refresh queue backlog</div>
                <div className={`text-xl font-semibold ${(perf?.refresh_queue_backlog ?? 0) > 5000 ? 'text-amber-600' : ''}`}>{fmtNum(perf?.refresh_queue_backlog ?? 0)}</div>
              </div>
            </div>

            {perf?.long_running_queries && perf.long_running_queries.length > 0 && (
              <div>
                <div className="font-medium mb-1">Long-running queries</div>
                <div className="border rounded divide-y">
                  {perf.long_running_queries.map(q => (
                    <div key={q.pid} className="p-2 text-xs">
                      <div className="flex justify-between">
                        <span>PID {q.pid} · {q.application_name}</span>
                        <span className="text-amber-600">{q.duration_seconds}s</span>
                      </div>
                      <code className="block mt-1 truncate">{q.query}</code>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {perf?.failed_cron_24h && perf.failed_cron_24h.length > 0 && (
              <div>
                <div className="font-medium mb-1">Recent failed cron runs (24h)</div>
                <div className="border rounded divide-y">
                  {perf.failed_cron_24h.map(c => (
                    <div key={c.runid} className="p-2 text-xs">
                      <div className="flex justify-between">
                        <span>job {c.jobid} · {fmtDate(c.end_time)}</span>
                        <Badge variant="destructive">failed</Badge>
                      </div>
                      <code className="block mt-1 truncate text-muted-foreground">{c.return_message}</code>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Growth */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5" /> History Growth Rate</CardTitle>
            <CardDescription>
              Hourly snapshots project how fast the database is growing and which tables drive it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {sizeHistory.length > 1 && (
              <div className="border rounded p-2">
                <div className="text-xs text-muted-foreground mb-1 flex items-center justify-between">
                  <span>Database size — last 14 days</span>
                  <span>{sizeHistory.length} snapshots</span>
                </div>
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sizeHistory.map(p => ({ t: new Date(p.captured_at).getTime(), bytes: p.total_db_bytes }))}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis
                        dataKey="t"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        className="text-xs"
                        stroke="hsl(var(--muted-foreground))"
                      />
                      <YAxis
                        tickFormatter={(v) => fmtBytes(v)}
                        className="text-xs"
                        stroke="hsl(var(--muted-foreground))"
                        width={70}
                      />
                      <RTooltip
                        labelFormatter={(v) => new Date(v as number).toLocaleString()}
                        formatter={(v: any) => [fmtBytes(v), 'DB size']}
                        contentStyle={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
                      />
                      <Line type="monotone" dataKey="bytes" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
            {!growth?.available && (
              <div className="text-muted-foreground">{growth?.note || 'Collecting baseline snapshots…'}</div>
            )}
            {growth?.available && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="p-3 border rounded">
                    <div className="text-xs text-muted-foreground">Estimated growth</div>
                    <div className="text-xl font-semibold">{fmtBytes(growth.bytes_per_day || 0)} / day</div>
                    <div className="text-xs text-muted-foreground">vs {growth.reference_hours_ago}h ago</div>
                  </div>
                  <div className="p-3 border rounded">
                    <div className="text-xs text-muted-foreground">Projected size in 30 days</div>
                    <div className={`text-xl font-semibold ${(growth.projected_30d_bytes || 0) > 6 * 1024 ** 3 ? 'text-red-600' : (growth.projected_30d_bytes || 0) > 4 * 1024 ** 3 ? 'text-amber-600' : ''}`}>
                      {fmtBytes(growth.projected_30d_bytes || 0)}
                    </div>
                    <div className="text-xs text-muted-foreground">linear projection</div>
                  </div>
                  <div className="p-3 border rounded">
                    <div className="text-xs text-muted-foreground">Current size</div>
                    <div className="text-xl font-semibold">{fmtBytes(growth.current_bytes)}</div>
                  </div>
                </div>
                {growth.top_growers && growth.top_growers.length > 0 && (
                  <div>
                    <div className="font-medium mb-1">Top growing tables</div>
                    <div className="border rounded divide-y">
                      {growth.top_growers.map(t => (
                        <div key={t.table} className="p-2 flex justify-between text-xs">
                          <span className="font-mono">{t.table}</span>
                          <span>
                            <span className="text-amber-600">+{fmtBytes(t.delta_bytes)}</span>
                            <span className="text-muted-foreground"> · now {fmtBytes(t.current_bytes)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Safe cleanup */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-700">
              <CheckCircle2 className="h-5 w-5" /> Safe Cleanups
            </CardTitle>
            <CardDescription>
              Non-locking DELETEs. Each click previews the row count before running. Nightly cron runs all enabled rows automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {settings.map(s => {
              const reco = recos[s.table_key];
              const showReco = reco != null && reco < s.retention_days;
              return (
                <div key={s.table_key} className="flex items-center gap-3 p-3 border rounded-md">
                  <div className="flex-1">
                    <div className="font-medium font-mono text-xs">{s.schema_name}.{s.table_name}</div>
                    <div className="text-xs text-muted-foreground">{s.description}</div>
                  </div>
                  {showReco && (
                    <Badge variant="outline" className="border-amber-400 text-amber-700 gap-1">
                      <Sparkles className="h-3 w-3" /> recommend {reco}d
                    </Badge>
                  )}
                  <Badge variant={s.enabled ? 'default' : 'secondary'}>{s.enabled ? 'auto on' : 'auto off'}</Badge>
                  <span className="text-xs text-muted-foreground">keep {s.retention_days}d</span>
                  <Button size="sm" disabled={running !== null} onClick={() => openConfirm(s)}>
                    {running === s.cleanup_rpc ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    <span className="ml-2">Clean now</span>
                  </Button>
                </div>
              );
            })}
            <div className="flex items-center justify-between pt-2 border-t">
              <div className="text-sm text-muted-foreground">Run every enabled cleanup with current retention.</div>
              <Button onClick={runAllSafe} disabled={running !== null}>
                {running === 'all' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                Run all safe cleanups
              </Button>
            </div>
            <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
              <div>
                <div className="font-medium">VACUUM ANALYZE (non-locking)</div>
                <div className="text-xs text-muted-foreground">Already runs nightly. Copy the script for an ad-hoc run in SQL Editor.</div>
              </div>
              <Button variant="outline" onClick={() => copyScript(false)}>
                <Copy className="h-4 w-4 mr-2" /> Copy SQL
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Retention settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Settings className="h-5 w-5" /> Retention Settings</CardTitle>
            <CardDescription>Per-table retention used by the nightly cron and Clean now buttons.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left">
                  <th className="py-2 pr-3">Table</th>
                  <th className="py-2 pr-3 text-right">Retention (days)</th>
                  <th className="py-2 pr-3 text-center">Recommended</th>
                  <th className="py-2 pr-3 text-center">Auto cleanup</th>
                </tr></thead>
                <tbody>
                  {settings.map(s => {
                    const reco = recos[s.table_key];
                    return (
                      <tr key={s.table_key} className="border-b">
                        <td className="py-2 pr-3 font-mono text-xs">{s.schema_name}.{s.table_name}</td>
                        <td className="py-2 pr-3 text-right">
                          <Input
                            type="number" min={1} className="w-24 h-8 ml-auto text-right"
                            value={s.retention_days}
                            onChange={e => setSettings(prev => prev.map(x => x.table_key === s.table_key ? { ...x, retention_days: Math.max(1, parseInt(e.target.value || '1', 10)) } : x))}
                            onBlur={() => saveSetting(s, { retention_days: s.retention_days })}
                          />
                        </td>
                        <td className="py-2 pr-3 text-center text-xs">
                          {reco != null ? (
                            <button
                              className={`px-2 py-0.5 rounded border ${reco < s.retention_days ? 'border-amber-400 text-amber-700 hover:bg-amber-50' : 'border-muted text-muted-foreground'}`}
                              onClick={() => reco !== s.retention_days && saveSetting(s, { retention_days: reco })}
                              title={reco !== s.retention_days ? `Apply recommended ${reco}d` : 'Already at recommended value'}
                            >
                              {reco}d {reco < s.retention_days && '↓'}
                            </button>
                          ) : '—'}
                        </td>
                        <td className="py-2 pr-3 text-center">
                          <Switch checked={s.enabled} onCheckedChange={v => saveSetting(s, { enabled: v })} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Danger zone */}
        <Card className="border-red-300">
          <CardHeader className="bg-red-50/50">
            <CardTitle className="flex items-center gap-2 text-red-700">
              <ShieldAlert className="h-5 w-5" /> Danger Zone — VACUUM FULL
            </CardTitle>
            <CardDescription className="text-red-700/80">
              Reclaims disk space by rewriting tables. Each table is locked while running (1–10 min). Manual only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>One-click VACUUM FULL — runs via edge function</AlertTitle>
              <AlertDescription>
                The two heaviest bloat targets can be reclaimed in-app. Each runs in the background against the direct DB connection (bypasses Supabase SQL Editor's transaction wrapper). Other tables: copy the SQL and run via psql.
              </AlertDescription>
            </Alert>
            <div className="space-y-2">
              <label className="text-sm font-medium">Type <code className="px-1 bg-muted rounded">CONFIRM VACUUM FULL</code> to enable:</label>
              <Input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="CONFIRM VACUUM FULL" />
            </div>

            <div className="space-y-2 rounded-md border p-3 bg-background">
              <div className="text-sm font-medium">One-click (admin only)</div>
              {ONE_CLICK_VACUUM_TABLES.map(t => {
                const isActive = vacuumJob?.table === t;
                const status = isActive ? vacuumJob!.status : null;
                const running = status === 'starting' || status === 'running';
                return (
                  <div key={t} className="flex items-center justify-between gap-2">
                    <code className="text-xs">{t}</code>
                    <div className="flex items-center gap-2">
                      {status === 'completed' && <Badge variant="default" className="bg-green-600">completed</Badge>}
                      {status === 'failed' && <Badge variant="destructive">failed</Badge>}
                      {running && <Badge variant="secondary"><Loader2 className="h-3 w-3 mr-1 animate-spin" /> running</Badge>}
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={confirmText !== 'CONFIRM VACUUM FULL' || running || !!vacuumJob && vacuumJob.status === 'running'}
                        onClick={() => runOneClickVacuum(t)}
                      >
                        <PlayCircle className="h-3 w-3 mr-1" /> Run VACUUM FULL
                      </Button>
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground pt-1">
                Each table is locked while running (1–10 min). Run one at a time. Never scheduled — manual only.
              </p>
            </div>

            <div className="grid gap-2 pt-2 border-t">
              <div className="text-sm font-medium text-muted-foreground">Other tables — copy SQL (run via psql)</div>
              <Button variant="outline" disabled={confirmText !== 'CONFIRM VACUUM FULL'} onClick={() => copyScript(true)}>
                <Copy className="h-4 w-4 mr-2" /> Copy VACUUM FULL script (all 6 tables)
              </Button>
              <div className="grid grid-cols-2 gap-2">
                {VACUUM_FULL_TABLES.map(t => (
                  <Button key={t} variant="outline" size="sm" disabled={confirmText !== 'CONFIRM VACUUM FULL'} onClick={() => copyScript(true, [t])}>
                    <Copy className="h-3 w-3 mr-2" /> {t}
                  </Button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* History */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5" /> Maintenance Job History</CardTitle>
            <CardDescription>Last 50 maintenance actions (manual + nightly cron).</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left">
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Action</th>
                  <th className="py-2 pr-3">By</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3 text-right">Rows</th>
                  <th className="py-2 pr-3 text-right">Before → After</th>
                  <th className="py-2 pr-3 text-right">Duration</th>
                </tr></thead>
                <tbody>
                  {jobs.length === 0 && (
                    <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">No jobs yet.</td></tr>
                  )}
                  {jobs.map(j => (
                    <tr key={j.id} className="border-b">
                      <td className="py-2 pr-3 text-xs">{fmtDate(j.started_at)}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{j.action}</td>
                      <td className="py-2 pr-3 text-xs">{j.triggered_by_email || '—'}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={j.status === 'completed' ? 'default' : j.status === 'failed' ? 'destructive' : 'secondary'}>{j.status}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-right">{fmtNum(j.rows_affected)}</td>
                      <td className="py-2 pr-3 text-right text-xs">{fmtBytes(j.before_total_bytes)} → {fmtBytes(j.after_total_bytes)}</td>
                      <td className="py-2 pr-3 text-right text-xs">{j.duration_ms != null ? `${(j.duration_ms / 1000).toFixed(2)}s` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
      <Footer />

      {/* Confirm cleanup dialog */}
      <AlertDialog open={!!pendingCleanup} onOpenChange={o => !o && setPendingCleanup(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run cleanup?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <div>
                  Delete rows older than <b>{pendingCleanup?.s.retention_days} days</b> from{' '}
                  <code className="px-1 bg-muted rounded">{pendingCleanup?.s.schema_name}.{pendingCleanup?.s.table_name}</code>.
                </div>
                <div className="text-sm">
                  Estimated rows to delete:{' '}
                  {pendingCleanup?.loading
                    ? <Loader2 className="inline h-3 w-3 animate-spin" />
                    : <b>{fmtNum(pendingCleanup?.estimate ?? 0)}</b>}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!pendingCleanup || pendingCleanup.loading}
              onClick={() => pendingCleanup && runCleanup(pendingCleanup.s)}
            >
              Yes, delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
