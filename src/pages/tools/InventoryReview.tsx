import { useEffect, useMemo, useState, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ExternalLink, RefreshCw, ArrowLeft, Search, ScanLine } from "lucide-react";

type ReviewStatus = "needs_review" | "confirmed_zero" | "restored" | "ignored";

interface ReviewRow {
  id: string;
  user_id: string;
  asin: string | null;
  sku: string | null;
  marketplace: string | null;
  prior_available: number | null;
  prior_reserved: number | null;
  prior_inbound: number | null;
  reason: string | null;
  detection_source: string | null;
  status: ReviewStatus;
  occurrences: number | null;
  first_missing_at: string | null;
  last_missing_at: string | null;
  notes: string | null;
}

interface InventoryRow {
  sku: string;
  asin: string | null;
  available: number | null;
  reserved: number | null;
  inbound: number | null;
}

const SELLER_CENTRAL_HOSTS: Record<string, string> = {
  ATVPDKIKX0DER: "sellercentral.amazon.com",
  A2EUQ1WTGCTBG2: "sellercentral.amazon.ca",
  A1AM78C64UM0Y8: "sellercentral.amazon.com.mx",
  A2Q3Y263D00KWC: "sellercentral.amazon.com.br",
  A1F83G8C2ARO7P: "sellercentral.amazon.co.uk",
  A1PA6795UKMFR9: "sellercentral.amazon.de",
  A13V1IB3VIYZZH: "sellercentral.amazon.fr",
  APJ6JRA9NG5V4: "sellercentral.amazon.it",
  A1RKKUPIHCS9HS: "sellercentral.amazon.es",
  A1VC38T7YXB528: "sellercentral.amazon.co.jp",
  A39IBJ37TRP1C6: "sellercentral.amazon.com.au",
};

const sellerCentralSearch = (sku: string | null, marketplace: string | null) => {
  const host = (marketplace && SELLER_CENTRAL_HOSTS[marketplace]) || "sellercentral.amazon.com";
  const q = encodeURIComponent(sku ?? "");
  return `https://${host}/inventory?searchString=${q}`;
};

const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

const statusVariant = (s: ReviewStatus): "default" | "secondary" | "destructive" | "outline" => {
  switch (s) {
    case "needs_review":
      return "destructive";
    case "restored":
      return "default";
    case "confirmed_zero":
      return "secondary";
    case "ignored":
      return "outline";
    default:
      return "outline";
  }
};

