import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireInternalCall } from "../_shared/require-internal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Cron-only orchestrator: discovers newly-stocked non-US (CA/MX/BR) ASINs
// into repricer_assignments automatically, the same way the "Verify {marketplace}
// listings" button's Step 1 does on-demand for a single user. Without this,
// new non-US listings never get a repricer_assignments row (and therefore never
// get priced or verified) until an admin clicks that button manually.
//
// Runs auto-assign-bulk once per (user, non-US marketplace they have active
// Amazon auth for). Scoped to users with the scheduler enabled, mirroring
// repricer-cron-trigger's user enumeration convention.
const INTL_MARKETPLACES: Record<string, string> = {
  CA: "A2EUQ1WTGCTBG2",
  MX: "A1AM78C64UM0Y8",
  BR: "A2Q3Y263D00KWC",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: enabledSettings, error: settingsError } = await supabase
      .from("repricer_settings")
      .select("user_id")
      .eq("scheduler_enabled", true);

    if (settingsError) throw settingsError;
    if (!enabledSettings || enabledSettings.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No scheduler-enabled users", processed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: any[] = [];

    for (const { user_id: userId } of enabledSettings) {
      const { data: authRows } = await supabase
        .from("seller_authorizations")
        .select("marketplace_id")
        .eq("user_id", userId)
        .eq("is_active", true);

      const activeMarketplaceIds = new Set((authRows || []).map((a: any) => a.marketplace_id));
      const marketplacesForUser = Object.entries(INTL_MARKETPLACES)
        .filter(([, mid]) => activeMarketplaceIds.has(mid))
        .map(([code]) => code);

      if (marketplacesForUser.length === 0) continue;

      for (const marketplace of marketplacesForUser) {
        try {
          const resp = await fetch(`${supabaseUrl}/functions/v1/auto-assign-bulk`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${supabaseKey}` },
            body: JSON.stringify({ user_id: userId, marketplace }),
          });
          const data = await resp.json().catch(() => null);
          results.push({
            user_id: userId,
            marketplace,
            status: resp.status,
            created: data?.created ?? null,
            skipped: data?.skipped ?? null,
            error: resp.ok ? null : (data?.error || `HTTP ${resp.status}`),
          });
        } catch (e) {
          results.push({ user_id: userId, marketplace, error: (e as Error).message });
        }
        // Small stagger between marketplace calls — auto-assign-bulk itself
        // is a heavy per-user scan; avoid back-to-back SP-API bursts.
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const totalCreated = results.reduce((sum, r) => sum + (Number(r.created) || 0), 0);
    const errors = results.filter((r) => r.error).length;
    console.log(`[auto-assign-bulk-intl-sweep] users=${enabledSettings.length} calls=${results.length} created=${totalCreated} errors=${errors}`);

    return new Response(JSON.stringify({ success: true, calls: results.length, created: totalCreated, errors, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[auto-assign-bulk-intl-sweep] Error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
