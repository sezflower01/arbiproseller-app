// Phase 1 — Self-Learning Proof: Outcome Attribution
//
// Computes baseline (T-7d), applied (T0), and measured (T+7d) snapshots
// for every tuning action, split by treatment vs control group.
//
// Triggered by:
//   - cron daily at 02:00 UTC (no body) → fills any missing baseline/measured
//   - manual call with { tuning_action_id, phase } for one-off recomputes
//
// Reads from: repricer_price_actions, repricer_competitor_snapshots, repricer_assignments
// Writes to:  smart_engine_outcome_snapshots

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WINDOW_DAYS = 7;
const STABILITY_HOURS = 6; // "no price change for N hours" threshold

interface Metrics {
  bb_win_rate_pct: number | null;
  price_changes_count: number;
  unnecessary_undercut_count: number;
  unnecessary_undercut_breakdown: Record<string, number>;
  realized_margin_avg: number | null;
  oscillation_events: number;
  floor_hits: number;
  hours_to_bb_regain: number | null;
  hours_to_price_stability: number | null;
  hours_to_no_further_cuts: number | null;
  sample_size: number;
}

function emptyMetrics(): Metrics {
  return {
    bb_win_rate_pct: null,
    price_changes_count: 0,
    unnecessary_undercut_count: 0,
    unnecessary_undercut_breakdown: {},
    realized_margin_avg: null,
    oscillation_events: 0,
    floor_hits: 0,
    hours_to_bb_regain: null,
    hours_to_price_stability: null,
    hours_to_no_further_cuts: null,
    sample_size: 0,
  };
}

