import { useEffect, useState, useCallback, useMemo } from "react";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  RefreshCw, ExternalLink, Copy, ShieldAlert, ShieldOff, Loader2, Package, Search,
} from "lucide-react";

type Status = "blocked_stock" | "blocked" | "at_risk_stock" | "dormant";

type Row = {
  rowId: string;
  source: "inventory" | "created_listings";
  id: string;
  asin: string;
  sku: string | null;
  title: string | null;
  imageUrl: string | null;
  marketplace: string;
  available: number;
  reserved: number;
  inbound: number;
  fbaBlocked: boolean;
  fbaBlockReason: string | null;
  checkedAt: string | null;
  status: Status;
};

const STATUS_META: Record<Status, { label: string; className: string; priority: number }> = {
  blocked_stock: { label: "Blocked · has stock", className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 border-red-300 dark:border-red-800", priority: 0 },
  blocked: { label: "Blocked", className: "bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400 border-red-200 dark:border-red-900", priority: 1 },
  at_risk_stock: { label: "At risk · has stock", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-300 dark:border-amber-800", priority: 2 },
  dormant: { label: "Dormant", className: "bg-muted text-muted-foreground border-border", priority: 3 },
};

const MARKETPLACE_HOSTS: Record<string, string> = {
  US: "sellercentral.amazon.com",
  CA: "sellercentral.amazon.ca",
  MX: "sellercentral.amazon.com.mx",
  BR: "sellercentral.amazon.com.br",
  UK: "sellercentral.amazon.co.uk",
  DE: "sellercentral.amazon.de",
  FR: "sellercentral.amazon.fr",
  IT: "sellercentral.amazon.it",
  ES: "sellercentral.amazon.es",
  JP: "sellercentral.amazon.co.jp",
};

const AMAZON_HOSTS: Record<string, string> = {
  US: "amazon.com",
  CA: "amazon.ca",
  MX: "amazon.com.mx",
  BR: "amazon.com.br",
  UK: "amazon.co.uk",
  DE: "amazon.de",
  FR: "amazon.fr",
  IT: "amazon.it",
  ES: "amazon.es",
  JP: "amazon.co.jp",
};

function classify(available: number, reserved: number, inbound: number, fbaBlocked: boolean): Status {
  const hasStock = available > 0 || reserved > 0 || inbound > 0;
  if (fbaBlocked) return hasStock ? "blocked_stock" : "blocked";
  return hasStock ? "at_risk_stock" : "dormant";
}

export default function FbaEligibilityIssues() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | Status>("all");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      // Full inventory scan (paginated) to find every listing sharing the
      // manufacturer-barcode/commingled signature (fnsku === asin) --
      // not just the ones Amazon has already blocked. That's what lets you
      // see exposure coming before it costs you a listing.
      const invAll: any[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("inventory")
          .select("id, asin, sku, fnsku, title, image_url, available, reserved, inbound, fba_blocked, fba_block_reason")
          .eq("user_id", user.id)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        invAll.push(...data);
        if (data.length < PAGE) break;
      }

      const [clRes, cacheRes] = await Promise.all([
        supabase
          .from("created_listings")
          .select("id, asin, title, image_url, fba_block_reason")
          .eq("user_id", user.id)
          .eq("fba_blocked", true)
          .limit(1000),
        supabase
          .from("fba_eligibility_cache")
          .select("asin, marketplace_id, checked_at")
          .eq("user_id", user.id)
          .limit(2000),
      ]);

      const cacheMap = new Map<string, { marketplace: string; checkedAt: string | null }>();
      for (const c of (cacheRes.data ?? []) as any[]) {
        const mpId = c.marketplace_id ?? "ATVPDKIKX0DER";
        const code = mpId === "ATVPDKIKX0DER" ? "US"
          : mpId === "A2EUQ1WTGCTBG2" ? "CA"
          : mpId === "A1AM78C64UM0Y8" ? "MX"
          : mpId === "A2Q3Y263D00KWC" ? "BR"
          : mpId === "A1F83G8C2ARO7P" ? "UK"
          : "US";
        cacheMap.set(String(c.asin).toUpperCase(), { marketplace: code, checkedAt: c.checked_at ?? null });
      }

      const exposedInventory = invAll.filter((r) => r.asin && r.fnsku && r.asin === r.fnsku);

      const invRows: Row[] = exposedInventory.map((r) => {
        const meta = cacheMap.get(String(r.asin).toUpperCase());
        const available = r.available ?? 0;
        const reserved = r.reserved ?? 0;
        const inbound = r.inbound ?? 0;
        const fbaBlocked = !!r.fba_blocked;
        return {
          rowId: `inventory:${r.id}`,
          source: "inventory",
          id: r.id,
          asin: r.asin,
          sku: r.sku ?? null,
          title: r.title ?? null,
          imageUrl: r.image_url ?? null,
          marketplace: meta?.marketplace ?? "US",
          available, reserved, inbound,
          fbaBlocked,
          fbaBlockReason: r.fba_block_reason ?? null,
          checkedAt: meta?.checkedAt ?? null,
          status: classify(available, reserved, inbound, fbaBlocked),
        };
      });

      // created_listings has no stock columns -- these are always fba_blocked=true
      // by the query filter, and always classified as dormant-blocked here.
      const clRows: Row[] = ((clRes.data ?? []) as any[]).map((r) => {
        const meta = cacheMap.get(String(r.asin).toUpperCase());
        return {
          rowId: `created_listings:${r.id}`,
          source: "created_listings",
          id: r.id,
          asin: r.asin,
          sku: null,
          title: r.title ?? null,
          imageUrl: r.image_url ?? null,
          marketplace: meta?.marketplace ?? "US",
          available: 0, reserved: 0, inbound: 0,
          fbaBlocked: true,
          fbaBlockReason: r.fba_block_reason ?? null,
          checkedAt: meta?.checkedAt ?? null,
          status: "blocked" as Status,
        };
      });

      const merged = [...invRows, ...clRows];
      const seen = new Set<string>();
      const dedup = merged.filter((r) => {
        const k = `${r.source}::${r.asin}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      dedup.sort((a, b) => {
        const pa = STATUS_META[a.status].priority;
        const pb = STATUS_META[b.status].priority;
        if (pa !== pb) return pa - pb;
        return a.asin > b.asin ? 1 : -1;
      });
      setRows(dedup);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to load FBA eligibility data");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<Status, number> = { blocked_stock: 0, blocked: 0, at_risk_stock: 0, dormant: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.status !== filter) return false;
      if (!q) return true;
      return (
        r.asin.toLowerCase().includes(q) ||
        (r.sku ?? "").toLowerCase().includes(q) ||
        (r.title ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, filter, search]);

  const recheck = async (row: Row) => {
    setBusyId(row.rowId);
    try {
      const { data, error } = await supabase.functions.invoke(
        "check-fba-listing-eligibility",
        { body: { asin: row.asin.toUpperCase(), marketplace: row.marketplace, force: true } },
      );
      if (error) throw error;
      const result = data as { eligible?: boolean; fba_block_reason?: string | null } | null;
      if (result?.eligible) {
        await supabase
          .from(row.source as any)
          .update({ fba_blocked: false, fba_block_reason: null } as any)
          .eq("id", row.id);
        toast.success(`${row.asin} is now FBA-eligible.`);
        setRows((prev) => prev.map((r) => (r.rowId === row.rowId
          ? { ...r, fbaBlocked: false, fbaBlockReason: null, status: classify(r.available, r.reserved, r.inbound, false) }
          : r)));
      } else {
        await supabase
          .from(row.source as any)
          .update({
            fba_blocked: true,
            fba_block_reason: result?.fba_block_reason ?? row.fbaBlockReason ?? "manufacturer_barcode_or_invalid_fnsku",
          } as any)
          .eq("id", row.id);
        toast.warning(`${row.asin} is still blocked: ${result?.fba_block_reason ?? "manufacturer barcode / invalid FNSKU"}`);
        setRows((prev) => prev.map((r) => (r.rowId === row.rowId
          ? { ...r, fbaBlocked: true, fbaBlockReason: result?.fba_block_reason ?? r.fbaBlockReason, checkedAt: new Date().toISOString(), status: classify(r.available, r.reserved, r.inbound, true) }
          : r)));
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Re-check failed");
    } finally {
      setBusyId(null);
    }
  };

  const markFbmOnly = async (row: Row) => {
    setBusyId(row.rowId);
    try {
      await supabase
        .from(row.source as any)
        .update({ fba_blocked: true, fba_block_reason: "fbm_only_acknowledged" } as any)
        .eq("id", row.id);
      toast.success(`${row.asin} marked FBM-only. It will stay excluded from FBA workflows.`);
      setRows((prev) => prev.map((r) => (r.rowId === row.rowId
        ? { ...r, fbaBlocked: true, fbaBlockReason: "fbm_only_acknowledged", status: classify(r.available, r.reserved, r.inbound, true) }
        : r)));
    } catch (err: any) {
      toast.error(err?.message ?? "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  const openSellerCentral = (row: Row) => {
    const host = MARKETPLACE_HOSTS[row.marketplace] ?? MARKETPLACE_HOSTS.US;
    window.open(`https://${host}/abis/listing/edit?asin=${encodeURIComponent(row.asin)}`, "_blank", "noopener,noreferrer");
  };

  const copyAsin = async (asin: string) => {
    try {
      await navigator.clipboard.writeText(asin);
      toast.success(`Copied ${asin}`);
    } catch {
      toast.error("Copy failed");
    }
  };

  const FILTERS: { key: "all" | Status; label: string }[] = [
    { key: "all", label: `All (${rows.length})` },
    { key: "blocked_stock", label: `Blocked + stock (${counts.blocked_stock})` },
    { key: "blocked", label: `Blocked (${counts.blocked})` },
    { key: "at_risk_stock", label: `At risk + stock (${counts.at_risk_stock})` },
    { key: "dormant", label: `Dormant (${counts.dormant})` },
  ];

  return (
    <>
      <Helmet>
        <title>FBA Eligibility Issues — ArbiProSeller</title>
        <meta name="description" content="Every listing exposed to Amazon's manufacturer-barcode / brand-registry restriction, blocked or not yet." />
      </Helmet>
      <Navbar />
      <main className="container mx-auto pt-24 pb-16 px-4">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ShieldAlert className="h-6 w-6 text-red-500" />
              FBA Eligibility Issues
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Listings shelved under the manufacturer's own barcode (UPC/EAN) instead of a seller-specific
              FNSKU — the setup Amazon restricts to registered brand owners. Shows what's already blocked
              and what's exposed to the same rule but hasn't been hit yet.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className={loading ? "h-3 w-3 mr-1 animate-spin" : "h-3 w-3 mr-1"} />
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <Card className="p-4">
            <div className="text-2xl font-semibold tabular-nums">{rows.length}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Total exposed</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">{counts.blocked_stock}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Blocked · has stock</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">{counts.blocked}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Blocked · dormant</div>
          </Card>
          <Card className="p-4">
            <div className="text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">{counts.at_risk_stock}</div>
            <div className="text-xs text-muted-foreground mt-0.5">At risk · has stock</div>
          </Card>
        </div>

        <div className="flex items-center gap-2 flex-wrap mb-4">
          <div className="relative w-64">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8 h-9"
              placeholder="Search ASIN, SKU, or title…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {FILTERS.map((f) => (
              <Button
                key={f.key}
                size="sm"
                variant={filter === f.key ? "default" : "outline"}
                className="h-9 text-xs"
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </Button>
            ))}
          </div>
          <span className="text-xs text-muted-foreground ml-auto">{filtered.length} of {rows.length} shown</span>
        </div>

        <Card className="overflow-hidden">
          {loading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 mx-auto mb-2 animate-spin" />
              Scanning your catalog…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <ShieldOff className="h-6 w-6 mx-auto mb-2 opacity-60" />
              {rows.length === 0 ? "No listings use manufacturer-barcode mode. You're clear." : "No listings match this search / filter."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[52px]">Image</TableHead>
                    <TableHead>ASIN</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead className="text-right">Avail</TableHead>
                    <TableHead className="text-right">Resv</TableHead>
                    <TableHead className="text-right">Inbnd</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right w-[260px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => {
                    const host = AMAZON_HOSTS[row.marketplace] ?? AMAZON_HOSTS.US;
                    const meta = STATUS_META[row.status];
                    return (
                      <TableRow key={row.rowId}>
                        <TableCell>
                          {row.imageUrl ? (
                            <img
                              src={row.imageUrl}
                              alt={row.title ?? row.asin}
                              className="h-10 w-10 min-w-10 min-h-10 object-cover rounded border"
                              loading="lazy"
                            />
                          ) : (
                            <div className="h-10 w-10 rounded border flex items-center justify-center bg-muted">
                              <Package className="h-4 w-4 text-muted-foreground" />
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          <a
                            href={`https://www.${host}/dp/${row.asin}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline dark:text-blue-400 inline-flex items-center gap-1"
                          >
                            {row.asin}
                            <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
                          </a>
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">{row.sku ?? "—"}</TableCell>
                        <TableCell className="max-w-[260px]">
                          <span className="line-clamp-2 text-sm">{row.title ?? "—"}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{row.available}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{row.reserved}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{row.inbound}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] whitespace-nowrap ${meta.className}`}>
                            {meta.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate" title={row.fbaBlockReason ?? ""}>
                          {row.fbaBlockReason?.replace("[MANUFACTURER_BARCODE_MODE] ", "") ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => recheck(row)}
                              disabled={busyId === row.rowId}
                              title="Re-check eligibility"
                            >
                              {busyId === row.rowId ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => markFbmOnly(row)}
                              disabled={busyId === row.rowId}
                              title="Mark as FBM only"
                            >
                              <ShieldOff className="h-3 w-3" />
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => openSellerCentral(row)} title="Open in Seller Central">
                              <ExternalLink className="h-3 w-3" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => copyAsin(row.asin)} title="Copy ASIN">
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>

        <div className="mt-4 text-xs text-muted-foreground">
          Tip: in Seller Central, edit the listing's <strong>Offer → Barcode</strong> setting and
          switch from "Manufacturer barcode" to "Amazon barcode (FNSKU)". After saving and
          re-syncing FNSKUs, click <strong>Re-check</strong> here.
        </div>
      </main>
      <Footer />
    </>
  );
}
