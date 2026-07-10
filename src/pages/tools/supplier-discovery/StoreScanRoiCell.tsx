import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { enqueueRoi } from "./roiQueue";
import type { AmazonPresence } from "./useLiveRoi";

/**
 * ROI cell for Store Scan results — DISPLAY-ONLY by default.
 *
 * Previously this auto-fetched live ROI for every visible row, which
 * caused the page to freeze on large result sets. Now it just shows
 * the saved ROI from the scan row, and exposes a tiny refresh button
 * that triggers a single live `calculate-roi` call on demand.
 *
 * The parent can also trigger a bulk refresh via the `refreshKey`
 * prop — bumping that value re-runs the live calculation for this
 * row exactly once.
 */
export type { AmazonPresence };

interface Props {
  asin: string | null;
  cost: number | null;
  marketplace?: string;
  /** Saved ROI from the scan row (DB) — shown until user refreshes. */
  fallbackRoi?: number | null;
  /** Saved Amazon price from the scan row (DB) — for the tooltip. */
  fallbackPrice?: number | null;
  /**
   * Parent-supplied live ROI (from a sibling fetch like self-heal). Takes
   * priority over `fallbackRoi` so the displayed value never lags behind
   * the value the parent uses for filtering. Prevents desync where the
   * cell shows 0.0% (saved) while the filter passes the row using a real
   * live ROI.
   */
  liveRoiOverride?: number | null;
  /** Parent-supplied live Amazon price (paired with liveRoiOverride). */
  livePriceOverride?: number | null;
  /** Bump to force this row to re-fetch live ROI (used for "refresh visible"). */
  refreshKey?: number;
  onRoi?: (roi: number | null) => void;
  onPrice?: (price: number | null) => void;
  onAmazonPresence?: (presence: AmazonPresence | null) => void;
}

interface LiveData {
  roi: number | null;
  price: number | null;
  totalFees: number | null;
  profit: number | null;
  margin: number | null;
}

export function StoreScanRoiCell({
  asin,
  cost,
  marketplace = "US",
  fallbackRoi = null,
  fallbackPrice = null,
  liveRoiOverride = null,
  livePriceOverride = null,
  refreshKey,
  onRoi,
  onPrice,
  onAmazonPresence,
}: Props) {
  const [live, setLive] = useState<LiveData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<number | undefined>(undefined);

  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const runRefresh = useCallback(async () => {
    if (!asin || cost == null || cost <= 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await enqueueRoi(asin, cost, marketplace);
      const calc = data?.calculation;
      if (!calc || data?.price == null || data?.price <= 0) {
        setError("unavailable");
        onAmazonPresence?.((data?.amazonPresence ?? null) as AmazonPresence | null);
        return;
      }
      const next: LiveData = {
        roi: num(calc.roi),
        price: num(data.price),
        totalFees: num(calc.totalFees),
        profit: num(calc.profit),
        margin: num(calc.margin),
      };
      setLive(next);
      onRoi?.(next.roi);
      onPrice?.(next.price);
      onAmazonPresence?.((data.amazonPresence ?? null) as AmazonPresence | null);
    } catch (e) {
      console.warn("[StoreScanRoiCell] refresh failed", { asin, error: e });
      setError(e instanceof Error ? e.message : "unavailable");
    } finally {
      setLoading(false);
    }
  }, [asin, cost, loading, marketplace, onAmazonPresence, onPrice, onRoi]);

  // Parent-driven bulk refresh: bump `refreshKey` to re-fetch.
  useEffect(() => {
    if (refreshKey === undefined || refreshKey === lastKey) return;
    setLastKey(refreshKey);
    // Fire-and-forget — guarded by `loading` inside runRefresh.
    void runRefresh();
  }, [lastKey, refreshKey, runRefresh]);

  if (!asin || cost == null || cost <= 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  // Display priority:
  //   1. Local live fetch (cell pressed ↻ or refreshKey bumped)
  //   2. Parent-supplied override (e.g. self-heal in UserStoreScan)
  //   3. Saved value from scan row
  // This guarantees the displayed ROI never lags behind the value the
  // parent uses to filter, eliminating the "shows 0.0% but passes a 70%
  // gate" desync.
  const displayRoi = live?.roi ?? liveRoiOverride ?? fallbackRoi;
  const displayPrice = live?.price ?? livePriceOverride ?? fallbackPrice;
  const isLive = live !== null || (liveRoiOverride != null && livePriceOverride != null && livePriceOverride > 0);

  const renderValue = () => {
    // While refreshing, keep showing the saved value if we have one — never blank it out.
    if (loading && displayRoi == null) {
      return (
        <span className="inline-flex items-center justify-end gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
        </span>
      );
    }
    if (displayRoi == null) {
      return (
        <span
          className="text-muted-foreground"
          title={error === "unavailable" ? "Live price/fees unavailable from Amazon SP-API" : (error ?? "ROI not calculated yet — click ↻ to fetch")}
        >
          n/a
        </span>
      );
    }
    const tone = displayRoi > 30 ? "text-success" : displayRoi > 0 ? "" : "text-destructive";
    return (
      <span
        className={tone}
        title={
          isLive
            ? `LIVE\nAmazon: $${displayPrice?.toFixed(2) ?? "?"}\nCost: $${cost.toFixed(2)}\nFees: $${live?.totalFees?.toFixed(2) ?? "?"}\nProfit: $${live?.profit?.toFixed(2) ?? "?"}\nMargin: ${live?.margin?.toFixed(1) ?? "?"}%`
            : `Saved ROI from scan (click ↻ to refresh live)\nAmazon: $${displayPrice?.toFixed(2) ?? "?"}\nCost: $${cost.toFixed(2)}`
        }
      >
        {displayRoi.toFixed(1)}%
        {!isLive && displayRoi != null && <span className="ml-0.5 text-[9px] text-muted-foreground">·s</span>}
      </span>
    );
  };

  return (
    <span className="inline-flex items-center justify-end gap-1">
      {renderValue()}
    </span>
  );
}
