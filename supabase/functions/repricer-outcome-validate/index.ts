// Outcome Validation Engine — runs every 2h.
// For each repricer_price_action older than 24h that lacks an outcome row,
// computes whether the action helped: BB improvement, sales lift, revenue/margin delta,
// inventory age progress. Persists outcome_label.
// This data feeds dynamic confidence scoring + memory.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Label = "successful" | "partial" | "neutral" | "failed" | "reversed";

function classify(
  bb: boolean | null,
  sales: boolean | null,
  revenueDelta: number,
  marginDelta: number,
  reversed: boolean,
): Label {
  if (reversed) return "reversed";
  let pos = 0;
  let neg = 0;
  if (bb === true) pos += 2;
  if (bb === false) neg += 1;
  if (sales === true) pos += 2;
  if (sales === false) neg += 1;
  if (revenueDelta > 0) pos += 1;
  if (revenueDelta < -0.5) neg += 2;
  if (marginDelta > 0) pos += 1;
  if (marginDelta < -2) neg += 2;
  if (pos >= 4 && neg === 0) return "successful";
  if (pos >= 2 && neg <= 1) return "partial";
  if (neg >= 3) return "failed";
  return "neutral";
}

async function processUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<number> {
  const cutoffOld = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const cutoffMax = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // Fetch recent unevaluated price actions
  const { data: actions } = await admin
    .from("repricer_price_actions")
    .select("id,asin,marketplace,old_price,new_price,created_at,reason")
    .eq("user_id", userId)
    .lte("created_at", cutoffOld)
    .gte("created_at", cutoffMax)
    .order("created_at", { ascending: false })
    .limit(500);

  if (!actions?.length) return 0;

  // Already-evaluated action ids
  const ids = actions.map((a: any) => a.id);
  const { data: existing } = await admin
    .from("repricer_action_outcomes")
    .select("action_id")
    .eq("user_id", userId)
    .in("action_id", ids);
  const existingIds = new Set((existing ?? []).map((r: any) => r.action_id));

  const todo = actions.filter((a: any) => !existingIds.has(a.id));
  if (!todo.length) return 0;

  // Snapshot lookups for BB + sales since action
  const asins = Array.from(new Set(todo.map((a: any) => a.asin)));
  const [{ data: assigns }, { data: salesRows }] = await Promise.all([
    admin
      .from("repricer_assignments")
      .select(
        "asin,marketplace,last_buybox_status,last_buybox_price,last_applied_price,buybox_lost_at",
      )
      .eq("user_id", userId)
      .in("asin", asins),
    admin
      .from("sales_orders")
      .select("asin,quantity,order_date,sold_price")
      .eq("user_id", userId)
      .in("asin", asins)
      .gte("order_date", cutoffMax),
  ]);

  const assignMap = new Map<string, any>();
  for (const a of assigns ?? [])
    assignMap.set(`${a.asin}|${a.marketplace}`, a);

  const rows: any[] = [];
  for (const act of todo) {
    const k = `${act.asin}|${act.marketplace}`;
    const assn = assignMap.get(k);
    const oldPrice = Number(act.old_price ?? 0);
    const newPrice = Number(act.new_price ?? 0);

    // Sales after action vs sales in equivalent window before
    const tAct = new Date(act.created_at).getTime();
    const after = (salesRows ?? []).filter(
      (s: any) =>
        s.asin === act.asin &&
        new Date(s.order_date).getTime() > tAct &&
        new Date(s.order_date).getTime() <= tAct + 48 * 3600 * 1000,
    );
    const before = (salesRows ?? []).filter(
      (s: any) =>
        s.asin === act.asin &&
        new Date(s.order_date).getTime() <= tAct &&
        new Date(s.order_date).getTime() > tAct - 48 * 3600 * 1000,
    );
    const unitsAfter = after.reduce(
      (s: number, r: any) => s + Number(r.quantity ?? 1),
      0,
    );
    const unitsBefore = before.reduce(
      (s: number, r: any) => s + Number(r.quantity ?? 1),
      0,
    );
    const salesImproved =
      unitsAfter > unitsBefore
        ? true
        : unitsAfter < unitsBefore
          ? false
          : null;

    // BB improvement signal — current status compared to direction implied by action
    const status = String(assn?.last_buybox_status || "").toUpperCase();
    let bbImproved: boolean | null = null;
    if (status === "WINNING") bbImproved = true;
    else if (status === "LOST" || status === "SUPPRESSED") bbImproved = false;

    const revenueAfter = after.reduce(
      (s: number, r: any) => s + Number(r.sold_price ?? newPrice) * Number(r.quantity ?? 1),
      0,
    );
    const revenueBefore = before.reduce(
      (s: number, r: any) => s + Number(r.sold_price ?? oldPrice) * Number(r.quantity ?? 1),
      0,
    );
    const revenueDelta = revenueAfter - revenueBefore;

    // Margin delta proxy = price change pct
    const marginDelta =
      oldPrice > 0 ? ((newPrice - oldPrice) / oldPrice) * 100 : 0;

    // Reversed = if there was an opposite-direction action within 24h after
    const { data: reversal } = await admin
      .from("repricer_price_actions")
      .select("id,old_price,new_price,created_at")
      .eq("user_id", userId)
      .eq("asin", act.asin)
      .eq("marketplace", act.marketplace)
      .gt("created_at", act.created_at)
      .lt(
        "created_at",
        new Date(tAct + 24 * 3600 * 1000).toISOString(),
      )
      .limit(5);
    let reversed = false;
    for (const r of reversal ?? []) {
      const od = Number(r.old_price ?? 0);
      const nd = Number(r.new_price ?? 0);
      if (newPrice < oldPrice && nd > od) reversed = true; // reduced then raised
      if (newPrice > oldPrice && nd < od) reversed = true; // raised then reduced
    }

    const label = classify(
      bbImproved,
      salesImproved,
      revenueDelta,
      marginDelta,
      reversed,
    );

    const actionType =
      newPrice < oldPrice
        ? "reduction"
        : newPrice > oldPrice
          ? "raise"
          : "hold";

    rows.push({
      user_id: userId,
      asin: act.asin,
      marketplace: act.marketplace,
      action_id: act.id,
      action_type: actionType,
      recommended_at: act.created_at,
      evaluated_at: new Date().toISOString(),
      before_snapshot: {
        price: oldPrice,
        units_window_before: unitsBefore,
      },
      after_snapshot: {
        price: newPrice,
        units_window_after: unitsAfter,
        bb_status_now: status,
      },
      bb_improved: bbImproved,
      sales_improved: salesImproved,
      revenue_delta_usd: Math.round(revenueDelta * 100) / 100,
      margin_delta_pct: Math.round(marginDelta * 100) / 100,
      age_improved: null,
      outcome_label: label,
      confidence_score:
        unitsBefore + unitsAfter >= 3 ? 0.8 : unitsBefore + unitsAfter >= 1 ? 0.5 : 0.3,
      notes: act.reason ?? null,
    });
  }

  for (let i = 0; i < rows.length; i += 200) {
    await admin
      .from("repricer_action_outcomes")
      .insert(rows.slice(i, i + 200));
  }
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
      if (!auth.includes(SERVICE_ROLE)) {
        return new Response(JSON.stringify({ error: "service required" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { withCronLock } = await import("../_shared/cron-lock.ts");
      const outcome = await withCronLock(admin as any, "repricer-outcome-validate-2h", 1800, async () => {
        const { data: users } = await admin
          .from("repricer_assignments")
          .select("user_id")
          .eq("is_enabled", true);
        const uniq = Array.from(new Set((users ?? []).map((u: any) => u.user_id)));
        let total = 0;
        for (const uid of uniq) {
          try {
            total += await processUser(admin, uid);
            await new Promise((r) => setTimeout(r, 400));
          } catch (e) {
            console.error("outcome user fail", uid, e);
          }
        }
        return { items_processed: total, detail: { total_users: uniq.length } };
      });
      return new Response(
        JSON.stringify({ outcomes: outcome.items_processed, ...outcome }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

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
    const n = await processUser(admin, user.id);
    return new Response(JSON.stringify({ outcomes: n }), {
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
