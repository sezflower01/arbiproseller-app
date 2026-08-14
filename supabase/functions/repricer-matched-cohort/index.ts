// repricer-matched-cohort (Task #107)
//
// repricer-rule-performance answers "how is each preset doing overall" —
// this answers "how does the SAME product do under different presets."
// Account-wide aggregates confound preset choice with product mix (Momentum
// Smart's 2,900+ orders vs Smart Match's 200 aren't the same portfolio), so
// this function looks for:
//   1. Same-ASIN comparisons: an ASIN that spent meaningful time under 2+ of
//      {Momentum Builder, Smart Match, Momentum Smart V1, Momentum Smart V2}
//      — the strongest available evidence, since the product is identical.
//   2. Matched-cohort comparisons: when same-ASIN pairs are too sparse,
//      ASINs that only ever saw ONE preset are bucketed by comparable
//      characteristics (sales-volume tercile, price tercile, both computed
//      from the candidate set itself) and compared bucket-by-bucket instead
//      of as one undifferentiated account total.
//
// This is READ-ONLY analysis. It does not touch repricer_rules,
// repricer_assignments, or any pricing/gating logic, and changes nothing
// about how repricer-ai-evaluate behaves.
//
// IMPORTANT — this is observational, not experimental. ASINs were not
// randomly assigned to presets; whoever assigned them (a human, or an
// earlier version of auto-assign) may have systematically put certain kinds
// of products on certain presets for reasons this data can't see. Every
// comparison in the response is descriptive ("this is what happened"), not
// causal ("the preset caused this") — see methodology_note.
//
// Attribution source: repricer_ai_decisions.rule_id is the only per-ASIN
// historical "which preset was this evaluated under, and when" signal that
// exists (repricer_setting_changes has no rule_id column at all — see
// repricer-rule-performance's own header comment). It is retained for a
// rolling 30 days only (see the cleanup job in
// 20260511195518_e966ddbc-a289-4ad3-9cdc-2af8c2eea603.sql), which caps how
// far back a same-ASIN preset switch can be detected.
//
// Windowing precision: repricer_asin_profile_days returns MIN/MAX(created_at)
// per (asin, marketplace, rule_id, before/after V2 cutover) rather than a
// day-by-day breakdown — an earlier day-level version reliably hit
// statement_timeout on this account's decision volume (millions of rows
// across the 3 target presets over 30 days; see the migration history for
// the full diagnosis, which traced it to `rule_id = ANY(array)` picking a
// bad query plan, not to the day-grouping itself). A sale/snapshot/raise is
// attributed to a window if its date falls within that window's observed
// [first_seen, last_seen] range; gaps inside a range are assumed to still
// belong to that window rather than treated as unattributed, which is a
// coarser approximation than repricer-rule-performance's exact-day
// attribution — see methodology_note.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { MOMENTUM_SMART_V2_CUTOVER, splitMomentumSmart } from '../_shared/momentum-smart-v2.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TARGET_PROFILES = new Set(['MOMENTUM_BUILDER', 'SMART_MATCH', 'MOMENTUM_SMART']);
const MIN_DAYS_FOR_WINDOW = 3; // fewer days spanned than this = too little exposure to trust
const MIN_ASINS_FOR_TERCILES = 6; // fewer single-preset-exposure ASINs than this = skip tercile bucketing
const RAISE_LOOKBACK_HOURS = 3;
const RAISE_LOOKAHEAD_HOURS = 12;
const MARKETPLACE_IDS: Record<string, string> = { US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2', MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC' };

type Window = {
  asin: string; marketplace: string; profile: string;
  firstSeen: string | null; lastSeen: string | null; // ISO timestamps; min/max across merged rows
  dayCount: number; // calendar-day span for a single ASIN window; SUM of members' spans for a cohort merge
  decisionCount: number; raiseAttempts: number; cooldownBlocks: number; floorRejects: number;
  units: number; revenue: number; cost: number; fees: number; orders: number;
  bbTotalSnapshots: number; bbWinningSnapshots: number;
  raisesChecked: number; raisesLostBb: number;
};