async function computeMetricsForAsin(
  admin: any,
  userId: string,
  asin: string,
  marketplace: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<Metrics> {
  const m = emptyMetrics();

  // 1. Pull all price actions in window for this ASIN/marketplace
  const { data: actions } = await admin
    .from("repricer_price_actions")
    .select(
      "action_type, old_price, new_price, reason, was_unnecessary_undercut, unnecessary_undercut_reason, unnecessary_undercut_reasons, created_at, intelligence_factors",
    )
    .eq("user_id", userId)
    .eq("asin", asin)
    .eq("marketplace", marketplace)
    .gte("created_at", windowStart.toISOString())
    .lt("created_at", windowEnd.toISOString())
    .order("created_at", { ascending: true });

  const acts = actions ?? [];
  m.sample_size = acts.length;
  if (acts.length === 0) return m;

  // 2. Price changes count
  m.price_changes_count = acts.filter((a: any) => a.action_type === "price_changed").length;

  // 3. Unnecessary undercut tally + breakdown
  //    NEW: walk the multi-reason JSONB array if present so the breakdown
  //    counts every matched condition. The single-enum primary reason is still
  //    counted under its key for backward compatibility.
  for (const a of acts) {
    if (!a.was_unnecessary_undercut) continue;
    m.unnecessary_undercut_count++;
    const matched: string[] = Array.isArray(a.unnecessary_undercut_reasons)
      ? (a.unnecessary_undercut_reasons as string[])
      : (a.unnecessary_undercut_reason ? [a.unnecessary_undercut_reason] : ["unknown"]);
    for (const r of matched) {
      m.unnecessary_undercut_breakdown[r] = (m.unnecessary_undercut_breakdown[r] ?? 0) + 1;
    }
  }

  // 4. Floor hits
  m.floor_hits = acts.filter((a: any) =>
    typeof a.reason === "string" &&
    (a.reason.toLowerCase().includes("floor") || a.reason.toLowerCase().includes("min_price"))
  ).length;

  // 5. Oscillation events (direction change between consecutive price changes)
  const changes = acts.filter((a: any) => a.action_type === "price_changed" && a.old_price && a.new_price);
  let lastDirection: "up" | "down" | null = null;
  let oscillations = 0;
  for (const c of changes) {
    const dir: "up" | "down" = Number(c.new_price) > Number(c.old_price) ? "up" : "down";
    if (lastDirection !== null && dir !== lastDirection) oscillations++;
    lastDirection = dir;
  }
  m.oscillation_events = oscillations;

  // 6. Buy Box win rate from competitor snapshots
  const { data: snaps } = await admin
    .from("repricer_competitor_snapshots")
    .select("buybox_owner, fetched_at")
    .eq("user_id", userId)
    .eq("asin", asin)
    .eq("marketplace", marketplace)
    .gte("fetched_at", windowStart.toISOString())
    .lt("fetched_at", windowEnd.toISOString());

  if (snaps && snaps.length > 0) {
    const owned = snaps.filter((s: any) => s.buybox_owner === "self" || s.buybox_owner === "owned").length;
    m.bb_win_rate_pct = (owned / snaps.length) * 100;
  }

  // 7. Realized margin avg — from intelligence_factors when available
  const margins: number[] = [];
  for (const a of acts) {
    const f = a.intelligence_factors as any;
    if (f && typeof f.realized_margin === "number") margins.push(f.realized_margin);
    else if (f && typeof f.profit_margin_pct === "number") margins.push(f.profit_margin_pct);
  }
  if (margins.length > 0) {
    m.realized_margin_avg = margins.reduce((a, b) => a + b, 0) / margins.length;
  }

  // 8. Time-to-impact: hours_to_bb_regain
  // Find first BB-loss event in window, then first re-ownership snapshot
  if (snaps && snaps.length > 0) {
    const sortedSnaps = [...snaps].sort(
      (a: any, b: any) => new Date(a.fetched_at).getTime() - new Date(b.fetched_at).getTime(),
    );
    let lostAt: Date | null = null;
    for (const s of sortedSnaps) {
      const owned = s.buybox_owner === "self" || s.buybox_owner === "owned";
      if (!owned && lostAt === null) {
        lostAt = new Date(s.fetched_at);
      } else if (owned && lostAt !== null) {
        const hours = (new Date(s.fetched_at).getTime() - lostAt.getTime()) / 3_600_000;
        m.hours_to_bb_regain = hours;
        break;
      }
    }
  }

  // 9. Time-to-impact: hours_to_price_stability
  // First gap of >= STABILITY_HOURS between consecutive price changes
  if (changes.length >= 2) {
    for (let i = 1; i < changes.length; i++) {
      const gap = (new Date(changes[i].created_at).getTime() - new Date(changes[i - 1].created_at).getTime()) / 3_600_000;
      if (gap >= STABILITY_HOURS) {
        const elapsedFromStart = (new Date(changes[i - 1].created_at).getTime() - windowStart.getTime()) / 3_600_000;
        m.hours_to_price_stability = elapsedFromStart;
        break;
      }
    }
  } else if (changes.length <= 1) {
    // Already stable from the start
    m.hours_to_price_stability = 0;
  }

  // 10. Time-to-impact: hours_to_no_further_cuts
  // First time after which there are no more downward changes for the rest of the window
  const downCuts = changes.filter((c: any) => Number(c.new_price) < Number(c.old_price));
  if (downCuts.length === 0) {
    m.hours_to_no_further_cuts = 0;
  } else {
    const lastCut = downCuts[downCuts.length - 1];
    const hours = (new Date(lastCut.created_at).getTime() - windowStart.getTime()) / 3_600_000;
    m.hours_to_no_further_cuts = hours;
  }

  return m;
}

async function snapshotAction(
  admin: any,
  action: any,
  phase: "baseline" | "applied" | "measured",
): Promise<{ inserted: number; skipped: number }> {
  const appliedAt = action.applied_at ? new Date(action.applied_at) : null;
  if (!appliedAt) return { inserted: 0, skipped: 0 };

  let windowStart: Date;
  let windowEnd: Date;
  if (phase === "baseline") {
    windowEnd = appliedAt;
    windowStart = new Date(appliedAt.getTime() - WINDOW_DAYS * 86_400_000);
  } else if (phase === "applied") {
    windowStart = appliedAt;
    windowEnd = new Date(appliedAt.getTime() + 60 * 60_000); // 1h capture
  } else {
    // measured
    windowStart = appliedAt;
    windowEnd = new Date(appliedAt.getTime() + WINDOW_DAYS * 86_400_000);
    if (windowEnd > new Date()) {
      // Not yet ready
      return { inserted: 0, skipped: 1 };
    }
  }

  const treatment: string[] = action.treatment_asins ?? [];
  const control: string[] = action.control_asins ?? [];
  const groups: Array<{ label: "treatment" | "control"; asins: string[] }> = [
    { label: "treatment", asins: treatment },
    { label: "control", asins: control },
  ];

  // Marketplace: most actions are scoped per-user but ASINs may live in multiple marketplaces.
  // Pull marketplaces from assignments for this user's scope ASINs.
  const allAsins = [...treatment, ...control];
  if (allAsins.length === 0) return { inserted: 0, skipped: 0 };

  const { data: assignments } = await admin
    .from("repricer_assignments")
    .select("asin, marketplace")
    .eq("user_id", action.user_id)
    .in("asin", allAsins);

  const asinMarketplaces = new Map<string, string[]>();
  for (const a of assignments ?? []) {
    const arr = asinMarketplaces.get(a.asin) ?? [];
    if (!arr.includes(a.marketplace)) arr.push(a.marketplace);
    asinMarketplaces.set(a.asin, arr);
  }

  let inserted = 0;
  let skipped = 0;

  for (const grp of groups) {
    for (const asin of grp.asins) {
      const marketplaces = asinMarketplaces.get(asin) ?? ["US"];
      for (const marketplace of marketplaces) {
        // Skip if snapshot already exists
        const { data: existing } = await admin
          .from("smart_engine_outcome_snapshots")
          .select("id")
          .eq("tuning_action_id", action.id)
          .eq("asin", asin)
          .eq("marketplace", marketplace)
          .eq("snapshot_phase", phase)
          .maybeSingle();

        if (existing) {
          skipped++;
          continue;
        }

        const m = await computeMetricsForAsin(
          admin,
          action.user_id,
          asin,
          marketplace,
          windowStart,
          windowEnd,
        );

        const { error: insErr } = await admin.from("smart_engine_outcome_snapshots").insert({
          user_id: action.user_id,
          tuning_action_id: action.id,
          asin,
          marketplace,
          group_label: grp.label,
          snapshot_phase: phase,
          window_start: windowStart.toISOString(),
          window_end: windowEnd.toISOString(),
          sample_size: m.sample_size,
          bb_win_rate_pct: m.bb_win_rate_pct,
          price_changes_count: m.price_changes_count,
          unnecessary_undercut_count: m.unnecessary_undercut_count,
          unnecessary_undercut_breakdown: m.unnecessary_undercut_breakdown,
          realized_margin_avg: m.realized_margin_avg,
          oscillation_events: m.oscillation_events,
          floor_hits: m.floor_hits,
          hours_to_bb_regain: m.hours_to_bb_regain,
          hours_to_price_stability: m.hours_to_price_stability,
          hours_to_no_further_cuts: m.hours_to_no_further_cuts,
        });

        if (insErr) {
          console.error("[outcome-snapshot] insert error", insErr);
          skipped++;
        } else {
          inserted++;
        }
      }
    }
  }

  return { inserted, skipped };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const __forbidden = requireInternalCall(req);
  if (__forbidden) return __forbidden;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Parse body up-front so we can include the source label in the cron-run row.
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* no body — cron mode */
  }

  const targetActionId: string | null = body?.tuning_action_id ?? null;
  const targetPhase: string | null = body?.phase ?? null;
  const isCronMode = !targetActionId;
  const startedAt = new Date();

  // ── Phase 1B Self-Learning Proof: open a cron-run log row.
  let runRowId: string | null = null;
  if (isCronMode) {
    const { data: runRow } = await admin
      .from("smart_engine_cron_runs")
      .insert({
        job_name: "smart-engine-outcome-snapshot",
        started_at: startedAt.toISOString(),
        status: "running",
        payload: body ?? {},
      })
      .select("id")
      .single();
    runRowId = runRow?.id ?? null;
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let actionsProcessed = 0;
  let errorsCount = 0;
  let errorSample: string | null = null;

  try {
    let actions: any[] = [];
    if (targetActionId) {
      const { data } = await admin
        .from("smart_engine_tuning_actions")
        .select("id, user_id, applied_at, rolled_back_at, treatment_asins, control_asins")
        .eq("id", targetActionId)
        .limit(1);
      actions = data ?? [];
    } else {
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const { data } = await admin
        .from("smart_engine_tuning_actions")
        .select("id, user_id, applied_at, rolled_back_at, treatment_asins, control_asins")
        .gte("applied_at", cutoff)
        .is("rolled_back_at", null)
        .order("applied_at", { ascending: false })
        .limit(100);
      actions = data ?? [];
    }

    actionsProcessed = actions.length;

    const phases: Array<"baseline" | "applied" | "measured"> = targetPhase
      ? [targetPhase as any]
      : ["baseline", "applied", "measured"];

    for (const action of actions) {
      for (const phase of phases) {
        try {
          const { inserted, skipped } = await snapshotAction(admin, action, phase);
          totalInserted += inserted;
          totalSkipped += skipped;
        } catch (innerErr) {
          errorsCount++;
          if (!errorSample) {
            errorSample = innerErr instanceof Error ? innerErr.message : String(innerErr);
          }
          console.error(
            `[outcome-snapshot] action=${action.id} phase=${phase} error:`,
            innerErr,
          );
        }
      }
    }

    if (runRowId) {
      const finishedAt = new Date();
      await admin
        .from("smart_engine_cron_runs")
        .update({
          finished_at: finishedAt.toISOString(),
          duration_ms: finishedAt.getTime() - startedAt.getTime(),
          status: errorsCount > 0 ? "error" : "success",
          actions_scanned: actionsProcessed,
          snapshots_inserted: totalInserted,
          snapshots_skipped: totalSkipped,
          errors_count: errorsCount,
          error_sample: errorSample,
        })
        .eq("id", runRowId);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        cron_run_id: runRowId,
        actions_processed: actionsProcessed,
        snapshots_inserted: totalInserted,
        snapshots_skipped: totalSkipped,
        errors: errorsCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? (e as Error).message : "Unknown error";
    console.error("[outcome-snapshot] fatal error:", e);

    if (runRowId) {
      const finishedAt = new Date();
      await admin
        .from("smart_engine_cron_runs")
        .update({
          finished_at: finishedAt.toISOString(),
          duration_ms: finishedAt.getTime() - startedAt.getTime(),
          status: "error",
          actions_scanned: actionsProcessed,
          snapshots_inserted: totalInserted,
          snapshots_skipped: totalSkipped,
          errors_count: errorsCount + 1,
          error_sample: msg,
        })
        .eq("id", runRowId);
    }

    return new Response(
      JSON.stringify({ error: msg, cron_run_id: runRowId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
