import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Loader2, ExternalLink, RefreshCw, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useSubscription } from "@/hooks/use-subscription";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type SalesRow = {
  order_id: string;
  asin: string | null;
  sku: string | null;
  title: string | null;
  quantity: number | null;
  sold_price: number | null;
  total_sale_amount: number | null;
  estimated_price: number | null;
  price_source: string | null;
  price_confidence: string | null;
  order_date: string | null;
  purchase_timestamp_utc: string | null;
  marketplace: string | null;
  order_status: string | null;
  status: string | null;
  is_cancelled: boolean | null;
};

type SnapRow = {
  order_id: string;
  asin: string | null;
  snapshot_price: number | null;
  snapshot_source: string | null;
  currency_code: string | null;
  fx_rate_used: number | null;
  captured_at: string | null;
};

type ActionRow = {
  asin: string;
  new_price: number | null;
  submitted_at: string | null;
};

type Category = "confirmed_mismatch" | "confirmed_match" | "pending_estimate" | "missing_my_price" | "fx_suspect" | "qty_half_suspect";

type Combined = {
  order: SalesRow;
  snap?: SnapRow;
  action?: ActionRow;
  myPrice: number | null;
  reportPrice: number | null;
  livePrice: number | null;
  deltaAbs: number | null;
  deltaPct: number | null;
  category: Category;
  flags: string[];
};

const orderUrl = (marketplace: string | null, orderId: string) => {
  const mp = (marketplace || "US").toUpperCase();
  const host =
    mp === "CA" ? "sellercentral.amazon.ca" :
    mp === "MX" ? "sellercentral.amazon.com.mx" :
    mp === "BR" ? "sellercentral.amazon.com.br" :
    "sellercentral.amazon.com";
  return `https://${host}/orders-v3/order/${orderId}`;
};

const money = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `$${Number(v).toFixed(2)}`;

// FX rates ~ USD → local. If reportPrice/myPrice ratio is close to any of these, flag as unconverted native.
const FX_HINTS: Record<string, number> = { MX: 18, BR: 5.3, CA: 1.37 };

function isPendingSource(src: string | null | undefined, conf: string | null | undefined): boolean {
  const s = (src || "").toLowerCase();
  const c = (conf || "").toUpperCase();
  if (c && c !== "CONFIRMED") return true;
  if (!s) return false;
  return (
    s.startsWith("seller_derived") ||
    s.startsWith("inventory_refresh") ||
    s.startsWith("inventory") ||
    s.startsWith("estimate") ||
    s.startsWith("listings_api") ||
    s.startsWith("pricing_api") ||
    s.startsWith("snapshot") ||
    s.startsWith("hint:")
  );
}

function classify(r: Omit<Combined, "category" | "flags">): { category: Category; flags: string[] } {
  const flags: string[] = [];
  const pending = isPendingSource(r.order.price_source, r.order.price_confidence);

  // FX suspect: confirmed but reportPrice ≈ myPrice × fxRate for non-US
  const mp = (r.order.marketplace || "US").toUpperCase();
  if (!pending && r.myPrice && r.reportPrice && r.myPrice > 0 && FX_HINTS[mp]) {
    const ratio = r.reportPrice / r.myPrice;
    const fx = FX_HINTS[mp];
    if (ratio >= fx * 0.75 && ratio <= fx * 1.25) {
      flags.push(`FX suspect (~${fx}x ${mp} native)`);
      return { category: "fx_suspect", flags };
    }
  }

  // Qty-half suspect: confirmed multi-unit, reportPrice ≈ myPrice/2 (or /qty)
  const qty = Number(r.order.quantity || 1) || 1;
  if (!pending && qty >= 2 && r.myPrice && r.reportPrice && r.myPrice > 0) {
    const expected = r.myPrice / qty;
    const diff = Math.abs(r.reportPrice - expected) / r.myPrice;
    if (diff < 0.05) {
      flags.push(`Qty-halving suspect (÷${qty})`);
      return { category: "qty_half_suspect", flags };
    }
  }

  if (r.myPrice == null) return { category: "missing_my_price", flags };
  if (pending || r.reportPrice == null || r.reportPrice === 0) return { category: "pending_estimate", flags };

  if (r.deltaAbs != null && r.deltaAbs >= 0.01) return { category: "confirmed_mismatch", flags };
  return { category: "confirmed_match", flags };
}

