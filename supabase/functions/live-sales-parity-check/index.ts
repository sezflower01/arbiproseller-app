// Live Sales parity check — compares server-computed summary against the
// stored rows in live_sales_summary, and (when invoked from a UI session)
// against the raw sales_orders aggregation the current Live Sales UI would
// produce for the same period.
//
// READ-ONLY. Never writes summary rows. Safe to call repeatedly.
//
// Body: { user_id?: string, days?: number, max_delta_cents?: number }
// Response: { ok, deltas: [...], totals: {summary, computed}, max_drift_cents }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { computeLiveSalesSummary } from "../_shared/live-sales-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function todayPT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}
function addDaysISO(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  let body: any = {};
  try { body = await req.json(); } catch {}

  let targetUserId: string | undefined = body.user_id;
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ") && authHeader.slice(7) !== serviceKey) {
    try {
      const u = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await u.auth.getUser();
      if (user?.id) targetUserId = user.id;
    } catch {}
  }
  if (!targetUserId) {
    return new Response(JSON.stringify({ error: "user_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const endISO = body.end_date || todayPT();
  const days = Number(body.days) > 0 ? Number(body.days) : 7;
  const startISO = body.start_date || addDaysISO(endISO, -(days - 1));
  const maxDeltaCents = Number(body.max_delta_cents) >= 0 ? Number(body.max_delta_cents) : 1;

  try {
    const t0 = Date.now();
    const computed = await computeLiveSalesSummary({ admin, userId: targetUserId, startISO, endISO });

    const { data: stored } = await admin.from("live_sales_summary")
      .select("business_date, marketplace_id, units, orders, revenue, fees, cost, profit, refund_amount, units_with_fallback, orders_with_fallback, revenue_with_fallback, fees_with_fallback, cost_with_fallback, profit_with_fallback, pending_estimate_revenue, confirmed_count, high_confidence_count, low_confidence_count, fallback_count")
      .eq("user_id", targetUserId)
      .gte("business_date", startISO).lte("business_date", endISO);

    const storedMap = new Map<string, any>();
    for (const r of (stored || [])) storedMap.set(`${r.business_date}|${r.marketplace_id}`, r);

    const computedMap = new Map<string, any>();
    for (const r of computed.daily) computedMap.set(`${r.business_date}|${r.marketplace_id}`, r);

    const keys = new Set([...storedMap.keys(), ...computedMap.keys()]);
    const deltas: any[] = [];
    let maxDriftCents = 0;
    const sumKeys = [
      "revenue", "fees", "cost", "profit", "refund_amount",
      "revenue_with_fallback", "fees_with_fallback", "cost_with_fallback", "profit_with_fallback",
      "pending_estimate_revenue",
    ];
    const intKeys = [
      "units", "orders",
      "units_with_fallback", "orders_with_fallback",
      "confirmed_count", "high_confidence_count", "low_confidence_count", "fallback_count",
    ];

    for (const k of keys) {
      const s = storedMap.get(k) || {};
      const c = computedMap.get(k) || {};
      const row: any = { key: k, missing_in_summary: !storedMap.has(k), missing_in_computed: !computedMap.has(k) };
      let anyDrift = false;
      for (const f of sumKeys) {
        const sv = Number(s[f] || 0);
        const cv = Number(c[f] || 0);
        const diffCents = Math.round((cv - sv) * 100);
        if (Math.abs(diffCents) > maxDeltaCents) {
          row[f] = { stored: sv, computed: cv, delta_cents: diffCents };
          anyDrift = true;
          if (Math.abs(diffCents) > maxDriftCents) maxDriftCents = Math.abs(diffCents);
        }
      }
      for (const f of intKeys) {
        const sv = Number(s[f] || 0);
        const cv = Number(c[f] || 0);
        if (sv !== cv) { row[f] = { stored: sv, computed: cv }; anyDrift = true; }
      }
      if (anyDrift || row.missing_in_summary || row.missing_in_computed) deltas.push(row);
    }

    const totals = (rows: any[]) => {
      const t: Record<string, number> = {
        units: 0, orders: 0, revenue: 0, fees: 0, cost: 0, profit: 0, refund_amount: 0,
        units_with_fallback: 0, orders_with_fallback: 0,
        revenue_with_fallback: 0, fees_with_fallback: 0, cost_with_fallback: 0, profit_with_fallback: 0,
        pending_estimate_revenue: 0,
        confirmed_count: 0, high_confidence_count: 0, low_confidence_count: 0, fallback_count: 0,
      };
      for (const r of rows) for (const k of Object.keys(t)) t[k] += Number((r as any)[k] || 0);
      return t;
    };

    return new Response(JSON.stringify({
      ok: true,
      user_id: targetUserId,
      date_range: { startISO, endISO },
      stored_rows: stored?.length || 0,
      computed_rows: computed.daily.length,
      source_row_count: computed.rowCount,
      drift_rows: deltas.length,
      max_drift_cents: maxDriftCents,
      totals: { stored: totals(stored || []), computed: totals(computed.daily) },
      compute_ms: computed.computeMs,
      parity_ms: Date.now() - t0,
      deltas,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("live-sales-parity-check error", err);
    return new Response(JSON.stringify({ ok: false, error: String((err as any)?.message || err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
