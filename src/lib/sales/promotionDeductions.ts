/**
 * Shared promotion-rebate calculator — SINGLE SOURCE OF TRUTH.
 *
 * Used by:
 *   • <PromotionsDeductedSection /> (Sales Report + Live Sales desktop & mobile)
 *   • PeriodStatsBlocks net-profit calc paths that previously hardcoded 0
 *     (fetchSellerboardModeStat, today/yesterday quick stats)
 *
 * Contract — what counts as a "deducted promotion":
 *   1. FEC  → financial_events_cache.promotional_rebates (USD-normalized,
 *      negative-signed; we take abs value). Authoritative for non-US
 *      Amazon-funded promos (MX/CA/BR lightning deals, coupons) AND
 *      settled US promos.
 *   2. SO   → sales_orders.promotion_discount, ONLY for rows where the
 *      stored amount is already USD (marketplace='US' OR
 *      promotion_discount_currency='USD'). Captures pending US promos
 *      before settlement lands in FEC. Mirrors getOrderPromoUsd().
 *
 * Both sources are summed (matches `get_smart_fallback_daily_totals`'s
 * so_promo_rebates + fec_promo_rebates today). The shared helper makes
 * the Sales Report block, the Live Sales block, and the net-profit math
 * mathematically identical.
 */

import { supabase } from "@/integrations/supabase/client";

export type PromoDeductionSource = "sales_orders" | "fec";

export type PromoDeductionRow = {
  source: PromoDeductionSource;
  source_field: string;              // e.g. "promotion_discount" / "promotional_rebates"
  event_date: string;                // YYYY-MM-DD
  order_id: string | null;
  asin: string | null;
  marketplace: string | null;
  amount_usd: number;                // positive number, deducted from profit
  currency: string | null;           // currency of the original record (USD for FEC)
};

export type PromotionDeductionsResult = {
  rows: PromoDeductionRow[];
  totalUsd: number;
  byMarketplace: Record<string, number>;
  bySource: { sales_orders: number; fec: number };
  range: { start: string; end: string };
  marketplaceFilter: string;
};

const normalizeMp = (mp: string | null | undefined) =>
  String(mp || "US").trim().toUpperCase() || "US";

const applyMarketplaceFilter = (q: any, marketplace: string) => {
  if (!marketplace || marketplace === "ALL") return q;
  if (marketplace === "US") {
    // US rows may be stored with null marketplace (legacy) — include both.
    return q.or("marketplace.eq.US,marketplace.is.null");
  }
  return q.eq("marketplace", marketplace);
};