function newWindow(asin: string, marketplace: string, profile: string): Window {
  return {
    asin, marketplace, profile, firstSeen: null, lastSeen: null, dayCount: 0,
    decisionCount: 0, raiseAttempts: 0, cooldownBlocks: 0, floorRejects: 0,
    units: 0, revenue: 0, cost: 0, fees: 0, orders: 0,
    bbTotalSnapshots: 0, bbWinningSnapshots: 0,
    raisesChecked: 0, raisesLostBb: 0,
  };
}

function extendRange(w: Window, firstSeen: string, lastSeen: string) {
  if (!w.firstSeen || firstSeen < w.firstSeen) w.firstSeen = firstSeen;
  if (!w.lastSeen || lastSeen > w.lastSeen) w.lastSeen = lastSeen;
}

function calendarSpanDays(startIso: string, endIso: string): number {
  const startDay = startIso.slice(0, 10);
  const endDay = endIso.slice(0, 10);
  const ms = new Date(`${endDay}T00:00:00.000Z`).getTime() - new Date(`${startDay}T00:00:00.000Z`).getTime();
  return Math.round(ms / 86400000) + 1;
}

function dayInRange(day: string, startIso: string, endIso: string): boolean {
  return day >= startIso.slice(0, 10) && day <= endIso.slice(0, 10);
}

function summarize(w: Window, opts?: { nAsins?: number; asins?: string[] }) {
  const days = w.dayCount;
  const profit = w.revenue - w.cost - w.fees;
  const raiseDenom = w.raisesChecked;
  const bbDenom = w.bbTotalSnapshots;
  return {
    asin: opts ? undefined : w.asin, marketplace: opts ? undefined : w.marketplace, profile: w.profile,
    n_asins: opts?.nAsins, asins: opts?.asins,
    window: { start: w.firstSeen ? w.firstSeen.slice(0, 10) : null, end: w.lastSeen ? w.lastSeen.slice(0, 10) : null, n_days: days },
    sample_size: { n_orders: w.orders, n_decisions: w.decisionCount, n_bb_snapshots: bbDenom, n_raises_submitted: w.raisesChecked },
    units_per_day: days > 0 ? Math.round((w.units / days) * 100) / 100 : null,
    revenue_per_day: days > 0 ? Math.round((w.revenue / days) * 100) / 100 : null,
    profit_per_day: days > 0 ? Math.round((profit / days) * 100) / 100 : null,
    roi_pct: w.cost > 0 ? Math.round((profit / w.cost) * 1000) / 10 : null,
    avg_selling_price: w.units > 0 ? Math.round((w.revenue / w.units) * 100) / 100 : null,
    buybox_win_rate_pct: bbDenom > 0 ? Math.round((w.bbWinningSnapshots / bbDenom) * 1000) / 10 : null,
    raise_attempts: w.raiseAttempts,
    raise_blocked_cooldown: w.cooldownBlocks,
    raise_rejected_floor_support: w.floorRejects,
    raise_to_bb_loss_rate_pct: raiseDenom > 0 ? Math.round((w.raisesLostBb / raiseDenom) * 1000) / 10 : null,
    raises_checked: raiseDenom,
  };
}

