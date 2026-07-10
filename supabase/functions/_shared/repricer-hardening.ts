/**
 * Repricer Hardening Utilities
 * 
 * Shared module for all 5 hardening features:
 * 1. Per-ASIN locking & idempotency (NOW ATOMIC via Postgres RPC)
 * 2. Post-apply reconciliation
 * 3. Global circuit breaker / safe mode
 * 4. DB pressure protection
 * 5. Per-ASIN anomaly detection
 */

// ─── COOLDOWN JITTER ────────────────────────────────────────────────────────
// Adds ±30 seconds of random jitter to cooldown expiry times to prevent
// synchronized wake-ups that cause throughput spikes and dead periods.
function jitteredCooldown(now: Date, cooldownMinutes: number): string {
  const jitterMs = (Math.random() - 0.5) * 2 * 30 * 1000; // ±30s
  return new Date(now.getTime() + cooldownMinutes * 60000 + jitterMs).toISOString();
}

// ─── 1. PER-ASIN LOCKING (ATOMIC via Postgres RPC) ─────────────────────────

export async function acquireLock(
  supabase: any,
  userId: string,
  asin: string,
  marketplace: string,
  owner: string,
  ttlSeconds: number = 90
): Promise<boolean> {
  const { data, error } = await supabase.rpc('acquire_repricer_lock', {
    p_user_id: userId,
    p_asin: asin,
    p_marketplace: marketplace,
    p_lock_owner: owner,
    p_ttl_seconds: ttlSeconds,
  });

  if (error) {
    console.log(`[lock] RPC failed for ${asin} (${marketplace}): ${error.message}`);
    return false;
  }
  
  if (!data) {
    console.log(`[lock] BLOCKED: ${asin} (${marketplace}) held by another owner, requested by ${owner}`);
  }
  return !!data;
}

export async function releaseLock(
  supabase: any,
  userId: string,
  asin: string,
  marketplace: string,
  owner: string
): Promise<void> {
  await supabase.rpc('release_repricer_lock', {
    p_user_id: userId,
    p_asin: asin,
    p_marketplace: marketplace,
    p_lock_owner: owner,
  });
}

export async function releaseAllLocks(
  supabase: any,
  userId: string,
  owner: string
): Promise<void> {
  await supabase.rpc('release_all_repricer_locks', {
    p_user_id: userId,
    p_lock_owner: owner,
  });
}

// ─── 2. IDEMPOTENCY ─────────────────────────────────────────────────────────

export function buildIdempotencyKey(
  userId: string,
  asin: string,
  marketplace: string,
  targetPrice: number,
  sourceCycle: string
): string {
  const priceCents = Math.round(targetPrice * 100);
  return `${userId}:${asin}:${marketplace}:${priceCents}:${sourceCycle}`;
}

export async function checkIdempotency(
  supabase: any,
  userId: string,
  key: string
): Promise<boolean> {
  await supabase
    .from('repricer_idempotency')
    .delete()
    .lt('expires_at', new Date().toISOString());

  const { data } = await supabase
    .from('repricer_idempotency')
    .select('id')
    .eq('user_id', userId)
    .eq('idempotency_key', key)
    .maybeSingle();

  return !!data;
}

export async function markSubmitted(
  supabase: any,
  userId: string,
  key: string,
  asin: string,
  marketplace: string,
  targetPrice: number,
  ttlMinutes: number = 15
): Promise<void> {
  await supabase
    .from('repricer_idempotency')
    .upsert({
      user_id: userId,
      idempotency_key: key,
      asin,
      marketplace,
      target_price: targetPrice,
      submitted_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
    }, { onConflict: 'user_id,idempotency_key' });
}

// ─── 3. CIRCUIT BREAKER / SAFE MODE ──────────────────────────────────────────

export interface CircuitBreakerCheck {
  triggered: boolean;
  reason: string | null;
}

const CIRCUIT_BREAKER_WINDOW_MINUTES = 30;
const CIRCUIT_BREAKER_ERROR_THRESHOLD = 50; // Only fatal errors count now

// ─── ERROR CLASSIFICATION ────────────────────────────────────────────────────
// Benign evaluation outcomes that should NOT trip the circuit breaker
const BENIGN_ERROR_PATTERNS = [
  'rule not found',
  'assignment not found',
  'asin is required',
  'ai win sales booster rule required',
  'no rule',
  'no inventory',
  'no fees cached',
  'no pricing data',
  'empty snapshot',
  'market stable',
  'throttled',
  'throttle',
  'rate limit',
  'ratelimiterror',
  'quotaexceeded',
  'no change',
  'skip',
  'do_not_reprice',
  'constrained_by',
  'profit_guard',
  'owner protection',
  'missing rule',
  'missing inventory',
  'missing sku',
  'no sku',
  'unauthorized',        // auth issue, not system crash
  'not found',           // 404-type, data missing
  'edge function returned a non-2xx', // usually Amazon rejection, not our crash
  'failed to send a request',         // edge function overload, transient
  'boot failure',                     // edge runtime transient failure
  'connection error',                 // transient network issue
  'timed out',                        // transient timeout, not a crash
  'timeout',                          // transient timeout variant
];

/**
 * Classify whether an error is a fatal system failure (should trip breaker)
 * or a benign evaluation outcome (should NOT trip breaker).
 */
export function isFatalError(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  const msg = errorMessage.toLowerCase();
  return !BENIGN_ERROR_PATTERNS.some(pattern => msg.includes(pattern));
}
const CIRCUIT_BREAKER_RAPID_CHANGE_THRESHOLD = 50;

