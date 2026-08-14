// repricer-rule-performance
//
// Aggregates the 7 metrics requested for monitoring hybrid/experimental
// repricer presets (e.g. MOMENTUM_SMART) against their siblings, grouped by
// smart_profile:
//   1. Buy Box win rate %      4. Profit/day        7. Raises that lost BB
//   2. Units/day               5. ROI
//   3. Revenue/day             6. Average selling price
//
// No existing page/query in this codebase computes any of these per-rule —
// see the investigation this was built from. Reuses sales_orders' own
// pre-computed total_sale_amount/total_cost/total_fees/roi (the same fields
// the P&L module trusts) rather than re-deriving fee math from scratch.
//
// Rule attribution caveat: an order is attributed to whichever rule its
// ASIN+SKU+marketplace assignment is CURRENTLY on, not whichever rule was
// active on the day of that historical sale. If a listing recently switched
// presets, some of its trailing-window sales will be misattributed to the
// new preset. Acceptable for a rough per-preset trend line, not for a
// precise backtest -- flagged in the response so the UI can say so.
//
// Raise -> BB loss detection: for each price_actions row where
// new_price > old_price, look at repricer_competitor_snapshots for the same
// asin/marketplace immediately before and after the raise, and compare
// buybox_seller_id to the user's own seller_id for that marketplace --
// "was the BB owner before, isn't after" within RAISE_LOOKAHEAD_HOURS.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PAGE_SIZE = 1000;
const RAISE_LOOKBACK_HOURS = 3;
const RAISE_LOOKAHEAD_HOURS = 12;