export default function PriceDiscrepancyAudit() {
  const { user } = useAuth();
  const { isAdmin, loading: subLoading } = useSubscription();

  const today = new Date().toISOString().slice(0, 10);
  const priorMonth = new Date();
  priorMonth.setDate(priorMonth.getDate() - 30);
  const priorStr = priorMonth.toISOString().slice(0, 10);

  const [startDate, setStartDate] = useState(priorStr);
  const [endDate, setEndDate] = useState(today);
  const [marketplace, setMarketplace] = useState<string>("ALL");
  const [minDelta, setMinDelta] = useState<string>("0.05");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Combined[]>([]);
  const [tab, setTab] = useState<Category>("confirmed_mismatch");

  async function load() {
    if (!user?.id) return;
    setLoading(true);
    try {
      let q = supabase
        .from("sales_orders")
        .select("order_id, asin, sku, title, quantity, sold_price, total_sale_amount, estimated_price, price_source, price_confidence, order_date, purchase_timestamp_utc, marketplace, order_status, status, is_cancelled")
        .eq("user_id", user.id)
        .gte("order_date", startDate)
        .lte("order_date", endDate)
        .order("order_date", { ascending: false })
        .limit(500);
      if (marketplace !== "ALL") q = q.eq("marketplace", marketplace);
      const { data: orders, error } = await q;
      if (error) throw error;

      const orderIds = (orders || []).map(o => o.order_id);
      const asins = Array.from(new Set((orders || []).map(o => o.asin).filter(Boolean))) as string[];

      const [{ data: snaps }, { data: actions }] = await Promise.all([
        orderIds.length
          ? supabase.from("order_price_snapshots")
              .select("order_id, asin, snapshot_price, snapshot_source, currency_code, fx_rate_used, captured_at")
              .eq("user_id", user.id)
              .in("order_id", orderIds)
          : Promise.resolve({ data: [] as SnapRow[] } as any),
        asins.length
          ? supabase.from("repricer_price_actions")
              .select("asin, new_price, submitted_at")
              .eq("user_id", user.id)
              .in("asin", asins)
              .gte("submitted_at", new Date(new Date(startDate).getTime() - 3 * 86400_000).toISOString())
              .order("submitted_at", { ascending: false })
              .limit(2000)
          : Promise.resolve({ data: [] as ActionRow[] } as any),
      ]);

      const snapByOrder = new Map<string, SnapRow>();
      for (const s of (snaps as SnapRow[]) || []) {
        if (!snapByOrder.has(s.order_id)) snapByOrder.set(s.order_id, s);
      }

      const actionsByAsin = new Map<string, ActionRow[]>();
      for (const a of (actions as ActionRow[]) || []) {
        if (!a.asin) continue;
        const arr = actionsByAsin.get(a.asin) || [];
        arr.push(a);
        actionsByAsin.set(a.asin, arr);
      }

      // Snapshot is only trustworthy as a purchase-time anchor if it was captured
      // at/before the purchase timestamp (5-min grace). Post-purchase snapshots are
      // just the current inventory price stamped after the fact — comparing that
      // against sold_price is comparing two different points in time and produces
      // fake "confirmed mismatches". Fall back to a repricer action at/before
      // purchase; if neither exists, route to Missing My Price.
      // Note: snapshot_source name ("inventory" vs "orders_api" etc.) is NOT used
      // to reject — legitimate pre-purchase inventory-price captures are common
      // and correct. Only timing matters.
      const GRACE_MS = 5 * 60_000;

      const combined: Combined[] = (orders || []).map((o: any) => {
        const rawSnap = snapByOrder.get(o.order_id);
        const orderTime = o.purchase_timestamp_utc ? new Date(o.purchase_timestamp_utc).getTime() : (o.order_date ? new Date(o.order_date).getTime() : 0);
        const actionList = o.asin ? actionsByAsin.get(o.asin) || [] : [];
        const action = actionList.find(a => a.submitted_at && new Date(a.submitted_at).getTime() <= orderTime);

        // Trust the snapshot only if captured at/before purchase (with grace).
        const snapCapturedMs = rawSnap?.captured_at ? new Date(rawSnap.captured_at).getTime() : null;
        const snapAnchored = !!rawSnap
          && snapCapturedMs != null
          && orderTime > 0
          && snapCapturedMs <= orderTime + GRACE_MS;
        const snap = snapAnchored ? rawSnap : undefined;

        const myPrice = snap?.snapshot_price ?? action?.new_price ?? null;
        const qty = Number(o.quantity || 1) || 1;
        const reportPrice = o.sold_price != null
          ? Number(o.sold_price)
          : (o.total_sale_amount != null ? Number(o.total_sale_amount) / qty : null);
        const livePrice = o.total_sale_amount != null
          ? Number(o.total_sale_amount) / qty
          : (o.sold_price != null ? Number(o.sold_price) : (o.estimated_price != null ? Number(o.estimated_price) : null));

        let deltaAbs: number | null = null;
        let deltaPct: number | null = null;
        if (myPrice != null && reportPrice != null) {
          deltaAbs = Math.abs(reportPrice - myPrice);
          if (myPrice > 0) deltaPct = (deltaAbs / myPrice) * 100;
        }

        const base = { order: o, snap, action, myPrice, reportPrice, livePrice, deltaAbs, deltaPct };
        const { category, flags } = classify(base);
        if (rawSnap && !snapAnchored) {
          flags.push(`snapshot rejected (source=${rawSnap.snapshot_source || "?"}, captured ${snapCapturedMs != null && orderTime > 0 ? Math.round((snapCapturedMs - orderTime) / 60_000) : "?"}min after purchase)`);
        }
        return { ...base, category, flags };
      });

      setRows(combined);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || "Failed to load orders");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (user?.id && isAdmin) load(); /* eslint-disable-next-line */ }, [user?.id, isAdmin]);

  const stats = useMemo(() => {
    const s = { confirmed_mismatch: 0, confirmed_match: 0, pending_estimate: 0, missing_my_price: 0, fx_suspect: 0, qty_half_suspect: 0 };
    for (const r of rows) s[r.category]++;
    return s;
  }, [rows]);

  const minD = Number(minDelta) || 0;

  const bucket = useMemo(() => {
    const b: Record<Category, Combined[]> = {
      confirmed_mismatch: [], confirmed_match: [], pending_estimate: [], missing_my_price: [], fx_suspect: [], qty_half_suspect: [],
    };
    for (const r of rows) {
      if (r.category === "confirmed_mismatch" && r.deltaAbs != null && r.deltaAbs < minD) {
        b.confirmed_match.push(r);
      } else {
        b[r.category].push(r);
      }
    }
    return b;
  }, [rows, minD]);

  if (subLoading) {
    return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>;
  }

  if (!isAdmin) {
    return (
      <div className="p-6">
        <Card><CardContent className="p-6 text-center text-muted-foreground">Admin access required.</CardContent></Card>
      </div>
    );
  }

  const renderTable = (list: Combined[], variant: Category) => (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr className="text-left">
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Order / ASIN</th>
            <th className="px-3 py-2">MP</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">My Price</th>
            <th className="px-3 py-2 text-right">{variant === "pending_estimate" ? "Estimated" : "Sales Report"}</th>
            <th className="px-3 py-2 text-right">Live Mobile</th>
            <th className="px-3 py-2 text-right">Δ Abs</th>
            <th className="px-3 py-2 text-right">Δ %</th>
            <th className="px-3 py-2">Source</th>
            <th className="px-3 py-2">Confidence</th>
            <th className="px-3 py-2">Flag</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {list.map(r => {
            const compareCol = variant === "pending_estimate" ? r.order.estimated_price ?? null : r.reportPrice;
            const highlight = variant === "confirmed_mismatch" || variant === "fx_suspect" || variant === "qty_half_suspect";
            return (
              <tr key={r.order.order_id + (r.order.asin || "")} className={cn("border-t align-top", highlight && "bg-destructive/5")}>
                <td className="px-3 py-2 whitespace-nowrap">{r.order.order_date}</td>
                <td className="px-3 py-2">
                  <div className="font-mono">{r.order.order_id}</div>
                  <div className="text-muted-foreground">{r.order.asin} {r.order.sku ? `· ${r.order.sku}` : ""}</div>
                  {r.order.title && <div className="text-muted-foreground truncate max-w-[280px]" title={r.order.title}>{r.order.title}</div>}
                </td>
                <td className="px-3 py-2"><Badge variant="outline">{r.order.marketplace || "US"}</Badge></td>
                <td className="px-3 py-2 text-right">{r.order.quantity ?? 1}</td>
                <td className="px-3 py-2 text-right font-mono">
                  {money(r.myPrice)}
                  {r.snap?.snapshot_source && <div className="text-[10px] text-muted-foreground">{r.snap.snapshot_source}</div>}
                  {!r.snap && r.action && <div className="text-[10px] text-muted-foreground">repricer_action</div>}
                </td>
                <td className="px-3 py-2 text-right font-mono">{money(compareCol)}</td>
                <td className="px-3 py-2 text-right font-mono">{money(r.livePrice)}</td>
                <td className={cn("px-3 py-2 text-right font-mono", highlight && "text-destructive font-semibold")}>{r.deltaAbs == null ? "—" : `$${r.deltaAbs.toFixed(2)}`}</td>
                <td className={cn("px-3 py-2 text-right font-mono", highlight && "text-destructive")}>{r.deltaPct == null ? "—" : `${r.deltaPct.toFixed(1)}%`}</td>
                <td className="px-3 py-2 text-[10px] text-muted-foreground">{r.order.price_source || "—"}</td>
                <td className="px-3 py-2">
                  {r.order.price_confidence ? <Badge variant="outline" className="text-[10px]">{r.order.price_confidence}</Badge> : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2 text-[10px]">
                  {r.flags.length ? (
                    <span className="inline-flex items-center gap-1 text-amber-600"><AlertTriangle className="w-3 h-3" />{r.flags.join(", ")}</span>
                  ) : "—"}
                </td>
                <td className="px-3 py-2">
                  <a href={orderUrl(r.order.marketplace, r.order.order_id)} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 hover:underline">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </td>
              </tr>
            );
          })}
          {!list.length && !loading && (
            <tr><td colSpan={13} className="text-center py-8 text-muted-foreground">No rows in this bucket.</td></tr>
          )}
          {loading && (
            <tr><td colSpan={13} className="text-center py-8 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1400px] mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Price Discrepancy Audit</h1>
        <p className="text-sm text-muted-foreground">
          Classified per-order comparison of <strong>My Price</strong> vs <strong>Sales Report</strong> vs <strong>Live Mobile</strong>. Pending estimates are separated from real confirmed mismatches, and FX / qty-halving patterns are auto-flagged.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Filters</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <div className="space-y-1"><Label className="text-xs">Start</Label><Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></div>
          <div className="space-y-1"><Label className="text-xs">End</Label><Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></div>
          <div className="space-y-1">
            <Label className="text-xs">Marketplace</Label>
            <Select value={marketplace} onValueChange={setMarketplace}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="US">US</SelectItem>
                <SelectItem value="CA">CA</SelectItem>
                <SelectItem value="MX">MX</SelectItem>
                <SelectItem value="BR">BR</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label className="text-xs">Min |Δ| ($)</Label><Input type="number" step="0.01" value={minDelta} onChange={e => setMinDelta(e.target.value)} /></div>
          <Button onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Reload
          </Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Confirmed mismatch</div><div className="text-2xl font-bold text-destructive">{stats.confirmed_mismatch}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">FX suspect</div><div className="text-2xl font-bold text-amber-600">{stats.fx_suspect}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Qty-halving</div><div className="text-2xl font-bold text-amber-600">{stats.qty_half_suspect}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Pending est.</div><div className="text-2xl font-bold text-blue-600">{stats.pending_estimate}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Missing My Price</div><div className="text-2xl font-bold text-muted-foreground">{stats.missing_my_price}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Matched</div><div className="text-2xl font-bold text-emerald-600">{stats.confirmed_match}</div></CardContent></Card>
      </div>

      <Card>
        <CardContent className="p-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Category)}>
            <TabsList className="flex flex-wrap h-auto">
              <TabsTrigger value="confirmed_mismatch">Confirmed Mismatch ({bucket.confirmed_mismatch.length})</TabsTrigger>
              <TabsTrigger value="fx_suspect">FX Suspect ({bucket.fx_suspect.length})</TabsTrigger>
              <TabsTrigger value="qty_half_suspect">Qty-halving ({bucket.qty_half_suspect.length})</TabsTrigger>
              <TabsTrigger value="pending_estimate">Pending Estimates ({bucket.pending_estimate.length})</TabsTrigger>
              <TabsTrigger value="missing_my_price">Missing My Price ({bucket.missing_my_price.length})</TabsTrigger>
              <TabsTrigger value="confirmed_match">Matched ({bucket.confirmed_match.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="confirmed_mismatch" className="mt-3">{renderTable(bucket.confirmed_mismatch, "confirmed_mismatch")}</TabsContent>
            <TabsContent value="fx_suspect" className="mt-3">{renderTable(bucket.fx_suspect, "fx_suspect")}</TabsContent>
            <TabsContent value="qty_half_suspect" className="mt-3">{renderTable(bucket.qty_half_suspect, "qty_half_suspect")}</TabsContent>
            <TabsContent value="pending_estimate" className="mt-3">{renderTable(bucket.pending_estimate, "pending_estimate")}</TabsContent>
            <TabsContent value="missing_my_price" className="mt-3">{renderTable(bucket.missing_my_price, "missing_my_price")}</TabsContent>
            <TabsContent value="confirmed_match" className="mt-3">{renderTable(bucket.confirmed_match, "confirmed_match")}</TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">How to read this</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1 text-muted-foreground">
          <p><strong>Confirmed Mismatch</strong> — order is CONFIRMED (Orders API / FEC) and Sales Report price differs from a <em>purchase-time-anchored</em> My Price by ≥ Min |Δ|. Real bugs live here.</p>
          <p><strong>FX Suspect</strong> — non-US confirmed row where Sales Report ≈ My Price × marketplace FX rate. Signature of unconverted native currency (MX ~18×, BR ~5.3×, CA ~1.37×).</p>
          <p><strong>Qty-halving</strong> — multi-unit order where Sales Report ≈ My Price ÷ qty. Signature of a double-divide in a backfill/estimate writer.</p>
          <p><strong>Pending Estimates</strong> — <code>price_confidence ≠ CONFIRMED</code> or source is <code>seller_derived / inventory_refresh / snapshot / listings_api</code>. Compared against <code>estimated_price</code>, not <code>sold_price</code>. These are not real discrepancies.</p>
          <p><strong>Missing My Price</strong> — no repricer snapshot or action captured at/before purchase time. Snapshots with <code>snapshot_source = inventory / inventory_refresh / live*</code> or <code>captured_at</code> after purchase are rejected (they're current-price backfills, not a purchase-time anchor) and land here with a <code>snapshot rejected</code> flag. Investigate whether the order was priced by Amazon Automate Pricing, a manual edit, or simply predates our snapshot coverage.</p>
        </CardContent>
      </Card>
    </div>
  );
}
