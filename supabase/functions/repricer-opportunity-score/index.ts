// Computes a unified Opportunity Score (0–100) per active ASIN.
// Drives Operator Queue, Action Center, and HOT escalation.
//
// POST { all_users: true } (service role) → fan-out for all users (cron)
// POST { } with JWT                       → compute for current user
// GET  ?live=1 with JWT                   → compute & return without persist

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Factors {
  revenue_opportunity: number; // 0..30
  inventory_age: number; // 0..20
  bb_loss_duration: number; // 0..15
  inventory_depth: number; // 0..10
  sales_velocity: number; // 0..10
  profit_margin: number; // 0..5
  competitor_pressure: number; // 0..5
  seasonal_urgency: number; // 0..5
}

interface Scored {
  asin: string;
  marketplace: string;
  sku: string | null;
  score: number;
  priority_bucket: "urgent" | "high" | "medium" | "routine";
  factors: Factors;
  business_reason: string;
  suggested_action: string;
  expected_impact_usd: number;
  confidence: "high" | "medium" | "estimated";
}

function bucketFor(score: number): Scored["priority_bucket"] {
  if (score >= 80) return "urgent";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  return "routine";
}

async function scoreUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<Scored[]> {
  const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const [
    { data: assigns },
    { data: invRows },
    { data: states },
    { data: salesRows },
    { data: memoryRows },
  ] = await Promise.all([
    admin
      .from("repricer_assignments")
      .select(
        "asin,sku,marketplace,is_enabled,status,last_buybox_status,last_buybox_price,last_applied_price,buybox_lost_at,min_price_override,last_recommendation_reason",
      )
      .eq("user_id", userId)
      .eq("is_enabled", true)
      .neq("status", "DISABLED")
      .limit(5000),
    admin
      .from("inventory")
      .select("asin,available,my_price,cost,estimated_age_days")
      .eq("user_id", userId)
      .gt("available", 0)
      .limit(10000),
    admin
      .from("repricer_strategy_states")
      .select("asin,marketplace,state,signals")
      .eq("user_id", userId)
      .limit(10000),
    admin
      .from("sales_orders")
      .select("asin,quantity,order_date")
      .eq("user_id", userId)
      .gte("order_date", since30d)
      .limit(20000),
    admin
      .from("repricer_asin_strategy_memory")
      .select(
        "asin,marketplace,personality_profile,oscillation_tendency,recent_outcome_score,sample_size",
      )
      .eq("user_id", userId)
      .limit(10000),
  ]);

  const memByKey = new Map<string, any>();
  for (const m of memoryRows ?? [])
    memByKey.set(`${m.asin}|${m.marketplace}`, m);

  const invByAsin = new Map<string, any>();
  for (const r of invRows ?? []) invByAsin.set(r.asin, r);
  const stateByKey = new Map<string, any>();
  for (const r of states ?? [])
    stateByKey.set(`${r.asin}|${r.marketplace}`, r);

  const sales30Map = new Map<string, number>();
  for (const s of salesRows ?? []) {
    const q = Number(s.quantity ?? 1);
    sales30Map.set(s.asin, (sales30Map.get(s.asin) ?? 0) + q);
  }

  // Active ignores
  const { data: ignores } = await admin
    .from("repricer_operator_actions")
    .select("asin,marketplace,ignore_until")
    .eq("user_id", userId)
    .eq("action", "ignored")
    .gt("ignore_until", new Date().toISOString());
  const ignoredKeys = new Set(
    (ignores ?? []).map((i: any) => `${i.asin}|${i.marketplace}`),
  );

  const out: Scored[] = [];

  for (const a of assigns ?? []) {
    const key = `${a.asin}|${a.marketplace}`;
    if (ignoredKeys.has(key)) continue;

    const inv = invByAsin.get(a.asin) || {};
    const state = stateByKey.get(key);
    const myPrice = Number(a.last_applied_price ?? inv.my_price ?? 0);
    const bbPrice = Number(a.last_buybox_price ?? 0);
    const available = Number(inv.available ?? 0);
    const age = Number(inv.estimated_age_days ?? 0);
    const cost = Number(inv.cost ?? 0);
    const margin =
      myPrice > 0 && cost > 0 ? Math.max(0, (myPrice - cost) / myPrice) : 0;
    const status = (a.last_buybox_status || "").toUpperCase();

    const sales30 = sales30Map.get(a.asin) ?? 0;
    const velocity = sales30 / 30;

    // BB loss duration in days
    let bbLossDays = 0;
    if (a.buybox_lost_at) {
      bbLossDays = Math.max(
        0,
        Math.round(
          (Date.now() - new Date(a.buybox_lost_at).getTime()) /
            (24 * 3600 * 1000),
        ),
      );
    }

    // Factor scoring (each capped)
    const f: Factors = {
      revenue_opportunity: 0,
      inventory_age: 0,
      bb_loss_duration: 0,
      inventory_depth: 0,
      sales_velocity: 0,
      profit_margin: 0,
      competitor_pressure: 0,
      seasonal_urgency: 0,
    };

    // Revenue opportunity: gap to BB × velocity proxy
    if (bbPrice > 0 && myPrice > bbPrice) {
      const gap = (myPrice - bbPrice) / Math.max(1, myPrice);
      const velMult = Math.min(1, velocity / 1.0);
      f.revenue_opportunity = Math.min(30, Math.round(gap * 100 * velMult * 1.5));
    }

    // Inventory age
    if (age >= 90) f.inventory_age = 20;
    else if (age >= 60) f.inventory_age = 15;
    else if (age >= 30) f.inventory_age = 8;
    else if (age >= 14) f.inventory_age = 3;

    // BB loss duration
    if (bbLossDays >= 14) f.bb_loss_duration = 15;
    else if (bbLossDays >= 7) f.bb_loss_duration = 12;
    else if (bbLossDays >= 3) f.bb_loss_duration = 6;
    else if (bbLossDays >= 1) f.bb_loss_duration = 2;

    // Depth (how much sitting)
    if (available >= 50) f.inventory_depth = 10;
    else if (available >= 20) f.inventory_depth = 6;
    else if (available >= 5) f.inventory_depth = 3;

    // Velocity bonus (low velocity + stock = problem)
    if (available > 0 && velocity < 0.05 && age >= 30) f.sales_velocity = 10;
    else if (velocity < 0.1 && available >= 10) f.sales_velocity = 6;
    else if (velocity > 0.5) f.sales_velocity = 2;

    // Margin (only meaningful when profit at risk)
    if (margin > 0.4) f.profit_margin = 5;
    else if (margin > 0.2) f.profit_margin = 3;

    // Competitor pressure
    if (status === "LOST" || status === "SUPPRESSED")
      f.competitor_pressure = 5;
    else if (status === "WINNING") f.competitor_pressure = 1;

    // Seasonal urgency: simple month-based (Q4 = peak)
    const m = new Date().getMonth();
    if (m === 9 || m === 10 || m === 11) f.seasonal_urgency = 5;
    else f.seasonal_urgency = 1;

    const score = Math.min(
      100,
      Math.round(
        f.revenue_opportunity +
          f.inventory_age +
          f.bb_loss_duration +
          f.inventory_depth +
          f.sales_velocity +
          f.profit_margin +
          f.competitor_pressure +
          f.seasonal_urgency,
      ),
    );

    if (score < 25) continue; // routine — exclude from queue

    // Business reason + suggested action (plain language)
    let reason = "";
    let suggestion = "";
    let impact = 0;

    if (
      f.bb_loss_duration >= 12 &&
      (state?.state === "aged_pressure" || age >= 30)
    ) {
      reason = `Buy Box lost for ${bbLossDays} days while ${available} units age (${age}+ days). Move toward liquidation.`;
      suggestion = "Approve a small price reduction to recover sales velocity.";
      impact = bbPrice > 0 ? Math.max(0, myPrice - bbPrice) * available * 0.2 : 0;
    } else if (status === "LOST" && bbPrice > 0 && myPrice > bbPrice) {
      reason = `Currently $${(myPrice - bbPrice).toFixed(2)} above the Buy Box. Recovery is likely worth it.`;
      suggestion = "Approve undercut to recapture the Buy Box.";
      impact = (myPrice - bbPrice) * Math.max(0.5, velocity) * 7; // 7d projection
    } else if (f.inventory_age >= 15 && available > 0) {
      reason = `${available} units sitting ${age}+ days with low velocity. Aging risk is rising.`;
      suggestion = "Consider liquidation strategy with conservative price step.";
      impact = (inv.my_price ?? 0) * available * 0.1;
    } else if (status === "SUPPRESSED") {
      reason = `Amazon hid the Buy Box. Pricing is uncompetitive.`;
      suggestion = "Approve direct undercut to restore Buy Box display.";
      impact = (inv.my_price ?? 0) * Math.max(0.5, velocity) * 7;
    } else if (
      String(a.last_recommendation_reason || "")
        .toUpperCase()
        .includes("OSCILLATION")
    ) {
      reason = "Repeated price oscillation detected — market is unstable.";
      suggestion = "Hold for now. Adaptation engine will widen cooldowns.";
      impact = 0;
    } else if (margin > 0.4 && status === "WINNING" && velocity > 0.3) {
      reason = "Strong margin, healthy velocity, you own the Buy Box.";
      suggestion = "Approve gradual price increase to maximize profit.";
      impact = (inv.my_price ?? 0) * 0.02 * velocity * 30;
    } else {
      reason = "Pricing requires operator review.";
      suggestion = "Review and approve the recommended action.";
      impact = 0;
    }

    // Dynamic confidence: combine sample size, memory health, oscillation
    const mem = memByKey.get(`${a.asin}|${a.marketplace}`);
    const memSamples = Number(mem?.sample_size ?? 0);
    const oscTendency = Number(mem?.oscillation_tendency ?? 0);
    const recentOutcome = Number(mem?.recent_outcome_score ?? 0.5);
    let confidence: Scored["confidence"] = "estimated";
    if (sales30 >= 5 && memSamples >= 5 && recentOutcome >= 0.6 && oscTendency < 0.3)
      confidence = "high";
    else if (sales30 >= 3 || (memSamples >= 3 && recentOutcome >= 0.4))
      confidence = "medium";
    // Penalize: if recent outcomes are mostly failures, downgrade
    if (memSamples >= 3 && recentOutcome < 0.3) confidence = "estimated";
    // Penalize: if highly oscillating, downgrade
    if (oscTendency >= 0.5 && confidence === "high") confidence = "medium";

    out.push({
      asin: a.asin,
      marketplace: a.marketplace,
      sku: a.sku ?? null,
      score,
      priority_bucket: bucketFor(score),
      factors: f,
      business_reason: reason,
      suggested_action: suggestion,
      expected_impact_usd: Math.round(impact * 100) / 100,
      confidence,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

async function persist(
  admin: ReturnType<typeof createClient>,
  userId: string,
  rows: Scored[],
) {
  if (!rows.length) return;
  // Wipe stale rows for this user, then upsert fresh
  await admin
    .from("repricer_opportunity_scores")
    .delete()
    .eq("user_id", userId);

  const chunks: Scored[][] = [];
  for (let i = 0; i < rows.length; i += 500) chunks.push(rows.slice(i, i + 500));
  for (const chunk of chunks) {
    await admin.from("repricer_opportunity_scores").insert(
      chunk.map((r) => ({
        user_id: userId,
        asin: r.asin,
        marketplace: r.marketplace,
        sku: r.sku,
        score: r.score,
        priority_bucket: r.priority_bucket,
        factors: r.factors,
        business_reason: r.business_reason,
        suggested_action: r.suggested_action,
        expected_impact_usd: r.expected_impact_usd,
        confidence: r.confidence,
      })),
    );
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });
    const url = new URL(req.url);
    const live = url.searchParams.get("live") === "1";

    let body: any = {};
    if (req.method !== "GET") {
      try {
        body = await req.json();
      } catch {
        body = {};
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
      const outcome = await withCronLock(admin as any, "repricer-opportunity-score-30m", 1500, async () => {
        const { data: users } = await admin
          .from("repricer_assignments")
          .select("user_id")
          .eq("is_enabled", true);
        const uniq = Array.from(new Set((users ?? []).map((u: any) => u.user_id)));
        let ok = 0;
        for (const uid of uniq) {
          try {
            const rows = await scoreUser(admin, uid);
            await persist(admin, uid, rows);
            ok += 1;
            await new Promise((r) => setTimeout(r, 250));
          } catch (e) {
            console.error("score user fail", uid, e);
          }
        }
        return { items_processed: ok, detail: { total_users: uniq.length } };
      });
      return new Response(JSON.stringify({ scored_users: outcome.items_processed, ...outcome }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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

    const rows = await scoreUser(admin, user.id);
    if (!live) await persist(admin, user.id, rows);

    return new Response(
      JSON.stringify({ count: rows.length, items: rows.slice(0, 200) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
