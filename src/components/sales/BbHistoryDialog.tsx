import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, History } from "lucide-react";

/**
 * Read-only "Pedu BB History" popup for a Sales Report row.
 *
 * Shows recent repricer_competitor_snapshots around the order time for the
 * given (asin, marketplace), so the user can audit:
 *   - Was Pedu owning the Buy Box near the order time?
 *   - What was the BB price?
 *   - Did the BB change just before/after the order?
 *
 * Does NOT change pricing, repricer, or sales calculations.
 */

const MARKETPLACE_CODE_TO_ID: Record<string, string> = {
  US: "ATVPDKIKX0DER",
  CA: "A2EUQ1WTGCTBG2",
  MX: "A1AM78C64UM0Y8",
  BR: "A2Q3Y263D00KWC",
};

interface Snapshot {
  id: string;
  fetched_at: string;
  buybox_price: number | null;
  buybox_is_fba: boolean | null;
  buybox_seller_id: string | null;
  buybox_seller_name: string | null;
  lowest_fba_price: number | null;
  lowest_fbm_price: number | null;
  source: string | null;
  offers_json?: Array<Record<string, unknown>> | null;
}

interface OrderBbRow {
  order_id: string | null;
  order_date: string | null;
  purchase_timestamp_utc: string | null;
  fulfillment_channel: string | null;
  bb_estimate_qualified: boolean | null;
  bb_estimate_owner_match: boolean | null;
  bb_estimate_price: number | null;
  bb_estimate_captured_at: string | null;
  bb_estimate_snapshot_age_seconds: number | null;
  bb_estimate_snapshot_fetched_at: string | null;
  bb_estimate_buybox_is_fba: boolean | null;
  bb_estimate_marketplace: string | null;
  bb_estimate_snapshot_id: string | null;
  price_source: string | null;
  price_confidence: string | null;
  sold_price: number | null;
  estimated_price: number | null;
}

// Backend Phase 2 freshness window (must mirror _shared/bbOwnEstimate.ts).
const FRESHNESS_WINDOW_SECONDS = 2 * 60 * 60;

type PromotionStatus =
  | { kind: "promoted"; label: string; tone: "emerald" }
  | { kind: "confirmed"; label: string; tone: "sky" }
  | { kind: "not_promoted"; label: string; tone: "amber" };

function derivePromotion(o: OrderBbRow): PromotionStatus {
  const confirmed =
    o.price_confidence === "CONFIRMED" ||
    (typeof o.sold_price === "number" && o.sold_price > 0);
  if (confirmed) {
    return { kind: "confirmed", label: "Confirmed — BB ignored", tone: "sky" };
  }
  if (o.price_source === "closest_bb_order_discovery") {
    return { kind: "promoted", label: "Promoted to pending estimate", tone: "emerald" };
  }
  return { kind: "not_promoted", label: "Not promoted", tone: "amber" };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  asin: string;
  marketplace: string; // 2-letter code (US/CA/MX/BR/...)
  referenceTimestampUtc: string | null; // latest purchase time for the row
}

function fmtAge(orderMs: number, snapMs: number): string {
  const diffSec = Math.round((orderMs - snapMs) / 1000);
  const abs = Math.abs(diffSec);
  const sign = diffSec >= 0 ? "before" : "after";
  if (abs < 60) return `${abs}s ${sign}`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ${sign}`;
  return `${(abs / 3600).toFixed(1)}h ${sign}`;
}

function fmtSignedAgeSeconds(ageSec: number): string {
  const abs = Math.abs(ageSec);
  const sign = ageSec >= 0 ? "before" : "after";
  if (abs < 60) return `${abs}s ${sign}`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ${sign}`;
  return `${(abs / 3600).toFixed(1)}h ${sign}`;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return iso; }
}

function getOrderTimeMs(o: OrderBbRow): number {
  const iso = o.purchase_timestamp_utc || o.order_date;
  return iso ? new Date(iso).getTime() : NaN;
}

function getEffectiveAgeSec(o: OrderBbRow): number | null {
  if (o.bb_estimate_snapshot_fetched_at) {
    const orderMs = getOrderTimeMs(o);
    const snapMs = new Date(o.bb_estimate_snapshot_fetched_at).getTime();
    if (Number.isFinite(orderMs) && Number.isFinite(snapMs)) {
      return Math.round((orderMs - snapMs) / 1000);
    }
  }
  return typeof o.bb_estimate_snapshot_age_seconds === "number" ? o.bb_estimate_snapshot_age_seconds : null;
}

