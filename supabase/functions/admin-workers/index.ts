import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Shards that actually have a pg_cron job invoking repricer-unified-dispatch
// for them today. Assigning a user to a shard NOT in this list means their
// account will simply never get picked up -- there's no worker checking it.
// Update this list (and provision the matching cron.schedule) whenever a new
// shard is actually added.
const PROVISIONED_SHARDS = ["A", "B"];

const log = (step: string, details?: unknown) => {
  console.log(`[ADMIN-WORKERS] ${step}${details ? ` - ${JSON.stringify(details)}` : ""}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) throw new Error("Authentication failed");

    const callerId = userData.user.id;
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", callerId)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleRow) {
      return new Response(JSON.stringify({ error: "Admin access required" }), { status: 403, headers: jsonHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const { action, user_id, shard } = body;
    log("Action requested", { action, user_id, shard, callerId });

    if (action === "list") {
      const { data: settingsRows, error: settingsErr } = await supabase
        .from("repricer_settings")
        .select("user_id, dispatch_worker_shard, scheduler_enabled, queue_paused")
        .order("user_id");
      if (settingsErr) throw settingsErr;

      const rows = settingsRows || [];
      const userIds = rows.map((r: any) => r.user_id);

      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email, first_name, last_name")
        .in("id", userIds.length > 0 ? userIds : ["00000000-0000-0000-0000-000000000000"]);
      const profileMap: Record<string, any> = {};
      (profiles || []).forEach((p: any) => { profileMap[p.id] = p; });

      const shardCounts: Record<string, { total: number; active: number }> = {};
      for (const row of rows) {
        const s = row.dispatch_worker_shard || "A";
        if (!shardCounts[s]) shardCounts[s] = { total: 0, active: 0 };
        shardCounts[s].total += 1;
        if (row.scheduler_enabled && !row.queue_paused) shardCounts[s].active += 1;
      }

      const users = rows.map((r: any) => {
        const p = profileMap[r.user_id];
        return {
          user_id: r.user_id,
          email: p?.email || "unknown",
          name: [p?.first_name, p?.last_name].filter(Boolean).join(" ") || null,
          shard: r.dispatch_worker_shard || "A",
          scheduler_enabled: !!r.scheduler_enabled,
          queue_paused: !!r.queue_paused,
        };
      });
      users.sort((a: any, b: any) => a.email.localeCompare(b.email));

      return new Response(
        JSON.stringify({ shardCounts, provisionedShards: PROVISIONED_SHARDS, users }),
        { headers: jsonHeaders }
      );
    }

    if (action === "set_shard") {
      if (!user_id || !shard) {
        return new Response(JSON.stringify({ error: "user_id and shard are required" }), { status: 400, headers: jsonHeaders });
      }
      const { error: updateErr } = await supabase
        .from("repricer_settings")
        .update({ dispatch_worker_shard: shard })
        .eq("user_id", user_id);
      if (updateErr) throw updateErr;

      return new Response(
        JSON.stringify({ success: true, unprovisioned: !PROVISIONED_SHARDS.includes(shard) }),
        { headers: jsonHeaders }
      );
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: jsonHeaders });
  } catch (err: any) {
    log("Error", { message: err.message });
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), { status: 500, headers: jsonHeaders });
  }
});
