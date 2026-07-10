import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Get all users with scheduler enabled
    const { data: settings } = await sb
      .from("repricer_settings")
      .select("user_id")
      .eq("scheduler_enabled", true);

    console.log(`[monitor-snapshot] Found ${settings?.length ?? 0} users with scheduler enabled`);

    if (!settings || settings.length === 0) {
      return new Response(JSON.stringify({ ok: true, snapshots: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date();
    const nowMs = now.getTime();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();
    const twentyFourHoursAgo = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const hotStalenessThresholdMs = 30 * 60 * 1000; // 30 minutes

    const snapshots: any[] = [];

    for (const { user_id } of settings) {
      try {
        // Fetch assignments with fields needed for HOT classification
        const { data: assignments, error: aErr } = await sb
          .from("repricer_assignments")
          .select("asin, status, is_enabled, rule_id, marketplace, last_sp_api_check_at, last_applied_price, last_buybox_status, is_priority, is_manual_priority, manual_min_price, last_floor_price_cents, buybox_lost_at, last_price_change_at, oscillation_cooldown_until, last_evaluated_at")
          .eq("user_id", user_id);

        if (aErr) {
          console.error(`[monitor-snapshot] User ${user_id}: assignment query error:`, aErr.message);
          continue;
        }

        if (!assignments || assignments.length === 0) {
          console.log(`[monitor-snapshot] User ${user_id}: no assignments found`);
          continue;
        }

        // US ASINs with rules for inheritance
        const usAsinsWithRule = new Set(
          assignments.filter((a: any) => a.marketplace === "US" && a.rule_id).map((a: any) => a.asin)
        );
        const hasEffectiveRule = (a: any) =>
          !!a.rule_id || (a.marketplace !== "US" && usAsinsWithRule.has(a.asin));

        // Eligible = active + enabled + has rule
        const eligible = assignments.filter(
          (a: any) => a.status === "active" && a.is_enabled !== false && hasEffectiveRule(a)
        );

        // Fetch recent BB alerts for HOT classification
        const { data: bbAlerts } = await sb
          .from("bb_price_alerts")
          .select("asin")
          .eq("user_id", user_id)
          .eq("dismissed", false)
          .gte("created_at", new Date(nowMs - 4 * 60 * 60 * 1000).toISOString());

        const alertedAsins = new Set((bbAlerts || []).map((a: any) => a.asin));

        // Fetch today's sales for HOT classification
        const todayStr = now.toISOString().slice(0, 10);
        const { data: salesToday } = await sb
          .from("asin_sales_daily")
          .select("asin")
          .eq("user_id", user_id)
          .eq("date", todayStr)
          .gt("units", 0);

        const soldTodayAsins = new Set((salesToday || []).map((s: any) => s.asin));

        // Classify HOT using same signals as dispatcher
        const hot = eligible.filter((a: any) => {
          // Starred (manual priority)
          if (a.is_priority || a.is_manual_priority) return true;
          // BB alert (active, undismissed)
          if (alertedAsins.has(a.asin)) return true;
          // BB loss (recent)
          if (a.last_buybox_status === "losing" && a.buybox_lost_at) {
            const lostAge = nowMs - new Date(a.buybox_lost_at).getTime();
            if (lostAge < 4 * 60 * 60 * 1000) return true; // Lost within 4h
          }
          // Cooldown just expired
          if (a.oscillation_cooldown_until) {
            const cooldownUntil = new Date(a.oscillation_cooldown_until).getTime();
            if (cooldownUntil > 0 && cooldownUntil <= nowMs && (nowMs - cooldownUntil) < 15 * 60 * 1000) return true;
          }
          // Sold today
          if (soldTodayAsins.has(a.asin)) return true;
          // Recent competitive move (price changed in last 30min)
          if (a.last_price_change_at) {
            const changeAge = nowMs - new Date(a.last_price_change_at).getTime();
            if (changeAge < 30 * 60 * 1000) return true;
          }
          return false;
        });

        // HOT freshness
        const hotFreshness = hot.map((a: any) => {
          if (!a.last_sp_api_check_at) return 9999;
          return (nowMs - new Date(a.last_sp_api_check_at).getTime()) / 60000;
        }).sort((a: number, b: number) => a - b);

        const p50Idx = Math.floor(hotFreshness.length * 0.5);
        const p90Idx = Math.min(Math.floor(hotFreshness.length * 0.9), hotFreshness.length - 1);
        const hotP50 = hotFreshness.length > 0 ? Math.round(hotFreshness[p50Idx]) : 0;
        const hotP90 = hotFreshness.length > 0 ? Math.round(hotFreshness[Math.max(0, p90Idx)]) : 0;

        // HOT blocked = bb owner stable OR at floor
        const hotBlocked = hot.filter((a: any) => {
          const bb = a.last_buybox_status;
          const minP = a.manual_min_price || (a.last_floor_price_cents ? a.last_floor_price_cents / 100 : null);
          return bb === "winning" || bb === "owned" || (a.last_applied_price && minP && a.last_applied_price <= minP * 1.01);
        }).length;
        const hotDispatchable = hot.length - hotBlocked;
        const hotStale = hot.filter((a: any) => {
          if (!a.last_sp_api_check_at) return true;
          return (nowMs - new Date(a.last_sp_api_check_at).getTime()) > hotStalenessThresholdMs;
        }).length;

        console.log(`[monitor-snapshot] User ${user_id}: ${eligible.length} eligible, ${hot.length} HOT (${hotBlocked} blocked, ${hotDispatchable} dispatchable, ${hotStale} stale)`);

        // Actions for throughput + constraints
        const { data: actions } = await sb
          .from("repricer_price_actions")
          .select("asin, action_type, success, error_type, intelligence_factors, created_at")
          .eq("user_id", user_id)
          .gte("created_at", twentyFourHoursAgo)
          .limit(2000);

        const acts = actions || [];
        const acts1h = acts.filter((a: any) => new Date(a.created_at) >= new Date(oneHourAgo));

        const evals24h = acts.length;
        const writes24h = acts.filter((a: any) => a.success && (a.action_type === "price_changed" || a.action_type === "price_change" || a.action_type === "changed")).length;
        const evals1h = acts1h.length;
        const writes1h = acts1h.filter((a: any) => a.success && (a.action_type === "price_changed" || a.action_type === "price_change" || a.action_type === "changed")).length;

        // Coverage
        const eligibleChecked24h = eligible.filter((a: any) =>
          a.last_sp_api_check_at && new Date(a.last_sp_api_check_at) >= todayStart
        ).length;
        const coveragePct = eligible.length > 0 ? Math.round((eligibleChecked24h / eligible.length) * 1000) / 10 : 0;

        // Constraint pressure
        let constraintProfitGuard = 0;
        let constraintMinBound = 0;
        let constraintMarketStable = 0;
        let constraintOther = 0;

        for (const a of acts) {
          // profit_guard branch removed — Profit Guard no longer fires.
          if (a.intelligence_factors?.constraint === "min_bound" || a.intelligence_factors?.reason?.includes?.("MIN")) {
            constraintMinBound++;
          } else if (a.intelligence_factors?.constraint === "market_stable") {
            constraintMarketStable++;
          } else if (!a.success && a.error_type) {
            constraintOther++;
          }
        }

        // BB wins — use "winning" or "owned" status
        const bbWinning = eligible.filter((a: any) => a.last_buybox_status === "winning" || a.last_buybox_status === "owned").length;
        const bbLosing = eligible.filter((a: any) => a.last_buybox_status === "losing").length;

        // Health score (simplified version)
        const systemHealth = 10;
        const hotResponsiveness = hot.length === 0 ? 10 : (hotStale === 0 ? 10 : Math.max(0, 10 - hotStale * 2));
        const optimizationActivity = writes24h > 0 ? Math.min(10, 5 + (writes24h / Math.max(evals24h, 1)) * 5) : 0;
        const coverage = Math.min(10, coveragePct / 10);
        const healthScore = Math.round(((systemHealth + hotResponsiveness + optimizationActivity + coverage) / 4) * 10) / 10;

        snapshots.push({
          user_id,
          captured_at: now.toISOString(),
          hot_eligible: hot.length,
          hot_dispatchable: hotDispatchable,
          hot_blocked: hotBlocked,
          hot_truly_stale: hotStale,
          hot_p50_minutes: hotP50,
          hot_p90_minutes: hotP90,
          evals_1h: evals1h,
          writes_1h: writes1h,
          evals_24h: evals24h,
          writes_24h: writes24h,
          eligible_total: eligible.length,
          eligible_checked_24h: eligibleChecked24h,
          coverage_pct: coveragePct,
          constraint_profit_guard: constraintProfitGuard,
          constraint_min_bound: constraintMinBound,
          constraint_market_stable: constraintMarketStable,
          constraint_other: constraintOther,
          health_score: healthScore,
          bb_winning: bbWinning,
          bb_losing: bbLosing,
        });
      } catch (userErr) {
        console.error(`[monitor-snapshot] Snapshot failed for user ${user_id}:`, userErr);
      }
    }

    // Batch insert
    if (snapshots.length > 0) {
      const { error } = await sb.from("repricer_monitor_snapshots").insert(snapshots);
      if (error) {
        console.error("[monitor-snapshot] Insert error:", error);
        return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Cleanup old snapshots (30-day retention)
    await sb.rpc("cleanup_old_monitor_snapshots");

    return new Response(JSON.stringify({ ok: true, snapshots: snapshots.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[monitor-snapshot] Error:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
