import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkCircuitBreaker } from '../_shared/repricer-hardening.ts';
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Repricer Priority Cron — TURBO MODE
 * 
 * Runs every 1 minute via pg_cron. For each user with scheduler_enabled,
 * picks 1-2 starred (is_priority=true) ASINs in round-robin order
 * and evaluates them via repricer-scheduler.
 * 
 * TURBO MODE: When ≤2 starred ASINs, runs 2 passes per invocation:
 *   Pass 1 at T=0s — check & reprice
 *   Sleep 25s
 *   Pass 2 at T=25s — only if Pass 1 detected BB moved or lost BB
 * 
 * This gives ~25-30s effective repricing while keeping 1-min cron.
 * 
 * Safety layers:
 * 1. Shared rate limiter: checks per-user SP-API call budget before consuming
 * 2. Auto-pause priority: pauses with exponential backoff on 429/throttle
 * 3. BB-moved-only: skips evaluation if buybox hasn't changed since last check
 * 4. Turbo gate: Pass 2 only fires if Pass 1 found BB movement
 */

const MAX_PRIORITY_PER_USER = 5;
const ASINS_PER_MINUTE = 2;
const RATE_WINDOW_SECONDS = 60;
const TURBO_DELAY_MS = 25_000; // 25 seconds between passes
const TURBO_MAX_STARRED = 2; // Only turbo when ≤2 starred

interface TurboPassResult {
  bbMoved: boolean;
  lostBB: boolean;
  priceGapDetected: boolean;
  evaluated: number;
  applied: number;
  throttled: boolean;
  triggerReason: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = requireInternalCall(req);
  if (__forbidden) return __forbidden;


  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('[priority-cron] Starting TURBO cycle at:', new Date().toISOString());

