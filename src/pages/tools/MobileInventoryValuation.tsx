import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { useAuth } from "@/contexts/AuthContext";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, RefreshCw, Warehouse } from "lucide-react";
import {
  getInventoryValuationTotals,
  triggerInventoryValuationRefresh,
  getProjectedValuationMetrics,
  type ProjectedValuationMetrics,
} from "@/lib/inventory-valuation";

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
  const [totals, setTotals] = useState<Totals | null>(null);
  const [projected, setProjected] = useState<ProjectedValuationMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string>("");

  const fetchTotals = useCallback(async (opts?: { force?: boolean }) => {
    if (!user?.id) return;
    setLoading(true);
    if (opts?.force) {
      // Kick the server writer; lock inside the edge fn coalesces concurrent
      // refreshes from multiple tabs into a single recompute.
      await triggerInventoryValuationRefresh();
    }
    const [valuation, projectedMetrics] = await Promise.all([
      getInventoryValuationTotals(user.id),
      getProjectedValuationMetrics(user.id),
    ]);
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
    setProjected(projectedMetrics);
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

  const fmtMoney = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

        {/* Projected Sale, Profit & ROI — if all current stock sold at today's live price */}
        <section className="rounded-2xl bg-white/[0.04] border border-white/10 p-4">
          <div className="text-[10px] uppercase tracking-wider font-bold text-white/50 mb-3">
            Projected (at today's price)
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="text-center">
              <div className="text-[9px] uppercase tracking-wide text-white/40">Sale</div>
              {loading && !projected ? (
                <Skeleton className="h-6 w-16 mt-1 mx-auto bg-white/10" />
              ) : (
                <div className="text-lg font-bold tabular-nums mt-0.5">
                  {homeCurrencySymbol}{fmtMoney(projected?.projectedSale ?? 0)}
                </div>
              )}
            </div>
            <div className="text-center">
              <div className="text-[9px] uppercase tracking-wide text-white/40">Profit</div>
              {loading && !projected ? (
                <Skeleton className="h-6 w-16 mt-1 mx-auto bg-white/10" />
              ) : (
                <div className={`text-lg font-bold tabular-nums mt-0.5 ${
                  projected?.projectedProfit != null && projected.projectedProfit >= 0
                    ? "text-emerald-300"
                    : projected?.projectedProfit != null
                      ? "text-red-300"
                      : ""
                }`}>
                  {projected?.projectedProfit != null ? `${homeCurrencySymbol}${fmtMoney(projected.projectedProfit)}` : "—"}
                </div>
              )}
            </div>
            <div className="text-center">
              <div className="text-[9px] uppercase tracking-wide text-white/40">ROI</div>
              {loading && !projected ? (
                <Skeleton className="h-6 w-16 mt-1 mx-auto bg-white/10" />
              ) : (
                <div className={`text-lg font-bold tabular-nums mt-0.5 ${
                  projected?.projectedRoi != null && projected.projectedRoi >= 30
                    ? "text-emerald-300"
                    : projected?.projectedRoi != null && projected.projectedRoi < 0
                      ? "text-red-300"
                      : ""
                }`}>
                  {projected?.projectedRoi != null ? `${projected.projectedRoi.toFixed(0)}%` : "—"}
                </div>
              )}
            </div>
          </div>
          {projected && projected.itemsWithRoi > 0 && projected.itemsWithCachedFees < projected.itemsWithRoi && (
            <div className="mt-2 text-[10px] text-white/40 text-center">
              {projected.itemsWithCachedFees} of {projected.itemsWithRoi} items use actual fees, rest estimated at 15%
            </div>
          )}
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
