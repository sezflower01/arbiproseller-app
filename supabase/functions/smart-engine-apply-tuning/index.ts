// Phase 1B – Self-Learning Proof: APPLY a tuning recommendation as an experiment.
//
// This is the "flip the switch" endpoint. It takes an approved recommendation
// and turns it into a real, measurable experiment by:
//
//   1. Resolving the candidate ASIN universe (all enabled assignments for the
//      user — future versions may scope by parameter_key, marketplace, etc.).
//   2. Pre-generating a tuning_action_id so the deterministic hash in
//      splitControlGroup is stable for the lifetime of this experiment.
//   3. Calling splitControlGroup() to get treatment / control / observational
//      flag.
//   4. Inserting the row into smart_engine_tuning_actions with:
//          treatment_asins, control_asins,
//          control_assignment_seed, control_group_pct, min_sample_size,
//          is_observational, scope_asins,
//          experiment_start_at  ← the moment the split actually went live
//   5. Marking the recommendation as `status = 'applied'`.
//
// Caller must be an admin (we cross-check via the user_roles table). This is
// intentional: only admins can launch experiments today.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { splitControlGroup, MIN_CAUSAL_SAMPLE_SIZE, DEFAULT_CONTROL_PCT } from "../_shared/controlGroupSplit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BodySchema = z.object({
  recommendation_id: z.string().uuid(),
  // Optional override knobs (admin can tune per-experiment)
  control_pct: z.number().min(0.05).max(0.5).optional(),
  min_sample_size: z.number().int().min(5).max(1000).optional(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---- AuthN: require a user JWT, then check role ----
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user) {
      return json({ error: "Invalid session" }, 401);
    }
    const callerId = userRes.user.id;

    const { data: isAdminRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", callerId)
      .eq("role", "admin")
      .maybeSingle();
    if (!isAdminRow) {
      return json({ error: "Admin role required" }, 403);
    }

    // ---- Validate body ----
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return json({ error: parsed.error.flatten().fieldErrors }, 400);
    }
    const { recommendation_id, control_pct, min_sample_size } = parsed.data;

    // ---- Load recommendation ----
    const { data: rec, error: recErr } = await admin
      .from("smart_engine_tuning_recommendations")
      .select(
        "id, user_id, parameter_key, current_value, suggested_value, status, recommendation_type",
      )
      .eq("id", recommendation_id)
      .maybeSingle();
    if (recErr || !rec) {
      return json({ error: "Recommendation not found" }, 404);
    }
    if (rec.status === "applied") {
      return json({ error: "Recommendation already applied" }, 409);
    }

    // ---- Resolve candidate ASINs (scope = enabled assignments for this user) ----
    // Future: narrow by marketplace / parameter_key. For now we treat the whole
    // active book as the candidate pool for the experiment.
    const { data: assignmentRows, error: asnErr } = await admin
      .from("repricer_assignments")
      .select("asin")
      .eq("user_id", rec.user_id)
      .eq("is_enabled", true);
    if (asnErr) {
      return json({ error: `Failed to load assignments: ${asnErr.message}` }, 500);
    }
    const scopeAsins = Array.from(
      new Set((assignmentRows ?? []).map((r) => r.asin).filter(Boolean) as string[]),
    );

    // ---- Pre-generate tuning_action_id so the hash is stable ----
    const tuningActionId = crypto.randomUUID();

    // ---- Split treatment / control deterministically ----
    const split = splitControlGroup(
      rec.user_id,
      tuningActionId,
      scopeAsins,
      {
        controlPct: control_pct ?? DEFAULT_CONTROL_PCT,
        minSampleSize: min_sample_size ?? MIN_CAUSAL_SAMPLE_SIZE,
      },
    );

    const nowIso = new Date().toISOString();

    // ---- Insert tuning action row (this IS the experiment) ----
    const { error: insErr } = await admin
      .from("smart_engine_tuning_actions")
      .insert({
        id: tuningActionId,
        user_id: rec.user_id,
        recommendation_id: rec.id,
        parameter_key: rec.parameter_key,
        old_value: rec.current_value != null ? String(rec.current_value) : null,
        new_value: rec.suggested_value != null ? String(rec.suggested_value) : null,
        applied_at: nowIso,
        applied_by: `admin:${callerId}`,
        scope_asins: scopeAsins,
        treatment_asins: split.treatment_asins,
        control_asins: split.control_asins,
        control_group_pct: split.control_group_pct,
        control_assignment_seed: split.control_assignment_seed,
        min_sample_size: split.min_sample_size,
        is_observational: split.is_observational,
        experiment_start_at: nowIso,
        outcome_summary: split.reason ?? null,
      });
    if (insErr) {
      return json({ error: `Failed to insert tuning action: ${insErr.message}` }, 500);
    }

    // ---- Mark recommendation as applied + capture effectiveness metadata ----
    // Pull tier / confidence from the most recent AI review for this user that
    // could plausibly have produced this recommendation. We deliberately keep
    // this lookup cheap: latest matching parameter_key in the last 24h. If we
    // can't find one, we fall back to whatever was already set (or null).
    let modelTier: string | null = null;
    let confidenceBucket: string | null = null;
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: reviewRow } = await admin
        .from("smart_engine_ai_reviews")
        .select("model_tier, ai_confidence")
        .eq("user_id", rec.user_id)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (reviewRow) {
        modelTier = (reviewRow as any).model_tier ?? null;
        const conf = String((reviewRow as any).ai_confidence ?? "").toLowerCase();
        if (conf === "high" || conf === "medium" || conf === "low") {
          confidenceBucket = conf;
        }
      }
    } catch (_) {
      // best-effort; tier/confidence are optional
    }

    await admin
      .from("smart_engine_tuning_recommendations")
      .update({
        status: "applied",
        admin_approved: true,
        was_applied: true,
        applied_at: nowIso,
        model_tier: modelTier,
        confidence_bucket: confidenceBucket,
        updated_at: nowIso,
      })
      .eq("id", rec.id);

    return json({
      ok: true,
      tuning_action_id: tuningActionId,
      experiment_start_at: nowIso,
      scope_size: scopeAsins.length,
      treatment_size: split.treatment_asins.length,
      control_size: split.control_asins.length,
      is_observational: split.is_observational,
      reason: split.reason ?? null,
      control_assignment_seed: split.control_assignment_seed,
    }, 200);
  } catch (e) {
    console.error("[smart-engine-apply-tuning] fatal", e);
    return json({ error: e instanceof Error ? (e as Error).message : String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