function marketBbPrice(o: OrderBbRow, snapshotLookup?: Map<string, Snapshot>): string | null {
  const snap = o.bb_estimate_snapshot_id ? snapshotLookup?.get(o.bb_estimate_snapshot_id) : null;
  const price = typeof snap?.buybox_price === "number" && snap.buybox_price > 0
    ? snap.buybox_price
    : typeof o.bb_estimate_price === "number" && o.bb_estimate_price > 0
      ? o.bb_estimate_price
      : null;
  return typeof price === "number" ? `$${price.toFixed(2)}` : null;
}

function formatBbSeller(s: Snapshot, ownSellerId: string | null): string {
  if (ownSellerId && s.buybox_seller_id === ownSellerId) return "Pedu";
  const name = (s.buybox_seller_name || "").trim();
  if (name && name !== "FBA" && name !== "FBM") return name;
  return s.buybox_seller_id ? "Other seller" : "—";
}

function positiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ownFeaturedOffer(s: Snapshot, ownSellerId: string | null): { price: number | null; isFba: boolean | null } | null {
  if (!ownSellerId || !Array.isArray(s.offers_json)) return null;
  const offer = s.offers_json.find((o) =>
    o?.seller_id === ownSellerId && (o?.is_buybox_winner === true || o?.is_buybox_winner === "true")
  );
  if (!offer) return null;
  const price = positiveNumber(offer.total_price) ?? positiveNumber(offer.price);
  const isFba = offer.is_fba === true || offer.is_fba === "true" ? true : offer.is_fba === false || offer.is_fba === "false" ? false : null;
  return { price, isFba };
}

function deriveReason(o: OrderBbRow, ownSellerId: string | null, snapshotLookup: Map<string, Snapshot>): string {
  // Already confirmed by Amazon/FEC — BB is ignored regardless of qualification.
  const confirmed =
    o.price_confidence === "CONFIRMED" ||
    (typeof o.sold_price === "number" && o.sold_price > 0);
  if (confirmed) return "Already confirmed by Amazon/FEC — BB ignored";

  if (o.bb_estimate_qualified === true) return "Qualified ✓ (closest snapshot within ±2h, Pedu-owned, fulfillment match)";
  if (o.bb_estimate_captured_at == null) return "Not captured (order pre-dates this metric, or capture skipped)";
  if (o.bb_estimate_snapshot_id == null) return "No snapshot within ±2h of order discovery";

  // Freshness check first — uses backend ±2h window.
  const ageSec = getEffectiveAgeSec(o);
  if (typeof ageSec === "number" && Math.abs(ageSec) > FRESHNESS_WINDOW_SECONDS) {
    const mins = Math.round(Math.abs(ageSec) / 60);
    const side = ageSec >= 0 ? "before" : "after";
    return `No snapshot within ±2h (closest was ${mins}m ${side} order)`;
  }

  if (o.bb_estimate_owner_match === false) {
    const price = marketBbPrice(o, snapshotLookup);
    return ownSellerId
      ? `Not Pedu — Buy Box${price ? ` was ${price}` : ""} held by a different seller`
      : "Owner match unknown — no active seller authorization on file";
  }

  // Fulfillment mismatch
  const fc = (o.fulfillment_channel || "").toUpperCase();
  const orderIsFba = fc === "AFN" || fc === "FBA" || fc === "AMAZON";
  const orderIsFbm = fc === "MFN" || fc === "FBM" || fc === "MERCHANT";
  if (orderIsFba && o.bb_estimate_buybox_is_fba === false) return "Fulfillment mismatch — order is FBA, BB was FBM";
  if (orderIsFbm && o.bb_estimate_buybox_is_fba === true) return "Fulfillment mismatch — order is FBM, BB was FBA";
  if (!orderIsFba && !orderIsFbm) return "Order fulfillment channel unknown — disqualified";
  // Backend gates bb_estimate_price on qualified=true. If we got here, the row
  // is unqualified for an unknown reason but owner+fulfillment+freshness all
  // passed. Look at the raw snapshot to distinguish a missing Pedu featured
  // offer from a backend-hidden price.
  const snap = o.bb_estimate_snapshot_id ? snapshotLookup.get(o.bb_estimate_snapshot_id) : null;
  const own = snap ? ownFeaturedOffer(snap, ownSellerId) : null;
  if (own?.price && own.price > 0) {
    return `Snapshot has Pedu featured offer at $${own.price.toFixed(2)} — backend hid it (qualified=false)`;
  }
  if (snap && ownSellerId) return "Pedu not present as a featured offer in snapshot";
  if (!o.bb_estimate_price || o.bb_estimate_price <= 0) return "Snapshot had no Buy Box price";
  return "Disqualified (see fields)";
}

