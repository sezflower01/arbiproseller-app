// Per-user writer for inventory_valuation_summary.
// Called by:
//   - cron fan-out (refresh-inventory-valuation-summary-all)
//   - UI manual Refresh button (source='manual')
//
// Safety: acquires per-user lock via try_acquire_inv_valuation_summary_lock
// so 5 browser tabs pressing Refresh do NOT trigger 5 concurrent re-computes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { computeInventoryValuation } from "../_shared/inventory-valuation-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  let body: { user_id?: string; source?: string; caller?: string } = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  // Caller can be authenticated user (UI Refresh) or service role (cron).
  let targetUserId = body.user_id;
  const source = body.source || "manual";
  const caller = body.caller || source;

  // If the request comes from a user session, resolve user from JWT and force that id.
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

  // Try to acquire per-user lock (max age 180s).
  const { data: gotLock, error: lockErr } = await admin.rpc(
    "try_acquire_inv_valuation_summary_lock",
    { p_user_id: targetUserId, p_caller: caller, p_max_age_seconds: 180 },
  );
  if (lockErr) {
    console.error("lock acquire error", lockErr);
  }
  if (!gotLock) {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: "lock_held" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const startedAt = Date.now();
  try {
    const totals = await computeInventoryValuation(admin, targetUserId);
    const computeMs = Date.now() - startedAt;

    const { error: upsertErr } = await admin
      .from("inventory_valuation_summary")
      .upsert({
        user_id: targetUserId,
        value: totals.value,
        units: totals.units,
        skus: totals.skus,
        available: totals.available,
        reserved: totals.reserved,
        inbound: totals.inbound,
        unfulfilled: totals.unfulfilled,
        available_value: totals.availableValue,
        reserved_value: totals.reservedValue,
        inbound_value: totals.inboundValue,
        unfulfilled_value: totals.unfulfilledValue,
        low_stock: totals.lowStock,
        total_rows: totals.totalRows,
        rows_stale_24h: totals.rowsStale24h,
        most_recent_sync: totals.mostRecentSync,
        computed_at: new Date().toISOString(),
        source,
        compute_ms: computeMs,
      }, { onConflict: "user_id" });

    if (upsertErr) throw upsertErr;

    return new Response(JSON.stringify({ ok: true, user_id: targetUserId, compute_ms: computeMs, source }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("refresh-inventory-valuation-summary error", err);
    return new Response(JSON.stringify({ ok: false, error: String((err as any)?.message || err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } finally {
    await admin.rpc("release_inv_valuation_summary_lock", { p_user_id: targetUserId });
  }
});
