import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkCircuitBreaker } from '../_shared/repricer-hardening.ts';
import { requireInternalOrUser } from '../_shared/require-internal.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function isLegacyAnonCronCall(req: Request): boolean {
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return Boolean(anonKey && bearer === anonKey && !req.headers.get("x-internal-secret"));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (isLegacyAnonCronCall(req)) {
    console.log("[auto-turbo] Legacy anon cron call ignored; v2 internal cron handles this job.");
    return new Response(JSON.stringify({ success: true, ignored_legacy_anon_cron: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;


  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  try {
    // === IDLE GUARD: Check if any unacted BB alerts exist before doing per-user work ===
    const { count: globalAlertCount } = await sb
      .from("bb_price_alerts")
      .select("id", { count: "exact", head: true })
      .eq("dismissed", false)
      .eq("acted", false);

    if (!globalAlertCount || globalAlertCount === 0) {
      console.log("[auto-turbo] IDLE SKIP — no unacted BB alerts globally");
      return new Response(JSON.stringify({ message: "No unacted alerts — idle skip", idle: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get all users with auto_turbo_enabled
    const { data: settings, error: settingsErr } = await sb
      .from("repricer_settings")
      .select("user_id, auto_turbo_enabled, auto_turbo_duration_minutes, auto_turbo_rule_id, auto_turbo_last_rotation_at, auto_turbo_current_batch, auto_turbo_rotation_pool, auto_turbo_rotation_cursor, safe_mode_active, safe_mode_reason, safe_mode_auto_resume_at, circuit_breaker_error_count, circuit_breaker_window_start")
      .eq("auto_turbo_enabled", true);

    if (settingsErr) throw settingsErr;
    if (!settings || settings.length === 0) {
      return new Response(JSON.stringify({ message: "No users with auto-turbo enabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: any[] = [];

    for (const userSettings of settings) {
      const userId = userSettings.user_id;

      // === CIRCUIT BREAKER CHECK ===
      const cbCheck = await checkCircuitBreaker(sb, userId, userSettings);
      if (cbCheck.triggered) {
        console.log(`[auto-turbo] Skipping ${userId} — safe mode: ${cbCheck.reason}`);
        results.push({ userId, action: 'safe_mode', reason: cbCheck.reason });
        continue;
      }

      const durationMinutes = userSettings.auto_turbo_duration_minutes || 30;
      const turboRuleId = userSettings.auto_turbo_rule_id;
      const currentBatch: any[] = userSettings.auto_turbo_current_batch || [];
      let rotationPool: string[] = userSettings.auto_turbo_rotation_pool || [];
      let rotationCursor: number = userSettings.auto_turbo_rotation_cursor || 0;

      // ========== STEP 0: Count manual stars (protected from auto-rotation) ==========
      const { count: manualStarCount } = await sb
        .from("repricer_assignments")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("is_manual_priority", true)
        .eq("is_priority", true);
      
      const manualStars = manualStarCount || 0;
      const MAX_TOTAL = 5;
      const autoSlots = Math.max(0, MAX_TOTAL - manualStars);
      
      console.log(`[auto-turbo] User ${userId}: manual stars=${manualStars}, auto slots=${autoSlots}`);

      // ========== STEP 1: Refresh the rotation pool from all unacted alerts ==========
      const { data: allAlerts } = await sb
        .from("bb_price_alerts")
        .select("asin")
        .eq("user_id", userId)
        .eq("dismissed", false)
        .eq("acted", false);

      const alertAsins = [...new Set((allAlerts || []).map((a: any) => a.asin))];

      // Pool = ONLY notification ASINs
      rotationPool = alertAsins;

      // Filter to only ASINs that have an enabled assignment
      const { data: allAssignments } = await sb
        .from("repricer_assignments")
        .select("asin, sku, rule_id")
        .eq("user_id", userId)
        .eq("is_enabled", true);

      const assignedAsinSet = new Set((allAssignments || []).map((a: any) => a.asin));
      const noAssignment = rotationPool.filter(asin => !assignedAsinSet.has(asin));
      rotationPool = rotationPool.filter(asin => assignedAsinSet.has(asin));

      // Track and EXCLUDE ASINs without rules
      const asinsWithRules = new Set((allAssignments || []).filter((a: any) => a.rule_id).map((a: any) => a.asin));
      const noRule = rotationPool.filter(asin => !asinsWithRules.has(asin));
      rotationPool = rotationPool.filter(asin => asinsWithRules.has(asin));

      // Filter out zero-stock ASINs
      const skusByAsin = new Map<string, string>();
      for (const a of (allAssignments || [])) {
        if (a.sku) skusByAsin.set(a.asin, a.sku);
      }
      const relevantSkus = rotationPool.map(asin => skusByAsin.get(asin)).filter(Boolean) as string[];
      const missingSku = rotationPool.filter(asin => !skusByAsin.has(asin));
      
      let removedZeroStock: string[] = [];
      if (relevantSkus.length > 0) {
        const { data: stockItems } = await sb
          .from("inventory")
          .select("sku, asin, available")
          .eq("user_id", userId)
          .in("sku", relevantSkus.slice(0, 500));

        const inStockAsins = new Set(
          (stockItems || [])
            .filter((i: any) => (i.available ?? 0) > 0)
            .map((i: any) => i.asin)
        );

        removedZeroStock = rotationPool.filter(asin => !inStockAsins.has(asin) && !missingSku.includes(asin));
        rotationPool = rotationPool.filter(asin => inStockAsins.has(asin));
      }

      // Diagnostic: show why pool was reduced
      const diagnostics = {
        alertAsins: alertAsins.length,
        noAssignment: noAssignment.length,
        noRule: noRule.length,
        missingSku: missingSku.length,
        zeroStock: removedZeroStock.length,
        eligible: rotationPool.length,
      };
      console.log(`[auto-turbo] User ${userId}: pool diagnostics:`, JSON.stringify(diagnostics));
      console.log(`[auto-turbo] User ${userId}: pool size=${rotationPool.length}, cursor=${rotationCursor}`);

      if (rotationPool.length === 0 || autoSlots === 0) {
        // Blanket clear all auto stars (not just batch IDs)
        await sb
          .from("repricer_assignments")
          .update({ is_priority: false })
          .eq("user_id", userId)
          .eq("is_priority", true)
          .eq("is_manual_priority", false);

        await sb.from("repricer_settings").update({
          auto_turbo_rotation_pool: rotationPool,
          auto_turbo_rotation_cursor: 0,
          auto_turbo_current_batch: [],
          auto_turbo_last_rotation_at: new Date().toISOString(),
        }).eq("user_id", userId);
        results.push({ userId, action: autoSlots === 0 ? "no_auto_slots" : "empty_pool", manualStars, diagnostics });
        continue;
      }

      // ========== STEP 2: Check if current batch has expired ==========
      const now = new Date();
      let needNewBatch = false;

      if (currentBatch.length > 0) {
        const oldestStarted = currentBatch.reduce((min: string, item: any) => {
          return item.started_at < min ? item.started_at : min;
        }, currentBatch[0].started_at);

        const elapsed = (now.getTime() - new Date(oldestStarted).getTime()) / 60000;

        if (elapsed >= durationMinutes) {
          // Duration expired - restore original rule_ids for current batch
          for (const item of currentBatch) {
            if (item.original_rule_id) {
              await sb
                .from("repricer_assignments")
                .update({ rule_id: item.original_rule_id })
                .eq("id", item.assignment_id)
                .eq("user_id", userId);
            }
          }

          // Unstar ONLY auto-turbo batch items (not manual stars)
          const batchIds = currentBatch.map((b: any) => b.assignment_id);
          await sb
            .from("repricer_assignments")
            .update({ is_priority: false })
            .eq("user_id", userId)
            .in("id", batchIds);

          // Mark related alerts as acted
          const batchAsins = currentBatch.map((i: any) => i.asin);
          await sb
            .from("bb_price_alerts")
            .update({ acted: true })
            .eq("user_id", userId)
            .in("asin", batchAsins)
            .eq("dismissed", false);

          needNewBatch = true;
        }
      } else {
        needNewBatch = true;
      }

      if (!needNewBatch) {
        // Save updated pool even if batch is still active
        await sb.from("repricer_settings").update({
          auto_turbo_rotation_pool: rotationPool,
        }).eq("user_id", userId);
        results.push({ userId, action: "batch_still_active", remaining: currentBatch.length, poolSize: rotationPool.length, manualStars });
        continue;
      }

      // ========== STEP 2b: BLANKET CLEAR all auto stars (prevents star accumulation) ==========
      // Instead of clearing only previous batch IDs, clear ALL non-manual stars
      // This prevents the 27/5 bug where old auto-stars linger from crashed rotations
      const { data: clearedRows } = await sb
        .from("repricer_assignments")
        .update({ is_priority: false })
        .eq("user_id", userId)
        .eq("is_priority", true)
        .eq("is_manual_priority", false)
        .select("id");

      const clearedCount = clearedRows?.length || 0;
      console.log(`[auto-turbo] User ${userId}: blanket-cleared ${clearedCount} auto stars, preserving ${manualStarCount} manual stars`);

      // ========== STEP 3: Pick next N from rotation pool using cursor (N = autoSlots) ==========
      // Wrap cursor if past end
      if (rotationCursor >= rotationPool.length) {
        rotationCursor = 0;
      }

      const selectedAsins: string[] = [];
      for (let i = 0; i < Math.min(autoSlots, rotationPool.length); i++) {
        const idx = (rotationCursor + i) % rotationPool.length;
        selectedAsins.push(rotationPool[idx]);
      }

      // Advance cursor for next rotation
      const nextCursor = (rotationCursor + selectedAsins.length) % rotationPool.length;

      // ========== STEP 4: Star the selected ASINs ==========
      const newBatch: any[] = [];
      for (const asin of selectedAsins) {
        const { data: assignments } = await sb
          .from("repricer_assignments")
          .select("id, rule_id, marketplace")
          .eq("user_id", userId)
          .eq("asin", asin)
          .eq("is_enabled", true)
          .limit(1);

        const assignment = assignments?.[0];
        if (!assignment) continue;

        const updatePayload: any = { is_priority: true };
        if (turboRuleId) updatePayload.rule_id = turboRuleId;

        await sb.from("repricer_assignments").update(updatePayload).eq("id", assignment.id);

        newBatch.push({
          assignment_id: assignment.id,
          asin,
          original_rule_id: assignment.rule_id,
          started_at: now.toISOString(),
        });
      }

      // ========== STEP 5: Save state ==========
      await sb.from("repricer_settings").update({
        auto_turbo_current_batch: newBatch,
        auto_turbo_rotation_pool: rotationPool,
        auto_turbo_rotation_cursor: nextCursor,
        auto_turbo_last_rotation_at: now.toISOString(),
      }).eq("user_id", userId);

      results.push({
        userId,
        action: "new_batch_started",
        asins: newBatch.map((b: any) => b.asin),
        poolSize: rotationPool.length,
        cursor: `${rotationCursor} → ${nextCursor}`,
        duration: durationMinutes,
        manualStars,
        autoSlots,
        diagnostics,
      });
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("Auto-turbo error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
