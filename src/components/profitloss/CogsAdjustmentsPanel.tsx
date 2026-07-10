import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Trash2, Plus, Info } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export interface CogsAdjustmentRow {
  id: string;
  label: string;
  amount: number;
  period_start: string;
  period_end: string;
  notes: string | null;
}

interface Props {
  userId: string;
  /** Current selected period start (YYYY-MM-DD, inclusive) */
  startDate: string;
  /** Current selected period end (YYYY-MM-DD, exclusive — same convention as the page) */
  endDate: string;
  onChanged?: (totalForPeriod: number, rows: CogsAdjustmentRow[]) => void;
}

const formatCurrency = (n: number) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CogsAdjustmentsPanel({ userId, startDate, endDate, onChanged }: Props) {
  const [rows, setRows] = useState<CogsAdjustmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("Historical COGS adjustment (migration)");
  const [amount, setAmount] = useState<string>("");
  const [pStart, setPStart] = useState(startDate);
  const [pEnd, setPEnd] = useState(endDate);
  const [notes, setNotes] = useState("");

  const fetchRows = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      // Fetch ALL adjustments for this user that overlap the selected period.
      // Overlap rule: period_start < endDate AND period_end >= startDate
      const { data, error } = await supabase
        .from("cogs_adjustments")
        .select("id,label,amount,period_start,period_end,notes")
        .eq("user_id", userId)
        .lt("period_start", endDate)
        .gte("period_end", startDate)
        .order("period_start", { ascending: true });
      if (error) throw error;
      const list = (data || []) as CogsAdjustmentRow[];
      setRows(list);
      const total = list.reduce((s, r) => s + Number(r.amount || 0), 0);
      onChanged?.(total, list);
    } catch (err: any) {
      console.error("[CogsAdjustments] fetch error:", err);
      toast.error(`Failed to load COGS adjustments: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  }, [userId, startDate, endDate, onChanged]);

  useEffect(() => {
    setPStart(startDate);
    setPEnd(endDate);
  }, [startDate, endDate]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const handleAdd = async () => {
    const amt = Number(amount);
    if (!label.trim()) return toast.error("Label is required");
    if (!Number.isFinite(amt) || amt === 0) return toast.error("Enter a non-zero amount");
    if (!pStart || !pEnd) return toast.error("Period dates required");

    setAdding(true);
    try {
      const { error } = await supabase.from("cogs_adjustments").insert({
        user_id: userId,
        label: label.trim(),
        amount: amt,
        period_start: pStart,
        period_end: pEnd,
        notes: notes.trim() || null,
      });
      if (error) throw error;
      toast.success(`Added COGS adjustment: ${formatCurrency(amt)}`);
      setAmount("");
      setNotes("");
      await fetchRows();
    } catch (err: any) {
      console.error("[CogsAdjustments] insert error:", err);
      toast.error(`Failed to add adjustment: ${err.message || err}`);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this COGS adjustment?")) return;
    try {
      const { error } = await supabase.from("cogs_adjustments").delete().eq("id", id);
      if (error) throw error;
      toast.success("Adjustment deleted");
      await fetchRows();
    } catch (err: any) {
      toast.error(`Failed to delete: ${err.message || err}`);
    }
  };

  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);

  return (
    <Card className="mt-6 border-orange-200 dark:border-orange-900/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-orange-600 text-base flex items-center gap-2">
          COGS Adjustments
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-4 w-4 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p className="text-xs">
                  One-time adjustments that flow directly into the <strong>COGS line</strong> (not Expenses).
                  Use this for historical migration data — e.g. costs from a prior accounting system that aren't in your library.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {total !== 0 && (
            <span className="ml-auto text-sm font-normal text-muted-foreground">
              Period total: <span className="font-semibold text-orange-600">{formatCurrency(total)}</span>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Add form */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end mb-4 p-3 rounded-md bg-muted/40">
          <div className="md:col-span-4">
            <Label className="text-xs">Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Historical COGS (migration)" />
          </div>
          <div className="md:col-span-2">
            <Label className="text-xs">Amount ($)</Label>
            <Input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="21000.00"
            />
          </div>
          <div className="md:col-span-2">
            <Label className="text-xs">Period start</Label>
            <Input type="date" value={pStart} onChange={(e) => setPStart(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <Label className="text-xs">Period end</Label>
            <Input type="date" value={pEnd} onChange={(e) => setPEnd(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <Button onClick={handleAdd} disabled={adding} className="w-full">
              <Plus className="h-4 w-4 mr-1" />
              {adding ? "Adding..." : "Add"}
            </Button>
          </div>
          <div className="md:col-span-12">
            <Label className="text-xs">Notes (optional)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why this adjustment exists..." />
          </div>
        </div>

        {/* List */}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No COGS adjustments for this period. Add one above to fill historical or migration gaps.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.period_start} → {r.period_end}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.notes || "—"}</TableCell>
                  <TableCell className="text-right font-mono text-orange-600">{formatCurrency(r.amount)}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(r.id)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell colSpan={3}>Period total (added to COGS)</TableCell>
                <TableCell className="text-right font-mono text-orange-600">{formatCurrency(total)}</TableCell>
                <TableCell></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
