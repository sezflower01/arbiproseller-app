import { useEffect, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, History, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

interface OverrideRow {
  id: string;
  unit_cost: number;
  effective_from: string;
  note: string | null;
  created_at: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asin: string;
  productTitle?: string | null;
  /** Called after a new override is added so the parent can refresh row badges. */
  onAdded?: () => void;
}

/**
 * Manual cost override editor with append-only timeline view.
 *
 * Rules enforced in UI:
 * - Forward-only: warns when effective_from is in the past (P&L snapshots stay frozen)
 * - Append-only: history is read-only; "change" means add a new entry
 * - Snapshot-first: copy explains that past P&L (snapshotted) is untouched
 */
export function CostOverrideDialog({
  open,
  onOpenChange,
  asin,
  productTitle,
  onAdded,
}: Props) {
  const { user } = useAuth();
  const [history, setHistory] = useState<OverrideRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [newCost, setNewCost] = useState("");
  const [newDate, setNewDate] = useState<Date>(new Date());
  const [newNote, setNewNote] = useState("");

  useEffect(() => {
    if (!open || !user || !asin) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("asin_cost_overrides")
        .select("id, unit_cost, effective_from, note, created_at")
        .eq("user_id", user.id)
        .eq("asin", asin)
        .order("effective_from", { ascending: false })
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        toast.error("Could not load cost history");
        console.error(error);
      } else {
        setHistory((data ?? []) as OverrideRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user, asin]);

  const handleAdd = async () => {
    if (!user) return;
    const cost = Number(newCost);
    if (!Number.isFinite(cost) || cost < 0) {
      toast.error("Enter a valid cost (>= 0)");
      return;
    }
    if (!newDate) {
      toast.error("Pick an effective date");
      return;
    }
    setSaving(true);
    const effective = format(newDate, "yyyy-MM-dd");
    const { error } = await supabase.from("asin_cost_overrides").insert({
      user_id: user.id,
      asin,
      unit_cost: cost,
      effective_from: effective,
      note: newNote.trim() || null,
      created_by: user.id,
    });
    setSaving(false);
    if (error) {
      if (error.code === "23505") {
        toast.error("An override already exists for that exact date — pick a different date");
      } else {
        toast.error(error.message || "Could not save override");
      }
      return;
    }
    toast.success("Manual cost saved — applies to new orders from " + effective);
    setNewCost("");
    setNewNote("");
    setNewDate(new Date());
    // Refresh
    const { data } = await supabase
      .from("asin_cost_overrides")
      .select("id, unit_cost, effective_from, note, created_at")
      .eq("user_id", user.id)
      .eq("asin", asin)
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false });
    setHistory((data ?? []) as OverrideRow[]);
    onAdded?.();
  };

  const today = format(new Date(), "yyyy-MM-dd");
  const effectiveStr = newDate ? format(newDate, "yyyy-MM-dd") : null;
  const isBackdating = effectiveStr !== null && effectiveStr < today;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Cost History — {asin}
          </DialogTitle>
          <DialogDescription>
            {productTitle ? (
              <span className="line-clamp-1">{productTitle}</span>
            ) : null}
            <span className="block mt-1 text-xs">
              Manual costs are applied to <strong>P&amp;L</strong> (forward-only) and the{" "}
              <strong>Repricer ROI floor</strong>. Inventory valuation stays at blended cost.
              Past sales with a saved snapshot are <strong>never</strong> rewritten.
            </span>
          </DialogDescription>
        </DialogHeader>

        {/* Add new override */}
        <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Plus className="h-4 w-4" />
            Add new cost entry
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="override-cost">Unit cost (USD)</Label>
              <Input
                id="override-cost"
                type="number"
                step="0.01"
                min="0"
                placeholder="e.g. 7.50"
                value={newCost}
                onChange={(e) => setNewCost(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Effective from</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !newDate && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {newDate ? format(newDate, "PPP") : <span>Pick a date</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={newDate}
                    onSelect={(d) => d && setNewDate(d)}
                    initialFocus
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="override-note">Note (optional)</Label>
            <Textarea
              id="override-note"
              placeholder="e.g. New supplier deal, bulk reorder discount..."
              rows={2}
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
            />
          </div>

          {isBackdating && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              ⚠ This date is in the past. The new cost will only affect orders <strong>without
              a saved cost snapshot</strong>. Existing settled P&amp;L numbers are NOT changed.
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={handleAdd} disabled={saving || !newCost}>
              {saving ? "Saving..." : "Save cost entry"}
            </Button>
          </div>
        </div>

        <Separator />

        {/* History */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Timeline (newest first)</div>
            <Badge variant="secondary" className="text-[10px]">
              <ShieldCheck className="h-3 w-3 mr-1" /> Append-only
            </Badge>
          </div>
          {loading ? (
            <div className="text-xs text-muted-foreground py-6 text-center">Loading...</div>
          ) : history.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">
              No manual cost overrides yet. The system uses your blended/purchase cost.
            </div>
          ) : (
            <div className="max-h-64 overflow-auto rounded-md border divide-y">
              {history.map((row, idx) => {
                const isCurrent = idx === 0 && row.effective_from <= today;
                return (
                  <div key={row.id} className="px-3 py-2 text-xs flex items-start gap-3">
                    <div className="flex-shrink-0 w-24">
                      <div className="font-mono font-semibold">${Number(row.unit_cost).toFixed(2)}</div>
                      {isCurrent && (
                        <Badge variant="default" className="text-[9px] mt-0.5">Active</Badge>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">From {row.effective_from}</div>
                      {row.note && (
                        <div className="text-muted-foreground line-clamp-2 mt-0.5">{row.note}</div>
                      )}
                      <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                        Recorded {format(new Date(row.created_at), "PPp")}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