function tercileBucket(value: number, sorted: number[]): 'low' | 'mid' | 'high' {
  const p33 = sorted[Math.floor(sorted.length * 0.33)];
  const p66 = sorted[Math.floor(sorted.length * 0.66)];
  if (value <= p33) return 'low';
  if (value <= p66) return 'mid';
  return 'high';
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

    const { data: roleRow } = await supabase.from('user_roles').select('role').eq('user_id', userId).eq('role', 'admin').maybeSingle();
    if (!roleRow) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: corsHeaders });

    const body = await req.json().catch(() => ({}));
    const days = Math.max(1, Math.min(180, Number(body?.days) || 30));
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // 1. This user's Momentum Builder / Smart Match / Momentum Smart rule(s).
    const { data: rules, error: rulesErr } = await supabase
      .from('repricer_rules').select('id, smart_profile')
      .eq('user_id', userId).in('smart_profile', [...TARGET_PROFILES]);
    if (rulesErr) throw rulesErr;
    const ruleToProfile = new Map<string, string>();
    for (const r of (rules || [])) ruleToProfile.set(r.id, r.smart_profile);
    const ruleIds = [...ruleToProfile.keys()];

    if (ruleIds.length === 0) {
      return new Response(JSON.stringify({
        window_days: days, since, momentum_smart_v2_cutover: MOMENTUM_SMART_V2_CUTOVER,
        same_asin_comparisons: [], matched_cohort_comparisons: [],
        excluded: { reason: 'no_target_preset_rules_found' },
        methodology_note: 'No rules found for Momentum Builder, Smart Match, or Momentum Smart.',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 2. Per-ASIN decision-window summary, one call per rule_id, SEQUENTIALLY
    // -- rule_id = ANY(array) was confirmed to trigger a bad query plan on
    // this table even for a single-element array (see the RPC's own
    // migration comment), and firing all the scalar-equality calls
    // concurrently via Promise.all was ALSO confirmed to reintroduce
    // timeouts (most of 13 concurrent calls failed even though each
    // succeeds in well under a second run alone) -- almost certainly
    // connection-pool contention under this account's connector limits, not
    // a query-plan issue.
    //
    // Some individual rules still time out even scalar-scoped and
    // sequential -- this account's decision volume is skewed heavily toward
    // a handful of rules (e.g. Momentum Builder has been the primary preset
    // for much longer than Momentum Smart has existed). Rather than fail
    // the whole request over one oversized rule, skip it, record it, and
    // keep going -- best-effort coverage with a transparent gap beats an
    // opaque 500. See excluded.rule_ids_skipped_timeout.
    const profileDayRows: any[] = [];
    const skippedRuleIds: string[] = [];
    const PER_RULE_TIMEOUT_MS = 12000; // don't sit through a slow rule's full ~15s DB statement_timeout one at a time -- but a real, useful call can take ~4-5s for this account's busiest rules, so leave real margin above that before giving up
    for (const ruleId of ruleIds) {
      const rpcPromise = supabase.rpc('repricer_asin_profile_days', {
        p_user_id: userId, p_since: since, p_rule_id: ruleId, p_v2_cutover: MOMENTUM_SMART_V2_CUTOVER,
      });
      const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error('client_timeout') }), PER_RULE_TIMEOUT_MS)
      );
      const { data, error } = await Promise.race([rpcPromise, timeoutPromise]);
      if (error) { skippedRuleIds.push(ruleId); continue; }
      profileDayRows.push(...(data || []));
    }

    // 3. Build windows: one per (asin, marketplace, profile) actually
    // observed, merging the before/after-cutover rows for non-Momentum-
    // Smart rules (they don't need the split) and keeping them apart for
    // Momentum Smart (V1 vs V2 must never merge).
    const windows = new Map<string, Window>(); // key: asin::marketplace::profile
    const windowsByAsinMarketplace = new Map<string, Window[]>();
    for (const row of profileDayRows) {
      const baseProfile = ruleToProfile.get(row.rule_id);
      if (!baseProfile) continue;
      const profile = baseProfile === 'MOMENTUM_SMART'
        ? (row.before_cutover ? 'MOMENTUM_SMART_V1' : 'MOMENTUM_SMART_V2')
        : baseProfile;
      const amKey = `${row.asin}::${row.marketplace}`;
      const wKey = `${amKey}::${profile}`;
      if (!windows.has(wKey)) {
        const w = newWindow(row.asin, row.marketplace, profile);
        windows.set(wKey, w);
        if (!windowsByAsinMarketplace.has(amKey)) windowsByAsinMarketplace.set(amKey, []);
        windowsByAsinMarketplace.get(amKey)!.push(w);
      }
      const w = windows.get(wKey)!;
      extendRange(w, row.first_seen, row.last_seen);
      w.decisionCount += Number(row.decision_count) || 0;
      w.raiseAttempts += Number(row.raise_attempts) || 0;
      w.cooldownBlocks += Number(row.cooldown_blocks) || 0;
      w.floorRejects += Number(row.floor_rejects) || 0;
    }
    for (const w of windows.values()) {
      if (w.firstSeen && w.lastSeen) w.dayCount = calendarSpanDays(w.firstSeen, w.lastSeen);
    }

    const candidateAsins = [...new Set([...windows.values()].map((w) => w.asin))];

    const findWindowForDay = (amKey: string, day: string): Window | null => {
      const list = windowsByAsinMarketplace.get(amKey);
      if (!list) return null;
      const matches = list.filter((w) => w.firstSeen && w.lastSeen && dayInRange(day, w.firstSeen, w.lastSeen));
      if (matches.length === 0) return null;
      if (matches.length === 1) return matches[0];
      // Overlapping windows (e.g. a rapid preset switch back and forth) --
      // prefer whichever window has more decision volume as the better guess.
      return matches.sort((a, b) => b.decisionCount - a.decisionCount)[0];
    };

    // 4. Sales, attributed to whichever window's date range covers that order's day.
    let unattributedOrders = 0;
    if (candidateAsins.length > 0) {
      const { data: salesDays, error: sdErr } = await supabase.rpc('repricer_asin_sales_days', {
        p_user_id: userId, p_since: since, p_asins: candidateAsins,
      });
      if (sdErr) throw sdErr;
      for (const row of (salesDays || [])) {
        const amKey = `${row.asin}::${row.marketplace}`;
        const day = String(row.order_day);
        const w = findWindowForDay(amKey, day);
        if (!w) { unattributedOrders += Number(row.order_count) || 0; continue; }
        w.units += Number(row.units) || 0;
        w.revenue += Number(row.revenue) || 0;
        w.cost += Number(row.cost) || 0;
        w.fees += Number(row.fees) || 0;
        w.orders += Number(row.order_count) || 0;
      }
    }

    // 5. Buy Box snapshot tally, attributed the same way.
    if (candidateAsins.length > 0) {
      const sellerAuths = await supabase.from('seller_authorizations').select('marketplace_id, seller_id, selling_partner_id').eq('user_id', userId);
      const sellerIdsByMarketplace: Record<string, string> = {};
      for (const [mp, mid] of Object.entries(MARKETPLACE_IDS)) {
        const auth = (sellerAuths.data || []).find((s: any) => s.marketplace_id === mid);
        const sid = auth?.seller_id || auth?.selling_partner_id;
        if (sid) sellerIdsByMarketplace[mp] = sid;
      }
      const { data: bbDays, error: bbErr } = await supabase.rpc('repricer_asin_bb_days', {
        p_user_id: userId, p_since: since, p_asins: candidateAsins, p_seller_ids: sellerIdsByMarketplace,
      });
      if (bbErr) throw bbErr;
      for (const row of (bbDays || [])) {
        const amKey = `${row.asin}::${row.marketplace}`;
        const day = String(row.snapshot_day);
        const w = findWindowForDay(amKey, day);
        if (!w) continue;
        w.bbTotalSnapshots += Number(row.total_snapshots) || 0;
        w.bbWinningSnapshots += Number(row.winning_snapshots) || 0;
      }
    }

    // 6. Raise -> BB-loss detection, attributed the same way, reusing the
    // same before/after-snapshot methodology as repricer-rule-performance.
    let unattributedRaises = 0;
    if (candidateAsins.length > 0) {
      const { data: raises_, error: raisesErr } = await supabase.rpc('repricer_asin_raises', {
        p_user_id: userId, p_since: since, p_asins: candidateAsins,
      });
      if (raisesErr) throw raisesErr;
      const raises = raises_ || [];

      const attributedRaises: any[] = [];
      for (const raise of raises) {
        const amKey = `${raise.asin}::${raise.marketplace}`;
        const day = new Date(raise.created_at).toISOString().slice(0, 10);
        const w = findWindowForDay(amKey, day);
        if (!w) { unattributedRaises++; continue; }
        w.raisesChecked++; // provisional; decremented below if no snapshot data
        attributedRaises.push({ ...raise, _window: w });
      }

      if (attributedRaises.length > 0) {
        const sellerAuths = await supabase.from('seller_authorizations').select('marketplace_id, seller_id, selling_partner_id').eq('user_id', userId);
        const ownSellerIdByMarketplace = new Map<string, string>();
        for (const [mp, mid] of Object.entries(MARKETPLACE_IDS)) {
          const auth = (sellerAuths.data || []).find((s: any) => s.marketplace_id === mid);
          const sid = auth?.seller_id || auth?.selling_partner_id;
          if (sid) ownSellerIdByMarketplace.set(mp, sid);
        }
        const uniqueAsins = [...new Set(attributedRaises.map((r) => r.asin))];
        const uniqueMarketplaces = [...new Set(attributedRaises.map((r) => r.marketplace))];
        const earliestNeeded = new Date(Math.min(...attributedRaises.map((r) => new Date(r.created_at).getTime())) - RAISE_LOOKBACK_HOURS * 3600000).toISOString();
        const latestNeeded = new Date(Math.max(...attributedRaises.map((r) => new Date(r.created_at).getTime())) + RAISE_LOOKAHEAD_HOURS * 3600000).toISOString();

        let allSnapshots: any[] = [];
        {
          let from = 0;
          while (true) {
            const { data, error } = await supabase.from('repricer_competitor_snapshots')
              .select('asin, marketplace, buybox_seller_id, fetched_at')
              .eq('user_id', userId).in('asin', uniqueAsins).in('marketplace', uniqueMarketplaces)
              .gte('fetched_at', earliestNeeded).lte('fetched_at', latestNeeded)
              .order('id', { ascending: true }).range(from, from + 999);
            if (error) throw error;
            if (!data?.length) break;
            allSnapshots = allSnapshots.concat(data);
            if (data.length < 1000) break;
            from += 1000;
          }
        }
        const snapshotsByPair = new Map<string, { buybox_seller_id: string | null; fetched_at: string }[]>();
        for (const s of allSnapshots) {
          const k = `${s.asin}::${s.marketplace}`;
          if (!snapshotsByPair.has(k)) snapshotsByPair.set(k, []);
          snapshotsByPair.get(k)!.push({ buybox_seller_id: s.buybox_seller_id, fetched_at: s.fetched_at });
        }
        for (const arr of snapshotsByPair.values()) arr.sort((a, b) => a.fetched_at.localeCompare(b.fetched_at));

        const findNearestBefore = (arr: { buybox_seller_id: string | null; fetched_at: string }[], atIso: string, cutoffIso: string) => {
          let best: typeof arr[0] | null = null;
          for (const s of arr) if (s.fetched_at >= cutoffIso && s.fetched_at <= atIso) best = s;
          return best;
        };
        const findNearestAfter = (arr: { buybox_seller_id: string | null; fetched_at: string }[], atIso: string, cutoffIso: string) => {
          for (const s of arr) if (s.fetched_at > atIso && s.fetched_at <= cutoffIso) return s;
          return null;
        };

        for (const raise of attributedRaises) {
          const w = raise._window as Window;
          const raiseTime = new Date(raise.created_at).getTime();
          const beforeCutoff = new Date(raiseTime - RAISE_LOOKBACK_HOURS * 3600000).toISOString();
          const afterCutoff = new Date(raiseTime + RAISE_LOOKAHEAD_HOURS * 3600000).toISOString();
          const ownSellerId = ownSellerIdByMarketplace.get(raise.marketplace);
          const pairSnapshots = snapshotsByPair.get(`${raise.asin}::${raise.marketplace}`) || [];
          const beforeSnap = findNearestBefore(pairSnapshots, raise.created_at, beforeCutoff);
          const afterSnap = findNearestAfter(pairSnapshots, raise.created_at, afterCutoff);
          if (!ownSellerId || !beforeSnap || !afterSnap) { w.raisesChecked--; continue; }
          const wasWinning = beforeSnap.buybox_seller_id === ownSellerId;
          const stillWinning = afterSnap.buybox_seller_id === ownSellerId;
          if (wasWinning && !stillWinning) w.raisesLostBb++;
        }
      }
    }

    // 7. Split into same-ASIN comparisons vs matched-cohort comparisons.
    const qualifying = [...windows.values()].filter((w) => w.dayCount >= MIN_DAYS_FOR_WINDOW);
    const belowThreshold = windows.size - qualifying.length;

    const byAsinMarketplace = new Map<string, Window[]>();
    for (const w of qualifying) {
      const key = `${w.asin}::${w.marketplace}`;
      if (!byAsinMarketplace.has(key)) byAsinMarketplace.set(key, []);
      byAsinMarketplace.get(key)!.push(w);
    }

    const sameAsinComparisons: any[] = [];
    const singleExposure: Window[] = [];
    for (const [key, ws] of byAsinMarketplace.entries()) {
      const distinctProfiles = new Set(ws.map((w) => w.profile));
      if (distinctProfiles.size >= 2) {
        const [asin, marketplace] = key.split('::');
        sameAsinComparisons.push({
          asin, marketplace,
          windows: ws.map((w) => summarize(w)).sort((a, b) => (a.window.start || '').localeCompare(b.window.start || '')),
        });
      } else {
        singleExposure.push(...ws);
      }
    }

    // 8. Matched cohorts from single-exposure ASINs (comparable sales-
    // volume / price tercile -- competition-level and historical-
    // performance dimensions were dropped; see methodology_note), only
    // when there's enough of them to form terciles meaningfully.
    const matchedCohortComparisons: any[] = [];
    let cohortNote = '';
    if (singleExposure.length >= MIN_ASINS_FOR_TERCILES) {
      const volumeSorted = singleExposure.map((w) => w.units / Math.max(1, w.dayCount)).sort((a, b) => a - b);
      const priceSorted = singleExposure.map((w) => (w.units > 0 ? w.revenue / w.units : 0)).sort((a, b) => a - b);

      const cohortBuckets = new Map<string, Window[]>();
      for (const w of singleExposure) {
        const volume = w.units / Math.max(1, w.dayCount);
        const price = w.units > 0 ? w.revenue / w.units : 0;
        const cohortKey = `vol_${tercileBucket(volume, volumeSorted)}|price_${tercileBucket(price, priceSorted)}`;
        if (!cohortBuckets.has(cohortKey)) cohortBuckets.set(cohortKey, []);
        cohortBuckets.get(cohortKey)!.push(w);
      }

      for (const [cohortKey, ws] of cohortBuckets.entries()) {
        const byProfile = new Map<string, Window[]>();
        for (const w of ws) {
          if (!byProfile.has(w.profile)) byProfile.set(w.profile, []);
          byProfile.get(w.profile)!.push(w);
        }
        if (byProfile.size < 2) continue; // nothing to compare within this bucket
        const profiles = [...byProfile.entries()].map(([profile, group]) => {
          const merged = newWindow('*', '*', profile);
          for (const w of group) {
            if (w.firstSeen && w.lastSeen) extendRange(merged, w.firstSeen, w.lastSeen); // union range, display only
            merged.dayCount += w.dayCount; // summed per-ASIN spans -- the actual rate denominator
            merged.decisionCount += w.decisionCount; merged.raiseAttempts += w.raiseAttempts;
            merged.cooldownBlocks += w.cooldownBlocks; merged.floorRejects += w.floorRejects;
            merged.units += w.units; merged.revenue += w.revenue; merged.cost += w.cost; merged.fees += w.fees; merged.orders += w.orders;
            merged.bbTotalSnapshots += w.bbTotalSnapshots; merged.bbWinningSnapshots += w.bbWinningSnapshots;
            merged.raisesChecked += w.raisesChecked; merged.raisesLostBb += w.raisesLostBb;
          }
          return summarize(merged, { nAsins: group.length, asins: group.map((w) => w.asin) });
        });
        matchedCohortComparisons.push({ cohort: cohortKey, profiles });
      }
    } else {
      cohortNote = `Only ${singleExposure.length} single-preset-exposure ASINs available — below the ${MIN_ASINS_FOR_TERCILES} needed to form meaningful volume/price terciles, so no matched-cohort comparisons were built this window.`;
    }

    return new Response(JSON.stringify({
      window_days: days, since,
      momentum_smart_v2_cutover: MOMENTUM_SMART_V2_CUTOVER,
      same_asin_comparisons: sameAsinComparisons,
      matched_cohort_comparisons: matchedCohortComparisons,
      excluded: {
        windows_below_min_days: belowThreshold,
        min_days_threshold: MIN_DAYS_FOR_WINDOW,
        unattributed_orders: unattributedOrders,
        unattributed_raises: unattributedRaises,
        raises_checked_capped_at: 3000,
        rule_ids_skipped_timeout: skippedRuleIds.map((id) => ({ rule_id: id, smart_profile: ruleToProfile.get(id) || null })),
        cohort_note: cohortNote || null,
      },
      methodology_note:
        'DESCRIPTIVE, NOT CAUSAL: ASINs were not randomly assigned to presets, so any difference between presets here may reflect why an ASIN was put on that preset (existing performance, product type, seller judgment) rather than an effect of the preset itself. Same-ASIN comparisons are the strongest evidence available (same product, different rules, different time windows) but are still before/after on ONE product, not a controlled experiment — other things (seasonality, competition, stock levels) could have changed between the two windows too. Matched-cohort comparisons are weaker still: ASINs are grouped by sales-volume/price terciles computed from this window\'s data (competition-level and historical-performance dimensions were dropped for this pass — see below), which only controls for what those two dimensions capture. ' +
        `Preset attribution comes from repricer_ai_decisions.rule_id, retained for a rolling 30 days only, so same-ASIN comparisons can only see up to ~30 days of preset history regardless of the requested window. Each window's date range is its observed [first decision, last decision] span for that preset — a sale/snapshot/raise inside that range counts as belonging to it even on a day with no decision logged (a coarser approximation than exact per-day attribution, made necessary because day-level grouping over this account's decision volume reliably timed out; see the RPC's migration history). Momentum Smart is split into V1/V2 against momentum_smart_v2_cutover (${MOMENTUM_SMART_V2_CUTOVER}), same as repricer-rule-performance, and the two are never merged into one row. A window needs at least ${MIN_DAYS_FOR_WINDOW} days of span to appear in any comparison; see excluded.windows_below_min_days for how many were dropped for being too sparse. Raise-loss checking is capped at the most recent 3000 account-wide price raises before filtering down to the candidate ASINs (same recency-cap approach repricer-rule-performance uses account-wide, applied here because it proved necessary for performance) — for a very high-raise-volume account this could undercount older raises for less-active candidate ASINs; see excluded.unattributed_raises. A rule with an especially large decision history can still time out even scoped to just that one rule_id — when that happens its ASINs are skipped entirely for this run rather than failing the whole request; see excluded.rule_ids_skipped_timeout for which ones and how many ASINs that potentially leaves out of the comparison. The "competition level" and "historical performance" cohort dimensions mentioned in the original request were not implemented this pass (offers_count averaging added measurable query cost for a dimension that was one of several suggested examples, not a requirement) — cohorts here use sales-volume and price only.`,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[repricer-matched-cohort] error:', e?.message || e);
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
