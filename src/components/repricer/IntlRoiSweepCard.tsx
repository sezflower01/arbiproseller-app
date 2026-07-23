import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ShieldCheck } from 'lucide-react';

/**
 * Re-applies each rule's per-marketplace Min ROI to every enabled assignment
 * in CA / MX / BR. Uses live SP-API fees + FX cross-rates and pushes new
 * Min/Max bounds to Amazon. The repricer's next evaluation raises live price
 * up to the new floor automatically.
 */
interface IntlRoiSweepCardProps {
  isAdmin?: boolean;
}

export default function IntlRoiSweepCard({ isAdmin = false }: IntlRoiSweepCardProps) {
  const { toast } = useToast();
  const [running, setRunning] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [lastResult, setLastResult] = useState<any | null>(null);

  const run = async (asDryRun: boolean) => {
    setRunning(true);
    setDryRun(asDryRun);
    try {
      const { data, error } = await supabase.functions.invoke('apply-min-roi-intl-sweep', {
        body: { dry_run: asDryRun },
      });
      if (error) throw error;
      setLastResult(data);
      toast({
        title: asDryRun ? 'Dry-run complete' : 'Min price floors updated',
        description: asDryRun
          ? `${data.pairs} rule×marketplace pairs would run`
          : isAdmin
            ? `${data.updated} assignments updated, ${data.skipped} skipped across ${data.ran} pairs`
            : `${data.updated} international listing${data.updated === 1 ? '' : 's'} updated to protect your margin`,
      });
    } catch (e: any) {
      toast({
        title: 'Sweep failed',
        description: e?.message || 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" /> International Min ROI Enforcement
        </CardTitle>
        <CardDescription>
          Re-applies each rule&apos;s per-marketplace Min ROI (CA / MX / BR) to all enabled
          assignments. Recalculates Min Price with live SP-API fees + FX, then pushes new
          bounds to Amazon. The repricer raises the live price to the new floor on its next
          evaluation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {isAdmin && (
            <Button variant="outline" disabled={running} onClick={() => run(true)}>
              {running && dryRun && <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />}
              Dry run
            </Button>
          )}
          <Button disabled={running} onClick={() => run(false)}>
            {running && !dryRun && <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />}
            Apply now
          </Button>
        </div>
        {lastResult && (
          isAdmin ? (
            <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1">
              <div>
                Pairs: <b>{lastResult.pairs}</b> · Ran: <b>{lastResult.ran ?? 0}</b> ·
                Updated: <b>{lastResult.updated ?? 0}</b> · Skipped:{' '}
                <b>{lastResult.skipped ?? 0}</b>
              </div>
              {Array.isArray(lastResult.results) && lastResult.results.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer opacity-80">Per-rule breakdown</summary>
                  <ul className="mt-2 space-y-0.5 max-h-64 overflow-auto">
                    {lastResult.results.map((r: any, i: number) => (
                      <li key={i} className="font-mono">
                        [{r.marketplace}] {r.rule_name ?? r.rule_id?.slice(0, 8)} →{' '}
                        ROI {r.target_roi ?? '—'}% · {r.status}
                        {r.updated != null ? ` · upd ${r.updated}/skip ${r.skipped}` : ''}
                        {r.reason ? ` · ${r.reason}` : ''}
                        {r.error ? ` · ${r.error}` : ''}
                        {r.would_touch != null ? ` · would touch ${r.would_touch}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ) : (
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              {(lastResult.updated ?? 0) > 0
                ? `Updated ${lastResult.updated} international listing${lastResult.updated === 1 ? '' : 's'} to protect your margin.`
                : 'No listings needed an update — your international pricing floors are already up to date.'}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}
