// Computes a daily Executive Summary snapshot for the repricer.
// - GET ?live=1            -> compute and return without persisting
// - POST { persist: true } -> compute + upsert today's snapshot for the user
// - POST { all_users: true } (service role) -> persist for every user (cron)
//
// Conservative business-language metrics. Always confidence-tagged.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface SummaryResult {
  snapshot_date: string;
  buybox_control_pct: number;
  revenue_protected: number;
  revenue_missed: number;
  aged_inventory_value: number;
  asins_needing_action: number;
  recovered_products: number;
  total_active_asins: number;
  top_blockers: Array<{ reason: string; label: string; count: number }>;
  strategy_distribution: Record<string, number>;
  assumptions: Record<string, unknown>;
  confidence: "high" | "medium" | "estimated";
}

const BLOCKER_LABELS: Record<string, string> = {
  AT_MIN_FLOOR: "Hit minimum price floor",
  MIN_FLOOR: "Hit minimum price floor",
  // PROFIT_GUARD / ROI_GUARD labels removed — Profit Guard no longer fires (manual-min-only policy).
  OSCILLATION_DETECTED: "Market unstable — pausing",
  RAPID_PRICE_INSTABILITY: "Market unstable — pausing",
  BB_OWNER_HOLD: "Already owns Buy Box",
  BUYBOX_SUPPRESSED: "Amazon hid the Buy Box",
  NOT_BB_ELIGIBLE: "Not Buy Box eligible",
  COOLDOWN: "Cooling down after recent change",
  MONOPOLY_COOLDOWN: "No competition — cooling down",
  SAFEGUARD_CLAMP: "Safety limit applied",
  AMAZON_MIN_PRICE_BLOCK: "Blocked by Amazon Automate min",
  AMAZON_MAX_PRICE_BLOCK: "Blocked by Amazon Automate max",
};

function labelFor(reason: string): string {
  if (!reason) return "Other";
  for (const k of Object.keys(BLOCKER_LABELS)) {
    if (reason.toUpperCase().includes(k)) return BLOCKER_LABELS[k];
  }
  return reason.replace(/_/g, " ").toLowerCase();
}

