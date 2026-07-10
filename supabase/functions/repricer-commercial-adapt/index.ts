// Commercial Adaptation Engine — runs hourly.
// Applies SAFE, AUDITED automatic adaptations:
//   - Move strategy state when conditions are met (BB-loss + aging → liquidation,
//     stable BB + velocity → profit_max, oscillation → defensive, monopoly → recovery)
//   - Suggests cooldown widening for repeatedly-oscillating ASINs (signal only — actual
//     pricing logic still consumes cooldowns from rules + market-volatility memo).
//
// Every adaptation is logged to repricer_adaptations_log with business_reason + confidence.
// Hard safety: never modifies rules, floors, or prices directly. Only updates strategy_states
// (which the evaluator reads) and writes a recommendation row that the evaluator can honor.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Adaptation {
  asin: string;
  marketplace: string;
  type:
    | "state_transition"
    | "cooldown_widen"
    | "aggression_reduce"
    | "recovery_initiate";
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  business_reason: string;
  technical_reason?: string;
  confidence: number;
}

async function adaptUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<number> {
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // Read automation tier (defaults to balanced)
  const { data: prefs } = await admin
    .from("repricer_user_automation_preferences")
    .select("automation_tier,allow_autonomous_recovery,recovery_speed")
    .eq("user_id", userId)
    .maybeSingle();
  const tier = (prefs?.automation_tier ?? "balanced") as
    | "conservative"
    | "balanced"
    | "aggressive"
    | "autonomous";
  const allowRecovery =
    tier === "aggressive" || tier === "autonomous"
      ? true
      : Boolean(prefs?.allow_autonomous_recovery);
  // Tier confidence floor: skip lower-confidence adaptations on conservative
  const minConf =
    tier === "conservative"
      ? 0.85
      : tier === "balanced"
        ? 0.75
        : tier === "aggressive"
          ? 0.65
          : 0.55;

  const [{ data: assigns }, { data: invRows }, { data: states }, { data: acks }] =
    await Promise.all([
      admin
        .from("repricer_assignments")
        .select(
          "asin,marketplace,last_buybox_status,last_buybox_price,last_applied_price,buybox_lost_at,last_recommendation_reason",
        )
        .eq("user_id", userId)
        .eq("is_enabled", true)
        .neq("status", "DISABLED")
        .limit(5000),
      admin
        .from("inventory")
        .select("asin,available,estimated_age_days")
        .eq("user_id", userId)
        .gt("available", 0)
        .limit(10000),
      admin
        .from("repricer_strategy_states")
        .select("asin,marketplace,state,signals,reason_business")
        .eq("user_id", userId)
        .limit(10000),
      admin
        .from("repricer_eval_acks")
        .select("asin,reason,created_at")
        .eq("user_id", userId)
        .gte("created_at", since7d)
        .limit(20000),
    ]);

  const invByAsin = new Map<string, any>();
  for (const r of invRows ?? []) invByAsin.set(r.asin, r);
  const stateByKey = new Map<string, any>();
  for (const r of states ?? [])
    stateByKey.set(`${r.asin}|${r.marketplace}`, r);

  // Count oscillation signals per ASIN in last 7d
  const oscByAsin = new Map<string, number>();
  for (const r of acks ?? []) {
    const reason = (r.reason || "").toUpperCase();
    if (reason.includes("OSCILLATION") || reason.includes("INSTABILITY")) {
      oscByAsin.set(r.asin, (oscByAsin.get(r.asin) ?? 0) + 1);
    }
  }

  const adaptations: Adaptation[] = [];

  for (const a of assigns ?? []) {
    const key = `${a.asin}|${a.marketplace}`;
    const inv = invByAsin.get(a.asin) || {};
    const cur = stateByKey.get(key);
    const curState = cur?.state ?? "unknown";

    const status = (a.last_buybox_status || "").toUpperCase();
    const age = Number(inv.estimated_age_days ?? 0);
    const available = Number(inv.available ?? 0);
    let bbLossDays = 0;
    if (a.buybox_lost_at) {
      bbLossDays = Math.round(
        (Date.now() - new Date(a.buybox_lost_at).getTime()) /
          (24 * 3600 * 1000),
      );
    }
    const oscCount = oscByAsin.get(a.asin) ?? 0;

    let target: string | null = null;
    let reason = "";
    let confidence = 0.7;

    if (oscCount >= 5) {
      // Oscillation → cooldown widen + reduce aggression (signal only)
      adaptations.push({
        asin: a.asin,
        marketplace: a.marketplace,
        type: "cooldown_widen",
        before: { state: curState, oscillations_7d: oscCount },
        after: { recommended_cooldown_multiplier: 2 },
        business_reason: `Detected ${oscCount} oscillation events in 7 days. Widening cooldowns to let the market settle.`,
        technical_reason: "OSCILLATION_THRESHOLD_5_PER_7D",
        confidence: 0.85,
      });
      target = "buybox_defense";
      reason =
        "Repeated oscillation detected — moving to defensive posture and widening cooldowns.";
      confidence = 0.85;
    } else if (
      bbLossDays >= 7 &&
      age >= 30 &&
      available > 0 &&
      curState !== "clearance"
    ) {
      target = age >= 60 ? "clearance" : "aged_pressure";
      reason = `Buy Box lost ${bbLossDays} days, ${available} units aging ${age}+ days. Moving toward ${target === "clearance" ? "clearance" : "aged-pressure pricing"}.`;
      confidence = 0.9;
    } else if (
      status === "WINNING" &&
      bbLossDays === 0 &&
      curState !== "profit_max" &&
      age < 30
    ) {
      target = "profit_max";
      reason =
        "Stable Buy Box ownership and healthy listing. Shifting to profit maximization.";
      confidence = 0.8;
    } else if (
      String(a.last_recommendation_reason || "")
        .toUpperCase()
        .includes("NO_COMPETITORS") &&
      curState !== "profit_max"
    ) {
      target = "profit_max";
      reason =
        "No active competitors — initiating gradual upward recovery to maximize margin.";
      confidence = 0.75;
    }

    if (target && target !== curState) {
      // Tier gating: skip recovery moves unless allowed; respect confidence floor
      const isRecovery = target === "profit_max";
      if (isRecovery && !allowRecovery) {
        // Skip — log a soft note instead
        adaptations.push({
          asin: a.asin,
          marketplace: a.marketplace,
          type: "recovery_initiate",
          before: { state: curState, tier },
          after: { skipped: true, reason: "tier_disallows_recovery" },
          business_reason: `${reason} (Skipped — automation tier "${tier}" does not allow autonomous recovery.)`,
          confidence,
        });
      } else if (confidence < minConf) {
        adaptations.push({
          asin: a.asin,
          marketplace: a.marketplace,
          type: "state_transition",
          before: { state: curState, tier },
          after: { skipped: true, min_confidence: minConf, confidence },
          business_reason: `${reason} (Skipped — confidence ${(confidence * 100).toFixed(0)}% below "${tier}" tier threshold ${(minConf * 100).toFixed(0)}%.)`,
          confidence,
        });
      } else {
        adaptations.push({
          asin: a.asin,
          marketplace: a.marketplace,
          type: isRecovery ? "recovery_initiate" : "state_transition",
          before: { state: curState },
          after: { state: target, tier },
          business_reason: reason,
          confidence,
        });

        await admin.from("repricer_strategy_states").upsert(
          {
            user_id: userId,
            asin: a.asin,
            marketplace: a.marketplace,
            state: target,
            reason_business: reason,
            reason_technical: "COMMERCIAL_ADAPT",
            signals: { adapted_at: new Date().toISOString(), confidence, tier },
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,asin,marketplace" },
        );
      }
    }
  }

  // Persist adaptation log entries (chunked)
  const rows = adaptations.map((ad) => ({
    user_id: userId,
    asin: ad.asin,
    marketplace: ad.marketplace,
    adaptation_type: ad.type,
    before_state: ad.before,
    after_state: ad.after,
    business_reason: ad.business_reason,
    technical_reason: ad.technical_reason ?? null,
    confidence: ad.confidence,
    auto_applied: true,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await admin
      .from("repricer_adaptations_log")
      .insert(rows.slice(i, i + 500));
  }
  return adaptations.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });
    let body: any = {};
    if (req.method !== "GET") {
      try {
        body = await req.json();
      } catch {
        /* empty */
      }
    }

    if (body?.all_users === true) {
      const auth = req.headers.get("authorization") || "";
      if (!auth.includes(SERVICE_ROLE)) {
        return new Response(JSON.stringify({ error: "service required" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { withCronLock } = await import("../_shared/cron-lock.ts");
      const outcome = await withCronLock(admin as any, "repricer-commercial-adapt-hourly", 1500, async () => {
        const { data: users } = await admin
          .from("repricer_assignments")
          .select("user_id")
          .eq("is_enabled", true);
        const uniq = Array.from(new Set((users ?? []).map((u: any) => u.user_id)));
        let total = 0;
        for (const uid of uniq) {
          try {
            total += await adaptUser(admin, uid);
            await new Promise((r) => setTimeout(r, 300));
          } catch (e) {
            console.error("adapt user fail", uid, e);
          }
        }
        return { items_processed: total, detail: { total_users: uniq.length } };
      });
      return new Response(
        JSON.stringify({ adaptations: outcome.items_processed, ...outcome }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Per-user
    const authHeader = req.headers.get("authorization");
    if (!authHeader)
      return new Response(JSON.stringify({ error: "auth required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    const userClient = createClient(
      SUPABASE_URL,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user)
      return new Response(JSON.stringify({ error: "invalid user" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    const count = await adaptUser(admin, user.id);
    return new Response(JSON.stringify({ adaptations: count }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
