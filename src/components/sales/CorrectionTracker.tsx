import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ArrowRightLeft } from "lucide-react";

interface CorrectionRow {
  id: string;
  order_id: string;
  asin: string;
  sku: string | null;
  marketplace: string | null;
  correction_type: string;
  previous_price_source: string | null;
  new_price_source: string | null;
  previous_unit_price: number | null;
  new_unit_price: number | null;
  previous_fee_source: string | null;
  new_fee_source: string | null;
  previous_total_fees: number | null;
  new_total_fees: number | null;
  revenue_delta: number;
  fee_delta: number;
  profit_delta: number;
  corrected_at: string;
}

interface CorrectionTrackerProps {
  userId: string;
  dateRange: { startDate: string; endDate: string } | null;
  className?: string;
}

export default function CorrectionTracker({ userId, dateRange, className }: CorrectionTrackerProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [corrections, setCorrections] = useState<CorrectionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState({ count: 0, revenueDelta: 0, feeDelta: 0, profitDelta: 0 });
  const fetchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || !dateRange) return;
    const key = `${userId}:${dateRange.startDate}:${dateRange.endDate}`;
    if (fetchedRef.current === key) return;
    fetchedRef.current = key;

    const fetchCorrections = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('sales_correction_history')
          .select('*')
          .eq('user_id', userId)
          .gte('corrected_at', `${dateRange.startDate}T00:00:00`)
          .lte('corrected_at', `${dateRange.endDate}T23:59:59`)
          .order('corrected_at', { ascending: false })
          .limit(200);

        if (error) {
          console.error('Correction tracker error:', error);
          setCorrections([]);
          setSummary({ count: 0, revenueDelta: 0, feeDelta: 0, profitDelta: 0 });
          setLoading(false);
          return;
        }

        const rows = (data || []) as CorrectionRow[];
        setCorrections(rows);
        setSummary({
          count: rows.length,
          revenueDelta: rows.reduce((s, r) => s + (r.revenue_delta || 0), 0),
          feeDelta: rows.reduce((s, r) => s + (r.fee_delta || 0), 0),
          profitDelta: rows.reduce((s, r) => s + (r.profit_delta || 0), 0),
        });
      } catch (err) {
        console.error('Correction tracker error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchCorrections();
  }, [userId, dateRange]);

  if (summary.count === 0 && !loading) return null;

  const money = (v: number) => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;

  return (
    <>
      <Card className={className}>
        <CardContent className="py-3 px-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <div className="flex items-center gap-1.5">
              <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-muted-foreground">Corrections</span>
            </div>
            <Badge variant="outline" className="text-xs">
              {summary.count} corrections
            </Badge>
            {summary.revenueDelta !== 0 && (
              <span className="text-xs font-mono">
                Revenue {money(summary.revenueDelta)}
              </span>
            )}
            {summary.profitDelta !== 0 && (
              <span className="text-xs font-mono">
                Profit {money(summary.profitDelta)}
              </span>
            )}
            <Button variant="ghost" size="sm" className="text-xs ml-auto" onClick={() => setShowDialog(true)}>
              View Details
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-5xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4" />
              Estimated → Actual Corrections
            </DialogTitle>
            <DialogDescription>
              Real deltas captured when order prices or fees transitioned from estimated/snapshot to actual settled values.
              Revenue Δ: {money(summary.revenueDelta)} · Fee Δ: {money(summary.feeDelta)} · Profit Δ: {money(summary.profitDelta)}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Order ID</TableHead>
                  <TableHead className="text-xs">ASIN</TableHead>
                  <TableHead className="text-xs">Type</TableHead>
                  <TableHead className="text-xs">Price Source</TableHead>
                  <TableHead className="text-xs text-right">Price Δ</TableHead>
                  <TableHead className="text-xs">Fee Source</TableHead>
                  <TableHead className="text-xs text-right">Fee Δ</TableHead>
                  <TableHead className="text-xs text-right">Profit Δ</TableHead>
                  <TableHead className="text-xs">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {corrections.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs font-mono">{row.order_id?.substring(0, 15)}…</TableCell>
                    <TableCell className="text-xs font-mono">{row.asin}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className="text-[10px]">{row.correction_type}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.previous_price_source && (
                        <span className="text-muted-foreground">{row.previous_price_source} → </span>
                      )}
                      {row.new_price_source || '—'}
                    </TableCell>
                    <TableCell className="text-xs text-right font-mono">
                      {row.revenue_delta !== 0 ? money(row.revenue_delta) : '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.previous_fee_source && (
                        <span className="text-muted-foreground">{row.previous_fee_source} → </span>
                      )}
                      {row.new_fee_source || '—'}
                    </TableCell>
                    <TableCell className="text-xs text-right font-mono">
                      {row.fee_delta !== 0 ? money(row.fee_delta) : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-right font-mono">
                      {row.profit_delta !== 0 ? money(row.profit_delta) : '—'}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {new Date(row.corrected_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </TableCell>
                  </TableRow>
                ))}
                {corrections.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-xs text-muted-foreground py-4">
                      No corrections found for this period.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