export async function fetchPromotionDeductions(params: {
  userId: string;
  rangeStart: string;                // YYYY-MM-DD
  rangeEnd: string;                  // YYYY-MM-DD
  marketplace?: string;              // "ALL" | "US" | "CA" | ...
  /**
   * How to date FEC promotional rebate rows.
   *   • 'event_date' (default) — Amazon settlement-posted date. Original
   *     behavior; required for desktop Sales Report + PeriodStatsBlocks
   *     net-profit math (unchanged).
   *   • 'order_date' — Attribute each FEC rebate to the linked
   *     sales_orders.order_date via amazon_order_id. Used by Mobile Live
   *     Sales so the "Promotions Deducted" line on the Today card only
   *     reflects orders purchased in the same period as Today's Sales.
   *     Orphan FEC rows (no matching sales_orders row in range) are
   *     excluded from the total.
   */
  attributionMode?: "event_date" | "order_date";
}): Promise<PromotionDeductionsResult> {
  const { userId, rangeStart, rangeEnd } = params;
  const marketplace = (params.marketplace || "ALL").toUpperCase();
  const attributionMode = params.attributionMode || "event_date";

  // Paginated fetch — Supabase caps each request at 1000 rows. YTD spans
  // tens of thousands of rows across SO + FEC, so we MUST page through all
  // chunks or totals silently undercount (root cause of the YTD shortfall).
  const PAGE_SIZE = 1000;
  const HARD_CAP = 100_000; // safety brake

  const fetchAllPages = async <T>(buildQuery: () => any, label: string): Promise<T[]> => {
    const all: T[] = [];
    let from = 0;
    // Loop until we get a short page or hit the safety cap.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const to = from + PAGE_SIZE - 1;
      const { data, error } = await buildQuery().range(from, to);
      if (error) {
        console.warn(`[promotionDeductions] ${label} page ${from}-${to} error:`, error.message);
        break;
      }
      const chunk = (data || []) as T[];
      all.push(...chunk);
      if (chunk.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
      if (from >= HARD_CAP) {
        console.warn(`[promotionDeductions] ${label} hit HARD_CAP ${HARD_CAP}`);
        break;
      }
    }
    return all;
  };

  // ── 1. SO promotion_discount (USD-safe rows only) ────────────────────────
  // Already keyed on order_date — identical in both attribution modes.
  const buildSo = () => {
    let q = supabase
      .from("sales_orders")
      .select(
        "order_id, asin, marketplace, order_date, promotion_discount, promotion_discount_currency, promotion_discount_source"
      )
      .eq("user_id", userId)
      .gte("order_date", rangeStart)
      .lte("order_date", rangeEnd)
      .gt("promotion_discount", 0)
      .order("order_date", { ascending: true });
    q = applyMarketplaceFilter(q, marketplace);
    return q;
  };

  // ── 2. FEC promotional_rebates ───────────────────────────────────────────
  const buildFecEventDate = () => {
    let q = supabase
      .from("financial_events_cache")
      .select(
        "amazon_order_id, asin, marketplace, event_date, event_type, promotional_rebates, promotional_rebate_refunds"
      )
      .eq("user_id", userId)
      .gte("event_date", rangeStart)
      .lte("event_date", rangeEnd)
      .or("promotional_rebates.neq.0,promotional_rebate_refunds.neq.0")
      .order("event_date", { ascending: true });
    q = applyMarketplaceFilter(q, marketplace);
    return q;
  };

  // For order_date mode: pull sales_orders order_ids in range first, then
  // fetch FEC rows where amazon_order_id IN (those ids).
  let orderDateMap: Map<string, string> | null = null;
  if (attributionMode === "order_date") {
    const buildSoIds = () => {
      let q = supabase
        .from("sales_orders")
        .select("order_id, order_date")
        .eq("user_id", userId)
        .gte("order_date", rangeStart)
        .lte("order_date", rangeEnd);
      q = applyMarketplaceFilter(q, marketplace);
      return q;
    };
    const soIdRows = await fetchAllPages<any>(buildSoIds, "SO-ids");
    orderDateMap = new Map();
    for (const r of soIdRows) {
      if (r?.order_id) orderDateMap.set(String(r.order_id), String(r.order_date || "").slice(0, 10));
    }
  }

  const fetchFecOrderDate = async (): Promise<any[]> => {
    if (!orderDateMap || orderDateMap.size === 0) return [];
    const ids = Array.from(orderDateMap.keys());
    const CHUNK = 200;
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const buildChunk = () => {
        let q = supabase
          .from("financial_events_cache")
          .select(
            "amazon_order_id, asin, marketplace, event_date, event_type, promotional_rebates, promotional_rebate_refunds"
          )
          .eq("user_id", userId)
          .in("amazon_order_id", slice)
          .or("promotional_rebates.neq.0,promotional_rebate_refunds.neq.0");
        q = applyMarketplaceFilter(q, marketplace);
        return q;
      };
      const rows = await fetchAllPages<any>(buildChunk, `FEC-od-${i}`);
      out.push(...rows);
    }
    return out;
  };

  const [soRows, fecRows] = await Promise.all([
    fetchAllPages<any>(buildSo, "SO"),
    attributionMode === "order_date"
      ? fetchFecOrderDate()
      : fetchAllPages<any>(buildFecEventDate, "FEC"),
  ]);

  const soRes = { data: soRows, error: null } as any;
  const fecRes = { data: fecRows, error: null } as any;
  console.log(
    `[promotionDeductions] mode=${attributionMode} SO=${soRows.length} FEC=${fecRows.length} range=${rangeStart}..${rangeEnd} mp=${marketplace}`
  );

  const rows: PromoDeductionRow[] = [];

  // SO rows — keep ONLY the USD-safe subset (matches getOrderPromoUsd).
  for (const r of (soRes.data || []) as any[]) {
    const mp = normalizeMp(r.marketplace);
    const curr = String(r.promotion_discount_currency || "").toUpperCase();
    const isUsdSafe = mp === "US" || curr === "USD";
    if (!isUsdSafe) continue;
    const amt = Number(r.promotion_discount || 0);
    if (!(amt > 0)) continue;
    rows.push({
      source: "sales_orders",
      source_field: "promotion_discount",
      event_date: String(r.order_date || "").slice(0, 10),
      order_id: r.order_id || null,
      asin: r.asin || null,
      marketplace: mp,
      amount_usd: amt,
      currency: curr || "USD",
    });
  }

  // FEC rows — promotional_rebates is USD and stored negative; take abs.
  // In 'order_date' mode, re-date each row to its linked sales_orders.order_date
  // (drop rows that don't match a sales_orders row in the requested range).
  for (const r of (fecRes.data || []) as any[]) {
    const rebate = Math.abs(Number(r.promotional_rebates || 0));
    const rebateRefund = Math.abs(Number(r.promotional_rebate_refunds || 0));
    const mp = normalizeMp(r.marketplace);
    let displayDate = String(r.event_date || "").slice(0, 10);
    if (attributionMode === "order_date") {
      const od = orderDateMap?.get(String(r.amazon_order_id || ""));
      if (!od) continue; // orphan FEC row — exclude from order-date totals
      displayDate = od;
    }
    if (rebate > 0) {
      rows.push({
        source: "fec",
        source_field: "promotional_rebates",
        event_date: displayDate,
        order_id: r.amazon_order_id || null,
        asin: r.asin || null,
        marketplace: mp,
        amount_usd: rebate,
        currency: "USD",
      });
    }
    if (rebateRefund > 0) {
      // Promotional rebate refunds REDUCE the deduction (Amazon paid us back).
      // Represent as a negative-amount row so totals net correctly.
      rows.push({
        source: "fec",
        source_field: "promotional_rebate_refunds",
        event_date: displayDate,
        order_id: r.amazon_order_id || null,
        asin: r.asin || null,
        marketplace: mp,
        amount_usd: -rebateRefund,
        currency: "USD",
      });
    }
  }


  // Sort newest first for the UI.
  rows.sort((a, b) => (a.event_date < b.event_date ? 1 : -1));

  const byMarketplace: Record<string, number> = {};
  const bySource = { sales_orders: 0, fec: 0 };
  let totalUsd = 0;
  for (const r of rows) {
    totalUsd += r.amount_usd;
    byMarketplace[r.marketplace || "UNKNOWN"] =
      (byMarketplace[r.marketplace || "UNKNOWN"] || 0) + r.amount_usd;
    bySource[r.source] += r.amount_usd;
  }

  return {
    rows,
    totalUsd: Math.max(0, totalUsd),
    byMarketplace,
    bySource,
    range: { start: rangeStart, end: rangeEnd },
    marketplaceFilter: marketplace,
  };
}
