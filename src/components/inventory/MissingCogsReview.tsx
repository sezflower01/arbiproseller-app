import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, FileWarning } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface MissingRow {
  id: string;
  order_id: string;
  asin: string;
  sku: string | null;
  quantity: number | null;
  sold_price: number | null;
  marketplace: string | null;
  order_date: string | null;
  // computed
  suggested_cost: number | null;
  suggestion_reason: string; // why we suggested or why we can't
  reason: string; // why cost needs review
}

interface ListingSnapshot {
  sku: string | null;
  amount: number | null;
  cost: number | null;
  units: number | null;
}

const DAYS_BACK = 90;

function computeSuggestion(
  snapshots: ListingSnapshot[]
): { suggested: number | null; reason: string } {
  const perUnits = snapshots
    .map((s) => {
      if (s.amount != null && s.amount > 0) return Number(s.amount);
      if (s.cost != null && s.units != null && s.units > 0)
        return Number(s.cost) / Number(s.units);
      return null;
    })
    .filter((v): v is number => v != null && isFinite(v) && v > 0);

  if (perUnits.length === 0)
    return { suggested: null, reason: "No created_listings snapshot for this SKU." };

  const min = Math.min(...perUnits);
  const max = Math.max(...perUnits);
  const avg = perUnits.reduce((a, b) => a + b, 0) / perUnits.length;
  const spread = max > 0 ? (max - min) / max : 0;

  if (spread <= 0.1) {
    return {
      suggested: Number(avg.toFixed(2)),
      reason: `Tight cost range across ${perUnits.length} lot${perUnits.length === 1 ? "" : "s"} ($${min.toFixed(2)}–$${max.toFixed(2)}).`,
    };
  }
  return {
    suggested: null,
    reason: `Cost varies too widely ($${min.toFixed(2)}–$${max.toFixed(2)} across ${perUnits.length} lots). Manual entry required.`,
  };
}

