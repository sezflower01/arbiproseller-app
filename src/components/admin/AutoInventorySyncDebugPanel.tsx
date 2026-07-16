/**
 * Auto Inventory Sync cron status — visible to every signed-in user (not
 * admin-only anymore, since the product is a SaaS where every user gets the
 * same tools). auto_inventory_sync_runs has no user_id column (one row per
 * whole cron cycle, aggregating counts across all users), so this only ever
 * shows aggregate counts, never another user's private data.
 *
 * Visibility into:
 *  - Whether the cron actually fired
 *  - When it started/completed
 *  - Items attempted / updated / skipped / errors
 *  - Next scheduled run (every 4h at :30)
 */
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, AlertTriangle, CheckCircle, Clock, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface RunRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  triggered_by: string | null;
  users_count: number | null;
  attempted: number | null;
  updated: number | null;
  skipped: number | null;
  errors: number | null;
  elapsed_ms: number | null;
  ok: boolean | null;
  error_message: string | null;
}

function nextCronAt(): Date {
  // Cron schedule: 30 */4 * * * UTC (00:30, 04:30, 08:30, 12:30, 16:30, 20:30)
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now);
    d.setUTCMinutes(30, 0, 0);
    d.setUTCHours(now.getUTCHours() + i);
    if (d.getUTCHours() % 4 === 0 && d.getTime() > now.getTime()) return d;
  }
  return now;
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function AutoInventorySyncDebugPanel() {
  const { user } = useAuth();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const fetchRuns = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("auto_inventory_sync_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(10);
    if (!error && data) setRuns(data as RunRow[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (user) fetchRuns();
  }, [user, fetchRuns]);

  const triggerNow = async () => {
    setTriggering(true);
    try {
      const { data, error } = await supabase.functions.invoke("auto-inventory-sync", {
        body: { user_id: user?.id, max_per_user: 25, triggered_by: "manual_user_trigger" },
      });
      if (error) throw error;
      toast.success(`Run complete: ${data?.summary?.[0]?.updated || 0} updated, ${data?.summary?.[0]?.errors || 0} errors`);
      await fetchRuns();
    } catch (e: any) {
      toast.error(`Trigger failed: ${e?.message || "unknown"}`);
    } finally {
      setTriggering(false);
    }
  };

  if (!user) return null;

  const latest = runs[0];
  const nextRun = nextCronAt();

  return (
    <Card className="border-dashed border-blue-500/40 bg-blue-50/30 dark:bg-blue-950/10">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4 text-blue-500" />
          Auto Inventory Sync — Cron Status
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              Next run: {nextRun.toLocaleString()} ({ago(new Date(Date.now() - (nextRun.getTime() - Date.now())).toISOString())} from now reversed)
            </span>
            <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={fetchRuns} disabled={loading}>
              <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="default" size="sm" className="h-6 px-2 text-[10px]" onClick={triggerNow} disabled={triggering}>
              {triggering ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : <Activity className="h-3 w-3 mr-1" />}
              Run now (me)
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2 px-4 space-y-2">
        {!latest ? (
          <div className="text-xs text-yellow-600 flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3" />
            No runs logged yet. Cron logging starts after the next deploy. Next scheduled: {nextRun.toLocaleString()}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
              <Stat label="Started" value={ago(latest.started_at)} title={new Date(latest.started_at).toLocaleString()} />
              <Stat label="Completed" value={latest.completed_at ? ago(latest.completed_at) : "in progress"} title={latest.completed_at ? new Date(latest.completed_at).toLocaleString() : ""} />
              <Stat label="Attempted" value={String(latest.attempted ?? 0)} />
              <Stat label="Updated" value={String(latest.updated ?? 0)} highlight={(latest.updated ?? 0) > 0} />
              <Stat label="Skipped" value={String(latest.skipped ?? 0)} />
              <Stat label="Errors" value={String(latest.errors ?? 0)} highlight={(latest.errors ?? 0) > 0} danger />
            </div>
            {latest.error_message && (
              <div className="text-[11px] text-red-600 bg-red-500/5 rounded px-2 py-1">
                <AlertTriangle className="inline h-3 w-3 mr-1" />
                {latest.error_message}
              </div>
            )}
          </>
        )}

        {runs.length > 1 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Run history ({runs.length})</summary>
            <div className="max-h-48 overflow-y-auto mt-1 space-y-0.5">
              {runs.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[10px] py-0.5 px-2 rounded bg-muted/30">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono w-32">{new Date(r.started_at).toLocaleString()}</span>
                  <Badge variant="outline" className="text-[9px] h-4">{r.triggered_by || "—"}</Badge>
                  <span>users {r.users_count ?? 0}</span>
                  <span>att {r.attempted ?? 0}</span>
                  <span>upd {r.updated ?? 0}</span>
                  <span>err {r.errors ?? 0}</span>
                  <span className="ml-auto">
                    {r.ok === true && <CheckCircle className="h-3 w-3 text-green-500 inline" />}
                    {r.ok === false && <AlertTriangle className="h-3 w-3 text-red-500 inline" />}
                    {r.ok === null && <RefreshCw className="h-3 w-3 text-muted-foreground inline animate-spin" />}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, highlight, danger, title }: { label: string; value: string; highlight?: boolean; danger?: boolean; title?: string }) {
  return (
    <div title={title} className={`rounded px-2 py-1 ${highlight ? (danger ? "bg-red-500/10 border border-red-500/30" : "bg-green-500/10 border border-green-500/30") : "bg-muted/40"}`}>
      <div className="text-[9px] uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`font-semibold ${danger && highlight ? "text-red-600" : highlight ? "text-green-600" : ""}`}>{value}</div>
    </div>
  );
}
