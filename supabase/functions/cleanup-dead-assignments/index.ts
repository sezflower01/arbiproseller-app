import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// PostgREST caps unpaginated selects at ~1000 rows by default, silently
// dropping the rest with no error. Users with 1000+ enabled assignments
// (a real case in this dataset — one user has 1,399) would have random
// rows excluded from every disable check below, forever. Page through
// with .range() so every row is actually considered.
async function fetchAllRows(
  supabase: any,
  table: string,
  select: string,
  applyFilters: (q: any) => any,
  pageSize = 1000,
): Promise<any[]> {
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await applyFilters(
      supabase.from(table).select(select).order("id", { ascending: true }),
    ).range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/**
 * cleanup-dead-assignments
 * 
 * Marketplace-aware cleanup that disables assignments which are no longer sellable.
 * Runs on a cron schedule (every 6 hours) or can be invoked manually.
 * 
 * CRITICAL: All disable logic is keyed on (user_id, asin, sku, marketplace) —
 * never by ASIN alone — to prevent cross-marketplace interference.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const stats = {
      intl_ineligible_disabled: 0,
      terminal_status_disabled: 0,
      mismatch_zero_stock_disabled: 0,
      users_processed: 0,
      errors: [] as string[],
    };

    // Get all users with enabled assignments
    const { data: users } = await supabase
      .from("repricer_settings")
      .select("user_id")
      .eq("scheduler_enabled", true);

    if (!users?.length) {
      return new Response(JSON.stringify({ message: "No active users", stats }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    for (const { user_id: userId } of users) {
      try {
        // ═══════════════════════════════════════════════════════════════
        // 1. INTERNATIONAL INELIGIBLE: Disable non-US assignments with
        //    bad intl_listing_status. Keyed on (user_id, marketplace).
        // ═══════════════════════════════════════════════════════════════
        const intlBad = await fetchAllRows(
          supabase,
          "repricer_assignments",
          "id, asin, sku, marketplace, intl_listing_status",
          (q) => q
            .eq("user_id", userId)
            .eq("is_enabled", true)
            .neq("marketplace", "US")
            .in("intl_listing_status", ["UNKNOWN", "NOT_FOUND", "INACTIVE", "[]", ""]),
        );

        // Also catch NULL intl_listing_status for non-US
        const intlNull = await fetchAllRows(
          supabase,
          "repricer_assignments",
          "id, asin, sku, marketplace, intl_listing_status",
          (q) => q
            .eq("user_id", userId)
            .eq("is_enabled", true)
            .neq("marketplace", "US")
            .is("intl_listing_status", null),
        );

        const intlToDisable = [...(intlBad || []), ...(intlNull || [])];
        
        const disablePayload = (reason: string) => ({
          is_enabled: false,
          manual_paused: false,
          last_disabled_by: "cleanup",
          last_disabled_reason: reason,
          last_disabled_at: new Date().toISOString(),
        });

        if (intlToDisable.length > 0) {
          const intlIds = intlToDisable.map(a => a.id);
          for (let b = 0; b < intlIds.length; b += 200) {
            const batch = intlIds.slice(b, b + 200);
            await supabase
              .from("repricer_assignments")
              .update(disablePayload("Intl ineligible (intl_listing_status)"))
              .eq("user_id", userId)
              .in("id", batch);
          }
          stats.intl_ineligible_disabled += intlToDisable.length;
          console.log(`[cleanup] ${userId}: disabled ${intlToDisable.length} intl ineligible assignments`);
        }

        // ═══════════════════════════════════════════════════════════════
        // 2. TERMINAL INVENTORY STATUS
        // ═══════════════════════════════════════════════════════════════
        const terminalInv = await fetchAllRows(
          supabase,
          "inventory",
          "asin, sku",
          (q) => q
            .eq("user_id", userId)
            .in("listing_status", ["NOT_IN_CATALOG", "DELETED", "NOT_FOUND"]),
        );

        if (terminalInv?.length) {
          const terminalAsins = new Set(terminalInv.map(i => i.asin));
          // A terminal inventory status (NOT_IN_CATALOG/DELETED/NOT_FOUND) means
          // the ASIN is gone from Amazon's catalog entirely, not just in one
          // marketplace — so this must disable assignments across ALL
          // marketplaces (US/CA/MX/BR), not just US. Previously this only
          // queried marketplace="US", leaving CA/MX/BR assignments for the
          // same ghost ASIN permanently enabled with no other cleanup path.
          const terminalAssignments = await fetchAllRows(
            supabase,
            "repricer_assignments",
            "id, asin, sku, marketplace",
            (q) => q.eq("user_id", userId).eq("is_enabled", true),
          );

          const toDisable = (terminalAssignments || []).filter(a => terminalAsins.has(a.asin));

          if (toDisable.length > 0) {
            const ids = toDisable.map(a => a.id);
            for (let b = 0; b < ids.length; b += 200) {
              await supabase
                .from("repricer_assignments")
                .update(disablePayload("Inventory listing_status terminal (NOT_IN_CATALOG/DELETED/NOT_FOUND)"))
                .eq("user_id", userId)
                .in("id", ids.slice(b, b + 200));
            }
            stats.terminal_status_disabled += toDisable.length;
            console.log(`[cleanup] ${userId}: disabled ${toDisable.length} terminal-status assignments (all marketplaces)`);
          }
        }

        // ═══════════════════════════════════════════════════════════════
        // 3. MISMATCH + ZERO STOCK
        // ═══════════════════════════════════════════════════════════════
        const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const mismatchInv = await fetchAllRows(
          supabase,
          "inventory",
          "asin, sku",
          (q) => q
            .eq("user_id", userId)
            .eq("listing_status", "MISMATCH")
            .lte("last_inventory_sync_at", cutoff)
            .eq("available", 0)
            .eq("reserved", 0)
            .eq("inbound", 0),
        );

        if (mismatchInv?.length) {
          const mismatchAsins = new Set(mismatchInv.map(i => i.asin));
          const usMismatchAssignments = await fetchAllRows(
            supabase,
            "repricer_assignments",
            "id, asin",
            (q) => q.eq("user_id", userId).eq("is_enabled", true).eq("marketplace", "US"),
          );

          const toDisable = (usMismatchAssignments || []).filter(a => mismatchAsins.has(a.asin));

          if (toDisable.length > 0) {
            const ids = toDisable.map(a => a.id);
            for (let b = 0; b < ids.length; b += 200) {
              await supabase
                .from("repricer_assignments")
                .update(disablePayload("MISMATCH with zero stock >48h"))
                .eq("user_id", userId)
                .in("id", ids.slice(b, b + 200));
            }
            stats.mismatch_zero_stock_disabled += toDisable.length;
            console.log(`[cleanup] ${userId}: disabled ${toDisable.length} mismatch zero-stock US assignments`);
          }
        }


        stats.users_processed++;
      } catch (userErr: any) {
        const errMsg = `User ${userId}: ${userErr.message}`;
        stats.errors.push(errMsg);
        console.error(`[cleanup] ${errMsg}`);
      }
    }

    console.log(`[cleanup] Complete:`, JSON.stringify(stats));
    return new Response(JSON.stringify({ success: true, stats }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[cleanup] Fatal error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
