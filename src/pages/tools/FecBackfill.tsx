import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { ModuleGuard } from '@/components/access/ModuleGuard';

interface MonthResult {
  month: string;
  upstream_status?: number;
  fec_rows?: number;
  elapsed_ms?: number;
  ok?: boolean;
  error?: string;
  status?: 'pending' | 'running' | 'ok' | 'failed';
  message?: string;
  progress_id?: string;
}

const DEFAULT_MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04'];
const STORAGE_KEY = 'fec-backfill-state-v1';

function FecBackfillInner() {
  const { user } = useAuth();
  const [targetUserId, setTargetUserId] = useState(user?.id ?? '');
  const [monthsText, setMonthsText] = useState(DEFAULT_MONTHS.join(', '));
  const [force, setForce] = useState(true);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<MonthResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  // Persist state so leaving/returning resumes instead of restarting.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.targetUserId) setTargetUserId(saved.targetUserId);
        if (saved.monthsText) setMonthsText(saved.monthsText);
        if (typeof saved.force === 'boolean') setForce(saved.force);
        if (Array.isArray(saved.results)) setResults(saved.results);
        if (saved.running) {
          // Auto-resume polling any month that wasn't finalized.
          setTimeout(() => resumeBackfill(saved), 100);
        }
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = (patch: any) => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const prev = raw ? JSON.parse(raw) : {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prev, ...patch }));
    } catch {}
  };

  const pollMonth = async (
    targetUserId: string,
    month: string,
    progressId: string,
    monthStarted: number,
    updateMonth: (m: string, p: Partial<MonthResult>) => void,
  ): Promise<boolean> => {
    let done = false;
    let ok = false;
    const MAX_WAIT_MS = 12 * 60_000; // 12 minutes per month
    while (!done) {
      if (cancelRef.current) return false;
      await new Promise((r) => setTimeout(r, 5000));
      const { data: statusData, error: statusError } = await supabase.functions.invoke(
        'admin-backfill-fec-months',
        { body: { action: 'status', target_user_id: targetUserId, month, progress_id: progressId } },
      );
      if (statusError) throw statusError;
      const elapsed = Date.now() - monthStarted;
      const fecRows = statusData?.fec_rows ?? 0;
      done = statusData?.done === true;
      // Hard cap: if we've waited > MAX_WAIT_MS and still no data, give up.
      if (!done && elapsed > MAX_WAIT_MS) {
        done = true;
        updateMonth(month, {
          ok: fecRows > 0,
          status: fecRows > 0 ? 'ok' : 'failed',
          error: fecRows > 0 ? undefined : `Timed out after ${Math.round(elapsed/60000)}m (progress=${statusData?.progress_status || 'unknown'})`,
          fec_rows: fecRows,
          elapsed_ms: elapsed,
        });
        return fecRows > 0;
      }
      updateMonth(month, {
        fec_rows: fecRows,
        elapsed_ms: elapsed,
        message: statusData?.message || (done ? 'Finished' : `Running… (${Math.round(elapsed/1000)}s, ${fecRows} rows)`),
      });
      if (done) {
        ok = statusData?.ok === true;
        updateMonth(month, {
          ok,
          status: ok ? 'ok' : 'failed',
          error: ok ? undefined : (statusData?.error || statusData?.message || 'Failed'),
          fec_rows: fecRows,
          elapsed_ms: elapsed,
        });
      }
    }
    return ok;
  };

  const resumeBackfill = async (saved: any) => {
    const savedResults: MonthResult[] = saved.results || [];
    const targetUserId: string = saved.targetUserId;
    if (!targetUserId) return;
    setRunning(true);
    cancelRef.current = false;

    const updateMonth = (month: string, patch: Partial<MonthResult>) => {
      setResults((prev) => {
        const next = (prev ?? savedResults).map((row) =>
          row.month === month ? { ...row, ...patch } : row,
        );
        persist({ results: next });
        return next;
      });
    };

    try {
      const months: string[] = savedResults.map((r) => r.month);
      let okCount = 0;
      for (const month of months) {
        const row = savedResults.find((r) => r.month === month);
        if (!row) continue;
        if (row.status === 'ok' || row.status === 'failed') {
          if (row.status === 'ok') okCount += 1;
          continue;
        }
        const monthStarted = Date.now() - (row.elapsed_ms ?? 0);
        let progressId = row.progress_id;
        if (!progressId) {
          updateMonth(month, { status: 'running', message: 'Starting…' });
          const { data: startData, error: startError } = await supabase.functions.invoke(
            'admin-backfill-fec-months',
            { body: { action: 'start_month', target_user_id: targetUserId, month, force: saved.force === true } },
          );
          if (startError) throw startError;
          progressId = startData?.progress_id;
          if (!progressId) throw new Error(`No progress ID for ${month}`);
          updateMonth(month, { progress_id: progressId, message: 'Amazon sync running…' });
        } else {
          updateMonth(month, { status: 'running', message: 'Resuming poll…' });
        }
        const ok = await pollMonth(targetUserId, month, progressId, monthStarted, updateMonth);
        if (cancelRef.current) break;
        if (ok) okCount += 1;
      }
      toast.success(`Backfill finished: ${okCount}/${months.length} months OK`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(msg);
      toast.error(`Backfill failed: ${msg}`);
    } finally {
      setRunning(false);
      persist({ running: false });
    }
  };

  const runBackfill = async () => {
    setError(null);
    const months = monthsText
      .split(/[\s,]+/)
      .map((m) => m.trim())
      .filter((m) => /^\d{4}-\d{2}$/.test(m));
    if (!targetUserId || months.length === 0) {
      toast.error('Provide a target user ID and at least one YYYY-MM month');
      return;
    }
    setRunning(true);
    cancelRef.current = false;
    const initialResults: MonthResult[] = months.map((month) => ({ month, status: 'pending', fec_rows: 0 }));
    setResults(initialResults);
    persist({ targetUserId, monthsText, force, results: initialResults, running: true });

    const updateMonth = (month: string, patch: Partial<MonthResult>) => {
      setResults((prev) => {
        const next = (prev ?? initialResults).map((row) =>
          row.month === month ? { ...row, ...patch } : row,
        );
        persist({ results: next });
        return next;
      });
    };

    try {
      let okCount = 0;
      for (const month of months) {
        if (cancelRef.current) break;
        const monthStarted = Date.now();
        updateMonth(month, { status: 'running', message: 'Starting…' });
        const { data: startData, error: startError } = await supabase.functions.invoke('admin-backfill-fec-months', {
          body: { action: 'start_month', target_user_id: targetUserId, month, force },
        });
        if (startError) throw startError;
        const progressId = startData?.progress_id;
        if (!progressId) throw new Error(`No progress ID returned for ${month}`);
        updateMonth(month, {
          progress_id: progressId,
          upstream_status: startData?.upstream_status,
          elapsed_ms: startData?.elapsed_ms,
          message: 'Amazon sync running…',
        });
        const ok = await pollMonth(targetUserId, month, progressId, monthStarted, updateMonth);
        if (cancelRef.current) break;
        if (ok) okCount += 1;
      }
      toast.success(`Backfill finished: ${okCount}/${months.length} months OK`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(msg);
      toast.error(`Backfill failed: ${msg}`);
    } finally {
      setRunning(false);
      persist({ running: false });
    }
  };

  const clearSaved = () => {
    cancelRef.current = true;
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    setResults(null);
    setRunning(false);
  };


  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">FEC Historical Backfill</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Admin-only. Calls <code>admin-backfill-fec-months</code> to reimport
          <code> financial_events_cache </code> for the selected months. Use
          this when monthly ROI looks too high because settlement data is missing.
        </p>
      </div>

      <Card className="p-4 space-y-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Target User ID</label>
          <Input
            value={targetUserId}
            onChange={(e) => setTargetUserId(e.target.value)}
            placeholder="UUID"
            className="font-mono text-xs"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Months (YYYY-MM, comma-separated)
          </label>
          <Input
            value={monthsText}
            onChange={(e) => setMonthsText(e.target.value)}
            placeholder="2026-01, 2026-02, 2026-03, 2026-04"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
          Force refresh (re-pull even if checkpoint says done)
        </label>

        <div className="flex items-center gap-2 rounded-md bg-amber-500/10 border border-amber-400/30 text-amber-200 px-3 py-2 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Each month can take 1–4 minutes. This page now polls progress so the request won't time out.
        </div>

        <Button onClick={runBackfill} disabled={running} className="w-full">
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Running backfill…
            </>
          ) : (
            'Run Backfill'
          )}
        </Button>
      </Card>

      {error && (
        <Card className="p-4 bg-destructive/10 border-destructive/30 text-sm text-destructive">
          {error}
        </Card>
      )}

      {results && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Results</h2>
            <Button size="sm" variant="ghost" onClick={clearSaved} disabled={running}>
              Clear
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Progress is saved locally — you can leave this page and return; polling resumes automatically.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b">
                <th className="py-2">Month</th>
                <th className="py-2">Upstream</th>
                <th className="py-2">FEC rows</th>
                <th className="py-2">Elapsed</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.month} className="border-b last:border-0">
                  <td className="py-2 font-mono">{r.month}</td>
                  <td className="py-2">{r.upstream_status ?? '—'}</td>
                  <td className="py-2">{r.fec_rows ?? 0}</td>
                  <td className="py-2">
                    {r.elapsed_ms != null ? `${(r.elapsed_ms / 1000).toFixed(1)}s` : '—'}
                  </td>
                  <td className="py-2">
                    {r.status === 'running' ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> {r.message || 'Running'}
                      </span>
                    ) : r.ok ? (
                      <span className="inline-flex items-center gap-1 text-green-500">
                        <CheckCircle2 className="h-4 w-4" /> OK
                      </span>
                    ) : r.status === 'pending' ? (
                      <span className="text-muted-foreground">Pending</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-destructive">
                        <XCircle className="h-4 w-4" /> {r.error || 'Failed'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

export default function FecBackfill() {
  return (
    <ModuleGuard module="admin_panel" redirectTo="/tools" redirectToast="Admin only">
      <FecBackfillInner />
    </ModuleGuard>
  );
}
