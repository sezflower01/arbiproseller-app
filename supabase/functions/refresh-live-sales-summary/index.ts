// Per-user writer for live_sales_summary + live_sales_today_by_asin.
//
// Phase 2 — Step 2. Read-side only. No repricer/sellability/FX writes.
// No cron yet — invoked manually for parity testing.
//
// Request body:
//   { user_id: string, source?: string, days?: number, start_date?: string, end_date?: string, dry_run?: boolean }
//
// Response: { ok, user_id, daily_rows, asin_rows, source_row_count, compute_ms, dry_run, preview? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { computeLiveSalesSummary, SUMMARY_VERSION } from "../_shared/live-sales-core.ts";

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
  try { body = await req.json(); } catch { /* empty */ }

  let targetUserId: string | undefined = body.user_id;
  const source = body.source || "manual";
  const dryRun = body.dry_run === true;

  // Resolve user from JWT if a user token is supplied (UI Refresh button).
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ") && authHeader.slice(7) !== serviceKey) {
    try {
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      if (user?.id) targetUserId = user.id;
    } catch { /* fall through */ }
  }

  if (!targetUserId) {
    return new Response(JSON.stringify({ error: "user_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Date range: default last 7 days (PT).
  const endISO = body.end_date || todayPT();
  const days = Number(body.days) > 0 ? Number(body.days) : 7;
  const startISO = body.start_date || addDaysISO(endISO, -(days - 1));

  try {
    const result = await computeLiveSalesSummary({ admin, userId: targetUserId, startISO, endISO });

    if (dryRun) {
      return new Response(JSON.stringify({
        ok: true, dry_run: true, user_id: targetUserId,
        date_range: { startISO, endISO },
        daily_rows: result.daily.length,
        asin_rows: result.todayByAsin.length,
        source_row_count: result.rowCount,
        compute_ms: result.computeMs,
        preview: { daily: result.daily, todayByAsin: result.todayByAsin.slice(0, 20) },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Upsert daily rows.
    const computedAt = new Date().toISOString();
    const dailyPayload = result.daily.map(r => ({ ...r, computed_at: computedAt, source }));
    if (dailyPayload.length > 0) {
      const { error } = await admin.from("live_sales_summary")
        .upsert(dailyPayload, { onConflict: "user_id,business_date,marketplace_id" });
      if (error) throw error;
    }

    // Per-ASIN today rows: replace today's set atomically.
    const today = todayPT();
    if (endISO >= today && startISO <= today) {
      const { error: delErr } = await admin.from("live_sales_today_by_asin")
        .delete().eq("user_id", targetUserId).eq("business_date", today);
      if (delErr) throw delErr;
      if (result.todayByAsin.length > 0) {
        const asinPayload = result.todayByAsin.map(r => ({ ...r, computed_at: computedAt }));
        const { error } = await admin.from("live_sales_today_by_asin")
          .upsert(asinPayload, { onConflict: "user_id,asin,business_date,marketplace" });
        if (error) throw error;
      }
    }

    return new Response(JSON.stringify({
      ok: true, user_id: targetUserId,
      date_range: { startISO, endISO },
      daily_rows: dailyPayload.length,
      asin_rows: result.todayByAsin.length,
      source_row_count: result.rowCount,
      compute_ms: result.computeMs,
      summary_version: SUMMARY_VERSION,
      source,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("refresh-live-sales-summary error", err);
    return new Response(JSON.stringify({ ok: false, error: String((err as any)?.message || err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
