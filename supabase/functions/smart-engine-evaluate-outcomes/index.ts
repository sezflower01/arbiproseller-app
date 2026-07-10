// Phase 2.5 — Lightweight effectiveness evaluator.
//
// For each applied recommendation that:
//   - was applied at least MIN_AGE_DAYS ago
//   - was applied at most MAX_AGE_DAYS ago
//   - has not been evaluated yet (outcome_direction IS NULL)
//
// We look up the matching tuning_action and its pre/post outcome snapshots
// (smart_engine_outcome_snapshots) and assign a coarse outcome_direction:
//
//   improved      — at least 2 of {bb_win up, margin up, undercuts down, bb_regain faster} positive
//   worse         — at least 2 of those signals negative
//   neutral       — mixed / small magnitudes
//   inconclusive  — not enough snapshot coverage to decide
//
// This is intentionally rule-based and cheap. It's a feedback loop, not a
// causal estimator (Phase 1 lift table already does proper causal inference).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIN_AGE_DAYS = 3;
const MAX_AGE_DAYS = 14;

type Snapshot = {
  snapshot_phase: string | null;
  group_label: string | null;
  bb_win_rate_pct: number | null;
  realized_margin_avg: number | null;
  unnecessary_undercut_count: number | null;
  hours_to_bb_regain: number | null;
  sample_size: number | null;
};

function avg(rows: Snapshot[], key: keyof Snapshot): number | null {
  const vals = rows
    .map((r) => r[key])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function classify(pre: Snapshot[], post: Snapshot[]): {
  direction: "improved" | "neutral" | "worse" | "inconclusive";
  notes: Record<string, unknown>;
} {
  if (pre.length === 0 || post.length === 0) {
    return {
      direction: "inconclusive",
      notes: { reason: "missing_snapshots", pre_count: pre.length, post_count: post.length },
    };
  }

  const preBB = avg(pre, "bb_win_rate_pct");
  const postBB = avg(post, "bb_win_rate_pct");
  const preMargin = avg(pre, "realized_margin_avg");
  const postMargin = avg(post, "realized_margin_avg");
  const preUnder = avg(pre, "unnecessary_undercut_count");
  const postUnder = avg(post, "unnecessary_undercut_count");
  const preRegain = avg(pre, "hours_to_bb_regain");
  const postRegain = avg(post, "hours_to_bb_regain");

  let pos = 0;
  let neg = 0;
  const detail: Record<string, unknown> = {};

  // BB win rate: higher is better, threshold 2pp
  if (preBB != null && postBB != null) {
    const d = postBB - preBB;
    detail.bb_win_delta_pp = d;
    if (d >= 2) pos++;
    else if (d <= -2) neg++;
  }
  // Margin: higher is better, threshold 1%
  if (preMargin != null && postMargin != null) {
    const d = postMargin - preMargin;
    detail.margin_delta = d;
    if (d >= 1) pos++;
    else if (d <= -1) neg++;
  }
  // Unnecessary undercuts: lower is better, threshold 10%
  if (preUnder != null && postUnder != null && preUnder > 0) {
    const d = (postUnder - preUnder) / preUnder;
    detail.undercut_delta_pct = d;
    if (d <= -0.1) pos++;
    else if (d >= 0.1) neg++;
  }
  // Hours to BB regain: lower is better, threshold 15%
  if (preRegain != null && postRegain != null && preRegain > 0) {
    const d = (postRegain - preRegain) / preRegain;
    detail.bb_regain_delta_pct = d;
    if (d <= -0.15) pos++;
    else if (d >= 0.15) neg++;
  }

  detail.positive_signals = pos;
  detail.negative_signals = neg;

  if (pos === 0 && neg === 0) {
    return { direction: "inconclusive", notes: { ...detail, reason: "no_signal_overlap" } };
  }
  if (pos >= 2 && pos > neg) return { direction: "improved", notes: detail };
  if (neg >= 2 && neg > pos) return { direction: "worse", notes: detail };
  return { direction: "neutral", notes: detail };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const minAppliedAt = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const maxAppliedAt = new Date(Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { data: recs, error: recErr } = await admin
      .from("smart_engine_tuning_recommendations")
      .select("id, user_id, applied_at, model_tier")
      .eq("was_applied", true)
      .is("outcome_direction", null)
      .gte("applied_at", minAppliedAt)
      .lte("applied_at", maxAppliedAt)
      .limit(200);
    if (recErr) {
      return json({ error: `recs query failed: ${recErr.message}` }, 500);
    }

    const recIds = (recs ?? []).map((r) => r.id);
    if (recIds.length === 0) {
      return json({ ok: true, evaluated: 0, scanned: 0, reason: "no_due_recommendations" });
    }

    // Map recommendation_id -> tuning_action_id
    const { data: actions, error: actErr } = await admin
      .from("smart_engine_tuning_actions")
      .select("id, recommendation_id")
      .in("recommendation_id", recIds);
    if (actErr) {
      return json({ error: `actions query failed: ${actErr.message}` }, 500);
    }
    const actionByRec = new Map<string, string>();
    for (const a of actions ?? []) {
      if (a.recommendation_id && a.id) actionByRec.set(a.recommendation_id, a.id);
    }

    const actionIds = Array.from(new Set(actionByRec.values()));
    const snapshotByAction = new Map<string, Snapshot[]>();
    if (actionIds.length > 0) {
      const { data: snaps, error: snapErr } = await admin
        .from("smart_engine_outcome_snapshots")
        .select(
          "tuning_action_id, snapshot_phase, group_label, bb_win_rate_pct, realized_margin_avg, unnecessary_undercut_count, hours_to_bb_regain, sample_size",
        )
        .in("tuning_action_id", actionIds);
      if (snapErr) {
        return json({ error: `snapshots query failed: ${snapErr.message}` }, 500);
      }
      for (const s of snaps ?? []) {
        const key = (s as any).tuning_action_id as string;
        const arr = snapshotByAction.get(key) ?? [];
        arr.push(s as Snapshot);
        snapshotByAction.set(key, arr);
      }
    }

    let evaluated = 0;
    const tierCounts: Record<string, Record<string, number>> = {};

    for (const rec of recs ?? []) {
      const actionId = actionByRec.get(rec.id);
      const snaps = (actionId ? snapshotByAction.get(actionId) : undefined) ?? [];
      // Only treatment-group rows; fall back to all if no group_label
      const treatment = snaps.filter(
        (s) => !s.group_label || s.group_label === "treatment",
      );
      const pre = treatment.filter((s) => s.snapshot_phase === "pre");
      const post = treatment.filter((s) => s.snapshot_phase === "post");

      const { direction, notes } = classify(pre, post);

      const { error: updErr } = await admin
        .from("smart_engine_tuning_recommendations")
        .update({
          outcome_direction: direction,
          outcome_evaluated_at: new Date().toISOString(),
          outcome_notes: notes,
        })
        .eq("id", rec.id);
      if (updErr) {
        console.error("[evaluate-outcomes] update failed", rec.id, updErr.message);
        continue;
      }
      evaluated++;
      const tier = rec.model_tier ?? "unknown";
      tierCounts[tier] = tierCounts[tier] ?? {};
      tierCounts[tier][direction] = (tierCounts[tier][direction] ?? 0) + 1;
    }

    return json({ ok: true, scanned: recs?.length ?? 0, evaluated, tier_counts: tierCounts });
  } catch (e) {
    console.error("[smart-engine-evaluate-outcomes] fatal", e);
    return json({ error: e instanceof Error ? (e as Error).message : String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
