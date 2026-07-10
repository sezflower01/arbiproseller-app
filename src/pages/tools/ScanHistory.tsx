import { useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ScanLine,
  Search,
  Package,
  Trash2,
  ExternalLink,
  RotateCw,
  Smartphone,
} from "lucide-react";
import { toast } from "sonner";

interface ScanRow {
  id: string;
  barcode: string;
  barcode_format: string | null;
  asin: string | null;
  title: string | null;
  image_url: string | null;
  brand: string | null;
  price: number | null;
  currency: string | null;
  marketplace: string | null;
  created_at: string;
}

const formatPrice = (price: number | null, currency: string | null) => {
  if (price == null) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(price);
  } catch {
    return `$${price.toFixed(2)}`;
  }
};

const formatTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

export default function ScanHistory() {
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("mobile_scan_history")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      setRows((data || []) as ScanRow[]);
    } catch (e: any) {
      console.error("[scan-history] load failed", e);
      toast.error("Failed to load scan history");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!authLoading && user) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.barcode, r.asin, r.title, r.brand]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [rows, search]);

  const deleteScan = async (id: string) => {
    try {
      const { error } = await supabase.from("mobile_scan_history").delete().eq("id", id);
      if (error) throw error;
      setRows((prev) => prev.filter((r) => r.id !== id));
      toast.success("Scan deleted");
    } catch (e) {
      toast.error("Delete failed");
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]">
      <Helmet>
        <title>Scan History | ArbiProSeller</title>
        <meta name="description" content="All barcodes you scanned from the mobile UPC scanner." />
      </Helmet>

      <Navbar />

      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4 max-w-6xl">
          {/* Header */}
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-blue-500/20 border border-blue-400/30 text-blue-300">
              <ScanLine className="h-6 w-6" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold text-white">Scan History</h1>
              <p className="text-sm text-white/60">
                Every UPC/EAN you scanned from the mobile scanner.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={load}
              disabled={loading}
              className="border-white/15 text-white hover:bg-white/5"
            >
              <RotateCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Link to="/m/scan">
              <Button className="bg-blue-500 hover:bg-blue-600 text-white">
                <Smartphone className="h-4 w-4 mr-2" />
                Open Mobile Scanner
              </Button>
            </Link>
          </div>

          {/* Search */}
          <div className="relative mb-4 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
            <Input
              placeholder="Search barcode, ASIN, title or brand…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-white/5 border-white/15 text-white placeholder:text-white/40"
            />
          </div>

          {/* Table */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white/[0.04] border-b border-white/10 text-white/60 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Product</th>
                    <th className="text-left px-4 py-3 font-medium">Barcode</th>
                    <th className="text-left px-4 py-3 font-medium">ASIN</th>
                    <th className="text-right px-4 py-3 font-medium">Price</th>
                    <th className="text-left px-4 py-3 font-medium">Scanned</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="px-4 py-3">
                          <Skeleton className="h-12 w-full bg-white/5" />
                        </td>
                        <td colSpan={5} className="px-4 py-3">
                          <Skeleton className="h-12 w-full bg-white/5" />
                        </td>
                      </tr>
                    ))
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-16 text-center">
                        <Package className="h-10 w-10 mx-auto mb-3 text-white/30" />
                        <div className="text-white/60 text-sm">
                          {rows.length === 0
                            ? "No scans yet. Open the mobile scanner to start scanning UPCs."
                            : "No scans match your search."}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filtered.map((row) => (
                      <tr
                        key={row.id}
                        className="border-b border-white/5 hover:bg-white/[0.04] transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="h-12 w-12 min-w-12 rounded-md overflow-hidden bg-white/10 flex items-center justify-center">
                              {row.image_url ? (
                                <img
                                  src={row.image_url}
                                  alt={row.title || row.barcode}
                                  className="h-full w-full object-cover"
                                  loading="lazy"
                                />
                              ) : (
                                <Package className="h-5 w-5 text-white/40" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="text-white text-sm font-medium truncate max-w-[280px]">
                                {row.title || "(no Amazon match)"}
                              </div>
                              {row.brand && (
                                <div className="text-xs text-white/50 truncate">
                                  {row.brand}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-white/80">
                          {row.barcode}
                          {row.barcode_format && (
                            <div className="text-[10px] text-white/40 mt-0.5">
                              {row.barcode_format}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {row.asin ? (
                            <a
                              href={`https://www.amazon.com/dp/${row.asin}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-xs text-emerald-300 hover:text-emerald-200 inline-flex items-center gap-1"
                            >
                              {row.asin}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-white/30 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-white font-medium">
                          {formatPrice(row.price, row.currency)}
                        </td>
                        <td className="px-4 py-3 text-white/60 text-xs">
                          {formatTime(row.created_at)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteScan(row.id)}
                            className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                            aria-label="Delete scan"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {!loading && rows.length > 0 && (
            <div className="mt-3 text-xs text-white/40 text-right">
              Showing {filtered.length} of {rows.length} scans
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
