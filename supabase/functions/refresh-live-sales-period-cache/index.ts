// refresh-live-sales-period-cache
//
// CANONICAL writer for live_sales_period_cache.
//
// CRITICAL: This function MUST stay bit-identical to the Live Sales UI/KPI
// path. It does that by reusing `computeLiveSalesSummary` from
// `_shared/live-sales-core.ts` — the exact same aggregator the rest of the
// stack (refresh-live-sales-summary, verify-live-sales-cache-parity, the UI
// reader) runs. No simplified math. No local revenue / fees / cost / promo /
// refund / dedup / FX logic in this file. If the UI changes, change the
// shared aggregator and this writer follows for free.
//
// Closed periods written per call (user, all marketplaces):
//   - last-month                          (full calendar month, just closed)
//   - month-<YYYY-MM>  (3 most recently closed months)
//   - year-<previous YEAR>                (only if missing)
//   - ytd-closed-<currentYear>            (Jan 1 → yesterday, sales TZ)
//
// Rows emitted per period:
//   - one ALL row (sum across marketplaces)
//   - one row per marketplace that had any activity
//
// `totals` JSON stores the rolled-up canonical SummaryRow (sums of every
// numeric field, then derived profit / roi recomputed). This is exactly what
// the reader needs to add today's delta to.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  computeLiveSalesSummary,
  SALES_BUSINESS_TZ,
  SUMMARY_VERSION,
  type SummaryRow,
} from "../_shared/live-sales-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_SECRET = Deno.env.get("INTERNAL_SYNC_SECRET") || "";

// -------- date helpers (sales business TZ) --------

function ymdInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
function firstOfMonth(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}
function lastOfMonth(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}
function shiftMonth(ymd: string, deltaMonths: number): string {
  const [y, m] = ymd.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + deltaMonths;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

interface PeriodSpec {
  period_key: string;
  period_start: string; // YYYY-MM-DD (inclusive)
  period_end: string;   // YYYY-MM-DD (inclusive)
}

function buildClosedPeriods(todayYmd: string): PeriodSpec[] {
  const yesterday = addDays(todayYmd, -1);
  const [curY] = todayYmd.split("-").map(Number);
  const firstOfThisMonth = firstOfMonth(todayYmd);
  const periods: PeriodSpec[] = [];

  for (let i = 1; i <= 3; i++) {
    const start = shiftMonth(firstOfThisMonth, -i);
    const end = lastOfMonth(start);
    const key = `month-${start.slice(0, 7)}`;
    periods.push({ period_key: key, period_start: start, period_end: end });
    if (i === 1) periods.push({ period_key: "last-month", period_start: start, period_end: end });
  }

  const prevYear = curY - 1;
  periods.push({
    period_key: `year-${prevYear}`,
    period_start: `${prevYear}-01-01`,
    period_end: `${prevYear}-12-31`,
  });

  if (yesterday >= `${curY}-01-01`) {
    periods.push({
      period_key: `ytd-closed-${curY}`,
      period_start: `${curY}-01-01`,
      period_end: yesterday,
    });
  }
  return periods;
}

// -------- canonical roll-up --------

function blankRolled(marketplace: string): SummaryRow {
  return {
    user_id: "",
    business_date: "",
    marketplace_id: marketplace,
    units: 0, orders: 0, revenue: 0, fees: 0, cost: 0, profit: 0, roi: 0,
    refund_amount: 0, refund_count: 0,
    units_with_fallback: 0, orders_with_fallback: 0,
    revenue_with_fallback: 0, fees_with_fallback: 0,
    cost_with_fallback: 0, profit_with_fallback: 0,
    pending_estimate_revenue: 0,
    confirmed_count: 0, high_confidence_count: 0,
    low_confidence_count: 0, fallback_count: 0,
  };
}

function addInto(acc: SummaryRow, r: SummaryRow) {
  acc.units += r.units;
  acc.orders += r.orders;
  acc.revenue += r.revenue;
  acc.fees += r.fees;
  acc.cost += r.cost;
  acc.refund_amount += r.refund_amount;
  acc.refund_count += r.refund_count;
  acc.units_with_fallback += r.units_with_fallback;
  acc.orders_with_fallback += r.orders_with_fallback;
  acc.revenue_with_fallback += r.revenue_with_fallback;
  acc.fees_with_fallback += r.fees_with_fallback;
  acc.cost_with_fallback += r.cost_with_fallback;
  acc.pending_estimate_revenue += r.pending_estimate_revenue;
  acc.confirmed_count += r.confirmed_count;
  acc.high_confidence_count += r.high_confidence_count;
  acc.low_confidence_count += r.low_confidence_count;
  acc.fallback_count += r.fallback_count;
}

function finalize(acc: SummaryRow): SummaryRow {
  acc.profit = acc.revenue - acc.fees - acc.cost - acc.refund_amount;
  acc.profit_with_fallback =
    acc.revenue_with_fallback - acc.fees_with_fallback - acc.cost_with_fallback - acc.refund_amount;
  acc.roi = acc.cost > 0 ? acc.profit / acc.cost : 0;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  acc.revenue = r2(acc.revenue);
  acc.fees = r2(acc.fees);
  acc.cost = r2(acc.cost);
  acc.refund_amount = r2(acc.refund_amount);
  acc.profit = r2(acc.profit);
  acc.revenue_with_fallback = r2(acc.revenue_with_fallback);
  acc.fees_with_fallback = r2(acc.fees_with_fallback);
  acc.cost_with_fallback = r2(acc.cost_with_fallback);
  acc.profit_with_fallback = r2(acc.profit_with_fallback);
  acc.pending_estimate_revenue = r2(acc.pending_estimate_revenue);
  acc.roi = Math.round(acc.roi * 10000) / 10000;
  return acc;
}

async function refreshUser(supa: any, userId: string, force: boolean) {
  // Skip if no recent sales activity
  const { data: recent } = await supa
    .from("sales_orders").select("order_id").eq("user_id", userId)
    .gte("order_date", new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10))
    .limit(1);
  if (!recent || recent.length === 0) {
    return { user_id: userId, skipped: "no_recent_sales", periods: 0 };
  }

  // sales_sync_version (best-effort)
  let salesSyncVersion = 0;
  try {
    const { data: vsRow } = await supa
      .from("user_sync_status").select("sales_sync_version").eq("user_id", userId).maybeSingle();
    salesSyncVersion = Number(vsRow?.sales_sync_version ?? 0) || 0;
  } catch { /* ignore */ }

  const todayYmd = ymdInTz(new Date(), SALES_BUSINESS_TZ);
  const periods = buildClosedPeriods(todayYmd);
  const startedAt = Date.now();
  let written = 0;
  const perPeriodNotes: any[] = [];

  for (const p of periods) {
    // Skip already-current cache row unless forced
    if (!force) {
      const { data: existing } = await supa
        .from("live_sales_period_cache")
        .select("sales_sync_version, period_start, period_end")
        .eq("user_id", userId).eq("marketplace", "ALL").eq("period_key", p.period_key)
        .maybeSingle();
      if (
        existing &&
        existing.sales_sync_version === salesSyncVersion &&
        existing.period_start === p.period_start &&
        existing.period_end === p.period_end
      ) {
        perPeriodNotes.push({ period: p.period_key, skipped: "version_match" });
        continue;
      }
    }

    const t0 = Date.now();

    // CANONICAL aggregator — same code path as the UI and parity checker.
    // Window covers the full period in sales business TZ (inclusive end day).
    const startISO = `${p.period_start}T00:00:00Z`;
    const endISO = `${p.period_end}T23:59:59Z`;

    const { daily, rowCount } = await computeLiveSalesSummary({
      admin: supa, userId, startISO, endISO,
    });

    // Roll up daily rows → per-marketplace + ALL.
    const perMkt = new Map<string, SummaryRow>();
    const all = blankRolled("ALL");
    for (const dr of daily) {
      const mp = (dr.marketplace_id || "US").toUpperCase();
      const acc = perMkt.get(mp) || blankRolled(mp);
      addInto(acc, dr);
      perMkt.set(mp, acc);
      addInto(all, dr);
    }
    for (const [, acc] of perMkt) finalize(acc);
    finalize(all);

    const dur = Date.now() - t0;
    const computedAt = new Date().toISOString();

    const rows = [
      {
        user_id: userId, marketplace: "ALL", period_key: p.period_key,
        period_start: p.period_start, period_end: p.period_end,
        totals: all,
        asin_rows: [], // Phase 2
        sales_sync_version: salesSyncVersion,
        source_row_count: rowCount,
        computed_at: computedAt,
        computed_duration_ms: dur,
        notes: { writer: "computeLiveSalesSummary", summary_version: SUMMARY_VERSION },
      },
      ...Array.from(perMkt.entries()).map(([mp, totals]) => ({
        user_id: userId, marketplace: mp, period_key: p.period_key,
        period_start: p.period_start, period_end: p.period_end,
        totals,
        asin_rows: [],
        sales_sync_version: salesSyncVersion,
        source_row_count: rowCount,
        computed_at: computedAt,
        computed_duration_ms: dur,
        notes: { writer: "computeLiveSalesSummary", summary_version: SUMMARY_VERSION },
      })),
    ];

    const { error: upErr } = await supa
      .from("live_sales_period_cache")
      .upsert(rows, { onConflict: "user_id,marketplace,period_key" });
    if (upErr) throw new Error(`upsert failed for ${p.period_key}: ${upErr.message}`);

    written += rows.length;
    perPeriodNotes.push({
      period: p.period_key, marketplaces: rows.length, rowCount, duration_ms: dur,
    });
  }

  return {
    user_id: userId,
    periods: periods.length,
    rows_written: written,
    sales_sync_version: salesSyncVersion,
    total_duration_ms: Date.now() - startedAt,
    detail: perPeriodNotes,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("authorization") || "";
  const internalHeader = req.headers.get("x-internal-secret") || "";
  const supaService = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  let body: any = {};
  try { body = req.method === "POST" ? await req.json() : {}; } catch { body = {}; }

  const wantsForce = Boolean(body?.force);
  const explicitUserId: string | undefined = body?.user_id;

  let targetUserId: string | null = null;
  const isService =
    authHeader.includes(SERVICE_ROLE) ||
    (INTERNAL_SECRET && internalHeader === INTERNAL_SECRET);

  if (isService) {
    targetUserId = explicitUserId || null;
  } else {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: udata, error: uerr } = await supaService.auth.getUser(token);
    if (uerr || !udata?.user?.id) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    targetUserId = udata.user.id;
  }

  if (!targetUserId) {
    return new Response(JSON.stringify({ error: "user_id_required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const result = await refreshUser(supaService, targetUserId, wantsForce);
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
