import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const log = (step: string, details?: unknown) => {
  console.log(`[ADMIN-ACCOUNT] ${step}${details ? ` - ${JSON.stringify(details)}` : ""}`);
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
    // Verify caller is admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) throw new Error("Authentication failed");

    const callerId = userData.user.id;

    // Check admin role
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", callerId)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleRow) {
      return new Response(JSON.stringify({ error: "Admin access required" }), { status: 403, headers: jsonHeaders });
    }

    const body = await req.json();
    const { action, user_id, reason } = body;

    log("Action requested", { action, user_id, callerId });

    if (action === "list_users") {
      // Get all auth users (includes those without profiles)
      const { data: authUsers, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      if (listErr) log("listUsers error", { message: listErr.message });
      const allAuthUsers = authUsers?.users || [];
      log("Auth users fetched", { count: allAuthUsers.length, emails: allAuthUsers.map((u: any) => u.email) });

      // Get all profiles
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email, first_name, last_name, account_status, account_status_reason, account_status_changed_at, created_at")
        .order("created_at", { ascending: false });

      const profileMap: Record<string, any> = {};
      (profiles || []).forEach((p: any) => { profileMap[p.id] = p; });

      // Merge: use auth.users as the source of truth, enrich with profile data
      const mergedUsers = allAuthUsers.map((au: any) => {
        const profile = profileMap[au.id];
        return {
          id: au.id,
          email: au.email || profile?.email || "unknown",
          first_name: profile?.first_name || au.user_metadata?.first_name || null,
          last_name: profile?.last_name || au.user_metadata?.last_name || null,
          account_status: profile?.account_status || "active",
          account_status_reason: profile?.account_status_reason || null,
          account_status_changed_at: profile?.account_status_changed_at || null,
          created_at: au.created_at || profile?.created_at,
        };
      });

      const userIds = mergedUsers.map((u: any) => u.id);

      const [subsRes, repRes, authRes] = await Promise.all([
        supabase.from("user_subscriptions").select("user_id, plan_id, status, cancel_at_period_end, current_period_end").in("user_id", userIds),
        supabase.from("repricer_settings").select("user_id, scheduler_enabled").in("user_id", userIds),
        supabase.from("seller_authorizations").select("user_id, is_active, marketplace_id").in("user_id", userIds),
      ]);

      const subsMap: Record<string, any> = {};
      (subsRes.data || []).forEach((s: any) => { subsMap[s.user_id] = s; });

      const repMap: Record<string, any> = {};
      (repRes.data || []).forEach((r: any) => { repMap[r.user_id] = r; });

      const authMap: Record<string, any[]> = {};
      (authRes.data || []).forEach((a: any) => {
        if (!authMap[a.user_id]) authMap[a.user_id] = [];
        authMap[a.user_id].push(a);
      });

      const users = mergedUsers.map((u: any) => ({
        ...u,
        subscription: subsMap[u.id] || null,
        repricer: repMap[u.id] || null,
        amazon_auths: authMap[u.id] || [],
      }));

      // Sort by created_at descending
      users.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      return new Response(JSON.stringify({ users }), { headers: jsonHeaders });
    }

    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required" }), { status: 400, headers: jsonHeaders });
    }

    if (action === "pause") {
      // Pause: disable repricer, disconnect Amazon, keep login
      await Promise.all([
        supabase.from("repricer_settings").update({
          scheduler_enabled: false, queue_paused: true, queue_pause_reason: "admin_paused"
        }).eq("user_id", user_id),
        supabase.from("seller_authorizations").update({
          is_active: false, deactivated_at: new Date().toISOString(), deactivation_reason: "admin_paused"
        }).eq("user_id", user_id),
        supabase.from("profiles").update({
          account_status: "paused",
          account_status_reason: reason || "Paused by admin",
          account_status_changed_at: new Date().toISOString(),
          account_status_changed_by: callerId,
        }).eq("id", user_id),
      ]);

      await supabase.from("subscription_events").insert({
        user_id, event_type: "admin_pause",
        details: { reason, admin_id: callerId },
      });

      log("User paused", { user_id });
      return new Response(JSON.stringify({ success: true, message: "Account paused" }), { headers: jsonHeaders });
    }

    if (action === "suspend") {
      // Suspend: block login + all services
      await Promise.all([
        supabase.from("repricer_settings").update({
          scheduler_enabled: false, queue_paused: true, queue_pause_reason: "admin_suspended"
        }).eq("user_id", user_id),
        supabase.from("seller_authorizations").update({
          is_active: false, deactivated_at: new Date().toISOString(), deactivation_reason: "admin_suspended"
        }).eq("user_id", user_id),
        supabase.from("profiles").update({
          account_status: "suspended",
          account_status_reason: reason || "Suspended by admin",
          account_status_changed_at: new Date().toISOString(),
          account_status_changed_by: callerId,
        }).eq("id", user_id),
        // Ban user in Supabase Auth to block login
        supabase.auth.admin.updateUserById(user_id, { ban_duration: "876000h" }), // ~100 years
      ]);

      await supabase.from("subscription_events").insert({
        user_id, event_type: "admin_suspend",
        details: { reason, admin_id: callerId },
      });

      log("User suspended", { user_id });
      return new Response(JSON.stringify({ success: true, message: "Account suspended — login blocked" }), { headers: jsonHeaders });
    }

    if (action === "restore") {
      // Restore: unban, set active, reactivate Amazon auth
      await Promise.all([
        supabase.from("profiles").update({
          account_status: "active",
          account_status_reason: "Restored by admin",
          account_status_changed_at: new Date().toISOString(),
          account_status_changed_by: callerId,
        }).eq("id", user_id),
        // Unban user
        supabase.auth.admin.updateUserById(user_id, { ban_duration: "none" }),
        // Reactivate Amazon auth
        supabase.from("seller_authorizations").update({
          is_active: true, deactivated_at: null, deactivation_reason: null
        }).eq("user_id", user_id),
      ]);

      await supabase.from("subscription_events").insert({
        user_id, event_type: "admin_restore",
        details: { reason: reason || "Restored", admin_id: callerId },
      });

      log("User restored", { user_id });
      return new Response(JSON.stringify({ success: true, message: "Account restored" }), { headers: jsonHeaders });
    }

    if (action === "delete") {
      // Delete: disable all services, record the event, then fully remove auth user
      const [repricerRes, sellerAuthRes, subscriptionRes, profileRes] = await Promise.all([
        supabase.from("repricer_settings").update({
          scheduler_enabled: false, queue_paused: true, queue_pause_reason: "account_deleted"
        }).eq("user_id", user_id),
        supabase.from("seller_authorizations").update({
          is_active: false, deactivated_at: new Date().toISOString(), deactivation_reason: "account_deleted"
        }).eq("user_id", user_id),
        supabase.from("user_subscriptions").update({ status: "expired" }).eq("user_id", user_id),
        supabase.from("profiles").update({
          account_status: "deleted",
          account_status_reason: reason || "Deleted by admin",
          account_status_changed_at: new Date().toISOString(),
          account_status_changed_by: callerId,
        }).eq("id", user_id),
      ]);

      const mutationErrors = [
        repricerRes.error,
        sellerAuthRes.error,
        subscriptionRes.error,
        profileRes.error,
      ].filter(Boolean);

      if (mutationErrors.length > 0) {
        const message = mutationErrors.map((err) => err?.message).filter(Boolean).join(" | ");
        log("Delete preflight failed", { user_id, message });
        throw new Error(message || "Failed to prepare account for deletion");
      }

      const { error: eventErr } = await supabase.from("subscription_events").insert({
        user_id, event_type: "admin_delete",
        details: { reason, admin_id: callerId },
      });

      if (eventErr) {
        log("Delete event log failed", { user_id, message: eventErr.message });
        throw new Error(eventErr.message);
      }

      const { error: deleteAuthErr } = await supabase.auth.admin.deleteUser(user_id, false);
      if (deleteAuthErr) {
        log("Auth user delete failed", { user_id, error: deleteAuthErr.message });
        throw new Error(deleteAuthErr.message);
      }

      log("User deleted + auth removed", { user_id });
      return new Response(JSON.stringify({ success: true, message: "Account permanently deleted — email freed for re-registration", deleted_user_id: user_id }), { headers: jsonHeaders });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: jsonHeaders });
  } catch (error) {
    const msg = error instanceof Error ? (error as Error).message : String(error);
    log("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: jsonHeaders });
  }
});
