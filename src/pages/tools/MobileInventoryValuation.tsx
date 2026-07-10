import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { useAuth } from "@/contexts/AuthContext";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, RefreshCw, Warehouse, Zap } from "lucide-react";
import { getInventoryValuationTotals, triggerInventoryValuationRefresh } from "@/lib/inventory-valuation";
import { supabase } from "@/integrations/supabase/client";
import { useSubscription } from "@/hooks/use-subscription";
import { useToast } from "@/hooks/use-toast";

interface Totals {
  value: number;
  units: number;
  skus: number;
  available: number;
  reserved: number;
  inbound: number;
  unfulfilled: number;
  availableValue: number;
  reservedValue: number;
  inboundValue: number;
  unfulfilledValue: number;
}

const MobileInventoryValuation = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { homeCurrencySymbol } = useHomeMarketplace();
  const { isAdmin } = useSubscription();
  const { toast } = useToast();
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [liveUpdateInProgress, setLiveUpdateInProgress] = useState(false);
  const [liveUpdateProgress, setLiveUpdateProgress] = useState<string | null>(null);

  const fetchTotals = useCallback(async (opts?: { force?: boolean }) => {
    if (!user?.id) return;
    setLoading(true);
    if (opts?.force) {
      // Kick the server writer; lock inside the edge fn coalesces concurrent
      // refreshes from multiple tabs into a single recompute.
      await triggerInventoryValuationRefresh();
    }
    const valuation = await getInventoryValuationTotals(user.id);
    setTotals({
      value: Math.round(valuation.value * 100) / 100,
      units: valuation.units,
      skus: valuation.skus,
      available: valuation.available,
      reserved: valuation.reserved,
      inbound: valuation.inbound,
      unfulfilled: valuation.unfulfilled,
      availableValue: Math.round(valuation.availableValue * 100) / 100,
      reservedValue: Math.round(valuation.reservedValue * 100) / 100,
      inboundValue: Math.round(valuation.inboundValue * 100) / 100,
      unfulfilledValue: Math.round(valuation.unfulfilledValue * 100) / 100,
    });
    setUpdatedAt(
      new Date().toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
    );
    setLoading(false);
  }, [user?.id]);

  useEffect(() => {
    void fetchTotals();
    // 15-minute refresh, paused while tab is hidden/backgrounded.
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchTotals();
    }, 15 * 60_000);
    return () => clearInterval(id);
  }, [fetchTotals]);

  // NOTE: The automatic 2-hour admin SP-API refresh has been removed.
  // Admins can still trigger a full refresh manually via the
  // "Manual SP-API Refresh" button below.

  const fmtMoney = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleLiveUpdateAll = async () => {
    if (!user) return;
    setLiveUpdateInProgress(true);
    setLiveUpdateProgress('Preparing live update...');

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ variant: "destructive", title: "Please log in first" });
        return;
      }

      // Paginate to bypass Supabase's 1000-row default limit
      const PAGE = 1000;
      const rows: any[] = [];
      for (let from = 0; from < 100000; from += PAGE) {
        const { data: chunk, error: invErr } = await supabase
          .from('inventory')
          .select('asin, sku, available, reserved, inbound, listing_status, source')
          .eq('user_id', user.id)
          .range(from, from + PAGE - 1);
        if (invErr) throw invErr;
        if (!chunk || chunk.length === 0) break;
        rows.push(...chunk);
        if (chunk.length < PAGE) break;
      }

      const itemsToUpdate = Array.from(
        new Map(
          (rows ?? [])
            .filter((item: any) => {
              const listingStatus = (item.listing_status || '').toUpperCase();
              return item.source !== 'created_listing' && listingStatus !== 'DELETED' && item.asin && item.sku;
            })
            .map((item: any) => [`${item.asin}::${item.sku}`, item])
        ).values()
      ) as any[];

      if (itemsToUpdate.length === 0) {
        toast({ title: "Nothing to update", description: "No synced Amazon SKUs found." });
        return;
      }

      let checked = 0;
      let updated = 0;
      let verifiedUnchanged = 0;
      let unresolved = 0;
      let errors = 0;
      let currentToken = session.access_token;
      let lastTokenRefresh = Date.now();

      for (const item of itemsToUpdate) {
        checked += 1;
        setLiveUpdateProgress(`Checking ${checked}/${itemsToUpdate.length}: ${item.sku}`);

        if (Date.now() - lastTokenRefresh > 3 * 60 * 1000) {
          try {
            const { data: refreshed } = await supabase.auth.getSession();
            if (refreshed?.session?.access_token) {
              currentToken = refreshed.session.access_token;
              lastTokenRefresh = Date.now();
            }
          } catch {
            // continue with current token
          }
        }

        try {
          const before = {
            available: item.available ?? 0,
            reserved: item.reserved ?? 0,
            inbound: item.inbound ?? 0,
          };

          const { data: result, error: rescueError } = await supabase.functions.invoke('rescue-inventory-asin', {
            headers: { Authorization: `Bearer ${currentToken}` },
            body: { asin: item.asin, sku: item.sku },
          });

          if (rescueError) {
            errors += 1;
          } else {
            const after = (result as any)?.updated_db || (result as any)?.live_stock;
            const changed =
              (after?.available ?? 0) !== before.available ||
              (after?.reserved ?? 0) !== before.reserved ||
              (after?.inbound ?? 0) !== before.inbound;

            if ((result as any)?.verification_status === 'corrected' || changed) {
              updated += 1;
            } else if ((result as any)?.verification_status === 'verified_unchanged') {
              verifiedUnchanged += 1;
            } else {
              unresolved += 1;
            }
          }
        } catch {
          errors += 1;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      toast({
        title: "Live update complete",
        description: `Checked ${checked} items: ${updated} corrected, ${verifiedUnchanged} verified unchanged, ${unresolved} unresolved${errors > 0 ? `, ${errors} errors` : ''}`,
      });

      await fetchTotals();
    } catch (err: any) {
      console.error("Live update error:", err);
      toast({ variant: "destructive", title: "Live update failed", description: err?.message || "Unknown error" });
    } finally {
      setLiveUpdateInProgress(false);
      setLiveUpdateProgress(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f1c3f] text-white">
      <Helmet>
        <title>Inventory Valuation — Live Totals</title>
        <meta name="description" content="Live inventory valuation totals on mobile." />
      </Helmet>

      <header className="sticky top-0 z-20 backdrop-blur bg-[#0f1c3f]/85 border-b border-white/10 px-4 py-3 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-white hover:bg-white/10 shrink-0"
          onClick={() => navigate("/tools")}
          aria-label="Back to tools"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2 min-w-0">
          <Warehouse className="h-5 w-5 text-amber-300" />
          <h1 className="text-base font-semibold truncate">Inventory Valuation</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-9 w-9 text-white hover:bg-white/10"
          onClick={() => void fetchTotals({ force: true })}
          disabled={loading}
          aria-label="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </header>

      <main className="px-4 pb-24 pt-5 max-w-md mx-auto space-y-4">
        {isAdmin && (
          <Button
            onClick={handleLiveUpdateAll}
            disabled={liveUpdateInProgress || !user}
            variant="outline"
            className="w-full gap-2 border-cyan-500/50 hover:bg-cyan-500/10 text-cyan-300 bg-cyan-500/5"
          >
            {liveUpdateInProgress ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span className="text-xs truncate">{liveUpdateProgress || 'Updating...'}</span>
              </>
            ) : (
              <>
                <Zap className="h-4 w-4" />
                Manual SP-API Refresh
              </>
            )}
          </Button>
        )}
        {/* Hero: Total Value */}
        <section className="rounded-2xl bg-gradient-to-br from-amber-500/15 via-amber-500/5 to-transparent border border-amber-400/25 p-5 shadow-lg shadow-amber-500/5">
          <div className="text-[10px] uppercase tracking-wider font-bold text-amber-300/90">
            Total Inventory Value
          </div>
          {loading && !totals ? (
            <Skeleton className="h-12 w-44 mt-2 bg-white/10" />
          ) : (
            <div className="text-4xl font-extrabold tabular-nums tracking-tight mt-1">
              {homeCurrencySymbol}{fmtMoney(totals?.value ?? 0)}
            </div>
          )}
          <div className="mt-1 text-[11px] text-white/55">
            Available + Reserved + Inbound + Unfulfilled × unit cost
            {updatedAt ? ` · Updated ${updatedAt}` : ""}
          </div>
        </section>

        {/* Units + SKUs */}
        <section className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-white/[0.04] border border-white/10 p-4">
            <div className="text-[10px] uppercase tracking-wider font-bold text-white/50">Units On-Hand</div>
            {loading && !totals ? (
              <Skeleton className="h-7 w-20 mt-2 bg-white/10" />
            ) : (
              <div className="text-2xl font-bold tabular-nums mt-1">
                {(totals?.units ?? 0).toLocaleString()}
              </div>
            )}
          </div>
          <div className="rounded-2xl bg-white/[0.04] border border-white/10 p-4">
            <div className="text-[10px] uppercase tracking-wider font-bold text-white/50">Active SKUs</div>
            {loading && !totals ? (
              <Skeleton className="h-7 w-20 mt-2 bg-white/10" />
            ) : (
              <div className="text-2xl font-bold tabular-nums mt-1">
                {(totals?.skus ?? 0).toLocaleString()}
              </div>
            )}
          </div>
        </section>

        {/* Breakdown */}
        <section className="rounded-2xl bg-white/[0.04] border border-white/10 p-4">
          <div className="text-[10px] uppercase tracking-wider font-bold text-white/50 mb-3">
            Stock Breakdown
          </div>
          <div className="space-y-2.5">
            <Row label="Available" units={totals?.available} value={totals?.availableValue} symbol={homeCurrencySymbol} loading={loading && !totals} color="text-emerald-300" />
            <Row label="Reserved (Customer Orders)" units={totals?.reserved} value={totals?.reservedValue} symbol={homeCurrencySymbol} loading={loading && !totals} color="text-blue-300" />
            <Row label="Inbound" units={totals?.inbound} value={totals?.inboundValue} symbol={homeCurrencySymbol} loading={loading && !totals} color="text-amber-300" />
            {(totals?.unfulfilled ?? 0) > 0 && (
              <>
                <div className="border-t border-white/10 my-2" />
                <Row label="Unfulfilled" units={totals?.unfulfilled} value={totals?.unfulfilledValue} symbol={homeCurrencySymbol} loading={loading && !totals} color="text-white/50" />
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

const Row = ({
  label, units, value, symbol, loading, color,
}: { label: string; units: number | undefined; value: number | undefined; symbol: string; loading: boolean; color: string }) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-sm text-white/75 shrink-0">{label}</span>
    {loading ? (
      <Skeleton className="h-4 w-24 bg-white/10" />
    ) : (
      <div className="text-right">
        <div className={`text-sm font-bold tabular-nums ${color}`}>
          {(units ?? 0).toLocaleString()} <span className="text-white/40 font-normal">units</span>
        </div>
        <div className="text-[11px] text-white/55 tabular-nums">
          {symbol}{(value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>
    )}
  </div>
);

export default MobileInventoryValuation;
