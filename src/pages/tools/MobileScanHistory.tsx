import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Package, RotateCw, ChevronRight, History as HistoryIcon, ScanLine } from "lucide-react";

interface ScanRow {
  id: string;
  barcode: string;
  asin: string | null;
  title: string | null;
  image_url: string | null;
  price: number | null;
  currency: string | null;
  created_at: string;
}

const formatPrice = (price: number | null, currency: string | null) => {
  if (price == null) return "—";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(price); }
  catch { return `$${price.toFixed(2)}`; }
};
const formatTime = (iso: string) => {
  try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return iso; }
};

export default function MobileScanHistory() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [history, setHistory] = useState<ScanRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) navigate("/login", { replace: true });
  }, [authLoading, user, navigate]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("mobile_scan_history")
        .select("id, barcode, asin, title, image_url, price, currency, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      setHistory((data || []) as ScanRow[]);
    } catch (e) {
      console.error("[mobile-scan-history] load failed", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] text-white">
      <Helmet>
        <title>Scan History | ArbiProSeller Mobile</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
      </Helmet>

      <header className="sticky top-0 z-20 backdrop-blur-md bg-black/40 border-b border-white/10">
        <div className="flex items-center gap-2 px-4 py-3">
          <button onClick={() => navigate("/m/scan")} className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/5 border border-white/10" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex-1">
            <h1 className="text-base font-semibold leading-none flex items-center gap-2"><HistoryIcon className="h-4 w-4 text-white/60" /> Scan History</h1>
            <p className="text-[11px] text-white/50 mt-0.5">{history.length} scans</p>
          </div>
          <button
            onClick={() => navigate("/m/scan")}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-500/15 border border-emerald-400/40 text-emerald-200 text-[11px] font-semibold hover:bg-emerald-500/25 transition-colors"
            aria-label="Scan again"
          >
            <ScanLine className="h-4 w-4" />
            Scan
          </button>
          <button onClick={load} className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/5 border border-white/10" aria-label="Refresh">
            <RotateCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="px-4 pt-4 pb-24 max-w-md mx-auto">
        {loading ? (
          <div className="space-y-2">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16 w-full bg-white/5" />)}</div>
        ) : history.length === 0 ? (
          <div className="text-center py-16 text-white/40">
            <Package className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <div className="text-sm">No scans yet.</div>
            <button onClick={() => navigate("/m/scan")} className="mt-4 inline-flex items-center gap-2 px-4 h-10 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium">
              <ScanLine className="h-4 w-4" /> Start scanning
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {history.map((row) => (
              <li key={row.id}>
                <button
                  onClick={() => navigate(`/m/scan/${row.id}`)}
                  className="w-full flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/10 hover:border-emerald-400/40 active:scale-[0.99] transition text-left"
                >
                  <div className="h-12 w-12 min-w-12 rounded-md overflow-hidden bg-white/10 flex items-center justify-center">
                    {row.image_url ? <img src={row.image_url} alt={row.title || row.barcode} className="h-full w-full object-cover" loading="lazy" /> : <Package className="h-5 w-5 text-white/40" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-white truncate">{row.title || "(no match)"}</div>
                    <div className="text-[10px] text-white/50 mt-0.5 flex items-center gap-1.5">
                      <span className="font-mono">{row.barcode}</span>
                      {row.asin && <><span>·</span><span className="font-mono text-emerald-300/80">{row.asin}</span></>}
                    </div>
                    <div className="text-[10px] text-white/40 mt-0.5">{formatTime(row.created_at)}</div>
                  </div>
                  <div className="text-right flex items-center gap-1">
                    <div className="text-sm font-semibold text-emerald-300">{formatPrice(row.price, row.currency)}</div>
                    <ChevronRight className="h-4 w-4 text-white/40" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
