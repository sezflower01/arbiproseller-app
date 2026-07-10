import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

type PurchaseRow = {
  id: string;
  asin: string;
  sku: string;
  title: string;
  image_url: string | null;
  cost: number | null;
  units: number | null;
  received_quantity: number | null;
  date_created: string | null;
  created_at: string;
  supplier_links: unknown;
};

type Period = "7" | "14" | "21" | "30" | "60" | "90" | "120" | "custom";

const PERIODS: { value: Period; label: string }[] = [
  { value: "7", label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "21", label: "Last 21 days" },
  { value: "30", label: "Last 1 month" },
  { value: "60", label: "Last 2 months" },
  { value: "90", label: "Last 3 months" },
  { value: "120", label: "Last 4 months" },
  { value: "custom", label: "Custom" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asin: string;
  draftId: string;
  shipmentId?: string | null;
  defaultUnitsToShip?: number;
  onSaved?: (totalAllocated: number, unitsToShip: number) => void;
}

function getSupplierName(links: unknown): string {
  if (!links) return "—";
  const arr = Array.isArray(links) ? links : [];
  const first = arr[0] as { supplier_name?: string; name?: string } | undefined;
  return first?.supplier_name ?? first?.name ?? "—";
}

// received falls back to ordered when not yet recorded
const effectiveReceived = (r: Pick<PurchaseRow, "received_quantity" | "units">) =>
  r.received_quantity != null ? r.received_quantity : (r.units ?? 0);

export function PurchaseHistoryDialog({
  open,
  onOpenChange,
  asin,
  draftId,
  shipmentId,
  defaultUnitsToShip = 0,
  onSaved,
}: Props) {
  const { user } = useAuth();
  const [period, setPeriod] = useState<Period>("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Record<string, number>>({});
  // Allocations from OTHER drafts so we can cap by remaining received
  const [externalAlloc, setExternalAlloc] = useState<Record<string, number>>({});
  const [unitsToShip, setUnitsToShip] = useState<number>(defaultUnitsToShip);
  const [saving, setSaving] = useState(false);
  // Inline-edited received quantities (clId -> value)
  const [receivedEdits, setReceivedEdits] = useState<Record<string, number>>({});
  const [savingReceived, setSavingReceived] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    setUnitsToShip(defaultUnitsToShip);
    setReceivedEdits({});
  }, [open, defaultUnitsToShip]);

  useEffect(() => {
    if (!open || !user || !asin) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        let q = supabase
          .from("created_listings")
          .select("id, asin, sku, title, image_url, cost, units, received_quantity, date_created, created_at, supplier_links")
          .eq("user_id", user.id)
          .eq("asin", asin)
          .order("created_at", { ascending: false });

        if (period === "custom") {
          if (customFrom) q = q.gte("created_at", customFrom);
          if (customTo) q = q.lte("created_at", `${customTo}T23:59:59`);
        } else {
          const days = parseInt(period, 10);
          const from = new Date(Date.now() - days * 86400000).toISOString();
          q = q.gte("created_at", from);
        }
        const { data, error } = await q.limit(500);
        if (error) throw error;
        if (!cancelled) setRows((data ?? []) as PurchaseRow[]);

        // Hydrate existing allocations for this draft+asin
        const { data: allocs } = await supabase
          .from("shipment_purchase_allocations")
          .select("created_listing_id, draft_id, units_allocated, units_shipped")
          .eq("user_id", user.id)
          .eq("asin", asin);
        if (!cancelled && allocs?.length) {
          const sel: Record<string, number> = {};
          const ext: Record<string, number> = {};
          let totalShipped = 0;
          for (const a of allocs) {
            if (a.draft_id === draftId) {
              sel[a.created_listing_id] = a.units_allocated ?? 0;
              totalShipped += a.units_shipped ?? 0;
            } else {
              ext[a.created_listing_id] = (ext[a.created_listing_id] ?? 0) + (a.units_allocated ?? 0);
            }
          }
          setSelected(sel);
          setExternalAlloc(ext);
          if (totalShipped > 0) setUnitsToShip(totalShipped);
        } else if (!cancelled) {
          setExternalAlloc({});
        }
      } catch (e: any) {
        toast.error(e?.message || "Failed to load purchase history");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, user, asin, period, customFrom, customTo, draftId]);

  const totalSelected = useMemo(
    () => Object.values(selected).reduce((s, n) => s + (Number(n) || 0), 0),
    [selected],
  );
  const diff = totalSelected - unitsToShip;

  const remainingFor = (r: PurchaseRow) => {
    const recv = receivedEdits[r.id] ?? effectiveReceived(r);
    const ext = externalAlloc[r.id] ?? 0;
    return Math.max(0, recv - ext);
  };

  const toggle = (row: PurchaseRow, checked: boolean) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (checked) next[row.id] = Math.min(remainingFor(row), effectiveReceived(row));
      else delete next[row.id];
      return next;
    });
  };

  const setQty = (row: PurchaseRow, qty: number) => {
    const cap = remainingFor(row);
    const clamped = Math.max(0, Math.min(cap, qty || 0));
    if (qty > cap) toast.warning(`Capped at ${cap} (received − already allocated elsewhere).`);
    setSelected((prev) => ({ ...prev, [row.id]: clamped }));
  };

  const commitReceived = async (row: PurchaseRow, value: number) => {
    if (!user) return;
    const v = Math.max(0, Math.floor(value || 0));
    setSavingReceived((s) => ({ ...s, [row.id]: true }));
    try {
      const { error } = await supabase
        .from("created_listings")
        .update({ received_quantity: v })
        .eq("id", row.id)
        .eq("user_id", user.id);
      if (error) throw error;
      setRows((prev) => prev.map((x) => x.id === row.id ? { ...x, received_quantity: v } : x));
      // re-clamp selection if it now exceeds remaining
      setSelected((prev) => {
        if (prev[row.id] == null) return prev;
        const ext = externalAlloc[row.id] ?? 0;
        const cap = Math.max(0, v - ext);
        return { ...prev, [row.id]: Math.min(prev[row.id], cap) };
      });
      toast.success("Received quantity updated");
    } catch (e: any) {
      toast.error(e?.message || "Failed to update received quantity");
    } finally {
      setSavingReceived((s) => ({ ...s, [row.id]: false }));
    }
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await supabase
        .from("shipment_purchase_allocations")
        .delete()
        .eq("user_id", user.id)
        .eq("draft_id", draftId)
        .eq("asin", asin);

      const entries = Object.entries(selected).filter(([, v]) => (v || 0) > 0);
      if (entries.length > 0) {
        const allocTotal = entries.reduce((s, [, v]) => s + (v || 0), 0);
        const ship = Math.max(0, unitsToShip || 0);
        const inserts = entries.map(([clId, units]) => {
          const row = rows.find((r) => r.id === clId);
          const portion = allocTotal > 0 ? Math.round((units / allocTotal) * ship) : 0;
          return {
            user_id: user.id,
            draft_id: draftId,
            shipment_id: shipmentId ?? null,
            created_listing_id: clId,
            asin,
            sku: row?.sku ?? null,
            units_allocated: units,
            units_shipped: portion,
          };
        });
        const { error } = await supabase.from("shipment_purchase_allocations").insert(inserts);
        if (error) throw error;
      }
      toast.success("Allocation saved");
      onSaved?.(totalSelected, unitsToShip);
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || "Failed to save allocation");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Purchase history · {asin}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap gap-2 py-2">
          {PERIODS.map((p) => (
            <Button
              key={p.value}
              size="sm"
              variant={period === p.value ? "default" : "outline"}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </Button>
          ))}
        </div>

        {period === "custom" && (
          <div className="flex gap-2 items-center pb-2">
            <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="w-44" />
            <span className="text-muted-foreground">to</span>
            <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="w-44" />
          </div>
        )}

        <div className="flex-1 overflow-auto border rounded-md">
          {loading ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No purchase records found for this period.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr className="text-left">
                  <th className="p-2 w-8"></th>
                  <th className="p-2">Date</th>
                  <th className="p-2">Product</th>
                  <th className="p-2">Supplier</th>
                  <th className="p-2 text-right">Ordered</th>
                  <th className="p-2 text-right w-24">Received</th>
                  <th className="p-2 text-right">Alloc. elsewhere</th>
                  <th className="p-2 text-right">Remaining</th>
                  <th className="p-2 text-right">Cost</th>
                  <th className="p-2 text-right w-24">Allocate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const checked = selected[r.id] != null;
                  const ordered = r.units ?? 0;
                  const received = receivedEdits[r.id] ?? effectiveReceived(r);
                  const ext = externalAlloc[r.id] ?? 0;
                  const remaining = remainingFor(r);
                  const shortage = (r.units ?? 0) > 0 && received < ordered;
                  return (
                    <tr key={r.id} className="border-t">
                      <td className="p-2">
                        <Checkbox checked={checked} onCheckedChange={(v) => toggle(r, !!v)} disabled={remaining <= 0} />
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {(r.date_created ?? r.created_at?.slice(0, 10)) || "—"}
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          {r.image_url && (
                            <img src={r.image_url} alt="" className="min-w-12 w-12 min-h-12 h-12 object-cover rounded" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate max-w-[260px]">{r.title}</div>
                            <div className="text-xs text-muted-foreground">{r.sku}</div>
                          </div>
                        </div>
                      </td>
                      <td className="p-2">{getSupplierName(r.supplier_links)}</td>
                      <td className="p-2 text-right tabular-nums">{ordered}</td>
                      <td className="p-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="number"
                            min={0}
                            value={received}
                            onChange={(e) =>
                              setReceivedEdits((s) => ({ ...s, [r.id]: parseInt(e.target.value, 10) || 0 }))
                            }
                            onBlur={(e) => {
                              const v = parseInt(e.target.value, 10) || 0;
                              if (v !== (r.received_quantity ?? -1)) commitReceived(r, v);
                            }}
                            className={`h-8 w-20 text-right ${shortage ? "border-amber-500/60" : ""}`}
                          />
                          {savingReceived[r.id] && <Loader2 className="h-3 w-3 animate-spin" />}
                        </div>
                      </td>
                      <td className="p-2 text-right tabular-nums text-muted-foreground">{ext}</td>
                      <td className="p-2 text-right tabular-nums font-medium">{remaining}</td>
                      <td className="p-2 text-right tabular-nums">
                        {r.cost != null ? `$${Number(r.cost).toFixed(2)}` : "—"}
                      </td>
                      <td className="p-2 text-right">
                        <Input
                          type="number"
                          min={0}
                          max={remaining}
                          value={selected[r.id] ?? ""}
                          disabled={!checked || remaining <= 0}
                          onChange={(e) => setQty(r, parseInt(e.target.value, 10))}
                          className="h-8 text-right"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3 pt-3 items-end">
          <div>
            <label className="text-xs text-muted-foreground">Selected from received</label>
            <div className="text-2xl font-bold tabular-nums">{totalSelected}</div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Units to ship</label>
            <Input
              type="number"
              min={0}
              value={unitsToShip}
              onChange={(e) => setUnitsToShip(parseInt(e.target.value, 10) || 0)}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Difference</label>
            <div className="text-2xl font-bold tabular-nums">
              {diff === 0 ? (
                <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">0 · matched</Badge>
              ) : diff > 0 ? (
                <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
                  {diff} not shipped yet
                </Badge>
              ) : (
                <Badge className="bg-red-500/15 text-red-700 dark:text-red-400">
                  {Math.abs(diff)} over-shipped
                </Badge>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Save allocation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default PurchaseHistoryDialog;
