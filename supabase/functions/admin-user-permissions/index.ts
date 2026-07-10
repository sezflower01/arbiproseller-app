import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const MODULES = [
  "repricer", "inventory", "reports", "supplier_discovery",
  "product_library", "personalhour", "settings", "admin_panel",
  "fba_builder", "profit_loss", "buy_again", "still_thinking",
  "mobile_live_sales", "mobile_inventory_valuation", "upc_scanner", "scan_history",
] as const;
const ACTIONS = ["view", "run", "edit", "admin"] as const;
const ROLES = ["admin", "user", "viewer"] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    // Verify caller is admin
    const { data: isAdmin } = await admin.rpc("has_role", {
      _user_id: user.id, _role: "admin",
    });
    if (!isAdmin) return json({ error: "Admin access required" }, 403);

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    // ========== LIST USERS ==========
    if (action === "list_users") {
      const { data: authData, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
      if (listErr) throw listErr;
      const users = authData?.users || [];
      const ids = users.map((u: any) => u.id);

      const [rolesRes, accessRes, profilesRes] = await Promise.all([
        admin.from("user_roles").select("user_id, role").in("user_id", ids),
        admin.from("user_module_access").select("user_id, module, action").in("user_id", ids),
        admin.from("profiles").select("id, is_approved, approved_at, approved_by").in("id", ids),
      ]);

      const rolesMap: Record<string, string[]> = {};
      (rolesRes.data || []).forEach((r: any) => {
        if (!rolesMap[r.user_id]) rolesMap[r.user_id] = [];
        rolesMap[r.user_id].push(r.role);
      });

      const accessMap: Record<string, { module: string; action: string }[]> = {};
      (accessRes.data || []).forEach((a: any) => {
        if (!accessMap[a.user_id]) accessMap[a.user_id] = [];
        accessMap[a.user_id].push({ module: a.module, action: a.action });
      });

      const approvalMap: Record<string, { is_approved: boolean; approved_at: string | null; approved_by: string | null }> = {};
      (profilesRes.data || []).forEach((p: any) => {
        approvalMap[p.id] = {
          is_approved: p.is_approved !== false,
          approved_at: p.approved_at || null,
          approved_by: p.approved_by || null,
        };
      });

      const result = users.map((u: any) => {
        const roles = rolesMap[u.id] || [];
        const primaryRole = roles.includes("admin") ? "admin"
          : roles.includes("viewer") ? "viewer"
          : "user";
        const approval = approvalMap[u.id] || { is_approved: true, approved_at: null, approved_by: null };
        return {
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
          banned_until: (u as any).banned_until || null,
          role: primaryRole,
          grants: accessMap[u.id] || [],
          is_approved: primaryRole === "admin" ? true : approval.is_approved,
          approved_at: approval.approved_at,
          approved_by: approval.approved_by,
        };
      }).sort((a: any, b: any) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      return json({ users: result });
    }

    // ========== SET ROLE ==========
    if (action === "set_role") {
      const { target_user_id, new_role } = body;
      if (!target_user_id || !ROLES.includes(new_role)) {
        return json({ error: "Invalid target_user_id or role" }, 400);
      }

      // Self-demotion guard for the only safety case: removing own admin
      if (target_user_id === user.id && new_role !== "admin") {
        if (!body.confirm_self_demote) {
          return json({ error: "self_demote_requires_confirmation" }, 400);
        }
      }

      // Capture old role
      const { data: oldRoles } = await admin.from("user_roles")
        .select("role").eq("user_id", target_user_id);
      const oldRole = (oldRoles || []).some((r: any) => r.role === "admin") ? "admin"
        : (oldRoles || []).some((r: any) => r.role === "viewer") ? "viewer"
        : "user";

      // Wipe existing rows in our managed enum values, then insert the new one
      await admin.from("user_roles").delete()
        .eq("user_id", target_user_id)
        .in("role", ["admin", "user", "viewer"]);

      const { error: insErr } = await admin.from("user_roles")
        .insert({ user_id: target_user_id, role: new_role });
      if (insErr) throw insErr;

      // If becoming admin, ensure admin_profiles row exists
      if (new_role === "admin") {
        const { data: tu } = await admin.auth.admin.getUserById(target_user_id);
        await admin.from("admin_profiles").upsert(
          { user_id: target_user_id, display_name: tu?.user?.email?.split("@")[0] || "" },
          { onConflict: "user_id" },
        );
      }

      await admin.from("admin_audit_log").insert({
        actor_id: user.id,
        target_user_id,
        action: "role_change",
        details: { old_role: oldRole, new_role },
      });

      return json({ success: true, old_role: oldRole, new_role });
    }

    // ========== SET MODULE ACCESS (bulk replace) ==========
    if (action === "set_module_access") {
      const { target_user_id, grants } = body;
      if (!target_user_id || !Array.isArray(grants)) {
        return json({ error: "Invalid target_user_id or grants" }, 400);
      }

      // Validate
      for (const g of grants) {
        if (!MODULES.includes(g.module) || !ACTIONS.includes(g.action)) {
          return json({ error: `Invalid grant: ${JSON.stringify(g)}` }, 400);
        }
      }

      // Capture previous
      const { data: prev } = await admin.from("user_module_access")
        .select("module, action").eq("user_id", target_user_id);

      // Replace all
      await admin.from("user_module_access").delete().eq("user_id", target_user_id);
      if (grants.length > 0) {
        const rows = grants.map((g: any) => ({
          user_id: target_user_id, module: g.module, action: g.action,
        }));
        const { error: insErr } = await admin.from("user_module_access").insert(rows);
        if (insErr) throw insErr;
      }

      await admin.from("admin_audit_log").insert({
        actor_id: user.id,
        target_user_id,
        action: "module_access_change",
        details: { previous: prev || [], new: grants },
      });

      return json({ success: true, count: grants.length });
    }

    // ========== AUDIT LOG ==========
    if (action === "list_audit") {
      const { target_user_id, limit = 50 } = body;
      let q = admin.from("admin_audit_log")
        .select("id, actor_id, target_user_id, action, details, created_at")
        .order("created_at", { ascending: false })
        .limit(Math.min(Number(limit) || 50, 200));
      if (target_user_id) q = q.eq("target_user_id", target_user_id);
      const { data, error } = await q;
      if (error) throw error;

      // Enrich with emails
      const ids = Array.from(new Set((data || []).flatMap((r: any) => [r.actor_id, r.target_user_id])));
      const { data: authData } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const emailMap: Record<string, string> = {};
      (authData?.users || []).forEach((u: any) => { emailMap[u.id] = u.email || ""; });

      const enriched = (data || []).map((r: any) => ({
        ...r,
        actor_email: emailMap[r.actor_id] || "unknown",
        target_email: emailMap[r.target_user_id] || "unknown",
      }));

      return json({ entries: enriched });
    }

    // ========== SET APPROVAL ==========
    if (action === "set_approval") {
      const { target_user_id, approved } = body;
      if (!target_user_id || typeof approved !== "boolean") {
        return json({ error: "Invalid target_user_id or approved" }, 400);
      }
      if (target_user_id === user.id && approved === false) {
        return json({ error: "Cannot revoke your own approval" }, 400);
      }

      const patch: Record<string, unknown> = approved
        ? { is_approved: true, approved_at: new Date().toISOString(), approved_by: user.id }
        : { is_approved: false, approved_at: null, approved_by: null };

      const { error: upErr } = await admin
        .from("profiles")
        .update(patch)
        .eq("id", target_user_id);
      if (upErr) throw upErr;

      await admin.from("admin_audit_log").insert({
        actor_id: user.id,
        target_user_id,
        action: approved ? "approval_granted" : "approval_revoked",
        details: { approved },
      });

      return json({ success: true, is_approved: approved });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err: any) {
    console.error("[admin-user-permissions] error", err);
    return json({ error: (err as Error).message || String(err) }, 500);
  }
});