export default function InventoryReview() {
  const { user } = useAuth();
  const { toast } = useToast();

  // Admin-only hard gate. Regular users must never reach this queue —
  // it's a backend safety net for genuinely ambiguous inventory cases
  // (both FBA Report AND Summaries missing/zero). Auto-resolvable cases
  // are handled upstream in sync-inventory-report (STALE→RESTORED path).
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    supabase
      .rpc("has_role", { _user_id: user.id, _role: "admin" })
      .then(({ data }) => setIsAdmin(!!data));
  }, [user?.id]);

  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [current, setCurrent] = useState<Record<string, InventoryRow>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ReviewStatus | "all">("needs_review");
  const [search, setSearch] = useState("");
  const [scanning, setScanning] = useState(false);
  const [showCleanup, setShowCleanup] = useState(false);


  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);

    const { data: reviewData, error: reviewErr } = await supabase
      .from("inventory_missing_review" as never)
      .select("*")
      .eq("user_id", user.id)
      .order("last_missing_at", { ascending: false })
      .limit(1000);

    if (reviewErr) {
      toast({ title: "Failed to load review queue", description: reviewErr.message, variant: "destructive" });
      setLoading(false);
      return;
    }

    const reviewRows = (reviewData ?? []) as unknown as ReviewRow[];
    setRows(reviewRows);

    const skus = Array.from(new Set(reviewRows.map((r) => r.sku).filter(Boolean) as string[]));
    if (skus.length > 0) {
      const { data: inv } = await supabase
        .from("inventory")
        .select("sku, asin, available, reserved, inbound")
        .eq("user_id", user.id)
        .in("sku", skus);

      const map: Record<string, InventoryRow> = {};
      for (const r of (inv ?? []) as InventoryRow[]) {
        if (r.sku) map[r.sku] = r;
      }
      setCurrent(map);
    } else {
      setCurrent({});
    }

    setLoading(false);
  }, [user?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const isCleanup = (r: ReviewRow) =>
    r.detection_source === "inactive_listing_cleanup" ||
    /inactive listing cleanup/i.test(r.reason ?? "");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const cleanup = isCleanup(r);
      if (!showCleanup && cleanup) return false;
      if (showCleanup && !cleanup) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        (r.sku ?? "").toLowerCase().includes(q) ||
        (r.asin ?? "").toLowerCase().includes(q) ||
        (r.marketplace ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, statusFilter, search, showCleanup]);

  const counts = useMemo(() => {
    const c = { needs_review: 0, confirmed_zero: 0, restored: 0, ignored: 0, cleanup: 0 } as Record<ReviewStatus | "cleanup", number>;
    for (const r of rows) {
      c[r.status] = (c[r.status] ?? 0) + 1;
      if (isCleanup(r) && r.status === "needs_review") c.cleanup += 1;
    }
    return c;
  }, [rows]);

  const valueImpact = (r: ReviewRow): number => {
    // Approximate: prior units lost from available + reserved (excluding inbound)
    const prior = (r.prior_available ?? 0) + (r.prior_reserved ?? 0);
    const cur = current[r.sku ?? ""];
    const now = (cur?.available ?? 0) + (cur?.reserved ?? 0);
    return Math.max(0, prior - now);
  };

  const restore = async (r: ReviewRow) => {
    if (!user?.id || !r.sku) return;
    setBusyId(r.id);
    try {
      const updates = {
        available: r.prior_available ?? 0,
        reserved: r.prior_reserved ?? 0,
        inbound: r.prior_inbound ?? 0,
        last_summaries_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const { error: invErr } = await supabase
        .from("inventory")
        .update(updates)
        .eq("user_id", user.id)
        .eq("sku", r.sku);
      if (invErr) throw invErr;

      const { error: rvErr } = await supabase
        .from("inventory_missing_review" as never)
        .update({
          status: "restored",
          resolved_at: new Date().toISOString(),
          resolved_by: user.id,
        } as never)
        .eq("id", r.id);
      if (rvErr) throw rvErr;

      toast({ title: "Stock restored", description: `${r.sku} → ${updates.available}/${updates.reserved}/${updates.inbound}` });
      await load();
    } catch (e) {
      toast({ title: "Restore failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const confirmZero = async (r: ReviewRow) => {
    if (!user?.id || !r.sku) return;
    setBusyId(r.id);
    try {
      const { error: invErr } = await supabase
        .from("inventory")
        .update({
          available: 0,
          reserved: 0,
          inbound: 0,
          last_summaries_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("sku", r.sku);
      if (invErr) throw invErr;

      const { error: rvErr } = await supabase
        .from("inventory_missing_review" as never)
        .update({
          status: "confirmed_zero",
          resolved_at: new Date().toISOString(),
          resolved_by: user.id,
        } as never)
        .eq("id", r.id);
      if (rvErr) throw rvErr;

      toast({ title: "Confirmed zero", description: r.sku ?? "" });
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const ignore = async (r: ReviewRow) => {
    setBusyId(r.id);
    try {
      const { error } = await supabase
        .from("inventory_missing_review" as never)
        .update({ status: "ignored" } as never)
        .eq("id", r.id);
      if (error) throw error;
      toast({ title: "Marked as ignored", description: r.sku ?? "" });
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const scanNow = async () => {
    setScanning(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("Please log in again before scanning.");

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inventory-review-scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({}),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `Scan failed (${response.status})`);
      const d = (data ?? {}) as { scanned?: number; flagged?: number; new_entries?: number };
      toast({
        title: "Scan complete (read-only)",
        description: `Scanned ${d.scanned ?? 0} SKUs · ${d.flagged ?? 0} flagged · ${d.new_entries ?? 0} new. No inventory was modified.`,
      });
      await load();
    } catch (e) {
      toast({ title: "Scan failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setScanning(false);
    }
  };

  // Hard admin gate — non-admins bounce to home before rendering anything.
  if (isAdmin === false) {
    return <Navigate to="/" replace />;
  }
  if (isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Inventory Review Queue · ArbiPro Seller (Admin)</title>
        <meta name="description" content="Admin-only backend safety queue for genuinely ambiguous inventory cases. Not user-facing." />
      </Helmet>

      <div className="max-w-[1400px] mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Button asChild variant="ghost" size="sm">
                <Link to="/tools/synced-inventory"><ArrowLeft className="h-4 w-4" /> Back to Inventory</Link>
              </Button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-3xl font-bold tracking-tight">Inventory Review Queue</h1>
              <span
                className="inline-flex items-center rounded-full border border-slate-400/40 bg-slate-500/10 text-slate-200 px-3 py-1 text-sm font-semibold"
                title="Admin-only. Regular users never see this. Auto-resolvable cases are already handled by sync-inventory-report (Summaries cross-check → STALE→RESTORED). Only cases where BOTH the FBA Report and Summaries agree the SKU is missing/zero land here."
              >
                Flag: Admin-only — auto-resolves via Summaries cross-check; only ambiguous cases land here
              </span>
            </div>
            <p className="text-muted-foreground">
              Backend safety queue. Populated only when the FBA Report AND live Summaries both fail to confirm a previously-positive SKU. Regular users never see this — auto-resolvable cases are reconciled upstream.
            </p>
            <p className="text-xs text-muted-foreground">
              <strong>Scan Now</strong> is read-only: it detects suspicious SKUs and populates this queue. It does <strong>not</strong> sync or modify inventory.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={scanNow}
              variant="default"
              disabled={scanning || loading}
              title="Read-only: detects suspicious SKUs and populates the queue. Does NOT sync or modify inventory."
            >
              <ScanLine className={`h-4 w-4 ${scanning ? "animate-pulse" : ""}`} />
              {scanning ? "Scanning…" : "Scan Now"}
            </Button>
            <Button onClick={load} variant="outline" disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Needs Review</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{counts.needs_review}</CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Restored</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{counts.restored}</CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Confirmed Zero</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{counts.confirmed_zero}</CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Ignored</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{counts.ignored}</CardContent></Card>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle>{showCleanup ? "Inactive Listing Cleanup" : "Queue"}</CardTitle>
              <div className="flex rounded-md border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowCleanup(false)}
                  className={`px-3 py-1 text-xs ${!showCleanup ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}
                >
                  Real issues
                </button>
                <button
                  type="button"
                  onClick={() => setShowCleanup(true)}
                  className={`px-3 py-1 text-xs ${showCleanup ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}
                >
                  Cleanup ({counts.cleanup})
                </button>
              </div>
              {showCleanup && (
                <span className="text-xs text-muted-foreground">
                  Deleted/inactive listings with leftover stock — typically safe to <strong>Confirm zero</strong>.
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-8 w-64"
                  placeholder="Search SKU / ASIN / marketplace"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as ReviewStatus | "all")}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="needs_review">Needs review</SelectItem>
                  <SelectItem value="restored">Restored</SelectItem>
                  <SelectItem value="confirmed_zero">Confirmed zero</SelectItem>
                  <SelectItem value="ignored">Ignored</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading review queue…
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground">
                Nothing here. The queue is clean.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ASIN</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Market</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead className="text-right">Prior A/R/I</TableHead>
                      <TableHead className="text-right">Current A/R/I</TableHead>
                      <TableHead className="text-right">Units Lost</TableHead>
                      <TableHead>Last Seen Missing</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((r) => {
                      const cur = current[r.sku ?? ""];
                      const lost = valueImpact(r);
                      const isBusy = busyId === r.id;
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="font-mono text-xs">
                            {r.asin ? (
                              <a
                                href={`https://www.amazon.com/dp/${r.asin}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline inline-flex items-center gap-1"
                                title="Open this ASIN on Amazon"
                              >
                                {r.asin}
                                <ExternalLink className="h-3 w-3 shrink-0" />
                              </a>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{r.sku ?? "—"}</TableCell>
                          <TableCell className="text-xs">{r.marketplace ?? "—"}</TableCell>
                          <TableCell className="text-xs max-w-[220px] truncate" title={r.reason ?? ""}>
                            {r.reason ?? "—"}
                            {r.detection_source && (
                              <div className="text-[10px] text-muted-foreground">via {r.detection_source}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {(r.prior_available ?? 0)}/{(r.prior_reserved ?? 0)}/{(r.prior_inbound ?? 0)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {cur ? `${cur.available ?? 0}/${cur.reserved ?? 0}/${cur.inbound ?? 0}` : "—"}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {lost > 0 ? <span className="text-destructive font-semibold">{lost}</span> : 0}
                          </TableCell>
                          <TableCell className="text-xs">{fmtDate(r.last_missing_at)}</TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                            {r.occurrences && r.occurrences > 1 ? (
                              <div className="text-[10px] text-muted-foreground mt-1">×{r.occurrences}</div>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1 flex-wrap">
                              <Button
                                size="sm"
                                variant="default"
                                disabled={isBusy || r.status === "restored"}
                                onClick={() => restore(r)}
                              >
                                Restore
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isBusy || r.status === "confirmed_zero"}
                                onClick={() => confirmZero(r)}
                              >
                                Confirm zero
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={isBusy || r.status === "ignored"}
                                onClick={() => ignore(r)}
                              >
                                Ignore
                              </Button>
                              <Button asChild size="sm" variant="outline">
                                <a
                                  href={sellerCentralSearch(r.sku, r.marketplace)}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="Open in Seller Central"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </a>
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
