// AI Business Advisor — generates weekly strategic insights using Lovable AI gateway.
// Reads aggregate intelligence (BB quality, marketplace personality, outcomes,
// inventory aging) and produces 4-8 plain-language insights stored in
// repricer_strategic_insights for the UI advisor card.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_KEY = Deno.env.get("LOVABLE_API_KEY");

async function buildContext(
  admin: ReturnType<typeof createClient>,
  userId: string,
) {
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const [
    { data: bbq },
    { data: mi },
    { data: outcomes },
    { data: assigns },
    { data: inv },
    { data: comps },
  ] = await Promise.all([
    admin
      .from("repricer_buybox_quality")
      .select("asin,marketplace,quality_score,classification,margin_quality")
      .eq("user_id", userId)
      .order("quality_score", { ascending: false })
      .limit(2000),
    admin
      .from("repricer_marketplace_intelligence")
      .select("*")
      .eq("user_id", userId),
    admin
      .from("repricer_action_outcomes")
      .select("outcome_label,evaluated_at,marketplace")
      .eq("user_id", userId)
      .gte("evaluated_at", since30)
      .limit(20000),
    admin
      .from("repricer_assignments")
      .select("asin,marketplace,is_enabled,status")
      .eq("user_id", userId)
      .eq("is_enabled", true)
      .neq("status", "DISABLED")
      .limit(5000),
    admin
      .from("inventory")
      .select("asin,available,estimated_age_days,my_price,cost")
      .eq("user_id", userId)
      .gt("available", 0)
      .limit(10000),
    admin
      .from("repricer_competitor_profiles")
      .select("classification,marketplace")
      .eq("user_id", userId)
      .limit(20000),
  ]);

  const summary = {
    marketplaces: mi ?? [],
    total_active: (assigns ?? []).length,
    bb_classifications: countBy(bbq ?? [], (r) => r.classification),
    bb_top_unprofitable: (bbq ?? [])
      .filter((b) => b.classification === "unprofitable_winner")
      .slice(0, 10)
      .map((b) => ({
        asin: b.asin,
        marketplace: b.marketplace,
        margin: b.margin_quality,
      })),
    outcome_counts_30d: countBy(outcomes ?? [], (r) => r.outcome_label),
    outcome_by_marketplace: countByPair(
      outcomes ?? [],
      (r) => r.marketplace,
      (r) => r.outcome_label,
    ),
    aging_units_60d: (inv ?? []).filter(
      (i: any) => Number(i.estimated_age_days ?? 0) >= 60,
    ).length,
    aging_units_120d: (inv ?? []).filter(
      (i: any) => Number(i.estimated_age_days ?? 0) >= 120,
    ).length,
    competitor_classifications: countBy(comps ?? [], (r) => r.classification),
  };
  return summary;
}

function countBy<T>(arr: T[], fn: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of arr) {
    const k = fn(r) || "unknown";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
function countByPair<T>(
  arr: T[],
  k1: (r: T) => string,
  k2: (r: T) => string,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of arr) {
    const a = k1(r) || "unknown";
    const b = k2(r) || "unknown";
    if (!out[a]) out[a] = {};
    out[a][b] = (out[a][b] ?? 0) + 1;
  }
  return out;
}

async function generateInsights(context: any): Promise<any[]> {
  if (!LOVABLE_KEY) {
    // Deterministic fallback when no AI key
    return ruleBasedInsights(context);
  }
  const prompt = `You are a senior Amazon pricing strategist reviewing this week's seller data.
Produce 4-8 concise, business-focused insights. Each must be actionable, plain-language, and conservative — never exaggerate.
Return STRICT JSON array of objects with keys: headline (short), body (1-3 sentences), category (margin|inventory|competition|recovery|marketplace|general), severity (info|watch|important), expected_impact_usd (number or null), affected_asins (number or null), marketplace (string or null).
Only return the JSON array, no prose.

DATA:
${JSON.stringify(context).slice(0, 8000)}`;

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_KEY}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "You produce concise, calibrated business insights. Output only valid JSON.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      console.error("AI gateway error", res.status, await res.text());
      return ruleBasedInsights(context);
    }
    const j = await res.json();
    const txt = j?.choices?.[0]?.message?.content ?? "[]";
    const cleaned = txt.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return ruleBasedInsights(context);
    return parsed;
  } catch (e) {
    console.error("ai insight fail", e);
    return ruleBasedInsights(context);
  }
}