    // === IDLE GUARD: Check if ANY starred assignments exist before doing per-user work ===
    const { count: globalStarredCount } = await supabase
      .from('repricer_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('is_priority', true)
      .eq('is_enabled', true)
      .eq('marketplace', 'US')
      .in('status', ['active', 'needs_attention']);

    if (!globalStarredCount || globalStarredCount === 0) {
      console.log('[priority-cron] IDLE SKIP — no starred assignments globally');
      return new Response(JSON.stringify({
        success: true, message: 'No starred assignments — idle skip', processed: 0, idle: true
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Get all users with scheduler enabled
    const { data: enabledSettings, error: settingsError } = await supabase
      .from('repricer_settings')
      .select('user_id, queue_paused, priority_paused, priority_auto_resume_at, priority_pause_reason, priority_backoff_seconds, sp_api_calls_this_window, sp_api_window_start, sp_api_calls_per_minute_cap, safe_mode_active, safe_mode_reason, safe_mode_auto_resume_at, circuit_breaker_error_count, circuit_breaker_window_start')
      .eq('scheduler_enabled', true);

    if (settingsError) {
      console.error('[priority-cron] Error fetching settings:', settingsError);
      throw new Error('Failed to fetch enabled schedulers');
    }

    if (!enabledSettings || enabledSettings.length === 0) {
      return new Response(JSON.stringify({
        success: true, message: 'No users with scheduler enabled', processed: 0
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const results: Array<{ user_id: string; processed: number; passes: number; skipped?: string; turbo?: boolean }> = [];

    for (const setting of enabledSettings) {
      const userResult = await processUser(supabase, supabaseUrl, supabaseKey, setting);
      results.push(userResult);

      // Small delay between users
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
    const turboUsers = results.filter(r => r.turbo).length;
    console.log(`[priority-cron] Cycle complete: ${totalProcessed} ASINs processed, ${turboUsers} turbo users, ${results.length} total users`);

    return new Response(JSON.stringify({
      success: true, totalProcessed, turboUsers, results
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[priority-cron] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message || 'Priority cron failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// ─── Process a single user (with turbo multi-pass) ───────────────────────────

async function processUser(
  supabase: any,
  supabaseUrl: string,
  supabaseKey: string,
  setting: any,
): Promise<{ user_id: string; processed: number; passes: number; skipped?: string; turbo?: boolean }> {
  const userId = setting.user_id;

  // Skip if main queue is paused (429 backoff active)
  if (setting.queue_paused) {
    console.log(`[priority-cron] Skipping ${userId} — main queue paused`);
    return { user_id: userId, processed: 0, passes: 0, skipped: 'queue_paused' };
  }

  // === CIRCUIT BREAKER CHECK ===
  const cbCheck = await checkCircuitBreaker(supabase, userId, setting);
  if (cbCheck.triggered) {
    console.log(`[priority-cron] Skipping ${userId} — safe mode: ${cbCheck.reason}`);
    return { user_id: userId, processed: 0, passes: 0, skipped: 'safe_mode' };
  }

  // === AUTO-PAUSE PRIORITY: Check & auto-resume ===
  if (setting.priority_paused) {
    if (setting.priority_auto_resume_at) {
      const resumeTime = new Date(setting.priority_auto_resume_at).getTime();
      if (Date.now() >= resumeTime) {
        console.log(`[priority-cron] Auto-resuming priority for ${userId}`);
        await supabase.from('repricer_settings').update({
          priority_paused: false,
          priority_pause_reason: null,
          priority_auto_resume_at: null,
          priority_backoff_seconds: 60,
        }).eq('user_id', userId);
      } else {
        const remainingSec = Math.round((resumeTime - Date.now()) / 1000);
        return { user_id: userId, processed: 0, passes: 0, skipped: `priority_paused_${remainingSec}s` };
      }
    } else {
      return { user_id: userId, processed: 0, passes: 0, skipped: 'priority_paused_manual' };
    }
  }

  // === SHARED RATE LIMITER: Check budget ===
  const windowStart = setting.sp_api_window_start ? new Date(setting.sp_api_window_start).getTime() : 0;
  const windowAge = (Date.now() - windowStart) / 1000;
  let callsThisWindow = setting.sp_api_calls_this_window || 0;
  const cap = setting.sp_api_calls_per_minute_cap || 10;

  // Reset window if expired
  if (windowAge >= RATE_WINDOW_SECONDS) {
    callsThisWindow = 0;
    await supabase.from('repricer_settings').update({
      sp_api_calls_this_window: 0,
      sp_api_window_start: new Date().toISOString(),
    }).eq('user_id', userId);
  }

  // Check if we have budget for at least 1 call
  const budgetRemaining = cap - callsThisWindow;
  if (budgetRemaining < 2) {
    console.log(`[priority-cron] Rate budget exhausted for ${userId}: ${callsThisWindow}/${cap}`);
    return { user_id: userId, processed: 0, passes: 0, skipped: 'rate_budget_exhausted' };
  }

  // Count total starred ASINs for turbo eligibility
  const { count: starredCount } = await supabase
    .from('repricer_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_priority', true)
    .eq('is_enabled', true)
    .eq('marketplace', 'US')
    .in('status', ['active', 'needs_attention']);

  const turboEligible = (starredCount || 0) <= TURBO_MAX_STARRED;

  // ─── PASS 1 ───────────────────────────────────────────────────────────────
  console.log(`[priority-cron] ${userId}: Pass 1 starting (turbo=${turboEligible}, starred=${starredCount})`);
  const pass1 = await executePriorityPass(
    supabase, supabaseUrl, supabaseKey, setting, userId, callsThisWindow, cap, 1
  );

  if (pass1.throttled) {
    return { user_id: userId, processed: 0, passes: 1, skipped: 'throttled_429', turbo: false };
  }

  callsThisWindow = pass1.callsUsed;
  let totalProcessed = pass1.evaluated;

  // ─── TURBO PASS 2 (only if eligible + Pass 1 detected movement) ───────────
  let passCount = 1;
  const pass1NeedsFollowUp = pass1.bbMoved || pass1.lostBB || pass1.priceGapDetected;

  if (turboEligible && pass1NeedsFollowUp && !pass1.throttled) {
    // Check remaining budget for pass 2
    const budgetForPass2 = cap - callsThisWindow;
    if (budgetForPass2 >= 2) {
      console.log(`[priority-cron] ${userId}: TURBO Pass 2 in ${TURBO_DELAY_MS / 1000}s (reason: ${pass1.triggerReason})`);
      await new Promise(resolve => setTimeout(resolve, TURBO_DELAY_MS));

      const pass2 = await executePriorityPass(
        supabase, supabaseUrl, supabaseKey, setting, userId, callsThisWindow, cap, 2
      );

      callsThisWindow = pass2.callsUsed;
      totalProcessed += pass2.evaluated;
      passCount = 2;

      if (pass2.throttled) {
        console.log(`[priority-cron] ${userId}: Pass 2 throttled, stopping`);
      }
    } else {
      console.log(`[priority-cron] ${userId}: Skipping Pass 2 — budget exhausted (${budgetForPass2} remaining)`);
    }
  } else if (turboEligible && !pass1NeedsFollowUp) {
    console.log(`[priority-cron] ${userId}: Turbo skip Pass 2 — BB stable (${pass1.triggerReason})`);
  }

  // Update final rate budget
  await supabase.from('repricer_settings').update({
    sp_api_calls_this_window: callsThisWindow,
  }).eq('user_id', userId);

  return {
    user_id: userId,
    processed: totalProcessed,
    passes: passCount,
    turbo: turboEligible && passCount > 1,
  };
}

// ─── Execute a single priority pass ─────────────────────────────────────────

interface PassResult extends TurboPassResult {
  callsUsed: number;
}

async function executePriorityPass(
  supabase: any,
  supabaseUrl: string,
  supabaseKey: string,
  setting: any,
  userId: string,
  callsThisWindow: number,
  cap: number,
  passNumber: number,
): Promise<PassResult> {
  const result: PassResult = {
    bbMoved: false,
    lostBB: false,
    priceGapDetected: false,
    evaluated: 0,
    applied: 0,
    throttled: false,
    triggerReason: 'stable',
    callsUsed: callsThisWindow,
  };

  const budgetRemaining = cap - callsThisWindow;
  if (budgetRemaining < 2) {
    result.triggerReason = 'budget_exhausted';
    return result;
  }

  const maxAsinsByBudget = Math.min(ASINS_PER_MINUTE, Math.floor(budgetRemaining / 2));

  // Fetch priority assignments ordered by oldest checked first (round-robin)
  const { data: priorityItems, error: priorityError } = await supabase
    .from('repricer_assignments')
    .select('id, asin, sku, marketplace, last_priority_check_at, last_buybox_price, last_applied_price')
    .eq('user_id', userId)
    .eq('is_priority', true)
    .eq('is_enabled', true)
    .eq('marketplace', 'US')
    .in('status', ['active', 'needs_attention'])
    .not('rule_id', 'is', null)
    .order('last_priority_check_at', { ascending: true, nullsFirst: true })
    .limit(maxAsinsByBudget);

  if (priorityError) {
    console.error(`[priority-cron] Pass ${passNumber} query error for ${userId}:`, priorityError);
    result.triggerReason = 'query_error';
    return result;
  }

  if (!priorityItems || priorityItems.length === 0) {
    result.triggerReason = 'no_priority_items';
    return result;
  }

  // === STOCK + LISTING ELIGIBILITY: Skip items with no sellable inventory ===
  const prioritySkus = priorityItems.map((p: any) => p.sku).filter(Boolean);
  const stockEligible = new Set<string>();
  if (prioritySkus.length > 0) {
    const { data: invRows } = await supabase
      .from('inventory')
      .select('sku, available, listing_status')
      .eq('user_id', userId)
      .in('sku', prioritySkus);
    for (const inv of invRows || []) {
      const ls = (inv.listing_status || '').toUpperCase();
      const isInactive = ls === 'INACTIVE' || ls === 'NOT_FOUND' || ls === 'INCOMPLETE';
      if (!isInactive && (inv.available || 0) > 0) {
        stockEligible.add(inv.sku);
      }
    }
  }
  const eligibleItems = priorityItems.filter((p: any) => stockEligible.has(p.sku));
  const stockSkipped = priorityItems.length - eligibleItems.length;
  if (stockSkipped > 0) {
    console.log(`[priority-cron] Pass ${passNumber} ${userId}: skipped ${stockSkipped} starred items (no sellable stock or inactive)`);
  }
  if (eligibleItems.length === 0) {
    result.triggerReason = 'no_sellable_stock';
    return result;
  }

  // === BB-MOVED-ONLY: Check if buybox changed before evaluating ===
  const itemsToEval: typeof eligibleItems = [];
  const bbSkipped: string[] = [];
  const triggerReasons: string[] = [];
  const latestBBPrices = new Map<string, number>(); // item.id → current BB price

  for (const item of eligibleItems) {
    const lastBB = item.last_buybox_price;

    // Was this ASIN evaluated recently? If so, only re-trigger on actual BB movement,
    // not persistent competitive gaps that were already evaluated with "No Change".
    const lastCheckMs = item.last_priority_check_at ? new Date(item.last_priority_check_at).getTime() : 0;
    const recentlyEvaluated = (Date.now() - lastCheckMs) < 3 * 60_000; // within 3 minutes

    // If we have no previous BB data, always evaluate
    if (lastBB === null || lastBB === undefined) {
      itemsToEval.push(item);
      triggerReasons.push('no_prev_bb');
      continue;
    }

    // Quick SP-API check to see if BB moved
    try {
      const spResp = await fetch(`${supabaseUrl}/functions/v1/repricer-sp-api-pricing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
        body: JSON.stringify({
          asin: item.asin, sku: item.sku,
          marketplace: item.marketplace,
          user_id: userId, internal: true,
        }),
      });
      const spData = await spResp.json();
      callsThisWindow++;

      if (spData.success && spData.data?.buyboxPrice !== undefined) {
        const parsePrice = (value: unknown): number | null => {
          if (value === null || value === undefined) return null;
          const parsed = typeof value === 'number' ? value : Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const toCents = (value: number) => Math.round(value * 100);

        const currentBB = parsePrice(spData.data.buyboxPrice);
        const previousBB = parsePrice(lastBB);
        const normalizedMyPrice = parsePrice(item.last_applied_price ?? spData.data.myPrice ?? spData.data.landedPrice);
        const lowestFba = parsePrice(spData.data.lowestFbaPrice ?? spData.data.lowestFba);
        const lowestFbm = parsePrice(spData.data.lowestFbmPrice ?? spData.data.lowestFbm);

        // === FRESH MARKET DATA PERSISTENCE ===
        // Even when BB hasn't moved we still persist a snapshot every >=30min so
        // the UI's "Live market fetch" timestamp doesn't go stale (was showing
        // 3+ day old market data during long tie/rotation patience holds).
        try {
          const { data: latestSnap } = await supabase
            .from('repricer_competitor_snapshots')
            .select('fetched_at')
            .eq('user_id', userId)
            .eq('asin', item.asin)
            .eq('marketplace', item.marketplace)
            .is('error', null)
            .order('fetched_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          const snapAgeMin = latestSnap?.fetched_at
            ? (Date.now() - new Date(latestSnap.fetched_at).getTime()) / 60_000
            : Infinity;

          if (snapAgeMin >= 30) {
            await supabase.from('repricer_competitor_snapshots').insert({
              user_id: userId,
              asin: item.asin,
              sku: item.sku,
              marketplace: item.marketplace,
              fetched_at: spData.data.fetchedAt || new Date().toISOString(),
              buybox_price: currentBB,
              buybox_is_fba: spData.data.buyboxIsFba ?? null,
              buybox_seller_id: spData.data.buyboxSellerId ?? null,
              lowest_fba_price: lowestFba,
              lowest_fbm_price: lowestFbm,
              lowest_overall_price: parsePrice(spData.data.lowestOverallPrice),
              offers_count: spData.data.totalOfferCount ?? null,
              offers_json: spData.data.offerBreakdown ?? [],
              credits_used: 0,
              source: 'sp-api-priority-bbcheck',
              fetch_reason: 'priority_cron_bb_check',
            });
            console.log(`[priority-cron] P${passNumber} ${item.asin}: refreshed market snapshot (prev age=${Number.isFinite(snapAgeMin) ? Math.round(snapAgeMin) + 'm' : 'none'})`);
          }
        } catch (e) {
          console.warn(`[priority-cron] P${passNumber} snapshot persist failed for ${item.asin}:`, e);
        }

        const bbChanged =
          currentBB === null ||
          previousBB === null ||
          Math.abs(toCents(currentBB) - toCents(previousBB)) >= 1;
        const lostBB = spData.data.isBuyboxOwner === false;

        // Gap to Buy Box
        const priceGap =
          normalizedMyPrice !== null &&
          currentBB !== null &&
          Math.abs(toCents(normalizedMyPrice) - toCents(currentBB)) >= 1;

        // Competitor anchor below us
        const lowestCompetitive =
          lowestFba !== null && lowestFba > 0
            ? lowestFba
            : lowestFbm !== null && lowestFbm > 0
              ? lowestFbm
              : null;
        const competitiveGap =
          normalizedMyPrice !== null &&
          lowestCompetitive !== null &&
          toCents(normalizedMyPrice) - toCents(lowestCompetitive) >= 1;

        // If recently evaluated with no change: only re-trigger on ACTUAL BB movement or lost BB.
        // Persistent competitive/price gaps already evaluated are suppressed until BB actually moves.
        const shouldTrigger = recentlyEvaluated
          ? (bbChanged || lostBB)
          : (bbChanged || lostBB || priceGap || competitiveGap);

        if (shouldTrigger) {
          const reason = bbChanged
            ? 'bb_moved'
            : lostBB
              ? 'lost_bb'
              : competitiveGap
                ? 'comp_gap'
                : 'gap_detected';
          console.log(
            `[priority-cron] P${passNumber} BB activity for ${item.asin}: $${lastBB}→$${currentBB}, lostBB=${lostBB}, bbGap=${priceGap}, compGap=${competitiveGap}, my=$${normalizedMyPrice}, lowComp=$${lowestCompetitive} [${reason}]`
          );
          itemsToEval.push(item);
          triggerReasons.push(reason);
          if (currentBB !== null) latestBBPrices.set(item.id, currentBB);
          result.bbMoved = result.bbMoved || bbChanged;
          result.lostBB = result.lostBB || lostBB;
          result.priceGapDetected = result.priceGapDetected || priceGap || competitiveGap;
        } else {
          if (recentlyEvaluated && (priceGap || competitiveGap)) {
            console.log(`[priority-cron] P${passNumber} ${item.asin}: suppressed (recently evaluated, persistent gap)`);
          }
          bbSkipped.push(item.asin);
          // Update check timestamp + current BB for accurate next-cycle comparison
          await supabase.from('repricer_assignments')
            .update({
              last_priority_check_at: new Date().toISOString(),
              last_buybox_price: currentBB,
            })
            .eq('id', item.id);
        }
      } else {
        // SP-API failed — evaluate to be safe
        itemsToEval.push(item);
        triggerReasons.push('sp_api_fallback');
      }

      // Check for 429/throttle
      if (spResp.status === 429 || spData.error?.includes?.('QuotaExceeded') || spData.error?.includes?.('429')) {
        console.warn(`[priority-cron] P${passNumber} 429 detected for ${userId} — pausing priority`);
        const backoff = setting.priority_backoff_seconds || 60;
        const nextBackoff = Math.min(backoff * 2, 600);
        await supabase.from('repricer_settings').update({
          priority_paused: true,
          priority_pause_reason: `429 throttle P${passNumber} at ${new Date().toISOString()}`,
          priority_auto_resume_at: new Date(Date.now() + backoff * 1000).toISOString(),
          priority_backoff_seconds: nextBackoff,
        }).eq('user_id', userId);
        result.throttled = true;
        result.callsUsed = callsThisWindow;
        return result;
      }
    } catch (e) {
      console.warn(`[priority-cron] P${passNumber} BB check failed for ${item.asin}:`, e);
      itemsToEval.push(item);
      triggerReasons.push('check_error');
    }

    await new Promise(resolve => setTimeout(resolve, 300)); // pace between BB checks
  }

  if (bbSkipped.length > 0) {
    console.log(`[priority-cron] P${passNumber} ${userId}: BB unchanged for ${bbSkipped.join(', ')} — skipped`);
  }

  result.triggerReason = triggerReasons.length > 0 ? triggerReasons.join(',') : 'bb_unchanged';

  if (itemsToEval.length === 0) {
    result.callsUsed = callsThisWindow;
    return result;
  }

  console.log(`[priority-cron] P${passNumber} ${userId}: evaluating ${itemsToEval.length} priority ASINs (${bbSkipped.length} BB-unchanged skipped)`);

  // Call repricer-scheduler with only these assignment IDs
  const assignmentIds = itemsToEval.map((p: any) => p.id);

  try {
    const response = await supabase.functions.invoke('repricer-scheduler', {
      body: {
        scheduled: true,
        user_id: userId,
        assignment_ids: assignmentIds,
        is_priority: true,
      }
    });

    // Update shared rate budget
    callsThisWindow += itemsToEval.length * 2;

    if (response.error) {
      const errStr = typeof response.error === 'string' ? response.error : JSON.stringify(response.error);
      if (errStr.includes('429') || errStr.includes('QuotaExceeded') || errStr.includes('queue_paused')) {
        const backoff = setting.priority_backoff_seconds || 60;
        const nextBackoff = Math.min(backoff * 2, 600);
        await supabase.from('repricer_settings').update({
          priority_paused: true,
          priority_pause_reason: `Scheduler 429 P${passNumber} at ${new Date().toISOString()}`,
          priority_auto_resume_at: new Date(Date.now() + backoff * 1000).toISOString(),
          priority_backoff_seconds: nextBackoff,
        }).eq('user_id', userId);
        result.throttled = true;
      } else {
        console.error(`[priority-cron] P${passNumber} Scheduler error for ${userId}:`, response.error);
      }
    } else {
      // Update last_priority_check_at AND last_buybox_price for processed items
      // This prevents stale BB ($16.52) from re-triggering bbChanged every cycle
      const now = new Date().toISOString();
      for (const item of itemsToEval) {
        const bbPrice = latestBBPrices.get(item.id);
        const updateFields: Record<string, any> = { last_priority_check_at: now };
        if (bbPrice !== undefined) {
          updateFields.last_buybox_price = bbPrice;
        }
        await supabase.from('repricer_assignments')
          .update(updateFields)
          .eq('id', item.id);
      }

      // Log PRIORITY_EVAL entries with turbo metadata
      const logEntries = itemsToEval.map((item: any, idx: number) => ({
        user_id: userId,
        assignment_id: item.id,
        asin: item.asin,
        sku: item.sku,
        marketplace: item.marketplace,
        action_type: 'priority_eval',
        trigger_source: 'priority_cron',
        reason: `P${passNumber} ⭐ ${triggerReasons[idx] || 'eval'} (${itemsToEval.length} evaluated, ${bbSkipped.length} skipped)`,
        success: true,
      }));

      await supabase.from('repricer_price_actions').insert(logEntries);

      const summary = response.data?.summary;
      result.evaluated = itemsToEval.length;
      result.applied = summary?.applied || 0;

      // Reset backoff on success
      if (setting.priority_backoff_seconds > 60) {
        await supabase.from('repricer_settings').update({
          priority_backoff_seconds: 60,
        }).eq('user_id', userId);
      }

      console.log(`[priority-cron] P${passNumber} ${userId}: ${summary?.evaluated || 0} evaluated, ${summary?.applied || 0} applied`);
    }
  } catch (e: any) {
    console.error(`[priority-cron] P${passNumber} Exception for ${userId}:`, e);
  }

  result.callsUsed = callsThisWindow;
  return result;
}