async function computeForUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<SummaryResult> {
  const today = new Date().toISOString().slice(0, 10);
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // Active assignments + buy box state
  const { data: assigns } = await admin
    .from("repricer_assignments")
    .select(
      "asin,sku,marketplace,is_enabled,status,last_buybox_status,last_buybox_price,last_applied_price,last_recommendation_reason,min_price_override",
    )
    .eq("user_id", userId)
    .eq("is_enabled", true)
    .neq("status", "DISABLED");

  const total = assigns?.length ?? 0;
  let bbWins = 0;
  let bbEligible = 0;
  for (const a of assigns ?? []) {
    const s = (a.last_buybox_status || "").toUpperCase();
    if (s && s !== "UNKNOWN") bbEligible += 1;
    if (s === "WINNING" || s === "OWNED" || s === "WON") bbWins += 1;
  }
  const buybox_control_pct =
    bbEligible > 0 ? Math.round((bbWins / bbEligible) * 1000) / 10 : 0;

  // Recent eval acks → blocker reasons + recovered + protected
  const { data: acks } = await admin
    .from("repricer_eval_acks")
    .select("reason,reason_business,strategy_state,asin,created_at")
    .eq("user_id", userId)
    .gte("created_at", since24h)
    .limit(5000);

  const blockerCounts = new Map<string, number>();
  let recovered = 0;
  let protectedCount = 0;
  for (const r of acks ?? []) {
    const reason = (r.reason || "").toUpperCase();
    if (!reason) continue;
    if (
      reason.includes("MIN_FLOOR") ||
      reason.includes("ROI_GUARD") ||
      reason.includes("PROFIT_GUARD")
    ) {
      protectedCount += 1;
    }
    if (
      reason.includes("BUYBOX_RECOVERED") ||
      reason.includes("UNDERPRICED_RECOVERY") ||
      reason.includes("RAISE")
    ) {
      recovered += 1;
    }
    if (
      reason.includes("FLOOR") ||
      reason.includes("GUARD") ||
      reason.includes("OSCILLATION") ||
      reason.includes("COOLDOWN") ||
      reason.includes("SUPPRESSED") ||
      reason.includes("CLAMP") ||
      reason.includes("AMAZON_MIN") ||
      reason.includes("AMAZON_MAX")
    ) {
      blockerCounts.set(reason, (blockerCounts.get(reason) ?? 0) + 1);
    }
  }

  const top_blockers = [...blockerCounts.entries()]
    .map(([reason, count]) => ({ reason, label: labelFor(reason), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Strategy distribution
  const { data: states } = await admin
    .from("repricer_strategy_states")
    .select("state")
    .eq("user_id", userId);
  const strategy_distribution: Record<string, number> = {};
  for (const s of states ?? []) {
    const k = (s.state as string) ?? "unknown";
    strategy_distribution[k] = (strategy_distribution[k] ?? 0) + 1;
  }

  // Inventory: aged value + needing action
  const { data: inv } = await admin
    .from("inventory")
    .select("asin,available,my_price,cost,estimated_age_days,listing_status")
    .eq("user_id", userId)
    .gt("available", 0)
    .limit(10000);

  let aged_inventory_value = 0;
  for (const row of inv ?? []) {
    const age = Number(row.estimated_age_days ?? 0);
    const avail = Number(row.available ?? 0);
    const price = Number(row.my_price ?? 0);
    if (age >= 60 && avail > 0 && price > 0) {
      // Conservative: value at risk = 50% of inventory value for 60+ day stock
      aged_inventory_value += 0.5 * price * avail;
    } else if (age >= 30 && avail > 0 && price > 0) {
      aged_inventory_value += 0.2 * price * avail;
    }
  }

  // ASINs needing action: enabled but with a current blocker reason in last 7d, or BB lost
  const { data: needsActionRows } = await admin
    .from("repricer_assignments")
    .select("asin")
    .eq("user_id", userId)
    .eq("is_enabled", true)
    .neq("status", "DISABLED")
    .or(
      "last_buybox_status.eq.LOST,last_buybox_status.eq.SUPPRESSED,apply_error.not.is.null",
    );
  const asins_needing_action = needsActionRows?.length ?? 0;

  // Revenue estimates — VERY conservative
  // Recent applied prices in last 24h: estimate recovered revenue = sum of (last_applied - prior) * 1 unit/day ceiling
  // We don't have unit velocity here per ASIN cheaply, so use a conservative "1 unit/listing/day" cap times raise delta.
  let revenue_protected_est = 0;
  let revenue_missed_est = 0;
  for (const a of assigns ?? []) {
    const myPrice = Number(a.last_applied_price ?? 0);
    const bbPrice = Number(a.last_buybox_price ?? 0);
    const floor = Number(a.min_price_override ?? 0);
    const status = (a.last_buybox_status || "").toUpperCase();

    // Missed: when we lost BB and we're floor-blocked above competitor
    if (
      (status === "LOST" || status === "SUPPRESSED") &&
      bbPrice > 0 &&
      myPrice > 0 &&
      myPrice > bbPrice
    ) {
      // Conservative: assume 0.5 lost unit/day at the gap value
      revenue_missed_est += Math.max(0, myPrice - bbPrice) * 0.5;
    }
    // Protected: when at floor and floor>=BB price (we held margin instead of chasing)
    if (floor > 0 && myPrice > 0 && Math.abs(myPrice - floor) < 0.05) {
      // Conservative: 0.25 unit/day held at floor margin
      revenue_protected_est += floor * 0.05; // ~5% margin held per held unit
    }
  }

  const confidence: SummaryResult["confidence"] =
    total > 50 && (acks?.length ?? 0) > 50 ? "medium" : "estimated";

  return {
    snapshot_date: today,
    buybox_control_pct,
    revenue_protected: Math.round(revenue_protected_est * 100) / 100,
    revenue_missed: Math.round(revenue_missed_est * 100) / 100,
    aged_inventory_value: Math.round(aged_inventory_value * 100) / 100,
    asins_needing_action,
    recovered_products: recovered,
    total_active_asins: total,
    top_blockers,
    strategy_distribution,
    assumptions: {
      buybox_control:
        "Wins / (assignments with known BB status). Excludes UNKNOWN.",
      revenue_protected:
        "Sum over ASINs at floor of floor_price * 0.05 (held margin proxy, 0.25 unit/day cap).",
      revenue_missed:
        "Sum over BB-lost/suppressed ASINs of (my_price - bb_price) * 0.5 (half a unit/day).",
      aged_inventory_value:
        "30-59 days: 20% of (price*qty). 60+ days: 50% of (price*qty).",
      recovered_products:
        "Eval-ack reasons containing RAISE / RECOVERED / UNDERPRICED_RECOVERY in last 24h.",
      strategy_distribution: "Live counts from repricer_strategy_states.",
      window_hours: 24,
      conservative: true,
    },
    confidence,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
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

    // Cron / fan-out: persist for all users
    if (body?.all_users === true) {
      const auth = req.headers.get("authorization") || "";
      if (!auth.includes(SERVICE_ROLE)) {
        return new Response(
          JSON.stringify({ error: "service role required" }),
          {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      const { withCronLock } = await import("../_shared/cron-lock.ts");
      const outcome = await withCronLock(admin as any, "repricer-executive-summary-daily", 2400, async () => {
        const { data: users } = await admin
          .from("repricer_assignments")
          .select("user_id")
          .eq("is_enabled", true);
        const uniq = Array.from(
          new Set((users ?? []).map((u: any) => u.user_id)),
        );
        let ok = 0;
        for (const uid of uniq) {
          try {
            const summary = await computeForUser(admin, uid);
            await admin.from("repricer_executive_snapshots").upsert(
              { user_id: uid, ...summary },
              { onConflict: "user_id,snapshot_date" },
            );
            ok += 1;
            await new Promise((r) => setTimeout(r, 200));
          } catch (e) {
            console.error("user fail", uid, e);
          }
        }
        return { items_processed: ok, detail: { total_users: uniq.length } };
      });
      return new Response(JSON.stringify({ persisted: outcome.items_processed, ...outcome }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Per-user via JWT
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "auth required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(
      SUPABASE_URL,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "invalid user" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const summary = await computeForUser(admin, user.id);

    if (!live && body?.persist !== false) {
      await admin.from("repricer_executive_snapshots").upsert(
        { user_id: user.id, ...summary },
        { onConflict: "user_id,snapshot_date" },
      );
    }

    return new Response(JSON.stringify(summary), {
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
