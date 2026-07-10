// health-retry-worker
// Single executor that advances due retry rows in business_health_issues.
// Runs every 5 minutes via pg_cron.
// - Claims due rows via claim_due_health_retries RPC (FOR UPDATE SKIP LOCKED)
// - Invokes the mapped auto_fix_action edge function (allowlisted)
// - Reports outcome via record_health_retry_outcome RPC
// - Writes a row to health_retry_runs for observability

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Allowlist: only these auto_fix_action values may be invoked by the worker.
// Anything else is treated as "no-op" — auto_resolve sweeper will close it
// when underlying data is fixed.
const ALLOWED_ACTIONS = new Set<string>([
  "enrich-pending-orders",
  "reconcile-settlement",
  "sync-sales-orders",
  "monitor-spapi-health",
  "rescue-inventory-asin",
  "fetch-settlements",
  "calculate-roi-range",
]);

async function invokeAction(action: string, userId: string, entities: any): Promise<{ ok: boolean; note: string }> {
  try {
    const body: Record<string, any> = { user_id: userId, triggered_by: "health-retry-worker" };
    // Common entity hints
    const asins: string[] = [];
    const orderIds: string[] = [];
    if (Array.isArray(entities)) {
      for (const e of entities) {
        if (!e || typeof e !== "object") continue;
        if (typeof e.asin === "string") asins.push(e.asin);
        if (typeof e.amazon_order_id === "string") orderIds.push(e.amazon_order_id);
        if (typeof e.order_id === "string") orderIds.push(e.order_id);
      }
    }
    if (asins.length) body.asins = asins.slice(0, 50);
    if (orderIds.length) body.order_ids = orderIds.slice(0, 50);

    const res = await fetch(`${SUPABASE_URL}/functions/v1/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE}`,
        apikey: SERVICE_ROLE,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, note: `HTTP ${res.status}: ${text.slice(0, 240)}` };
    return { ok: true, note: text.slice(0, 240) };
  } catch (e: any) {
    return { ok: false, note: e?.message ?? String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const startedAt = new Date().toISOString();
  let processed = 0, advanced = 0, resolved = 0, stuck = 0, errors = 0;

  try {
    const { data: claims, error: claimErr } = await sb.rpc("claim_due_health_retries", { _limit: 50 });
    if (claimErr) throw claimErr;

    const rows = (claims ?? []) as Array<{
      id: string; user_id: string; fingerprint: string; module: string;
      auto_fix_action: string | null; affected_entities: any;
      retry_attempts: number; display_category: string;
    }>;

    for (const row of rows) {
      processed++;
      const action = row.auto_fix_action ?? "";
      if (!action || !ALLOWED_ACTIONS.has(action)) {
        // No safe action — leave to auto_resolve sweep. Mark "success" so the worker
        // doesn't inflate attempts; auto_resolve will close it when the row is clean.
        await sb.rpc("record_health_retry_outcome", { _issue_id: row.id, _success: true, _note: "no-allowlisted-action" });
        continue;
      }
      const out = await invokeAction(action, row.user_id, row.affected_entities);
      const { error: recErr } = await sb.rpc("record_health_retry_outcome", {
        _issue_id: row.id, _success: out.ok, _note: out.note,
      });
      if (recErr) errors++;
      if (out.ok) {
        advanced++;
      } else {
        if (row.retry_attempts + 1 >= 5) stuck++;
        else advanced++;
      }
      // brief gap to respect inter-function rate limits
      await new Promise((r) => setTimeout(r, 800));
    }

    await sb.from("health_retry_runs").insert({
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      processed, advanced, resolved, moved_to_stuck: stuck, errors,
    });

    return new Response(
      JSON.stringify({ ok: true, processed, advanced, stuck, errors }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    await sb.from("health_retry_runs").insert({
      started_at: startedAt, finished_at: new Date().toISOString(),
      processed, advanced, resolved, moved_to_stuck: stuck, errors: errors + 1,
      notes: (e?.message ?? String(e)).slice(0, 500),
    });
    return new Response(
      JSON.stringify({ ok: false, error: e?.message ?? String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