async function fetchAllRows(
  supabase: any,
  table: string,
  select: string,
  applyFilters: (q: any) => any,
): Promise<any[]> {
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await applyFilters(
      supabase.from(table).select(select).order('id', { ascending: true }),
    ).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Missing auth' }), { status: 401, headers: corsHeaders });
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    const userId = user.id;

    // Admin-only: same user_roles check every other admin repricer page uses.
    const { data: roleRow } = await supabase.from('user_roles').select('role').eq('user_id', userId).eq('role', 'admin').maybeSingle();
    if (!roleRow) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: corsHeaders });

    const body = await req.json().catch(() => ({}));
    const days = Math.max(1, Math.min(180, Number(body?.days) || 30));
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // 1. Rules -> smart_profile label
    const rules = await fetchAllRows(supabase, 'repricer_rules', 'id, name, smart_profile', (q) => q.eq('user_id', userId));
    const ruleToProfile = new Map<string, string>();
    for (const r of rules) ruleToProfile.set(r.id, r.smart_profile || 'CUSTOM');

    // 2. Assignments -> current rule/profile, for BB win-rate + order attribution
    const assignments = await fetchAllRows(
      supabase, 'repricer_assignments',
      'id, asin, sku, marketplace, rule_id, is_enabled, last_buybox_status',
      (q) => q.eq('user_id', userId).not('rule_id', 'is', null),
    );
    const skuToProfile = new Map<string, string>(); // `${asin}::${sku}::${marketplace}` -> profile
    const profileBb = new Map<string, { winning: number; losing: number; unknown: number }>();
    const ensureBb = (p: string) => {
      if (!profileBb.has(p)) profileBb.set(p, { winning: 0, losing: 0, unknown: 0 });
      return profileBb.get(p)!;
    };
    for (const a of assignments) {
      const profile = ruleToProfile.get(a.rule_id) || 'CUSTOM';
      skuToProfile.set(`${a.asin}::${a.sku}::${a.marketplace}`, profile);
      if (!a.is_enabled) continue;
      const bucket = ensureBb(profile);
      if (a.last_buybox_status === 'winning' || a.last_buybox_status === 'owned') bucket.winning++;
      else if (a.last_buybox_status === 'losing') bucket.losing++;
      else bucket.unknown++;
    }

    // 3. Sales orders in window -> units/revenue/profit/ROI/ASP per profile per day.
    // Joined + grouped server-side (repricer_rule_perf_sales RPC) -- sales_orders
    // is too high-volume in this account to page through client-side just to
    // group by a handful of profile keys.
    const { data: salesAgg, error: salesAggErr } = await supabase.rpc('repricer_rule_perf_sales', {
      p_user_id: userId, p_since: since,
    });
    if (salesAggErr) throw salesAggErr;
    type ProfileTotals = { units: number; revenue: number; cost: number; fees: number; orders: number; byDay: Map<string, { units: number; revenue: number; profit: number }> };
    const profileTotals = new Map<string, ProfileTotals>();
    const ensureTotals = (p: string) => {
      if (!profileTotals.has(p)) profileTotals.set(p, { units: 0, revenue: 0, cost: 0, fees: 0, orders: 0, byDay: new Map() });
      return profileTotals.get(p)!;
    };
    for (const row of (salesAgg || [])) {
      const t = ensureTotals(row.smart_profile || 'CUSTOM');
      const qty = Number(row.units) || 0;
      const revenue = Number(row.revenue) || 0;
      const cost = Number(row.cost) || 0;
      const fees = Number(row.fees) || 0;
      t.units += qty; t.revenue += revenue; t.cost += cost; t.fees += fees; t.orders += Number(row.order_count) || 0;
      const day = String(row.order_day);
      if (!t.byDay.has(day)) t.byDay.set(day, { units: 0, revenue: 0, profit: 0 });
      const d = t.byDay.get(day)!;
      d.units += qty; d.revenue += revenue; d.profit += (revenue - cost - fees);
    }

    // 4. Price actions -> raises -> BB-loss-after-raise, per profile.
    // Filtered ("is this a raise") and LIMITed server-side (repricer_rule_perf_raises
    // RPC) -- repricer_price_actions is extremely high-volume for this account
    // (confirmed ~1000+ rows for a single ASIN over 11 days); pulling every row
    // through the edge function to filter client-side timed out in testing.
    const RAISE_CHECK_LIMIT = 500;
    const { data: raises_, error: raisesErr } = await supabase.rpc('repricer_rule_perf_raises', {
      p_user_id: userId, p_since: since, p_limit: RAISE_CHECK_LIMIT,
    });
    if (raisesErr) throw raisesErr;
    const raises = raises_ || [];

    // Own seller_id per marketplace, to determine BB ownership from snapshots.
    const sellerAuths = await fetchAllRows(supabase, 'seller_authorizations', 'marketplace_id, seller_id, selling_partner_id', (q) => q.eq('user_id', userId));
    const MARKETPLACE_IDS: Record<string, string> = { US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2', MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC' };
    const ownSellerIdByMarketplace = new Map<string, string>();
    for (const [mp, mid] of Object.entries(MARKETPLACE_IDS)) {
      const auth = sellerAuths.find((s: any) => s.marketplace_id === mid);
      const sid = auth?.seller_id || auth?.selling_partner_id;
      if (sid) ownSellerIdByMarketplace.set(mp, sid);
    }

    type RaiseStats = { totalRaises: number; lostBbAfter: number; noSnapshotData: number };
    const profileRaises = new Map<string, RaiseStats>();
    const ensureRaises = (p: string) => {
      if (!profileRaises.has(p)) profileRaises.set(p, { totalRaises: 0, lostBbAfter: 0, noSnapshotData: 0 });
      return profileRaises.get(p)!;
    };

    // raises already comes pre-limited (most recent RAISE_CHECK_LIMIT) and
    // pre-sorted DESC by the RPC itself.
    const raisesToCheck = raises;

    // Batch-fetch every snapshot that could possibly be a "before" or "after"
    // reference for ANY raise being checked, in one paginated query, then
    // match in memory -- avoids O(raises) round trips (was timing out at
    // 2 queries/raise against a real account's raise volume).
    let snapshotsByPair = new Map<string, { buybox_seller_id: string | null; fetched_at: string }[]>();
    if (raisesToCheck.length > 0) {
      const uniqueAsins = [...new Set(raisesToCheck.map((r: any) => r.asin))];
      const uniqueMarketplaces = [...new Set(raisesToCheck.map((r: any) => r.marketplace))];
      const earliestNeeded = new Date(
        Math.min(...raisesToCheck.map((r: any) => new Date(r.created_at).getTime())) - RAISE_LOOKBACK_HOURS * 3600000,
      ).toISOString();
      const latestNeeded = new Date(
        Math.max(...raisesToCheck.map((r: any) => new Date(r.created_at).getTime())) + RAISE_LOOKAHEAD_HOURS * 3600000,
      ).toISOString();
      const allSnapshots = await fetchAllRows(
        supabase, 'repricer_competitor_snapshots',
        'asin, marketplace, buybox_seller_id, fetched_at',
        (q) => q.eq('user_id', userId)
          .in('asin', uniqueAsins).in('marketplace', uniqueMarketplaces)
          .gte('fetched_at', earliestNeeded).lte('fetched_at', latestNeeded),
      );
      for (const s of allSnapshots) {
        const k = `${s.asin}::${s.marketplace}`;
        if (!snapshotsByPair.has(k)) snapshotsByPair.set(k, []);
        snapshotsByPair.get(k)!.push({ buybox_seller_id: s.buybox_seller_id, fetched_at: s.fetched_at });
      }
      for (const arr of snapshotsByPair.values()) arr.sort((a, b) => a.fetched_at.localeCompare(b.fetched_at));
    }

    const findNearestBefore = (arr: { buybox_seller_id: string | null; fetched_at: string }[], atIso: string, cutoffIso: string) => {
      let best: typeof arr[0] | null = null;
      for (const s of arr) {
        if (s.fetched_at >= cutoffIso && s.fetched_at <= atIso) best = s; // sorted ascending, keep latest in range
      }
      return best;
    };
    const findNearestAfter = (arr: { buybox_seller_id: string | null; fetched_at: string }[], atIso: string, cutoffIso: string) => {
      for (const s of arr) {
        if (s.fetched_at > atIso && s.fetched_at <= cutoffIso) return s; // sorted ascending, first in range = nearest
      }
      return null;
    };

    for (const raise of raisesToCheck) {
      const key = `${raise.asin}::${raise.sku}::${raise.marketplace}`;
      const profile = skuToProfile.get(key);
      if (!profile) continue;
      const stats = ensureRaises(profile);
      stats.totalRaises++;

      const raiseTime = new Date(raise.created_at).getTime();
      const beforeCutoff = new Date(raiseTime - RAISE_LOOKBACK_HOURS * 3600000).toISOString();
      const afterCutoff = new Date(raiseTime + RAISE_LOOKAHEAD_HOURS * 3600000).toISOString();
      const ownSellerId = ownSellerIdByMarketplace.get(raise.marketplace);
      const pairSnapshots = snapshotsByPair.get(`${raise.asin}::${raise.marketplace}`) || [];

      const beforeSnap = findNearestBefore(pairSnapshots, raise.created_at, beforeCutoff);
      const afterSnap = findNearestAfter(pairSnapshots, raise.created_at, afterCutoff);

      if (!ownSellerId || !beforeSnap || !afterSnap) {
        stats.noSnapshotData++;
        continue;
      }
      const wasWinning = beforeSnap.buybox_seller_id === ownSellerId;
      const stillWinning = afterSnap.buybox_seller_id === ownSellerId;
      if (wasWinning && !stillWinning) stats.lostBbAfter++;
    }

    // 5. Assemble per-profile response
    const allProfiles = new Set<string>([...profileBb.keys(), ...profileTotals.keys(), ...profileRaises.keys()]);
    const results = [...allProfiles].map((profile) => {
      const bb = profileBb.get(profile) || { winning: 0, losing: 0, unknown: 0 };
      const bbDenom = bb.winning + bb.losing;
      const totals = profileTotals.get(profile) || { units: 0, revenue: 0, cost: 0, fees: 0, orders: 0, byDay: new Map() };
      const profit = totals.revenue - totals.cost - totals.fees;
      const raiseStats = profileRaises.get(profile) || { totalRaises: 0, lostBbAfter: 0, noSnapshotData: 0 };
      const raiseDenom = raiseStats.totalRaises - raiseStats.noSnapshotData;
      return {
        smart_profile: profile,
        buybox: { winning: bb.winning, losing: bb.losing, unknown: bb.unknown, win_rate_pct: bbDenom > 0 ? Math.round((bb.winning / bbDenom) * 1000) / 10 : null },
        units_per_day: Math.round((totals.units / days) * 100) / 100,
        revenue_per_day: Math.round((totals.revenue / days) * 100) / 100,
        profit_per_day: Math.round((profit / days) * 100) / 100,
        roi_pct: totals.cost > 0 ? Math.round((profit / totals.cost) * 1000) / 10 : null,
        avg_selling_price: totals.units > 0 ? Math.round((totals.revenue / totals.units) * 100) / 100 : null,
        raises: {
          total: raiseStats.totalRaises,
          checked: raiseDenom,
          lost_bb_after: raiseStats.lostBbAfter,
          lost_bb_after_pct: raiseDenom > 0 ? Math.round((raiseStats.lostBbAfter / raiseDenom) * 1000) / 10 : null,
          no_snapshot_data: raiseStats.noSnapshotData,
        },
        order_count: totals.orders,
        daily_breakdown: [...totals.byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, d]) => ({
          day, units: d.units, revenue: Math.round(d.revenue * 100) / 100, profit: Math.round(d.profit * 100) / 100,
        })),
      };
    });

    return new Response(JSON.stringify({
      window_days: days,
      since,
      results,
      raises_checked: raisesToCheck.length,
      raises_check_capped_at: RAISE_CHECK_LIMIT,
      methodology_note: 'Orders are attributed to whichever rule/preset the ASIN+SKU+marketplace assignment is CURRENTLY on (via a SQL join, unattributed orders are silently excluded by that join), not whichever preset was active at the time of each historical sale — a listing that recently switched presets will have some trailing sales misattributed to the new one. "Raises that lost BB" compares the Buy Box owner in the nearest competitor snapshot before vs. after each price raise (lookback 3h / lookahead 12h); raises with no snapshot in that window are excluded from the percentage, not counted as losses. Raise checking is capped at the most recent N raises for performance.',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[repricer-rule-performance] error:', e?.message || e);
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
