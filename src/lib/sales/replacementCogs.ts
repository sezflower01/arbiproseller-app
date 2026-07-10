/**
 * Replacement / Free-Shipment COGS Fetcher
 *
 * Queries sales_orders for rows flagged `is_replacement = true` within a date
 * range and returns the per-order audit list + total COGS impact.
 *
 * Profit rule: revenue = $0, cogs = unit_cost * quantity, fees from FEC if
 * any. This amount is shown as a negative line in Live Sales / Sales Report /
 * P&L so profit is not overstated.
 *
 * Uses paginated fetch to bypass Supabase's 1000-row default limit so YTD
 * totals are mathematically correct.
 */

import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "./paginatedFetch";

export interface ReplacementRow {
  id: string;
  order_id: string;
  asin: string | null;
  sku: string | null;
  title: string | null;
  marketplace: string | null;
  quantity: number;
  unit_cost: number;
  cogs_usd: number;
  fees_usd: number;
  order_date: string;
  order_status: string | null;
  fulfillment_channel: string | null;
  order_type: string | null;
  is_replacement: boolean;
  replacement_reason: string | null;
  related_order_id: string | null;
}

export interface ReplacementCogsResult {
  totalCogsUsd: number;
  totalFeesUsd: number;
  totalProfitImpactUsd: number;   // -(cogs + fees)
  unitsLost: number;
  orderCount: number;
  byMarketplace: Record<string, { cogs: number; orders: number; units: number }>;
  byReason: Record<string, { cogs: number; orders: number }>;
  rows: ReplacementRow[];
}

export interface FetchReplacementCogsParams {
  userId: string;
  rangeStart: string;
  rangeEnd: string;
  marketplace?: string;   // "ALL" / "US" / "CA" / ...
}

export async function fetchReplacementCogs(
  params: FetchReplacementCogsParams,
): Promise<ReplacementCogsResult> {
  const { userId, rangeStart, rangeEnd, marketplace = "ALL" } = params;

  const rows = await fetchAllPages<any>(
    () => {
      let q = supabase
        .from("sales_orders")
        .select(
          "id, order_id, asin, sku, seller_sku, title, marketplace, quantity, unit_cost, total_cost, total_fees, fees_source, order_date, order_status, fulfillment_channel, order_type, is_replacement, replacement_reason, related_order_id",
        )
        .eq("user_id", userId)
        .gte("order_date", rangeStart)
        .lte("order_date", rangeEnd)
        .eq("is_replacement", true)
        .order("order_date", { ascending: false });

      if (marketplace && marketplace !== "ALL") {
        if (marketplace === "US") {
          q = q.or("marketplace.eq.US,marketplace.is.null");
        } else {
          q = q.eq("marketplace", marketplace);
        }
      }
      return q;
    },
    { label: "REPLACEMENT_COGS" },
  );


  // Dedupe by (order_id, asin) — defensive
  const seen = new Set<string>();
  const cleaned: any[] = [];
  for (const r of rows) {
    const key = `${String(r.order_id || "").trim()}::${String(r.asin || "").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(r);
  }

  const out: ReplacementRow[] = [];
  const byMarketplace: ReplacementCogsResult["byMarketplace"] = {};
  const byReason: ReplacementCogsResult["byReason"] = {};
  let totalCogs = 0;
  let totalFees = 0;
  let unitsLost = 0;

  for (const r of cleaned) {
    const qty = Math.max(1, Number(r.quantity || 0) || 1);
    const unitCost = Math.max(0, Number(r.unit_cost || 0));
    const cogs = Number(r.total_cost) > 0
      ? Number(r.total_cost)
      : unitCost * qty;
    // Only count fees that came from real FEC settlement. Estimated/learned/cached
    // fees do NOT apply to $0 replacement shipments (Amazon doesn't re-charge FBA
    // fees on a replacement), so including them would overstate the profit hit.
    const feesAreReal = String(r.fees_source || "") === "financial_events";
    const fees = feesAreReal ? Math.max(0, Number(r.total_fees || 0)) : 0;
    const mp = String(r.marketplace || "US").toUpperCase();
    const reason = String(r.replacement_reason || "unknown");

    totalCogs += cogs;
    totalFees += fees;
    unitsLost += qty;

    byMarketplace[mp] = byMarketplace[mp] || { cogs: 0, orders: 0, units: 0 };
    byMarketplace[mp].cogs += cogs;
    byMarketplace[mp].orders += 1;
    byMarketplace[mp].units += qty;

    byReason[reason] = byReason[reason] || { cogs: 0, orders: 0 };
    byReason[reason].cogs += cogs;
    byReason[reason].orders += 1;

    out.push({
      id: r.id,
      order_id: r.order_id,
      asin: r.asin,
      sku: r.sku || r.seller_sku || null,
      title: r.title,
      marketplace: r.marketplace,
      quantity: qty,
      unit_cost: unitCost,
      cogs_usd: Math.round(cogs * 100) / 100,
      fees_usd: Math.round(fees * 100) / 100,
      order_date: r.order_date,
      order_status: r.order_status,
      fulfillment_channel: r.fulfillment_channel,
      order_type: r.order_type,
      is_replacement: r.is_replacement === true,
      replacement_reason: r.replacement_reason,
      related_order_id: r.related_order_id,
    });
  }

  return {
    totalCogsUsd: Math.round(totalCogs * 100) / 100,
    totalFeesUsd: Math.round(totalFees * 100) / 100,
    totalProfitImpactUsd: Math.round((totalCogs + totalFees) * 100) / 100,
    unitsLost,
    orderCount: out.length,
    byMarketplace,
    byReason,
    rows: out,
  };
}