function ruleBasedInsights(c: any): any[] {
  const out: any[] = [];
  const unprof = c.bb_classifications?.unprofitable_winner ?? 0;
  if (unprof > 0)
    out.push({
      headline: `${unprof} listings winning Buy Box at thin margins`,
      body: `These ASINs hold the Buy Box but margins are close to floor. Consider raising floors or routing to profit-protection rules.`,
      category: "margin",
      severity: unprof > 10 ? "important" : "watch",
      expected_impact_usd: null,
      affected_asins: unprof,
      marketplace: null,
    });
  if ((c.aging_units_120d ?? 0) > 0)
    out.push({
      headline: `${c.aging_units_120d} units aging past 120 days`,
      body: `Storage cost pressure rising. Aged-pressure or clearance routing is recommended for the oldest cohort.`,
      category: "inventory",
      severity: "important",
      expected_impact_usd: null,
      affected_asins: c.aging_units_120d,
      marketplace: null,
    });
  const oc = c.outcome_counts_30d ?? {};
  const total = Object.values(oc).reduce((a: any, b: any) => a + b, 0) as number;
  if (total > 5) {
    const fail = ((oc.failed ?? 0) + (oc.reversed ?? 0)) / total;
    if (fail > 0.3)
      out.push({
        headline: `Decision quality dipped this week`,
        body: `${Math.round(fail * 100)}% of recent automated actions were neutral or reversed. Consider tightening confidence thresholds or moving toward Conservative tier temporarily.`,
        category: "general",
        severity: "watch",
        expected_impact_usd: null,
        affected_asins: null,
        marketplace: null,
      });
    else
      out.push({
        headline: `Automation is performing well`,
        body: `${Math.round((1 - fail) * 100)}% of recent actions delivered improvements. Current settings look balanced.`,
        category: "general",
        severity: "info",
        expected_impact_usd: null,
        affected_asins: null,
        marketplace: null,
      });
  }
  for (const m of c.marketplaces ?? []) {
    if (Number(m.decision_churn_score) > 0.4)
      out.push({
        headline: `${m.marketplace}: high decision churn`,
        body: `A meaningful share of price changes in ${m.marketplace} are <1% adjustments. Consider widening cooldowns to reduce noise.`,
        category: "marketplace",
        severity: "watch",
        expected_impact_usd: null,
        affected_asins: null,
        marketplace: m.marketplace,
      });
  }
  const comp = c.competitor_classifications ?? {};
  if ((comp.aggressive_undercutter ?? 0) > 5)
    out.push({
      headline: `Aggressive competitors detected`,
      body: `${comp.aggressive_undercutter} sellers across your catalog react under 10 minutes with sub-5¢ undercuts. Avoid micro-undercut wars on these ASINs.`,
      category: "competition",
      severity: "watch",
      expected_impact_usd: null,
      affected_asins: comp.aggressive_undercutter,
      marketplace: null,
    });
  return out.slice(0, 8);
}

function impactTier(i: any): "high" | "medium" | "low" {
  const usd = Number(i.expected_impact_usd ?? 0);
  const asins = Number(i.affected_asins ?? 0);
  if (usd >= 500 || asins >= 25 || i.severity === "important") return "high";
  if (usd >= 100 || asins >= 5 || i.severity === "watch") return "medium";
  return "low";
}

function dedupeKey(i: any): string {
  const cat = (i.category ?? "general").toLowerCase();
  const mp = (i.marketplace ?? "all").toLowerCase();
  const norm = String(i.headline ?? "")
    .toLowerCase()
    .replace(/[0-9]+/g, "#")
    .replace(/[^a-z#]+/g, "_")
    .slice(0, 80);
  return `${cat}:${mp}:${norm}`;
}

async function processUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
) {
  const ctx = await buildContext(admin, userId);
  const insights = await generateInsights(ctx);
  if (!insights.length) return 0;
  const now = new Date().toISOString();
  const rows = insights.map((i) => {
    const tier = impactTier(i);
    return {
      user_id: userId,
      generated_at: now,
      category: i.category ?? "general",
      severity: i.severity ?? "info",
      headline: String(i.headline ?? "").slice(0, 200),
      body: String(i.body ?? "").slice(0, 1500),
      expected_impact_usd:
        i.expected_impact_usd != null ? Number(i.expected_impact_usd) : null,
      affected_asins: i.affected_asins != null ? Number(i.affected_asins) : null,
      marketplace: i.marketplace ?? null,
      impact_tier: tier,
      dedupe_key: dedupeKey(i),
      suppressed: tier === "low",
      source_data: { context_summary: { marketplaces: ctx.marketplaces?.length ?? 0 } },
    };
  });
  // Upsert on dedupe_key so re-runs refresh existing insights instead of stacking duplicates.
  await admin
    .from("repricer_strategic_insights")
    .upsert(rows, { onConflict: "user_id,dedupe_key", ignoreDuplicates: false });
  return rows.length;
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
        /* */
      }
    }
    if (body?.all_users === true) {
      const auth = req.headers.get("authorization") || "";
      if (!auth.includes(SERVICE_ROLE))
        return new Response(JSON.stringify({ error: "service required" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      const { data: users } = await admin
        .from("repricer_assignments")
        .select("user_id")
        .eq("is_enabled", true);
      const uniq = Array.from(new Set((users ?? []).map((u: any) => u.user_id)));
      let total = 0;
      for (const uid of uniq) {
        try {
          total += await processUser(admin, uid);
          await new Promise((r) => setTimeout(r, 1500));
        } catch (e) {
          console.error("advisor user fail", uid, e);
        }
      }
      return new Response(JSON.stringify({ users: uniq.length, insights: total }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const auth = req.headers.get("authorization");
    if (!auth)
      return new Response(JSON.stringify({ error: "auth required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    const userClient = createClient(
      SUPABASE_URL,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user)
      return new Response(JSON.stringify({ error: "invalid user" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    const n = await processUser(admin, user.id);
    return new Response(JSON.stringify({ insights: n }), {
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
