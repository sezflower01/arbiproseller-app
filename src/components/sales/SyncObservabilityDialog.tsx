import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, RefreshCw } from "lucide-react";

interface SyncTraceRow {
  id: string;
  sync_type: string;
  phase: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  rows_fetched: number;
  rows_inserted: number;
  rows_updated: number;
  duplicates_skipped: number;
  rows_corrected: number;
  rows_missing_price: number;
  rows_missing_fees: number;
  error_count: number;
  retry_count: number;
  error_message: string | null;
}

interface EnrichmentLogRow {
  id: string;
  enrichment_type: string;
  source: string;
  status: string;
  order_id: string | null;
  asin: string | null;
  seller_sku: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
}

interface SyncObservabilityDialogProps {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SyncObservabilityDialog({ userId, open, onOpenChange }: SyncObservabilityDialogProps) {
  const [traces, setTraces] = useState<SyncTraceRow[]>([]);
  const [enrichmentLogs, setEnrichmentLogs] = useState<EnrichmentLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("traces");
  const fetchedRef = useRef(false);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [tracesRes, logsRes] = await Promise.all([
        supabase
          .from('sync_traces')
          .select('*')
          .eq('user_id', userId)
          .order('started_at', { ascending: false })
          .limit(100),
        supabase
          .from('enrichment_logs')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(100),
      ]);
      setTraces((tracesRes.data as SyncTraceRow[]) || []);
      setEnrichmentLogs((logsRes.data as EnrichmentLogRow[]) || []);
    } catch (err) {
      console.error('Failed to fetch sync data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !userId || fetchedRef.current) return;
    fetchedRef.current = true;
    fetchAll();
  }, [open, userId]);

  const handleRefresh = () => {
    fetchedRef.current = false;
    fetchAll();
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case 'completed': case 'success': return <Badge variant="default" className="text-[10px]">{status}</Badge>;
      case 'failed': return <Badge variant="destructive" className="text-[10px]">failed</Badge>;
      case 'started': return <Badge variant="outline" className="text-[10px]">running</Badge>;
      case 'rate_limited': return <Badge variant="secondary" className="text-[10px]">throttled</Badge>;
      default: return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
    }
  };

  // Trace-level summary
  const traceSummary = (() => {
    const completed = traces.filter(t => t.status === 'completed').length;
    const failed = traces.filter(t => t.status === 'failed').length;
    const totalInserted = traces.reduce((s, t) => s + (t.rows_inserted || 0), 0);
    const totalCorrected = traces.reduce((s, t) => s + (t.rows_corrected || 0), 0);
    const totalDupsSkipped = traces.reduce((s, t) => s + (t.duplicates_skipped || 0), 0);
    return { completed, failed, totalInserted, totalCorrected, totalDupsSkipped };
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Sync Observability
          </DialogTitle>
          <DialogDescription>
            End-to-end sync traces with per-run stats, plus enrichment log details.
          </DialogDescription>
        </DialogHeader>

        {/* Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
          <div className="rounded-md border p-2 text-xs">
            <div className="font-medium">Completed</div>
            <div className="text-lg font-mono">{traceSummary.completed}</div>
          </div>
          <div className="rounded-md border p-2 text-xs">
            <div className="font-medium">Failed</div>
            <div className="text-lg font-mono text-destructive">{traceSummary.failed}</div>
          </div>
          <div className="rounded-md border p-2 text-xs">
            <div className="font-medium">Rows Inserted</div>
            <div className="text-lg font-mono">{traceSummary.totalInserted}</div>
          </div>
          <div className="rounded-md border p-2 text-xs">
            <div className="font-medium">Corrections</div>
            <div className="text-lg font-mono">{traceSummary.totalCorrected}</div>
          </div>
          <div className="rounded-md border p-2 text-xs">
            <div className="font-medium">Dups Skipped</div>
            <div className="text-lg font-mono">{traceSummary.totalDupsSkipped}</div>
          </div>
        </div>

        <div className="flex justify-between items-center mb-2">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-8">
              <TabsTrigger value="traces" className="text-xs">Sync Traces ({traces.length})</TabsTrigger>
              <TabsTrigger value="enrichment" className="text-xs">Enrichment Logs ({enrichmentLogs.length})</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
            <RefreshCw className={`h-3 w-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Sync Traces Table */}
        {tab === "traces" && (
          <div className="max-h-[50vh] overflow-auto rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Started</TableHead>
                  <TableHead className="text-xs">Type</TableHead>
                  <TableHead className="text-xs">Phase</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs text-right">Fetched</TableHead>
                  <TableHead className="text-xs text-right">Inserted</TableHead>
                  <TableHead className="text-xs text-right">Updated</TableHead>
                  <TableHead className="text-xs text-right">Dups</TableHead>
                  <TableHead className="text-xs text-right">Corrected</TableHead>
                  <TableHead className="text-xs">Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {traces.map(t => (
                  <TableRow key={t.id}>
                    <TableCell className="text-xs font-mono whitespace-nowrap">
                      {new Date(t.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </TableCell>
                    <TableCell className="text-xs capitalize">{t.sync_type}</TableCell>
                    <TableCell className="text-xs">{t.phase || '—'}</TableCell>
                    <TableCell>{statusBadge(t.status)}</TableCell>
                    <TableCell className="text-xs text-right font-mono">{t.rows_fetched}</TableCell>
                    <TableCell className="text-xs text-right font-mono">{t.rows_inserted}</TableCell>
                    <TableCell className="text-xs text-right font-mono">{t.rows_updated}</TableCell>
                    <TableCell className="text-xs text-right font-mono">{t.duplicates_skipped}</TableCell>
                    <TableCell className="text-xs text-right font-mono">{t.rows_corrected}</TableCell>
                    <TableCell className="text-xs text-destructive max-w-[200px] truncate" title={t.error_message || ''}>
                      {t.error_message || '—'}
                    </TableCell>
                  </TableRow>
                ))}
                {traces.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-xs text-muted-foreground py-4">
                      No sync traces found. Traces are recorded when sync jobs run.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Enrichment Logs Table */}
        {tab === "enrichment" && (
          <div className="max-h-[50vh] overflow-auto rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Time</TableHead>
                  <TableHead className="text-xs">Type</TableHead>
                  <TableHead className="text-xs">Source</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs">Order/ASIN</TableHead>
                  <TableHead className="text-xs">Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {enrichmentLogs.map(log => (
                  <TableRow key={log.id}>
                    <TableCell className="text-xs font-mono whitespace-nowrap">
                      {new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </TableCell>
                    <TableCell className="text-xs capitalize">{log.enrichment_type}</TableCell>
                    <TableCell className="text-xs font-mono">{log.source}</TableCell>
                    <TableCell>{statusBadge(log.status)}</TableCell>
                    <TableCell className="text-xs font-mono">
                      {log.order_id ? `${log.order_id.substring(0, 12)}…` : ''}
                      {log.asin ? ` / ${log.asin}` : ''}
                    </TableCell>
                    <TableCell className="text-xs text-destructive max-w-[200px] truncate" title={log.error_message || ''}>
                      {log.error_message || '—'}
                    </TableCell>
                  </TableRow>
                ))}
                {enrichmentLogs.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-4">
                      No enrichment logs found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
