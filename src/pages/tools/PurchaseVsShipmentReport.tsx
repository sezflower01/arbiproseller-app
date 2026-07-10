import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type AllocRow = {
  id: string;
  draft_id: string;
  shipment_id: string | null;
  created_listing_id: string;
  asin: string;
  sku: string | null;
  units_allocated: number;
  units_shipped: number;
  updated_at: string;
  created_listings: {
    title: string | null;
    image_url: string | null;
    supplier_links: unknown;
    units: number | null;
    received_quantity: number | null;
  } | null;
};

type AsinAgg = {
  asin: string;
  title: string;
  image_url: string | null;
  supplier: string;
  ordered: number;
  received: number;
  allocated: number;
  shipped: number;
  shipments: Set<string>;
  listingIds: Set<string>;
};

function supplierName(links: unknown): string {
  if (!Array.isArray(links) || links.length === 0) return "—";
  const first = links[0] as { supplier_name?: string; name?: string };
  return first?.supplier_name ?? first?.name ?? "—";
}

function statusFor(ordered: number, received: number, shipped: number): { label: string; cls: string } {
  if (shipped > received) return { label: "Over-shipped", cls: "bg-red-500/15 text-red-700 dark:text-red-400" };
  if (ordered > 0 && received < ordered) return { label: "Supplier shortage", cls: "bg-orange-500/15 text-orange-700 dark:text-orange-400" };
  if (shipped === 0) return { label: "Not shipped yet", cls: "bg-muted text-muted-foreground" };
  if (shipped < received) return { label: "Inventory available", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-400" };
  return { label: "Fully shipped", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" };
}

export default function PurchaseVsShipmentReport() {
  const { user } = useAuth();
  const [rows, setRows] = useState<AllocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const loadData = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("shipment_purchase_allocations")
      .select("id, draft_id, shipment_id, created_listing_id, asin, sku, units_allocated, units_shipped, updated_at, created_listings(title, image_url, supplier_links, units, received_quantity)")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(2000);
    if (error) console.warn(error);
    const allocs = (data ?? []) as unknown as AllocRow[];

    // Filter out allocations whose draft was deleted (orphans).
    const draftIds = Array.from(new Set(allocs.map((r) => r.draft_id).filter(Boolean)));
    let liveDraftIds = new Set<string>();
    if (draftIds.length > 0) {
      const { data: drafts } = await supabase
        .from("shipment_builder_drafts")
        .select("draft_id")
        .eq("user_id", user.id)
        .in("draft_id", draftIds);
      liveDraftIds = new Set((drafts ?? []).map((d: { draft_id: string }) => d.draft_id));
    }
    const orphanIds = allocs.filter((r) => !liveDraftIds.has(r.draft_id)).map((r) => r.id);
    if (orphanIds.length > 0) {
      // Auto-cleanup orphans so the report always reflects reality.
      await supabase
        .from("shipment_purchase_allocations")
        .delete()
        .eq("user_id", user.id)
        .in("id", orphanIds);
    }
    setRows(allocs.filter((r) => liveDraftIds.has(r.draft_id)));
    setLoading(false);
  };

  useEffect(() => { loadData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user]);

  const aggregated = useMemo(() => {
    const map = new Map<string, AsinAgg>();
    for (const r of rows) {
      const a = map.get(r.asin) ?? {
        asin: r.asin,
        title: r.created_listings?.title ?? r.asin,
        image_url: r.created_listings?.image_url ?? null,
        supplier: supplierName(r.created_listings?.supplier_links),
        ordered: 0,
        received: 0,
        allocated: 0,
        shipped: 0,
        shipments: new Set<string>(),
        listingIds: new Set<string>(),
      };
      a.allocated += r.units_allocated || 0;
      a.shipped += r.units_shipped || 0;
      if (r.shipment_id) a.shipments.add(r.shipment_id);
      else a.shipments.add(r.draft_id);
      // Count ordered/received once per source listing
      if (!a.listingIds.has(r.created_listing_id)) {
        a.listingIds.add(r.created_listing_id);
        const ordered = r.created_listings?.units ?? 0;
        const recv = r.created_listings?.received_quantity ?? ordered;
        a.ordered += ordered;
        a.received += recv;
      }
      map.set(r.asin, a);
    }
    let list = Array.from(map.values());
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((x) => x.asin.toLowerCase().includes(q) || x.title.toLowerCase().includes(q));
    }
    return list.sort((a, b) => b.received - a.received);
  }, [rows, query]);

  const totals = useMemo(() => {
    let ordered = 0, received = 0, shipped = 0;
    for (const a of aggregated) { ordered += a.ordered; received += a.received; shipped += a.shipped; }
    return { ordered, received, shipped, remaining: received - shipped, asinCount: aggregated.length };
  }, [aggregated]);

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <Link to="/tools">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
          </Link>
          <h1 className="text-2xl font-bold">Purchase vs Shipment Report</h1>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">ASINs tracked</div>
            <div className="text-2xl font-bold tabular-nums">{totals.asinCount}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Ordered</div>
            <div className="text-2xl font-bold tabular-nums">{totals.ordered}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Received</div>
            <div className="text-2xl font-bold tabular-nums">{totals.received}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Shipped</div>
            <div className="text-2xl font-bold tabular-nums">{totals.shipped}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Remaining</div>
            <div className="text-2xl font-bold tabular-nums">{totals.remaining}</div>
          </Card>
        </div>

        <div className="mb-3">
          <Input placeholder="Search ASIN or title…" value={query} onChange={(e) => setQuery(e.target.value)} className="max-w-sm" />
        </div>

        <Card className="overflow-hidden">
          {loading ? (
            <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : aggregated.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No allocations yet. Use “Purchase History” in the FBA Shipment Builder to allocate purchases to a shipment.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-3">Product</th>
                  <th className="p-3">ASIN</th>
                  <th className="p-3">Supplier</th>
                  <th className="p-3 text-right">Shipments</th>
                  <th className="p-3 text-right">Ordered</th>
                  <th className="p-3 text-right">Received</th>
                  <th className="p-3 text-right">Shipped</th>
                  <th className="p-3 text-right">Remaining</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 w-12"></th>
                </tr>
              </thead>
              <tbody>
                {aggregated.map((a) => {
                  const remaining = a.received - a.shipped;
                  const s = statusFor(a.ordered, a.received, a.shipped);
                  const remove = async () => {
                    if (!user) return;
                    if (!confirm(`Remove ${a.asin} from the report? This deletes its purchase allocations.`)) return;
                    const { error } = await supabase
                      .from("shipment_purchase_allocations")
                      .delete()
                      .eq("user_id", user.id)
                      .eq("asin", a.asin);
                    if (error) { toast.error(error.message); return; }
                    toast.success("Removed");
                    setRows((prev) => prev.filter((r) => r.asin !== a.asin));
                  };
                  return (
                    <tr key={a.asin} className="border-t hover:bg-muted/30">
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          {a.image_url && (
                            <img src={a.image_url} alt="" className="min-w-12 w-12 min-h-12 h-12 object-cover rounded" />
                          )}
                          <div className="font-medium truncate max-w-[320px]">{a.title}</div>
                        </div>
                      </td>
                      <td className="p-3 font-mono text-xs">{a.asin}</td>
                      <td className="p-3">{a.supplier}</td>
                      <td className="p-3 text-right tabular-nums">{a.shipments.size}</td>
                      <td className="p-3 text-right tabular-nums">{a.ordered}</td>
                      <td className="p-3 text-right tabular-nums">{a.received}</td>
                      <td className="p-3 text-right tabular-nums">{a.shipped}</td>
                      <td className="p-3 text-right tabular-nums font-semibold">{remaining}</td>
                      <td className="p-3"><Badge className={s.cls}>{s.label}</Badge></td>
                      <td className="p-3">
                        <Button variant="ghost" size="icon" onClick={remove} title="Remove from report">
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
