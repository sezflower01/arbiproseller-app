import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle, RefreshCw, ShieldCheck, Activity } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface ParityGap {
  check_date: string;
  marketplace: string;
  so_count: number;
  fec_count: number;
  gap_type: string;
  repair_status: string;
}

interface SyncHealthPanelProps {
  userId: string;
  className?: string;
  isAdmin?: boolean;
}

export function SyncHealthPanel({ userId, className, isAdmin }: SyncHealthPanelProps) {
  const [gaps, setGaps] = useState<ParityGap[]>([]);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [lastCheck, setLastCheck] = useState<string | null>(null);

  const fetchGaps = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('sync_parity_log')
        .select('*')
        .eq('user_id', userId)
        .not('gap_type', 'is', null)
        .order('check_date', { ascending: false })
        .limit(50);

      if (!error && data) {
        setGaps(data.map(d => ({
          check_date: d.check_date,
          marketplace: d.marketplace,
          so_count: d.so_count,
          fec_count: d.fec_count,
          gap_type: d.gap_type || '',
          repair_status: d.repair_status,
        })));
        if (data.length > 0) {
          setLastCheck(data[0].created_at);
        }
      }
    } catch (err) {
      console.error('[SyncHealthPanel] Error:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { fetchGaps(); }, [fetchGaps]);

  const triggerManualCheck = async () => {
    setRepairing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not logged in');

      const res = await supabase.functions.invoke('nightly-parity-check', {
        body: { days_back: 30, auto_repair: true },
      });

      if (res.error) throw res.error;

      const result = res.data;
      toast.success(`Parity check complete: ${result.total_gaps_found} gaps found, ${result.repairs_triggered} repairs triggered`);
      await fetchGaps();
    } catch (err: any) {
      toast.error(err?.message || 'Parity check failed');
    } finally {
      setRepairing(false);
    }
  };

  const unrepairedGaps = gaps.filter(g => g.repair_status === 'pending' || g.repair_status === 'queued');
  const repairedGaps = gaps.filter(g => g.repair_status === 'repaired');
  const isHealthy = unrepairedGaps.length === 0;

  return (
    <Card className={cn("border-dashed", isHealthy ? "border-green-500/30" : "border-yellow-500/50", className)}>
      <CardHeader className="py-3 px-4 pb-0">
        <CardTitle className="text-sm flex items-center gap-2">
          {isHealthy ? (
            <ShieldCheck className="h-4 w-4 text-green-500" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
          )}
          Sync Health Monitor
          {!isHealthy && (
            <Badge variant="outline" className="text-yellow-600 border-yellow-500/50 text-[10px]">
              {unrepairedGaps.length} gap{unrepairedGaps.length !== 1 ? 's' : ''} detected
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            {lastCheck && (
              <span className="text-[10px] text-muted-foreground">
                Last check: {new Date(lastCheck).toLocaleDateString()}
              </span>
            )}
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={triggerManualCheck}
                disabled={repairing}
              >
                {repairing ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : <Activity className="h-3 w-3 mr-1" />}
                Run Parity Check
              </Button>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2 px-4">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" /> Loading sync health...
          </div>
        ) : isHealthy ? (
          <div className="text-xs text-green-600 flex items-center gap-1.5">
            <CheckCircle className="h-3 w-3" />
            All data sources are in sync. Purchase-date and settled data match across all days.
            {repairedGaps.length > 0 && (
              <span className="text-muted-foreground ml-2">({repairedGaps.length} gaps auto-repaired)</span>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <div className="text-xs text-yellow-600 mb-1">
              The following days have mismatched data between purchase-date (sales_orders) and settled (financial_events_cache):
            </div>
            <div className="max-h-32 overflow-y-auto space-y-0.5">
              {unrepairedGaps.slice(0, 10).map((gap, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] py-0.5 px-2 rounded bg-yellow-500/5">
                  <span className="font-mono text-muted-foreground w-20">{gap.check_date}</span>
                  <Badge variant="outline" className="text-[9px] h-4">{gap.marketplace}</Badge>
                  <span className="text-muted-foreground">
                    SO: {gap.so_count} / FEC: {gap.fec_count}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn("text-[9px] h-4", {
                      'text-red-500 border-red-500/30': gap.gap_type === 'so_missing',
                      'text-orange-500 border-orange-500/30': gap.gap_type === 'fec_missing',
                    })}
                  >
                    {gap.gap_type === 'so_missing' ? 'Missing purchase data' : 'Missing settled data'}
                  </Badge>
                  <Badge variant="secondary" className="text-[9px] h-4">
                    {gap.repair_status}
                  </Badge>
                </div>
              ))}
              {unrepairedGaps.length > 10 && (
                <div className="text-[10px] text-muted-foreground pl-2">
                  +{unrepairedGaps.length - 10} more gaps...
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default SyncHealthPanel;