export default function BbHistoryDialog({
  open, onOpenChange, userId, asin, marketplace, referenceTimestampUtc,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [orderRows, setOrderRows] = useState<OrderBbRow[]>([]);
  const [ownSellerId, setOwnSellerId] = useState<string | null>(null);

  const orderMs = useMemo(
    () => (referenceTimestampUtc ? new Date(referenceTimestampUtc).getTime() : NaN),
    [referenceTimestampUtc],
  );

  const snapshotLookup = useMemo(() => new Map(snapshots.map((s) => [s.id, s])), [snapshots]);

  useEffect(() => {
    if (!open || !userId || !asin || !marketplace) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSnapshots([]);
    setOrderRows([]);
    setOwnSellerId(null);

    (async () => {
      try {
        // Window: ±6h around the order, or last 24h if no order time.
        let startIso: string;
        let endIso: string;
        if (Number.isFinite(orderMs)) {
          startIso = new Date(orderMs - 6 * 3600 * 1000).toISOString();
          endIso = new Date(orderMs + 6 * 3600 * 1000).toISOString();
        } else {
          endIso = new Date().toISOString();
          startIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        }

        // Wider window for order-level Phase 1 tracking — show every order
        // for this ASIN/marketplace in the last 30 days, so the user sees
        // Phase 1 capture results even for orders outside the ±6h snapshot window.
        const ordersStartIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

        const mpId = MARKETPLACE_CODE_TO_ID[marketplace];
        const [snapsRes, sellerRes, ordersRes] = await Promise.all([
          supabase
            .from("repricer_competitor_snapshots")
            .select("id, fetched_at, buybox_price, buybox_is_fba, buybox_seller_id, buybox_seller_name, lowest_fba_price, lowest_fbm_price, source, offers_json")
            .eq("user_id", userId)
            .eq("asin", asin)
            .eq("marketplace", marketplace)
            .gte("fetched_at", startIso)
            .lte("fetched_at", endIso)
            .order("fetched_at", { ascending: false })
            .limit(200),
          mpId
            ? supabase
                .from("seller_authorizations")
                .select("seller_id")
                .eq("user_id", userId)
                .eq("marketplace_id", mpId)
                .eq("is_active", true)
                .order("updated_at", { ascending: false })
                .limit(1)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null } as any),
          supabase
            .from("sales_orders")
            .select("order_id, order_date, purchase_timestamp_utc, fulfillment_channel, bb_estimate_qualified, bb_estimate_owner_match, bb_estimate_price, bb_estimate_captured_at, bb_estimate_snapshot_age_seconds, bb_estimate_snapshot_fetched_at, bb_estimate_buybox_is_fba, bb_estimate_marketplace, bb_estimate_snapshot_id, price_source, price_confidence, sold_price, estimated_price")
            .eq("user_id", userId)
            .eq("asin", asin)
            .eq("marketplace", marketplace)
            .gte("order_date", ordersStartIso)
            .not("order_id", "like", "%-REFUND")
            .order("order_date", { ascending: false })
            .limit(50),
        ]);

        if (cancelled) return;
        if (snapsRes.error) throw snapsRes.error;
        if (ordersRes.error) throw ordersRes.error;
        setSnapshots((snapsRes.data || []) as Snapshot[]);
        setOrderRows((ordersRes.data || []) as OrderBbRow[]);
        setOwnSellerId(((sellerRes as any)?.data?.seller_id) ?? null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load BB history");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, userId, asin, marketplace, orderMs]);

  // Identify nearest-before and nearest-after the order time.
  const { nearestBeforeId, nearestAfterId } = useMemo(() => {
    if (!Number.isFinite(orderMs)) return { nearestBeforeId: null, nearestAfterId: null };
    let before: Snapshot | null = null;
    let after: Snapshot | null = null;
    for (const s of snapshots) {
      const t = new Date(s.fetched_at).getTime();
      if (t <= orderMs) {
        if (!before || t > new Date(before.fetched_at).getTime()) before = s;
      } else {
        if (!after || t < new Date(after.fetched_at).getTime()) after = s;
      }
    }
    return { nearestBeforeId: before?.id ?? null, nearestAfterId: after?.id ?? null };
  }, [snapshots, orderMs]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            Closest BB at Order Discovery — {asin} ({marketplace})
          </DialogTitle>
          <DialogDescription>
            Read-only audit. Shows the closest Buy Box snapshot captured when this order was first discovered by our system.
            Amazon's Orders API typically reveals new orders 60–120 minutes after the actual purchase, so this is the nearest
            observable market state — not the price at the exact moment of sale. Does not change pricing or sales calculations.
            {referenceTimestampUtc && (
              <span className="block mt-1 text-xs">
                Order time reported by Amazon (UTC): <span className="font-mono">{fmtTime(referenceTimestampUtc)}</span>
              </span>
            )}
            {!ownSellerId && (
              <span className="block mt-1 text-xs text-amber-500">
                No active seller authorization found for {marketplace}; ownership match cannot be computed.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading snapshots…
          </div>
        )}
        {error && (
          <div className="text-sm text-destructive py-4">{error}</div>
        )}
        {!loading && !error && (
          <div className="border border-border rounded-md">
            <div className="px-3 py-2 bg-muted/30 border-b border-border flex items-center justify-between">
              <div className="text-xs font-semibold">Closest BB at Order Discovery — per order (last 30 days)</div>
              <div className="text-[10px] text-muted-foreground">
                Qualifies when your matching-fulfillment offer is featured in a snapshot within ±2h of the order timestamp.
              </div>
            </div>
            {orderRows.length === 0 ? (
              <div className="text-xs text-muted-foreground py-4 text-center">
                No orders found for this ASIN / marketplace in the last 30 days.
              </div>
            ) : (
              <div className="max-h-[30vh] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 sticky top-0">
                    <tr className="text-left">
                      <th className="px-2 py-1.5 font-semibold">Order time (UTC)</th>
                      <th className="px-2 py-1.5 font-semibold">Order ID</th>
                      <th className="px-2 py-1.5 font-semibold">Checked</th>
                      <th className="px-2 py-1.5 font-semibold">Pedu BB (closest)</th>
                      <th className="px-2 py-1.5 font-semibold">Owner</th>
                      <th className="px-2 py-1.5 font-semibold text-right">Market BB price</th>
                      <th className="px-2 py-1.5 font-semibold text-right">Pedu BB price (closest)</th>
                      <th className="px-2 py-1.5 font-semibold">Snap age</th>
                      <th className="px-2 py-1.5 font-semibold">Promotion</th>
                      <th className="px-2 py-1.5 font-semibold">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderRows.map((o, i) => {
                      const captured = !!o.bb_estimate_captured_at;
                      const qualified = o.bb_estimate_qualified === true;
                      const reason = deriveReason(o, ownSellerId, snapshotLookup);
                      const ageSec = getEffectiveAgeSec(o);
                      const marketPrice = marketBbPrice(o, snapshotLookup);
                      const promotion = derivePromotion(o);
                      const promoToneClass =
                        promotion.tone === "emerald"
                          ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
                          : promotion.tone === "sky"
                            ? "bg-sky-500/15 text-sky-500 border-sky-500/30"
                            : "bg-amber-500/10 text-amber-500 border-amber-500/30";
                      return (
                        <tr key={(o.order_id || "") + i} className="border-b border-border/40 hover:bg-muted/30">
                          <td className="px-2 py-1.5 font-mono whitespace-nowrap">{o.purchase_timestamp_utc ? fmtTime(o.purchase_timestamp_utc) : o.order_date ? fmtTime(o.order_date) : "—"}</td>
                          <td className="px-2 py-1.5 font-mono truncate max-w-[140px]" title={o.order_id || ""}>
                            {o.order_id ? String(o.order_id).slice(-14) : "—"}
                          </td>
                          <td className="px-2 py-1.5">
                            {captured ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-500/15 text-sky-500 border border-sky-500/30">YES</span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-muted text-muted-foreground border border-border">NO</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {qualified ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">YES</span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30">NO</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {o.bb_estimate_owner_match === true ? "Pedu" : o.bb_estimate_owner_match === false ? "Other" : "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                            {marketPrice || "—"}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {(() => {
                              if (qualified && typeof o.bb_estimate_price === "number" && o.bb_estimate_price > 0) {
                                return `$${o.bb_estimate_price.toFixed(2)}`;
                              }
                              // Fallback: derive from raw snapshot offers_json so the user
                              // can see Pedu's price even when the backend gated it.
                              const snap = o.bb_estimate_snapshot_id ? snapshotLookup.get(o.bb_estimate_snapshot_id) : null;
                              const own = snap ? ownFeaturedOffer(snap, ownSellerId) : null;
                              if (own?.price && own.price > 0) {
                                return (
                                  <span className="text-muted-foreground" title="Derived from snapshot offers_json — backend hid this because the row was not fully qualified">
                                    ${own.price.toFixed(2)}<span className="ml-1 text-[10px]">(raw)</span>
                                  </span>
                                );
                              }
                              return "—";
                            })()}
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                            {typeof ageSec === "number" ? fmtSignedAgeSeconds(ageSec) : "—"}
                          </td>
                          <td className="px-2 py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${promoToneClass}`}>
                              {promotion.label}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground text-[11px]">{reason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {!loading && !error && snapshots.length === 0 && (
          <div className="text-xs text-muted-foreground py-4 text-center border border-dashed border-border rounded-md">
            No competitor snapshots in the ±6h window around this order.
            <div className="mt-1 text-[11px]">
              Phase 2 qualifies an order when a snapshot exists within ±2h of order discovery, Pedu owns the Buy Box, and fulfillment matches.
              Order-time on-demand BB capture is not enabled yet — historical orders cannot be backfilled.
            </div>
          </div>
        )}


        {!loading && !error && snapshots.length > 0 && (
          <div className="max-h-[60vh] overflow-auto border border-border rounded-md">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 sticky top-0">
                <tr className="text-left">
                  <th className="px-2 py-1.5 font-semibold">When</th>
                  <th className="px-2 py-1.5 font-semibold">Age vs order</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Market BB price</th>
                  <th className="px-2 py-1.5 font-semibold">Pedu owned?</th>
                  <th className="px-2 py-1.5 font-semibold">Fulfillment</th>
                  <th className="px-2 py-1.5 font-semibold">Market BB seller</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Lowest FBA</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Lowest FBM</th>
                  <th className="px-2 py-1.5 font-semibold">Source</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => {
                  const snapMs = new Date(s.fetched_at).getTime();
                  const ownFeatured = ownFeaturedOffer(s, ownSellerId);
                  const isOwner = !!ownFeatured || !!(ownSellerId && s.buybox_seller_id && s.buybox_seller_id === ownSellerId);
                  const sellerLabel = formatBbSeller(s, ownSellerId);
                  const rowHi =
                    s.id === nearestBeforeId ? "bg-emerald-500/10 border-l-2 border-emerald-500" :
                    s.id === nearestAfterId ? "bg-sky-500/10 border-l-2 border-sky-500" :
                    "";
                  return (
                    <tr key={s.id} className={`border-b border-border/40 hover:bg-muted/30 ${rowHi}`}>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap">{fmtTime(s.fetched_at)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                        {Number.isFinite(orderMs) ? fmtAge(orderMs, snapMs) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {ownFeatured?.price ? `$${ownFeatured.price.toFixed(2)}` : typeof s.buybox_price === "number" ? `$${s.buybox_price.toFixed(2)}` : "—"}
                      </td>
                      <td className="px-2 py-1.5">
                        {isOwner ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">YES</span>
                        ) : s.buybox_seller_id ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-muted text-muted-foreground border border-border">NO</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {ownFeatured?.isFba === true ? "FBA" : ownFeatured?.isFba === false ? "FBM" : s.buybox_is_fba === true ? "FBA" : s.buybox_is_fba === false ? "FBM" : "—"}
                      </td>
                  <td className="px-2 py-1.5 truncate max-w-[160px]" title={s.buybox_seller_id || s.buybox_seller_name || ""}>
                    {sellerLabel}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                        {typeof s.lowest_fba_price === "number" ? `$${s.lowest_fba_price.toFixed(2)}` : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                        {typeof s.lowest_fbm_price === "number" ? `$${s.lowest_fbm_price.toFixed(2)}` : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{s.source || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && snapshots.length > 0 && (
          <div className="text-[11px] text-muted-foreground pt-2 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500/40 border border-emerald-500" />
              Nearest snapshot BEFORE order
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm bg-sky-500/40 border border-sky-500" />
              Nearest snapshot AFTER order
            </span>
            <span>Window: ±6h around order time. Up to 200 snapshots.</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
