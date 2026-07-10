import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * resume-needs-review
 *
 * Safely re-enables LEGACY "Needs review" assignments — rows that were
 * disabled before the audit-trail system existed. ONLY resumes rows where:
 *   - is_enabled = false
 *   - last_disabled_by IS NULL  (no audit = legacy)
 *   - manual_paused = false      (not a real user pause)
 *   - rule_id IS NOT NULL        (rule attached)
 *   - matching inventory exists  (US: inventory row non-terminal;
 *                                 Intl: intl_listing_status not bad)
 *
 * NEVER touches: manually paused, system/cleanup-disabled, no-rule,
 * no-inventory, or terminal listings.
 *
 * Modes:
 *   { mode: 'preview' }  -> returns counts + reason breakdown
 *   { mode: 'apply' }    -> performs the resume
 *   optional: { marketplace: 'US' | 'CA' | ... }  -> scope to one marketplace
 */

const TERMINAL_US = new Set(["NOT_IN_CATALOG", "DELETED", "NOT_FOUND"]);
const BAD_INTL = new Set(["UNKNOWN", "NOT_FOUND", "INACTIVE", "[]", ""]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Identify caller
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const mode: "preview" | "apply" = body?.mode === "apply" ? "apply" : "preview";
    const marketplaceFilter: string | undefined = body?.marketplace;

    const supabase = createClient(supabaseUrl, serviceKey);

    // Fetch all disabled assignments for this user
    let q = supabase
      .from("repricer_assignments")
      .select("id, asin, sku, marketplace, rule_id, is_enabled, manual_paused, last_disabled_by, intl_listing_status")
      .eq("user_id", userId)
      .eq("is_enabled", false);
    if (marketplaceFilter) q = q.eq("marketplace", marketplaceFilter);

    const { data: assignments, error: aErr } = await q.limit(10000);
    if (aErr) throw aErr;

    const stats = {
      total_disabled: assignments?.length || 0,
      eligible: 0,
      skip_manual_paused: 0,
      skip_system_disabled: 0,
      skip_no_rule: 0,
      skip_no_inventory: 0,
      skip_intl_ineligible: 0,
    };

    // Pre-filter: legacy candidates (no audit, no manual pause, has rule)
    const legacyCandidates: any[] = [];
    for (const a of assignments || []) {
      if (a.manual_paused === true) { stats.skip_manual_paused++; continue; }
      if (a.last_disabled_by) { stats.skip_system_disabled++; continue; }
      if (!a.rule_id) { stats.skip_no_rule++; continue; }
      legacyCandidates.push(a);
    }

    // Inventory lookup for US candidates (no marketplace column on inventory)
    const usCandidates = legacyCandidates.filter(a => a.marketplace === "US");
    const intlCandidates = legacyCandidates.filter(a => a.marketplace !== "US");

    const usKeys = new Set<string>();
    if (usCandidates.length) {
      const skus = [...new Set(usCandidates.map(a => a.sku).filter(Boolean))];
      for (let i = 0; i < skus.length; i += 200) {
        const batch = skus.slice(i, i + 200);
        const { data: inv } = await supabase
          .from("inventory")
          .select("sku, asin, listing_status")
          .eq("user_id", userId)
          .in("sku", batch);
        for (const r of inv || []) {
          const status = (r.listing_status || "").toUpperCase();
          if (TERMINAL_US.has(status)) continue;
          usKeys.add(`${r.asin}|${r.sku}`);
        }
      }
    }

    const toResumeIds: string[] = [];
    for (const a of usCandidates) {
      if (usKeys.has(`${a.asin}|${a.sku}`)) {
        stats.eligible++;
        toResumeIds.push(a.id);
      } else {
        stats.skip_no_inventory++;
      }
    }
    for (const a of intlCandidates) {
      const intl = (a.intl_listing_status || "").toUpperCase();
      if (!intl || BAD_INTL.has(intl)) {
        stats.skip_intl_ineligible++;
        continue;
      }
      stats.eligible++;
      toResumeIds.push(a.id);
    }

    if (mode === "preview") {
      return new Response(JSON.stringify({ success: true, mode, stats, eligible_ids_count: toResumeIds.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Apply
    let updated = 0;
    const nowIso = new Date().toISOString();
    for (let i = 0; i < toResumeIds.length; i += 200) {
      const chunk = toResumeIds.slice(i, i + 200);
      const { error: uErr, data } = await supabase
        .from("repricer_assignments")
        .update({
          is_enabled: true,
          manual_paused: false,
          last_enabled_by: "user",
          last_enabled_at: nowIso,
          last_disabled_by: null,
          last_disabled_reason: null,
          last_disabled_at: null,
        })
        .in("id", chunk)
        .select("id");
      if (uErr) throw uErr;
      updated += data?.length || 0;
    }

    return new Response(JSON.stringify({ success: true, mode, stats, updated }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[resume-needs-review] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