export default function MissingCogsReview() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<MissingRow[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setRows([]);
        return;
      }

      const since = new Date(Date.now() - DAYS_BACK * 86400_000).toISOString().slice(0, 10);

      // Pull recent confirmed sales with missing COGS
      const { data: orders, error } = await supabase
        .from("sales_orders")
        .select("id, order_id, asin, sku, quantity, sold_price, marketplace, order_date, unit_cost, is_cancelled, order_status, price_confidence")
        .eq("user_id", user.id)
        .gte("order_date", since)
        .order("order_date", { ascending: false })
        .limit(500);

      if (error) throw error;

      const candidates = (orders || []).filter((o: any) => {
        const cost = Number(o.unit_cost || 0);
        const sold = Number(o.sold_price || 0);
        if (o.is_cancelled) return false;
        return sold > 0 && cost <= 0;
      });

      // Fetch listing snapshots for distinct SKUs
      const skus = Array.from(new Set(candidates.map((c: any) => c.sku).filter(Boolean))) as string[];
      const snapshotsBySku: Record<string, ListingSnapshot[]> = {};
      if (skus.length > 0) {
        const { data: listings } = await supabase
          .from("created_listings")
          .select("sku, amount, cost, units")
          .eq("user_id", user.id)
          .in("sku", skus);
        for (const l of (listings || []) as any[]) {
          if (!l.sku) continue;
          (snapshotsBySku[l.sku] ||= []).push({
            sku: l.sku,
            amount: l.amount != null ? Number(l.amount) : null,
            cost: l.cost != null ? Number(l.cost) : null,
            units: l.units != null ? Number(l.units) : null,
          });
        }
      }

      const enriched: MissingRow[] = candidates.map((o: any) => {
        const snaps = (o.sku && snapshotsBySku[o.sku]) || [];
        const { suggested, reason } = snaps.length > 0
          ? computeSuggestion(snaps)
          : { suggested: null, reason: "No created_listings snapshot for this SKU." };
        return {
          id: o.id,
          order_id: o.order_id,
          asin: o.asin,
          sku: o.sku,
          quantity: o.quantity,
          sold_price: o.sold_price,
          marketplace: o.marketplace,
          order_date: o.order_date,
          suggested_cost: suggested,
          suggestion_reason: reason,
          reason: "Confirmed sale with unit_cost = 0. ROI cannot be calculated until cost is entered.",
        };
      });

      setRows(enriched);
      // Pre-fill inputs with suggestions (user still must press Save)
      const next: Record<string, string> = {};
      for (const r of enriched) {
        if (r.suggested_cost != null) next[r.id] = String(r.suggested_cost);
      }
      setInputs(next);
    } catch (err: any) {
      console.error("Missing COGS load failed:", err);
      toast({ variant: "destructive", title: "Failed to load missing-COGS rows", description: err?.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (row: MissingRow) => {
    const raw = inputs[row.id]?.trim();
    const value = Number(raw);
    if (!raw || !isFinite(value) || value <= 0) {
      toast({ variant: "destructive", title: "Invalid cost", description: "Enter a positive number." });
      return;
    }
    setSavingId(row.id);
    try {
      const qty = Number(row.quantity || 1);
      const { error } = await supabase
        .from("sales_orders")
        .update({ unit_cost: value, total_cost: value * qty })
        .eq("id", row.id);
      if (error) throw error;
      toast({ title: "Cost saved", description: `${row.order_id} → $${value.toFixed(2)} per unit` });
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (err: any) {
      console.error("Save COGS failed:", err);
      toast({ variant: "destructive", title: "Save failed", description: err?.message });
    } finally {
      setSavingId(null);
    }
  };

  const total = rows.length;
  const withSuggestion = useMemo(() => rows.filter((r) => r.suggested_cost != null).length, [rows]);

  return (
    <Card className="bg-card/40 border-border p-5">
      <div className="flex items-start gap-4">
        <FileWarning className="h-5 w-5 text-amber-400 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">Missing COGS Review</h3>
              {!loading && (
                <Badge
                  variant="outline"
                  className={
                    total === 0
                      ? "border-emerald-500/40 text-emerald-200 bg-emerald-500/10"
                      : "border-amber-500/40 text-amber-200 bg-amber-500/10"
                  }
                >
                  {total === 0 ? "All clear" : `${total} row${total === 1 ? "" : "s"} need cost`}
                </Badge>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1.5" />}
              Refresh
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Confirmed sales (last {DAYS_BACK} days) where <code className="text-xs">unit_cost = 0</code>. ROI hides until
            a cost is entered. Suggestions come from <code className="text-xs">created_listings</code> snapshots only when
            the per-unit cost is tightly clustered — they are <span className="text-amber-200 font-medium">never auto-saved</span>.
            {!loading && total > 0 && withSuggestion > 0 && (
              <> {withSuggestion} of {total} have a suggestion pre-filled.</>
            )}
          </p>

          {loading ? (
            <div className="flex items-center gap-2 mt-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : total === 0 ? (
            <div className="flex items-center gap-2 mt-4 text-sm text-emerald-200">
              <CheckCircle2 className="h-4 w-4" /> No confirmed-sale rows are missing COGS.
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {rows.map((r) => {
                const sold = Number(r.sold_price || 0);
                const qty = Number(r.quantity || 1);
                const hasSuggestion = r.suggested_cost != null;
                return (
                  <div
                    key={r.id}
                    className="rounded-md border border-border bg-background/40 p-3 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="text-sm leading-snug">
                        <div className="font-mono text-xs text-muted-foreground">{r.order_id}</div>
                        <div className="font-medium">
                          {r.asin} <span className="text-muted-foreground">· {r.sku || "—"}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {r.marketplace || "US"} · {r.order_date} · qty {qty} · sold ${sold.toFixed(2)}
                        </div>
                      </div>
                      {hasSuggestion ? (
                        <Badge variant="outline" className="border-blue-500/40 text-blue-200 bg-blue-500/10">
                          Suggestion: ${r.suggested_cost!.toFixed(2)}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-500/40 text-amber-200 bg-amber-500/10">
                          Manual cost required
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-start gap-2 text-xs text-muted-foreground">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-amber-400 shrink-0" />
                      <div>
                        <div>{r.reason}</div>
                        <div className="mt-0.5">{r.suggestion_reason}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <div className="text-xs text-muted-foreground">Unit cost ($)</div>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={inputs[r.id] || ""}
                        onChange={(e) => setInputs((p) => ({ ...p, [r.id]: e.target.value }))}
                        placeholder={hasSuggestion ? r.suggested_cost!.toFixed(2) : "enter cost"}
                        className="w-32 h-8"
                      />
                      <Button
                        size="sm"
                        onClick={() => save(r)}
                        disabled={savingId === r.id}
                        className="bg-blue-600 hover:bg-blue-500 text-white h-8"
                      >
                        {savingId === r.id ? (
                          <>
                            <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> Saving…
                          </>
                        ) : (
                          "Confirm & Save"
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
