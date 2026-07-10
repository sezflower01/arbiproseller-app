import { useEffect, useState, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  RefreshCw, ExternalLink, Copy, ShieldAlert, ShieldOff, Loader2, Package,
} from "lucide-react";

type BlockedRow = {
  rowId: string;
  source: "inventory" | "created_listings";
  id: string;
  asin: string;
  title: string | null;
  imageUrl: string | null;
  marketplace: string;
  fbaBlockReason: string | null;
  checkedAt: string | null;
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

export default function FbaEligibilityIssues() {
  const { user } = useAuth();
  const [rows, setRows] = useState<BlockedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [invRes, clRes, cacheRes] = await Promise.all([
        supabase
          .from("inventory")
          .select("id, asin, title, image_url, fba_block_reason")
          .eq("user_id", user.id)
          .eq("fba_blocked", true)
          .limit(1000),
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
        cacheMap.set(String(c.asin).toUpperCase(), {
          marketplace: c.marketplace_id ?? "ATVPDKIKX0DER",
          checkedAt: c.checked_at ?? null,
        });
      }

      const mkRow = (r: any, source: BlockedRow["source"]): BlockedRow => {
        const meta = cacheMap.get(String(r.asin).toUpperCase());
        const mpId = meta?.marketplace ?? "ATVPDKIKX0DER";
        const code = mpId === "ATVPDKIKX0DER" ? "US"
          : mpId === "A2EUQ1WTGCTBG2" ? "CA"
          : mpId === "A1AM78C64UM0Y8" ? "MX"
          : mpId === "A2Q3Y263D00KWC" ? "BR"
          : mpId === "A1F83G8C2ARO7P" ? "UK"
          : "US";
        return {
          rowId: `${source}:${r.id}`,
          source,
          id: r.id,
          asin: r.asin,
          title: r.title ?? null,
          imageUrl: r.image_url ?? null,
          marketplace: code,
          fbaBlockReason: r.fba_block_reason ?? null,
          checkedAt: meta?.checkedAt ?? null,
        };
      };

      const merged: BlockedRow[] = [
        ...((invRes.data ?? []) as any[]).map((r) => mkRow(r, "inventory")),
        ...((clRes.data ?? []) as any[]).map((r) => mkRow(r, "created_listings")),
      ];
      // Dedup on (source, asin) so duplicate batches don't spam the table.
      const seen = new Set<string>();
      const dedup = merged.filter((r) => {
        const k = `${r.source}::${r.asin}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      dedup.sort((a, b) => (a.asin > b.asin ? 1 : -1));
      setRows(dedup);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to load blocked listings");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const recheck = async (row: BlockedRow) => {
    setBusyId(row.rowId);
    try {
      const { data, error } = await supabase.functions.invoke(
        "check-fba-listing-eligibility",
        { body: { asin: row.asin.toUpperCase(), marketplace: row.marketplace, force: true } },
      );
      if (error) throw error;
      const result = data as { eligible?: boolean; fba_block_reason?: string | null } | null;
      if (result?.eligible) {
        // Clear the flag on the underlying row so future flows treat it as eligible.
        await supabase
          .from(row.source as any)
          .update({ fba_blocked: false, fba_block_reason: null } as any)
          .eq("id", row.id);
        toast.success(`${row.asin} is now FBA-eligible. Removed from blocked list.`);
        setRows((prev) => prev.filter((r) => r.rowId !== row.rowId));
      } else {
        // Still blocked — refresh reason text.
        await supabase
          .from(row.source as any)
          .update({
            fba_blocked: true,
            fba_block_reason: result?.fba_block_reason ?? row.fbaBlockReason ?? "manufacturer_barcode_or_invalid_fnsku",
          } as any)
          .eq("id", row.id);
        toast.warning(`${row.asin} is still blocked: ${result?.fba_block_reason ?? "manufacturer barcode / invalid FNSKU"}`);
        setRows((prev) =>
          prev.map((r) =>
            r.rowId === row.rowId
              ? { ...r, fbaBlockReason: result?.fba_block_reason ?? r.fbaBlockReason, checkedAt: new Date().toISOString() }
              : r,
          ),
        );
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Re-check failed");
    } finally {
      setBusyId(null);
    }
  };

  const markFbmOnly = async (row: BlockedRow) => {
    setBusyId(row.rowId);
    try {
      // Already fba_blocked=true. This action just confirms intent and tags the
      // row with a clear FBM-only reason for downstream UIs.
      await supabase
        .from(row.source as any)
        .update({
          fba_blocked: true,
          fba_block_reason: "fbm_only_acknowledged",
        } as any)
        .eq("id", row.id);
      toast.success(`${row.asin} marked FBM-only. It will stay excluded from FBA workflows.`);
      setRows((prev) =>
        prev.map((r) =>
          r.rowId === row.rowId ? { ...r, fbaBlockReason: "fbm_only_acknowledged" } : r,
        ),
      );
    } catch (err: any) {
      toast.error(err?.message ?? "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  const openSellerCentral = (row: BlockedRow) => {
    const host = MARKETPLACE_HOSTS[row.marketplace] ?? MARKETPLACE_HOSTS.US;
    const url = `https://${host}/abis/listing/edit?asin=${encodeURIComponent(row.asin)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const copyAsin = async (asin: string) => {
    try {
      await navigator.clipboard.writeText(asin);
      toast.success(`Copied ${asin}`);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <>
      <Helmet>
        <title>FBA Blocked ASINs — ArbiProSeller</title>
        <meta name="description" content="Review ASINs blocked from FBA shipment due to manufacturer barcode or invalid FNSKU." />
      </Helmet>
      <Navbar />
      <main className="container mx-auto pt-24 pb-16 px-4">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ShieldAlert className="h-6 w-6 text-red-500" />
              FBA Blocked ASINs
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Listings flagged as ineligible for FBA (manufacturer barcode, missing/invalid FNSKU,
              or marked FBM-only). These rows are excluded from shipment plans, label printing,
              and FBA-bound purchase flows.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {rows.length} blocked
            </Badge>
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? "h-3 w-3 mr-1 animate-spin" : "h-3 w-3 mr-1"} />
              Refresh
            </Button>
          </div>
        </div>

        <Card className="overflow-hidden">
          {loading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 mx-auto mb-2 animate-spin" />
              Loading blocked listings…
            </div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <ShieldOff className="h-6 w-6 mx-auto mb-2 opacity-60" />
              No ASINs are currently blocked from FBA. You're clear to ship.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[60px]">Image</TableHead>
                    <TableHead>ASIN</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Marketplace</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Date Checked</TableHead>
                    <TableHead className="text-right w-[260px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.rowId}>
                      <TableCell>
                        {row.imageUrl ? (
                          <img
                            src={row.imageUrl}
                            alt={row.title ?? row.asin}
                            className="h-12 w-12 min-w-12 min-h-12 object-cover rounded border"
                            loading="lazy"
                          />
                        ) : (
                          <div className="h-12 w-12 rounded border flex items-center justify-center bg-muted">
                            <Package className="h-4 w-4 text-muted-foreground" />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <a
                          href={`https://www.${
                            row.marketplace === "CA" ? "amazon.ca"
                            : row.marketplace === "MX" ? "amazon.com.mx"
                            : row.marketplace === "BR" ? "amazon.com.br"
                            : row.marketplace === "UK" ? "amazon.co.uk"
                            : row.marketplace === "DE" ? "amazon.de"
                            : row.marketplace === "FR" ? "amazon.fr"
                            : row.marketplace === "IT" ? "amazon.it"
                            : row.marketplace === "ES" ? "amazon.es"
                            : row.marketplace === "JP" ? "amazon.co.jp"
                            : "amazon.com"
                          }/dp/${row.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {row.asin}
                        </a>
                      </TableCell>
                      <TableCell className="max-w-[320px]">
                        <span className="line-clamp-2 text-sm">{row.title ?? "—"}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px]">{row.marketplace}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-red-700 dark:text-red-300 max-w-[260px]">
                        {row.fbaBlockReason ?? "manufacturer_barcode_or_invalid_fnsku"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.source === "inventory" ? "Inventory" : "Created Listings"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.checkedAt ? new Date(row.checkedAt).toLocaleString() : "—"}
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
                            {busyId === row.rowId ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3" />
                            )}
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
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openSellerCentral(row)}
                            title="Open in Seller Central"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => copyAsin(row.asin)}
                            title="Copy ASIN"
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
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