export async function checkCircuitBreaker(
  supabase: any,
  userId: string,
  settings: any
): Promise<CircuitBreakerCheck> {
  if (settings?.safe_mode_active) {
    if (settings.safe_mode_auto_resume_at) {
      const resumeTime = new Date(settings.safe_mode_auto_resume_at).getTime();
      if (Date.now() >= resumeTime) {
        // Auto-resume: reset EVERYTHING including window
        await supabase.from('repricer_settings').update({
          safe_mode_active: false,
          safe_mode_reason: null,
          safe_mode_activated_at: null,
          safe_mode_auto_resume_at: null,
          circuit_breaker_error_count: 0,
          circuit_breaker_window_start: new Date().toISOString(),
        }).eq('user_id', userId);
        console.log(`[circuit-breaker] Auto-resumed safe mode for ${userId}, reset error count and window`);
        return { triggered: false, reason: null };
      }
    }
    return { triggered: true, reason: settings.safe_mode_reason || 'Safe mode active' };
  }

  const windowStart = settings?.circuit_breaker_window_start 
    ? new Date(settings.circuit_breaker_window_start).getTime() 
    : 0;
  const windowAge = (Date.now() - windowStart) / (1000 * 60);
  
  let errorCount = settings?.circuit_breaker_error_count || 0;
  
  if (windowAge > CIRCUIT_BREAKER_WINDOW_MINUTES) {
    errorCount = 0;
    await supabase.from('repricer_settings').update({
      circuit_breaker_error_count: 0,
      circuit_breaker_window_start: new Date().toISOString(),
    }).eq('user_id', userId);
  }

  if (errorCount >= CIRCUIT_BREAKER_ERROR_THRESHOLD) {
    const reason = `Too many errors (${errorCount}) in ${CIRCUIT_BREAKER_WINDOW_MINUTES}min window`;
    await activateSafeMode(supabase, userId, reason, 30);
    return { triggered: true, reason };
  }

  const windowISO = new Date(Date.now() - CIRCUIT_BREAKER_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { data: rapidChanges } = await supabase
    .from('repricer_price_actions')
    .select('asin')
    .eq('user_id', userId)
    .eq('action_type', 'price_change')
    .eq('success', true)
    .gte('created_at', windowISO);

  if (rapidChanges) {
    const asinCounts = new Map<string, number>();
    for (const r of rapidChanges) {
      asinCounts.set(r.asin, (asinCounts.get(r.asin) || 0) + 1);
    }
    for (const [asin, count] of asinCounts) {
      if (count >= CIRCUIT_BREAKER_RAPID_CHANGE_THRESHOLD) {
        const reason = `ASIN ${asin} has ${count} price changes in ${CIRCUIT_BREAKER_WINDOW_MINUTES}min — possible oscillation`;
        await activateSafeMode(supabase, userId, reason, 60);
        return { triggered: true, reason };
      }
    }
  }

  return { triggered: false, reason: null };
}

/**
 * Only increment errors when NOT in safe mode (prevents phantom accumulation)
 */

export async function incrementCircuitBreakerErrors(
  supabase: any,
  userId: string
): Promise<void> {
  try {
    const { data } = await supabase
      .from('repricer_settings')
      .select('circuit_breaker_error_count, safe_mode_active')
      .eq('user_id', userId)
      .maybeSingle();
    
    // Don't accumulate errors while already in safe mode — prevents phantom count growth
    if (data?.safe_mode_active) {
      return;
    }
    
    const newCount = (data?.circuit_breaker_error_count || 0) + 1;
    await supabase
      .from('repricer_settings')
      .update({ circuit_breaker_error_count: newCount })
      .eq('user_id', userId);
  } catch (e) {
    console.error('[circuit-breaker] Failed to increment error count:', e);
  }
}

async function activateSafeMode(
  supabase: any,
  userId: string,
  reason: string,
  autoResumeMinutes: number
): Promise<void> {
  const resumeAt = new Date(Date.now() + autoResumeMinutes * 60 * 1000).toISOString();
  
  await supabase.from('repricer_settings').update({
    safe_mode_active: true,
    safe_mode_reason: reason,
    safe_mode_activated_at: new Date().toISOString(),
    safe_mode_auto_resume_at: resumeAt,
    circuit_breaker_last_trigger: reason,
  }).eq('user_id', userId);

  await supabase.from('repricer_price_actions').insert({
    user_id: userId,
    asin: 'CIRCUIT_BREAKER',
    marketplace: 'US',
    action_type: 'safe_mode_activated',
    trigger_source: 'circuit_breaker',
    reason,
    success: true,
  });

  console.log(`[circuit-breaker] SAFE MODE ACTIVATED for ${userId}: ${reason}. Auto-resume at ${resumeAt}`);
}

// ─── 4. DB PRESSURE PROTECTION ──────────────────────────────────────────────

const MAX_WRITES_PER_CYCLE = 500;
const WRITE_CYCLE_DURATION_MINUTES = 15;

export async function checkWriteBudget(
  supabase: any,
  userId: string,
  settings: any
): Promise<{ allowed: boolean; remaining: number }> {
  const cycleStart = settings?.writes_cycle_start 
    ? new Date(settings.writes_cycle_start).getTime() 
    : 0;
  const cycleAge = (Date.now() - cycleStart) / (1000 * 60);
  
  let writesThisCycle = settings?.writes_this_cycle || 0;
  
  if (cycleAge > WRITE_CYCLE_DURATION_MINUTES) {
    writesThisCycle = 0;
    await supabase.from('repricer_settings').update({
      writes_this_cycle: 0,
      writes_cycle_start: new Date().toISOString(),
    }).eq('user_id', userId);
  }

  return {
    allowed: writesThisCycle < MAX_WRITES_PER_CYCLE,
    remaining: MAX_WRITES_PER_CYCLE - writesThisCycle,
  };
}

export async function incrementWriteCount(
  supabase: any,
  userId: string,
  count: number = 1
): Promise<void> {
  const { data } = await supabase
    .from('repricer_settings')
    .select('writes_this_cycle')
    .eq('user_id', userId)
    .maybeSingle();
  
  await supabase.from('repricer_settings').update({
    writes_this_cycle: (data?.writes_this_cycle || 0) + count,
  }).eq('user_id', userId);
}

// ─── 5. PER-ASIN ANOMALY DETECTION ──────────────────────────────────────────

export interface OscillationSettings {
  oscillation_mode: 'safe' | 'balanced' | 'aggressive';
  oscillation_cooldown_minutes: number;
  oscillation_max_reactions: number;
  oscillation_bb_loss_limit: number;
}

export const DEFAULT_OSCILLATION: OscillationSettings = {
  oscillation_mode: 'safe',
  oscillation_cooldown_minutes: 20,
  oscillation_max_reactions: 0,
  oscillation_bb_loss_limit: 1,
};

export interface AnomalyResult {
  score: number;
  flags: string[];
  forceEvalOnly: boolean;
  oscillationAction: string; // e.g. OSCILLATION_BLOCKED_SAFE, OSCILLATION_REACTION_BALANCED, etc.
}

export interface InventoryPressure {
  daysWithoutSale: number;
  daysOfStock: number;
  unitsAvailable: number;
  inventoryAgeDays: number;
}

/**
 * Compute an inventory pressure relief factor (0 = no relief, up to -5 score reduction).
 * High-pressure inventory (aging, overstocked, no sales) gets oscillation relief
 * so the system doesn't freeze products that need price movement to sell.
 */
function computeInventoryPressureRelief(pressure: InventoryPressure | undefined): { relief: number; reasons: string[] } {
  if (!pressure) return { relief: 0, reasons: [] };
  let relief = 0;
  const reasons: string[] = [];

  // Days without sale: 7+ days = moderate relief, 14+ = strong
  if (pressure.daysWithoutSale >= 14) {
    relief += 2; reasons.push(`no_sale_${pressure.daysWithoutSale}d`);
  } else if (pressure.daysWithoutSale >= 7) {
    relief += 1; reasons.push(`no_sale_${pressure.daysWithoutSale}d`);
  }

  // Days of stock: 180+ = strong relief, 90+ = moderate
  if (pressure.daysOfStock >= 180) {
    relief += 2; reasons.push(`overstock_${pressure.daysOfStock}d`);
  } else if (pressure.daysOfStock >= 90) {
    relief += 1; reasons.push(`overstock_${pressure.daysOfStock}d`);
  }

  // Inventory age: 60+ days = moderate relief
  if (pressure.inventoryAgeDays >= 120) {
    relief += 1; reasons.push(`aging_${pressure.inventoryAgeDays}d`);
  } else if (pressure.inventoryAgeDays >= 60) {
    relief += 0.5; reasons.push(`aging_${pressure.inventoryAgeDays}d`);
  }

  // Cap total relief at 5 points
  relief = Math.min(5, relief);

  return { relief, reasons };
}

export async function detectAnomalies(
  supabase: any,
  userId: string,
  assignmentId: string,
  assignment: any,
  newPrice: number | null,
  currentPrice: number | null,
  oscillationSettings?: OscillationSettings,
  liveIsBuyboxOwner?: boolean,
  liveBuyboxPrice?: number | null,
  stockGatedMaximize: boolean = false,
  restockReentry: boolean = false,
  inventoryPressure?: InventoryPressure,
  marketState?: 'calm' | 'active' | 'chaotic',
  triggerSource?: string,
): Promise<AnomalyResult> {
  const osc = oscillationSettings || DEFAULT_OSCILLATION;
  const flags: string[] = [];
  let score = assignment.anomaly_score || 0;
  let oscillationAction = '';
  // ── MANUAL EVAL NOISE REDUCTION ────────────────────────────────────────
  // Manual evaluations and rule edits are user/admin testing activity, not
  // real market reactions. They must NOT contaminate the recent_prices
  // sequence (which feeds OSCILLATION_DETECTED + RAPID_PRICE_INSTABILITY)
  // and must NOT add to the anomaly score. Existing cooldowns are still
  // honored — we only stop NEW score accumulation from manual noise.
  const isManualNoise = triggerSource === 'manual_run_selected'
    || triggerSource === 'manual'
    || triggerSource === 'rule_change';
  // Market-volatility softening: in chaotic markets the score gate is raised
  // and aggressive-mode cooldowns are halved, because heavy competitor churn
  // is healthy market behavior — not self-chasing. Calm/active behave as before.
  const mvState: 'calm' | 'active' | 'chaotic' = marketState
    || (assignment.market_state as any)
    || 'calm';
  const scoreGate = mvState === 'chaotic' ? 65 : mvState === 'active' ? 58 : 50;

  const recentPrices: number[] = (assignment.recent_prices || []).slice(-10);
  // Only append the proposed price into the oscillation history when this is a
  // genuine market-driven evaluation. Manual evals / rule edits are filtered
  // out so admin testing doesn't simulate a competitor war.
  if (newPrice !== null && !isManualNoise) {
    recentPrices.push(newPrice);
  }

  const stockGatedRaiseAttempt = Boolean(
    stockGatedMaximize
    && newPrice !== null
    && currentPrice !== null
    && newPrice > currentPrice
  );
  const stockGatedMaxStep = currentPrice != null
    ? Math.min(2.0, currentPrice * 0.10) + 0.01
    : 1.01;
  const recentRecoveryTail = stockGatedRaiseAttempt ? recentPrices.slice(-3) : [];
  const isStockGatedRecoveryStaircase = Boolean(
    stockGatedRaiseAttempt
    && recentRecoveryTail.length >= 2
    && recentRecoveryTail.every((p, i) => i === 0 || p >= recentRecoveryTail[i - 1])
    && recentRecoveryTail.every((p, i) =>
      i === 0 || (p - recentRecoveryTail[i - 1]) <= stockGatedMaxStep
    )
  );

  // Restock snap-back: downward correction after restock should bypass oscillation/anomaly
  const restockSnapbackAttempt = Boolean(
    restockReentry
    && newPrice !== null
    && currentPrice !== null
    && newPrice < currentPrice
  );
  if (restockSnapbackAttempt) {
    console.log(`[anomaly] ${assignment.asin}: restock_reentry_snapback detected ($${currentPrice!.toFixed(2)} → $${newPrice!.toFixed(2)}) — bypassing oscillation/anomaly guards`);
  }

  // 1. OSCILLATION — exempt monotonic non-decreasing sequences with controlled steps
  // Skip entirely on manual evals/rule edits — the proposed price wasn't appended,
  // but we also don't want a stale historical sequence to keep firing during admin testing.
  let oscillationDetected = false;
  if (!isManualNoise && recentPrices.length >= 4) {
    const isMonotonicUp = recentPrices.every((p, i) => i === 0 || p >= recentPrices[i - 1]);
    const MAX_CONTROLLED_STEP_OSC = stockGatedRaiseAttempt ? stockGatedMaxStep : 0.50;
    const hasControlledSteps = isMonotonicUp && recentPrices.every((p, i) =>
      i === 0 || (p - recentPrices[i - 1]) <= MAX_CONTROLLED_STEP_OSC
    );
    if (!hasControlledSteps && !isStockGatedRecoveryStaircase) {
      let oscillations = 0;
      for (let i = 2; i < recentPrices.length; i++) {
        const prev = recentPrices[i - 2];
        const mid = recentPrices[i - 1];
        const curr = recentPrices[i];
        if ((mid > prev && curr < mid) || (mid < prev && curr > mid)) {
          oscillations++;
        }
      }
      if (oscillations >= 3) {
        flags.push('OSCILLATION_DETECTED');
        score = Math.min(100, score + 20);
        oscillationDetected = true;
      }
    }
  }

  // 2. REPEATED CLAMP
  const today = new Date().toISOString().split('T')[0];
  let clampCount = assignment.clamp_count_today || 0;
  if (assignment.clamp_count_reset_at !== today) {
    clampCount = 0;
  }
  if (clampCount >= 10) {
    flags.push('REPEATED_CLAMP');
    score = Math.min(100, score + 15);
  }

  // 3. BB LOSS AFTER RAISE
  const bbLossCount = assignment.bb_loss_after_raise_count || 0;
  if (bbLossCount >= 3) {
    flags.push('BB_LOSS_AFTER_RAISE');
    score = Math.min(100, score + 25);
  }

  // 4. EXCESSIVE RAPID CHANGES (exempt narrow monotonic raises with controlled steps)
  // Also skipped on manual eval / rule edit noise so admin testing can't trigger
  // RAPID_PRICE_INSTABILITY by re-running evaluations against a static market.
  if (!isManualNoise && recentPrices.length >= 6) {
    const last6 = recentPrices.slice(-6);
    const uniquePrices = new Set(last6.map(p => Math.round(p * 100)));
    const isMonotonicUp = last6.every((p, i) => i === 0 || p >= last6[i - 1]);
    const MAX_CONTROLLED_STEP = stockGatedRaiseAttempt ? stockGatedMaxStep : 0.50;
    const hasControlledSteps = isMonotonicUp && last6.every((p, i) =>
      i === 0 || (p - last6[i - 1]) <= MAX_CONTROLLED_STEP
    );
    if (uniquePrices.size >= 5 && !hasControlledSteps && !isStockGatedRecoveryStaircase) {
      flags.push('RAPID_PRICE_INSTABILITY');
      score = Math.min(100, score + 15);
    }
  }

  // Decay score if no new flags
  if (flags.length === 0 && score > 0) {
    const isMonotonicUp = recentPrices.length >= 2 && recentPrices.every((p, i) => i === 0 || p >= recentPrices[i - 1]);
    const MAX_STEP = stockGatedRaiseAttempt ? stockGatedMaxStep : 0.50;
    const hasControlledSteps = isMonotonicUp && recentPrices.every((p, i) =>
      i === 0 || (p - recentPrices[i - 1]) <= MAX_STEP
    );
    if (restockSnapbackAttempt && score >= 30) {
      score = Math.max(0, score - 50);
      console.log(`[anomaly] ${assignment.asin}: Restock snap-back — aggressive decay to score=${score}`);
    } else if ((hasControlledSteps || isStockGatedRecoveryStaircase) && score >= 50) {
      score = Math.max(0, score - 40);
      console.log(`[anomaly] ${assignment.asin}: Monotonic raise detected, fast decay to score=${score}`);
    } else {
      score = Math.max(0, score - 10);
    }
  }

  // ─── INVENTORY PRESSURE RELIEF ──────────────────────────────────────────
  // Reduce oscillation strictness for aging/slow-selling/overstocked inventory
  // so the system doesn't freeze products that need price movement to sell.
  const { relief: inventoryRelief, reasons: reliefReasons } = computeInventoryPressureRelief(inventoryPressure);
  if (inventoryRelief > 0) {
    const scoreBefore = score;
    score = Math.max(0, score - Math.round(inventoryRelief));
    console.log(`[OSCILLATION_INVENTORY_RELIEF] ${assignment.asin}: score ${scoreBefore}→${score} (relief=${inventoryRelief}) signals=[${reliefReasons.join(',')}] pressure={noSale=${inventoryPressure?.daysWithoutSale}d, stock=${inventoryPressure?.daysOfStock}d, age=${inventoryPressure?.inventoryAgeDays}d, units=${inventoryPressure?.unitsAvailable}}`);
  }

  // ─── OSCILLATION MODE LOGIC ───────────────────────────────────────────
  let hasAnomalyFlags = oscillationDetected || flags.includes('RAPID_PRICE_INSTABILITY') || flags.includes('BB_LOSS_AFTER_RAISE');
  let forceEvalOnly = false;
  const now = new Date();
  const reactionCount = assignment.oscillation_reaction_count || 0;
  const cooldownUntil = assignment.oscillation_cooldown_until ? new Date(assignment.oscillation_cooldown_until) : null;
  const cooldownActive = !!(cooldownUntil && cooldownUntil.getTime() > now.getTime());
  const cooldownExpired = !!(cooldownUntil && cooldownUntil.getTime() <= now.getTime());
  const isTimedOscillationState = typeof assignment.oscillation_state === 'string'
    && (assignment.oscillation_state.includes('cooldown') || assignment.oscillation_state === 'blocked');
  const justExpiredCooldown = cooldownExpired && isTimedOscillationState;
  const liveBuybox = liveBuyboxPrice ?? newPrice;
  const currentPriceCents = currentPrice != null ? Math.round(currentPrice * 100) : null;
  const liveBuyboxCents = liveBuybox != null ? Math.round(liveBuybox * 100) : null;
  const significantGapThresholdCents = currentPriceCents != null && currentPriceCents >= 3000 ? 10 : 5;
  const priceDisadvantageCents = currentPriceCents != null && liveBuyboxCents != null
    ? Math.max(0, currentPriceCents - liveBuyboxCents)
    : 0;

  const oscStateUpdate: any = {};

  if (justExpiredCooldown) {
    oscStateUpdate.oscillation_state = 'competing';
    oscStateUpdate.oscillation_cooldown_until = null;
    oscStateUpdate.oscillation_reaction_count = 0;
    oscStateUpdate.bb_loss_after_raise_count = 0;
    oscStateUpdate.oscillation_last_mode_used = osc.oscillation_mode;
    oscStateUpdate.oscillation_last_reason = 'cooldown_expired_released';
    // Clear recent_prices to prevent stale oscillation patterns from re-triggering immediately
    oscStateUpdate.recent_prices = currentPrice != null ? [currentPrice] : [];
    if (currentPrice != null) {
      oscStateUpdate.last_stable_price = currentPrice;
    }
    // Reset local variables so flags aren't re-triggered this same cycle
    flags.length = 0;
    score = 0;
    // Also reset local oscillationDetected so hasAnomalyFlags won't fire
    oscillationDetected = false;
    console.log(`[OSCILLATION_MODE] ${String(osc.oscillation_mode).toUpperCase()}: ${assignment.asin} expired cooldown released back to competing (bb_loss_count reset, recent_prices cleared)`);
    // Recalculate hasAnomalyFlags after clearing
    hasAnomalyFlags = false;
  }

  if (hasAnomalyFlags || score >= scoreGate) {
    // ─── INVENTORY PRESSURE ESCAPE ──────────────────────────────────────
    // If inventory pressure is high enough (relief >= 3), allow one controlled
    // repositioning move even during oscillation, as long as target is above floor.
    // This prevents the system from freezing aging/slow-selling inventory for days/weeks.
    const highPressureEscape = inventoryRelief >= 3;
    if (highPressureEscape && !cooldownActive) {
      console.log(`[OSCILLATION_INVENTORY_ESCAPE] ${assignment.asin}: HIGH inventory pressure (relief=${inventoryRelief}, signals=[${reliefReasons.join(',')}]) — bypassing oscillation guard for controlled repositioning`);
      // Allow the move through — don't set forceEvalOnly
      const oscEscapeAction = 'OSCILLATION_INVENTORY_PRESSURE_BYPASS';
      oscStateUpdate.oscillation_state = 'inventory_pressure_bypass';
      oscStateUpdate.oscillation_last_mode_used = osc.oscillation_mode;
      oscStateUpdate.oscillation_last_reason = `inventory_pressure_${reliefReasons.join('_')}`;
      // Set a short cooldown to prevent unlimited rapid drops (1 move per 5 min max)
      oscStateUpdate.oscillation_cooldown_until = jitteredCooldown(now, 5);

      await supabase.from('repricer_assignments').update({
        anomaly_score: score,
        anomaly_flags: flags.length > 0 ? flags : assignment.anomaly_flags || [],
        anomaly_last_checked_at: new Date().toISOString(),
        recent_prices: recentPrices.slice(-10),
        oscillation_count: flags.includes('OSCILLATION_DETECTED')
          ? (assignment.oscillation_count || 0) + 1
          : assignment.oscillation_count || 0,
        ...oscStateUpdate,
      }).eq('id', assignmentId);

      return { score, flags, forceEvalOnly: false, oscillationAction: oscEscapeAction };
    }

    const bbLossExceeded = !justExpiredCooldown && bbLossCount >= osc.oscillation_bb_loss_limit;

    if (osc.oscillation_mode === 'safe') {
      forceEvalOnly = true;
      oscillationAction = 'OSCILLATION_BLOCKED_SAFE';
      oscStateUpdate.oscillation_state = 'blocked';
      oscStateUpdate.oscillation_last_mode_used = 'safe';
      oscStateUpdate.oscillation_last_reason = flags.join(',') || 'score_threshold';
      if (oscillationDetected && !assignment.oscillation_detected_at) {
        oscStateUpdate.oscillation_detected_at = now.toISOString();
      }
      // Only set cooldown if not already in an active cooldown — prevents infinite loop
      // where stale recent_prices re-detect oscillation and keep resetting the timer
      if (!cooldownActive) {
        oscStateUpdate.oscillation_cooldown_until = jitteredCooldown(now, osc.oscillation_cooldown_minutes);
      }
      console.log(`[OSCILLATION_MODE] SAFE: ${assignment.asin} BLOCKED. score=${score}, flags=${flags.join(',')}, cooldown=${osc.oscillation_cooldown_minutes}min, cooldownActive=${cooldownActive}`);

    } else if (osc.oscillation_mode === 'balanced') {
      if (cooldownActive && restockSnapbackAttempt) {
        forceEvalOnly = false;
        oscillationAction = 'OSCILLATION_COOLDOWN_CLEARED_RESTOCK_REENTRY';
        oscStateUpdate.oscillation_state = 'competing';
        oscStateUpdate.oscillation_cooldown_until = null;
        oscStateUpdate.oscillation_reaction_count = 0;
        oscStateUpdate.oscillation_last_mode_used = 'balanced';
        oscStateUpdate.oscillation_last_reason = 'cleared_restock_reentry_snapback';
        console.log(`[OSCILLATION_MODE] BALANCED: ${assignment.asin} COOLDOWN CLEARED — restock re-entry snap-back`);
      } else if (cooldownActive && (stockGatedRaiseAttempt || isStockGatedRecoveryStaircase)) {
        forceEvalOnly = false;
        oscillationAction = 'OSCILLATION_COOLDOWN_CLEARED_STOCK_GATED';
        oscStateUpdate.oscillation_state = 'competing';
        oscStateUpdate.oscillation_cooldown_until = null;
        oscStateUpdate.oscillation_reaction_count = 0;
        oscStateUpdate.oscillation_last_mode_used = 'balanced';
        oscStateUpdate.oscillation_last_reason = 'cleared_stock_gated_recovery_raise';
        console.log(`[OSCILLATION_MODE] BALANCED: ${assignment.asin} COOLDOWN CLEARED — stock-gated recovery raise`);
      } else if (cooldownActive) {
        forceEvalOnly = true;
        oscillationAction = 'OSCILLATION_COOLDOWN_BALANCED';
        oscStateUpdate.oscillation_state = 'cooldown';
        oscStateUpdate.oscillation_last_mode_used = 'balanced';
        console.log(`[OSCILLATION_MODE] BALANCED: ${assignment.asin} IN COOLDOWN until ${cooldownUntil!.toISOString()}`);
      } else if (bbLossExceeded && (stockGatedRaiseAttempt || isStockGatedRecoveryStaircase)) {
        forceEvalOnly = false;
        oscillationAction = 'OSCILLATION_BYPASS_STOCK_GATED_MAXIMIZE';
        oscStateUpdate.oscillation_state = 'competing';
        oscStateUpdate.oscillation_cooldown_until = null;
        oscStateUpdate.oscillation_reaction_count = 0;
        oscStateUpdate.oscillation_last_mode_used = 'balanced';
        oscStateUpdate.oscillation_last_reason = 'stock_gated_recovery_bypass';
        console.log(`[OSCILLATION_MODE] BALANCED: ${assignment.asin} bypassing BB-loss cooldown for stock-gated recovery raise`);
      } else if (bbLossExceeded) {
        forceEvalOnly = true;
        oscillationAction = 'OSCILLATION_PAUSED_AFTER_BB_LOSS';
        oscStateUpdate.oscillation_state = 'bb_loss_cooldown';
        oscStateUpdate.oscillation_cooldown_until = jitteredCooldown(now, osc.oscillation_cooldown_minutes);
        oscStateUpdate.oscillation_last_mode_used = 'balanced';
        oscStateUpdate.oscillation_last_reason = `bb_loss_limit_${bbLossCount}`;
        console.log(`[OSCILLATION_MODE] BALANCED: ${assignment.asin} BB_LOSS_LIMIT reached (${bbLossCount}/${osc.oscillation_bb_loss_limit}), entering cooldown`);
      } else if (reactionCount >= osc.oscillation_max_reactions) {
        forceEvalOnly = true;
        oscillationAction = 'OSCILLATION_COOLDOWN_BALANCED';
        oscStateUpdate.oscillation_state = 'reaction_limit_cooldown';
        oscStateUpdate.oscillation_cooldown_until = jitteredCooldown(now, osc.oscillation_cooldown_minutes);
        oscStateUpdate.oscillation_reaction_count = 0;
        oscStateUpdate.oscillation_last_mode_used = 'balanced';
        console.log(`[OSCILLATION_MODE] BALANCED: ${assignment.asin} reaction limit reached (${reactionCount}/${osc.oscillation_max_reactions}), entering cooldown`);
      } else {
        forceEvalOnly = false;
        oscillationAction = 'OSCILLATION_REACTION_BALANCED';
        oscStateUpdate.oscillation_state = 'reacting';
        oscStateUpdate.oscillation_reaction_count = reactionCount + 1;
        oscStateUpdate.oscillation_last_mode_used = 'balanced';
        if (oscillationDetected && !assignment.oscillation_detected_at) {
          oscStateUpdate.oscillation_detected_at = now.toISOString();
        }
        console.log(`[OSCILLATION_MODE] BALANCED: ${assignment.asin} REACTION ${reactionCount + 1}/${osc.oscillation_max_reactions}. score=${score}, flags=${flags.join(',')}`);
      }

    } else if (osc.oscillation_mode === 'aggressive') {
      const currentlyOwning = liveIsBuyboxOwner === true;
      const priceMatchesBb = currentPriceCents != null && liveBuyboxCents != null && Math.abs(currentPriceCents - liveBuyboxCents) <= 1;
      const skipBbLossCooldown = currentlyOwning || priceMatchesBb || stockGatedRaiseAttempt || isStockGatedRecoveryStaircase;
      const repeatedBbLoss = reactionCount >= Math.max(2, osc.oscillation_bb_loss_limit);
      const meaningfulPriceDisadvantage = priceDisadvantageCents >= significantGapThresholdCents;
      const shouldEnterBbLossCooldown = !skipBbLossCooldown && (meaningfulPriceDisadvantage || repeatedBbLoss);

      if (cooldownActive && !skipBbLossCooldown) {
        forceEvalOnly = true;
        oscillationAction = 'OSCILLATION_COOLDOWN_AGGRESSIVE';
        oscStateUpdate.oscillation_state = 'bb_loss_cooldown';
        oscStateUpdate.oscillation_last_mode_used = 'aggressive';
        console.log(`[OSCILLATION_MODE] AGGRESSIVE: ${assignment.asin} IN BB_LOSS COOLDOWN until ${cooldownUntil!.toISOString()}`);
      } else if (cooldownActive && skipBbLossCooldown) {
        forceEvalOnly = false;
        oscillationAction = currentlyOwning || priceMatchesBb
          ? 'OSCILLATION_COOLDOWN_CLEARED_WINNING'
          : 'OSCILLATION_COOLDOWN_CLEARED_STOCK_GATED';
        oscStateUpdate.oscillation_state = 'competing';
        oscStateUpdate.oscillation_cooldown_until = null;
        oscStateUpdate.oscillation_reaction_count = 0;
        oscStateUpdate.oscillation_last_mode_used = 'aggressive';
        oscStateUpdate.oscillation_last_reason = currentlyOwning
          ? 'cleared_currently_owning_bb'
          : priceMatchesBb
            ? 'cleared_price_matches_bb'
            : 'cleared_stock_gated_recovery_raise';
        console.log(`[OSCILLATION_MODE] AGGRESSIVE: ${assignment.asin} COOLDOWN CLEARED — ${currentlyOwning ? 'currently owns BB' : priceMatchesBb ? 'price matches BB' : 'stock-gated recovery raise'}`);
      } else if (shouldEnterBbLossCooldown) {
        forceEvalOnly = true;
        oscillationAction = 'OSCILLATION_PAUSED_AFTER_BB_LOSS';
        oscStateUpdate.oscillation_state = 'bb_loss_cooldown';
        // Chaotic markets: halve the BB-loss cooldown (1 min). Heavy competitor
        // churn means the BB rotates fast; waiting 2 min is too slow.
        const bbLossCdMin = mvState === 'chaotic' ? 1 : 2;
        oscStateUpdate.oscillation_cooldown_until = jitteredCooldown(now, bbLossCdMin);
        oscStateUpdate.oscillation_last_mode_used = 'aggressive';
        oscStateUpdate.oscillation_last_reason = meaningfulPriceDisadvantage
          ? `bb_loss_gap_${priceDisadvantageCents}c_mv_${mvState}`
          : `bb_loss_repeat_${reactionCount}_mv_${mvState}`;
        console.log(`[OSCILLATION_MODE] AGGRESSIVE: ${assignment.asin} entering BB-loss cooldown (gap=${priceDisadvantageCents}c, reactions=${reactionCount}, mv=${mvState}, cd=${bbLossCdMin}min)`);

      } else if (currentPrice && newPrice && currentPrice > 0) {
        const gapPct = Math.abs(currentPrice - newPrice) / currentPrice * 100;
        if (gapPct > 15 && newPrice < currentPrice) {
          // Real margin-destruction guard — leave intact regardless of mvState.
          forceEvalOnly = true;
          oscillationAction = 'AGGRESSIVE_SAFETY_GAP_TOO_WIDE';
          oscStateUpdate.oscillation_state = 'safety_cooldown';
          oscStateUpdate.oscillation_cooldown_until = jitteredCooldown(now, 15);
          oscStateUpdate.oscillation_last_mode_used = 'aggressive';
          oscStateUpdate.oscillation_last_reason = `gap_${Math.round(gapPct)}pct`;
          console.log(`[OSCILLATION_MODE] AGGRESSIVE SAFETY: ${assignment.asin} price gap ${gapPct.toFixed(1)}% > 15% threshold. Entering 15min cooldown to prevent margin destruction.`);
        } else if (reactionCount >= 5 && assignment.last_buybox_status !== 'owned') {
          // Futile-war guard — relax in chaotic markets where 5 reactions is
          // normal background activity. Raise reaction floor to 8 in chaotic.
          if (mvState === 'chaotic' && reactionCount < 8) {
            forceEvalOnly = false;
            oscillationAction = 'OSCILLATION_REACTION_AGGRESSIVE_MV_CHAOTIC';
            oscStateUpdate.oscillation_state = 'competing';
            oscStateUpdate.oscillation_reaction_count = reactionCount + 1;
            oscStateUpdate.oscillation_last_mode_used = 'aggressive';
            oscStateUpdate.oscillation_last_reason = `mv_chaotic_futile_war_relaxed_${reactionCount}`;
            console.log(`[OSCILLATION_MODE] AGGRESSIVE: ${assignment.asin} futile-war guard RELAXED (mv=chaotic, reactions=${reactionCount}/8)`);
          } else {
            forceEvalOnly = true;
            oscillationAction = 'AGGRESSIVE_SAFETY_FUTILE_WAR';
            oscStateUpdate.oscillation_state = 'safety_cooldown';
            const futileCd = mvState === 'chaotic' ? 5 : 10;
            oscStateUpdate.oscillation_cooldown_until = jitteredCooldown(now, futileCd);
            oscStateUpdate.oscillation_reaction_count = 0;
            oscStateUpdate.oscillation_last_mode_used = 'aggressive';
            oscStateUpdate.oscillation_last_reason = `futile_war_${reactionCount}_reactions_no_bb_mv_${mvState}`;
            console.log(`[OSCILLATION_MODE] AGGRESSIVE SAFETY: ${assignment.asin} ${reactionCount} reactions without BB ownership (mv=${mvState}). Entering ${futileCd}min cooldown.`);
          }
        } else if (reactionCount >= 10) {
          forceEvalOnly = true;
          oscillationAction = 'AGGRESSIVE_SAFETY_REACTION_CAP';
          oscStateUpdate.oscillation_state = 'safety_cooldown';
          oscStateUpdate.oscillation_cooldown_until = jitteredCooldown(now, 5);
          oscStateUpdate.oscillation_reaction_count = 0;
          oscStateUpdate.oscillation_last_mode_used = 'aggressive';
          oscStateUpdate.oscillation_last_reason = `reaction_cap_${reactionCount}`;
          console.log(`[OSCILLATION_MODE] AGGRESSIVE SAFETY: ${assignment.asin} ${reactionCount} reactions reached cap. 5min breather cooldown.`);
        } else {
          forceEvalOnly = false;
          oscillationAction = justExpiredCooldown ? 'OSCILLATION_COOLDOWN_EXPIRED_REEVAL' : 'OSCILLATION_REACTION_AGGRESSIVE';
          oscStateUpdate.oscillation_state = 'competing';
          oscStateUpdate.oscillation_reaction_count = justExpiredCooldown ? 1 : reactionCount + 1;
          oscStateUpdate.oscillation_last_mode_used = 'aggressive';
          console.log(`[OSCILLATION_MODE] AGGRESSIVE: ${assignment.asin} CONTINUING despite anomaly. score=${score}, flags=${flags.join(',')}`);
        }
      } else {
        forceEvalOnly = false;
        oscillationAction = justExpiredCooldown ? 'OSCILLATION_COOLDOWN_EXPIRED_REEVAL' : 'OSCILLATION_REACTION_AGGRESSIVE';
        oscStateUpdate.oscillation_state = 'competing';
        oscStateUpdate.oscillation_reaction_count = justExpiredCooldown ? 1 : reactionCount + 1;
        oscStateUpdate.oscillation_last_mode_used = 'aggressive';
        console.log(`[OSCILLATION_MODE] AGGRESSIVE: ${assignment.asin} CONTINUING despite anomaly. score=${score}, flags=${flags.join(',')}`);
      }
    }
  } else {
    if (assignment.oscillation_state) {
      oscStateUpdate.oscillation_state = null;
      oscStateUpdate.oscillation_detected_at = null;
      oscStateUpdate.oscillation_reaction_count = 0;
      oscStateUpdate.oscillation_cooldown_until = null;
      oscStateUpdate.oscillation_last_reason = null;
      if (currentPrice) {
        oscStateUpdate.last_stable_price = currentPrice;
      }
    }
    oscillationAction = '';
  }

  await supabase.from('repricer_assignments').update({
    anomaly_score: score,
    anomaly_flags: flags.length > 0 ? flags : assignment.anomaly_flags || [],
    anomaly_last_checked_at: new Date().toISOString(),
    recent_prices: recentPrices.slice(-10),
    oscillation_count: flags.includes('OSCILLATION_DETECTED')
      ? (assignment.oscillation_count || 0) + 1
      : assignment.oscillation_count || 0,
    ...oscStateUpdate,
  }).eq('id', assignmentId);

  if (flags.length > 0 || oscillationAction) {
    console.log(`[anomaly] ${assignment.asin}: score=${score}, flags=${flags.join(',')}, evalOnly=${forceEvalOnly}, oscMode=${osc.oscillation_mode}, oscAction=${oscillationAction}`);
  }

  return { score, flags, forceEvalOnly, oscillationAction };
}

export async function trackBbLossAfterRaise(
  supabase: any,
  assignmentId: string,
  wasRaise: boolean,
  lostBb: boolean
): Promise<void> {
  if (wasRaise && lostBb) {
    const { data } = await supabase
      .from('repricer_assignments')
      .select('bb_loss_after_raise_count')
      .eq('id', assignmentId)
      .maybeSingle();
    
    await supabase.from('repricer_assignments').update({
      bb_loss_after_raise_count: (data?.bb_loss_after_raise_count || 0) + 1,
    }).eq('id', assignmentId);
  }
}

export async function incrementClampCount(
  supabase: any,
  assignmentId: string
): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('repricer_assignments')
    .select('clamp_count_today, clamp_count_reset_at')
    .eq('id', assignmentId)
    .maybeSingle();
  
  const count = (data?.clamp_count_reset_at === today) ? (data?.clamp_count_today || 0) + 1 : 1;
  
  await supabase.from('repricer_assignments').update({
    clamp_count_today: count,
    clamp_count_reset_at: today,
  }).eq('id', assignmentId);
}

// ─── 6. POST-APPLY RECONCILIATION HELPERS ────────────────────────────────────

export async function markReconciliation(
  supabase: any,
  actionId: string,
  status: 'matched' | 'mismatch' | 'unverified' | 'pending_timeout' | 'failed',
  verifiedPrice: number | null,
  reason: string | null
): Promise<void> {
  await supabase.from('repricer_price_actions').update({
    reconciliation_status: status,
    verified_live_price: verifiedPrice,
    reconciliation_reason: reason,
    verified_at: new Date().toISOString(),
  }).eq('id', actionId);
}

// ─── CLEANUP HELPERS ─────────────────────────────────────────────────────────

export async function cleanupExpiredHardeningData(supabase: any): Promise<{ locks: number; idempotency: number }> {
  const now = new Date().toISOString();
  
  const { data: locks } = await supabase
    .from('repricer_asin_locks')
    .delete()
    .lt('expires_at', now)
    .select('id');

  const { data: idemp } = await supabase
    .from('repricer_idempotency')
    .delete()
    .lt('expires_at', now)
    .select('id');

  return {
    locks: locks?.length || 0,
    idempotency: idemp?.length || 0,
  };
}
