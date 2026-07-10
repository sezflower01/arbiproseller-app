// Daily Intelligence Builder
// Computes Buy Box Quality, Competitor Profiles, Marketplace Personality,
// and Decision Churn from existing snapshots, price actions, outcomes, sales.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const r2 = (n: number) => Math.round(n * 100) / 100;

async function buildForUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
) {
  const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const since14d = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

  const [
    { data: assigns },
    { data: snaps },
    { data: actions },
    { data: outcomes },
    { data: sales },
    { data: invRows },
  ] = await Promise.all([
    admin
      .from("repricer_assignments")
      .select(
        "asin,marketplace,last_buybox_status,last_buybox_price,last_applied_price,buybox_lost_at,min_price_override",
      )
      .eq("user_id", userId)
      .eq("is_enabled", true)
      .neq("status", "DISABLED")
      .limit(5000),
    admin
      .from("repricer_competitor_snapshots")
      .select(
        "asin,marketplace,fetched_at,buybox_price,buybox_seller_id,lowest_fba_price,offers_count,offers_json",
      )
      .eq("user_id", userId)
      .gte("fetched_at", since14d)
      .order("fetched_at", { ascending: true })
      .limit(50000),
    admin
      .from("repricer_price_actions")
      .select("asin,marketplace,old_price,new_price,created_at")
      .eq("user_id", userId)
      .gte("created_at", since30d)
      .limit(50000),
    admin
      .from("repricer_action_outcomes")
      .select("asin,marketplace,outcome_label,evaluated_at")
      .eq("user_id", userId)
      .gte("evaluated_at", since30d)
      .limit(50000),
    admin
      .from("sales_orders")
      .select("asin,quantity,order_date")
      .eq("user_id", userId)
      .gte("order_date", since30d)
      .limit(50000),
    admin
      .from("inventory")
      .select("asin,cost,my_price")
      .eq("user_id", userId)
      .limit(20000),
  ]);

  const invByAsin = new Map<string, any>();
  for (const i of invRows ?? []) invByAsin.set(i.asin, i);

  // Group snapshots by asin|marketplace
  const snapByKey = new Map<string, any[]>();
  for (const s of snaps ?? []) {
    const k = `${s.asin}|${s.marketplace}`;
    if (!snapByKey.has(k)) snapByKey.set(k, []);
    snapByKey.get(k)!.push(s);
  }
  const actionsByKey = new Map<string, any[]>();
  for (const a of actions ?? []) {
    const k = `${a.asin}|${a.marketplace}`;
    if (!actionsByKey.has(k)) actionsByKey.set(k, []);
    actionsByKey.get(k)!.push(a);
  }
  const outcomesByKey = new Map<string, any[]>();
  for (const o of outcomes ?? []) {
    const k = `${o.asin}|${o.marketplace}`;
    if (!outcomesByKey.has(k)) outcomesByKey.set(k, []);
    outcomesByKey.get(k)!.push(o);
  }
  const salesByAsin = new Map<string, any[]>();
  for (const s of sales ?? []) {
    if (!salesByAsin.has(s.asin)) salesByAsin.set(s.asin, []);
    salesByAsin.get(s.asin)!.push(s);
  }

  // ---- Buy Box Quality per assignment ----
  const bbqRows: any[] = [];
  for (const a of assigns ?? []) {
    const k = `${a.asin}|${a.marketplace}`;
    const snList = snapByKey.get(k) ?? [];
    if (snList.length < 2) continue;
    const inv = invByAsin.get(a.asin);
    const cost = Number(inv?.cost ?? 0);
    const myPrice = Number(a.last_applied_price ?? inv?.my_price ?? 0);
    const minPrice = Number(a.min_price_override ?? 0);

    // Margin quality: how far above floor relative to price
    const marginQ =
      myPrice > 0 && minPrice > 0
        ? clamp((myPrice - minPrice) / myPrice)
        : myPrice > 0 && cost > 0
          ? clamp((myPrice - cost) / myPrice)
          : 0.5;

    // Hold duration: longest contiguous streak where buybox_seller_id was us
    // We don't store our seller_id consistently; approximate: streak where buybox_price ~= last_applied_price (±1%).
    let inWin = false;
    let curStart = 0;
    let bestHours = 0;
    let totalWinSamples = 0;
    let stableSamples = 0;
    for (let i = 0; i < snList.length; i++) {
      const s = snList[i];
      const owns =
        s.buybox_price &&
        myPrice > 0 &&
        Math.abs(Number(s.buybox_price) - myPrice) / myPrice < 0.01;
      if (owns) {
        totalWinSamples++;
        if (!inW(inWin)) {
          inWin = true;
          curStart = new Date(s.fetched_at).getTime();
        }
        const hours =
          (new Date(s.fetched_at).getTime() - curStart) / 3600000;
        if (hours > bestHours) bestHours = hours;
      } else {
        inWin = false;
      }
      // price stability: consecutive snapshots with same buybox price
      if (i > 0) {
        const prev = snList[i - 1];
        const dp =
          prev.buybox_price && s.buybox_price
            ? Math.abs(Number(s.buybox_price) - Number(prev.buybox_price))
            : 1;
        if (dp < 0.05) stableSamples++;
      }
    }
    const stability = clamp(stableSamples / Math.max(1, snList.length - 1));

    // Velocity after win: units sold during win window vs baseline
    const aSales = salesByAsin.get(a.asin) ?? [];
    const recentUnits = aSales
      .filter((s: any) => new Date(s.order_date).getTime() > Date.now() - 7 * 86400000)
      .reduce((acc: number, s: any) => acc + Number(s.quantity ?? 1), 0);
    const velocity = recentUnits / 7;

    // Recovery sustainability: outcome win rate weighted by absence of reversals
    const oList = outcomesByKey.get(k) ?? [];
    const good = oList.filter((o: any) => o.outcome_label === "successful").length;
    const partial = oList.filter((o: any) => o.outcome_label === "partial").length;
    const reversed = oList.filter((o: any) => o.outcome_label === "reversed").length;
    const failed = oList.filter((o: any) => o.outcome_label === "failed").length;
    const denom = Math.max(1, good + partial + failed + reversed);
    const recoverySust = clamp((good + partial * 0.5 - reversed - failed * 0.5) / denom + 0.5);

    // Competitor quality: how many distinct competitors and their volatility — high count + volatility => tougher market
    const distinctCompetitors = new Set<string>();
    for (const s of snList) {
      for (const o of (s.offers_json as any[]) || []) {
        if (o?.seller_id) distinctCompetitors.add(o.seller_id);
      }
      if (s.buybox_seller_id) distinctCompetitors.add(s.buybox_seller_id);
    }
    const compQ = clamp(distinctCompetitors.size / 15);

    const winRate = totalWinSamples / snList.length;
    const score = Math.round(
      (marginQ * 30 +
        stability * 15 +
        clamp(bestHours / 48) * 15 +
        clamp(velocity / 5) * 10 +
        recoverySust * 20 +
        winRate * 10) ,
    );

    let classification = "unknown";
    if (winRate > 0.6 && marginQ > 0.3) classification = "profitable_winner";
    else if (winRate > 0.6 && marginQ <= 0.15) classification = "unprofitable_winner";
    else if (winRate > 0.3 && stability < 0.4) classification = "volatile_winner";
    else if (winRate < 0.2) classification = "losing";

    bbqRows.push({
      user_id: userId,
      asin: a.asin,
      marketplace: a.marketplace,
      quality_score: score,
      margin_quality: r2(marginQ),
      price_stability: r2(stability),
      hold_duration_hours: r2(bestHours),
      velocity_after_win: r2(velocity),
      competitor_quality: r2(compQ),
      recovery_sustainability: r2(recoverySust),
      classification,
      signals: {
        win_rate: r2(winRate),
        distinct_competitors: distinctCompetitors.size,
        snapshot_count: snList.length,
      },
      computed_at: new Date().toISOString(),
    });
  }

  for (let i = 0; i < bbqRows.length; i += 200) {
    await admin
      .from("repricer_buybox_quality")
      .upsert(bbqRows.slice(i, i + 200), {
        onConflict: "user_id,asin,marketplace",
      });
  }

  // ---- Competitor profiles (aggregate by seller_id across snapshots) ----
  type CP = {
    asin: string;
    marketplace: string;
    seller_id: string;
    prices: { ts: number; price: number }[];
  };
  const cpAgg = new Map<string, CP>();
  for (const s of snaps ?? []) {
    const offers = (s.offers_json as any[]) || [];
    for (const o of offers) {
      const sid = o?.seller_id;
      const price = Number(o?.price ?? o?.landed_price ?? 0);
      if (!sid || !price) continue;
      const k = `${s.asin}|${s.marketplace}|${sid}`;
      if (!cpAgg.has(k))
        cpAgg.set(k, {
          asin: s.asin,
          marketplace: s.marketplace,
          seller_id: sid,
          prices: [],
        });
      cpAgg.get(k)!.prices.push({
        ts: new Date(s.fetched_at).getTime(),
        price,
      });
    }
  }
  const cpRows: any[] = [];
  for (const cp of cpAgg.values()) {
    if (cp.prices.length < 3) continue;
    cp.prices.sort((a, b) => a.ts - b.ts);
    // reaction time: avg minutes between price changes
    let totalMin = 0;
    let changes = 0;
    let undercutSum = 0;
    let undercutN = 0;
    let volSum = 0;
    for (let i = 1; i < cp.prices.length; i++) {
      const dp = cp.prices[i].price - cp.prices[i - 1].price;
      if (Math.abs(dp) > 0.01) {
        totalMin +=
          (cp.prices[i].ts - cp.prices[i - 1].ts) / 60000;
        changes += 1;
        volSum += Math.abs(dp);
        if (dp < 0) {
          undercutSum += Math.abs(dp) * 100; // cents
          undercutN += 1;
        }
      }
    }
    const avgReact = changes > 0 ? totalMin / changes : null;
    const undercutCents = undercutN > 0 ? undercutSum / undercutN : null;
    const meanPrice =
      cp.prices.reduce((a, b) => a + b.price, 0) / cp.prices.length;
    const volatility = meanPrice > 0 ? volSum / cp.prices.length / meanPrice : 0;

    let classification = "unknown";
    if (avgReact != null && avgReact < 10 && undercutCents != null && undercutCents < 5)
      classification = "aggressive_undercutter";
    else if (avgReact != null && avgReact > 240) classification = "slow_repricer";
    else if (changes <= 1) classification = "premium_holder";
    else if (volatility > 0.05) classification = "oscillator";
    else if (undercutCents != null && undercutCents < 2 && changes > 5)
      classification = "race_to_bottom";

    cpRows.push({
      user_id: userId,
      asin: cp.asin,
      marketplace: cp.marketplace,
      competitor_seller_id: cp.seller_id,
      classification,
      avg_reaction_minutes: avgReact != null ? r2(avgReact) : null,
      undercut_pattern_cents: undercutCents != null ? r2(undercutCents) : null,
      volatility: r2(volatility),
      observation_count: cp.prices.length,
      last_seen: new Date(cp.prices[cp.prices.length - 1].ts).toISOString(),
      signals: { changes },
      computed_at: new Date().toISOString(),
    });
  }
  for (let i = 0; i < cpRows.length; i += 200) {
    await admin
      .from("repricer_competitor_profiles")
      .upsert(cpRows.slice(i, i + 200), {
        onConflict: "user_id,asin,marketplace,competitor_seller_id",
      });
  }

  // ---- Marketplace personality ----
  const mpAgg = new Map<
    string,
    {
      vol: number[];
      changes: number;
      total: number;
      churnLowImpact: number;
      churnTotal: number;
      bbStable: number;
      bbTotal: number;
    }
  >();
  for (const s of snaps ?? []) {
    if (!mpAgg.has(s.marketplace))
      mpAgg.set(s.marketplace, {
        vol: [],
        changes: 0,
        total: 0,
        churnLowImpact: 0,
        churnTotal: 0,
        bbStable: 0,
        bbTotal: 0,
      });
  }
  for (const cp of cpAgg.values()) {
    const m = mpAgg.get(cp.marketplace);
    if (!m) continue;
    const meanPrice =
      cp.prices.reduce((a, b) => a + b.price, 0) / cp.prices.length;
    let v = 0;
    for (let i = 1; i < cp.prices.length; i++)
      v += Math.abs(cp.prices[i].price - cp.prices[i - 1].price);
    if (meanPrice > 0) m.vol.push(v / cp.prices.length / meanPrice);
  }
  for (const a of actions ?? []) {
    const m = mpAgg.get(a.marketplace);
    if (!m) continue;
    m.churnTotal += 1;
    const old = Number(a.old_price ?? 0);
    const nw = Number(a.new_price ?? 0);
    if (old > 0 && Math.abs(nw - old) / old < 0.01) m.churnLowImpact += 1;
  }
  for (const s of snaps ?? []) {
    const m = mpAgg.get(s.marketplace);
    if (!m) continue;
    m.bbTotal += 1;
  }
  // bb stability — group buybox seller per asin and count shifts
  const bbShifts = new Map<string, { shifts: number; total: number }>();
  const sortedSnaps = (snaps ?? []).slice().sort(
    (a: any, b: any) => a.fetched_at.localeCompare(b.fetched_at),
  );
  let lastByKey = new Map<string, string | null>();
  for (const s of sortedSnaps) {
    const k = `${s.marketplace}|${s.asin}`;
    if (!bbShifts.has(s.marketplace))
      bbShifts.set(s.marketplace, { shifts: 0, total: 0 });
    bbShifts.get(s.marketplace)!.total += 1;
    const prev = lastByKey.get(k);
    if (prev !== undefined && prev !== s.buybox_seller_id)
      bbShifts.get(s.marketplace)!.shifts += 1;
    lastByKey.set(k, s.buybox_seller_id);
  }

  const miRows: any[] = [];
  for (const [mp, m] of mpAgg) {
    const volAvg =
      m.vol.length > 0
        ? m.vol.reduce((x, y) => x + y, 0) / m.vol.length
        : 0;
    const churn =
      m.churnTotal > 0 ? m.churnLowImpact / m.churnTotal : 0;
    const bb = bbShifts.get(mp);
    const bbStability = bb && bb.total > 0 ? 1 - bb.shifts / bb.total : 0;
    const recommended =
      volAvg > 0.05
        ? "balanced"
        : bbStability > 0.7
          ? "aggressive"
          : "balanced";
    miRows.push({
      user_id: userId,
      marketplace: mp,
      volatility_score: r2(clamp(volAvg * 5)),
      avg_competitor_aggression: r2(clamp(volAvg * 5)),
      bb_stability_score: r2(clamp(bbStability)),
      floor_sensitivity: r2(0.5),
      recommended_aggression: recommended,
      decision_churn_score: r2(clamp(churn)),
      signals: {
        snapshots: m.bbTotal,
        actions: m.churnTotal,
        low_impact_actions: m.churnLowImpact,
      },
      computed_at: new Date().toISOString(),
    });
  }
  if (miRows.length) {
    await admin
      .from("repricer_marketplace_intelligence")
      .upsert(miRows, { onConflict: "user_id,marketplace" });
  }

  return {
    bb_quality: bbqRows.length,
    competitor_profiles: cpRows.length,
    marketplaces: miRows.length,
  };
}

// helper to satisfy linter on inline assignment
function inW(b: boolean) {
  return b;
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
      const { withCronLock } = await import("../_shared/cron-lock.ts");
      const outcome = await withCronLock(admin as any, "repricer-intelligence-build-daily", 3600, async () => {
        const { data: users } = await admin
          .from("repricer_assignments")
          .select("user_id")
          .eq("is_enabled", true);
        const uniq = Array.from(new Set((users ?? []).map((u: any) => u.user_id)));
        const totals = { bb_quality: 0, competitor_profiles: 0, marketplaces: 0 };
        for (const uid of uniq) {
          try {
            const t = await buildForUser(admin, uid);
            totals.bb_quality += t.bb_quality;
            totals.competitor_profiles += t.competitor_profiles;
            totals.marketplaces += t.marketplaces;
            await new Promise((r) => setTimeout(r, 600));
          } catch (e) {
            console.error("intel fail", uid, e);
          }
        }
        return { items_processed: totals.bb_quality + totals.competitor_profiles, detail: { total_users: uniq.length, ...totals } };
      });
      return new Response(JSON.stringify({ ...outcome }), {
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
    const t = await buildForUser(admin, user.id);
    return new Response(JSON.stringify(t), {
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
