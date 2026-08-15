// Cross-function Keepa rate gate. Coordinates via the keepa_daily_usage
// table's last_called_at claim -- the SAME table and claim pattern as
// repricer-sp-api-pricing's inline acquireKeepaGlobalSlot, so a new Keepa
// caller (e.g. check-seller-watchlist) shares awareness of the account's
// single 5-tokens/min plan instead of burning through it independently.
// Deliberately a standalone copy rather than importing repricer's inline
// version -- that function is live/critical and this avoids touching it.
//
// TWO LAYERS, and both are needed:
//
//   1. CALL rate  -- KEEPA_GUARD_LIMIT calls/min, the original guard. Stops
//                    any single caller from hammering the API.
//   2. TOKEN cost -- the real constraint. Added 2026-08-15 after measuring
//                    actual costs with keepa-token-probe:
//                      /seller?storefront=1 = flat 10 tokens (catalog size
//                                             is irrelevant: 238, 92 and
//                                             38-ASIN storefronts all cost 10)
//                      /product             = 1 token PER ASIN
//                      /product with offers = more still
//
// The call gate alone permits 4 x 10 = 40 tokens/min against a 5/min refill
// -- an 8x overdraw, and up to 40x for a 50-ASIN product batch, draining the
// ~300-token bucket in about 90 seconds. It looked like protection and was
// not. repricer-sp-api-pricing shares this account, so an unmetered burst
// starves live repricing with no error surfaced (exactly the incident in
// seller-storefront-snapshot/index.ts's header comment).
//
// Token accounting lives in public.keepa_token_budget via claim_keepa_tokens
// (see migration 20260815210000). Estimates only need to be roughly right:
// reportKeepaTokensLeft() overwrites them with the tokensLeft value Keepa
// returns on every response, so drift self-corrects on the next call.
const KEEPA_GUARD_LIMIT = 4; // plan: 5 tokens/min; guard at 4 to avoid 429 spikes
const KEEPA_GUARD_INTERVAL_MS = Math.ceil(60_000 / KEEPA_GUARD_LIMIT);

// Measured 2026-08-15. Used as pre-call reservations.
export const KEEPA_COST = {
  /** /seller?storefront=1 -- flat, independent of storefront size. */
  sellerStorefront: 10,
  /** /product -- 1 token per ASIN. */
  productPerAsin: 1,
  /**
   * /product with offers=N. Offers are billed on top of the per-ASIN cost;
   * the exact multiplier is not published, so this errs high. Over-reserving
   * is corrected within one call by reportKeepaTokensLeft(); under-reserving
   * is what causes 429s.
   */
  productWithOffersPerAsin: 6,
} as const;

/**
 * Tokens to leave untouched for repricer-sp-api-pricing. Background callers
 * (seller monitoring, source search) pass this so they cannot drain the
 * bucket that live repricing depends on. The repricer itself passes 0.
 */
export const KEEPA_REPRICER_RESERVE = 60;

export interface KeepaSlotOptions {
  /** Estimated token cost of the call about to be made. Default: 1 seller call. */
  estimatedTokens?: number;
  /** Floor to leave for higher-priority callers. Default: KEEPA_REPRICER_RESERVE. */
  minReserve?: number;
}

export interface KeepaSlotResult {
  ok: boolean;
  waitSeconds: number;
  /** Which layer refused, when ok is false -- useful for log triage. */
  blockedBy?: 'call-rate' | 'token-budget';
  /** Projected balance after a successful claim. */
  tokensLeft?: number;
}

/**
 * Claim permission to make ONE Keepa call.
 *
 * Callers MUST pass an estimatedTokens matching the request they are about
 * to make; the default assumes a single seller call and will badly
 * under-reserve a large /product batch.
 */
export async function acquireKeepaGlobalSlot(
  supabase: any,
  options: KeepaSlotOptions = {},
): Promise<KeepaSlotResult> {
  const estimatedTokens = options.estimatedTokens ?? KEEPA_COST.sellerStorefront;
  const minReserve = options.minReserve ?? KEEPA_REPRICER_RESERVE;

  // Layer 1 -- call rate. Unchanged from the original guard, and checked
  // first so a hammering caller is refused before touching the budget row.
  const callSlot = await acquireCallRateSlot(supabase);
  if (!callSlot.ok) {
    return { ok: false, waitSeconds: callSlot.waitSeconds, blockedBy: 'call-rate' };
  }

  // Layer 2 -- token budget.
  const { data, error } = await supabase.rpc('claim_keepa_tokens', {
    p_tokens: estimatedTokens,
    p_min_reserve: minReserve,
  });

  if (error) {
    // Fail OPEN on an accounting outage. The call gate above still applies,
    // so this degrades to the old (weaker) behaviour rather than halting all
    // Keepa traffic because one table is unreachable.
    console.warn('[Keepa] token budget check unavailable, falling back to call-rate only:', error.message);
    return { ok: true, waitSeconds: 0 };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.allowed) {
    return {
      ok: false,
      waitSeconds: row?.wait_seconds ?? Math.ceil(KEEPA_GUARD_INTERVAL_MS / 1000),
      blockedBy: 'token-budget',
      tokensLeft: row?.tokens_left,
    };
  }

  return { ok: true, waitSeconds: 0, tokensLeft: row.tokens_left };
}

/**
 * Reconcile the local budget with Keepa's own accounting. Every Keepa
 * response carries tokensLeft; pass it here right after each call so
 * estimate error cannot accumulate.
 */
export async function reportKeepaTokensLeft(supabase: any, tokensLeft: unknown): Promise<void> {
  if (typeof tokensLeft !== 'number' || !Number.isFinite(tokensLeft)) return;
  const { error } = await supabase.rpc('observe_keepa_tokens', { p_tokens_left: tokensLeft });
  if (error) console.warn('[Keepa] failed to record observed tokensLeft:', error.message);
}

// --- Layer 1 implementation (original call-rate claim, unchanged) ---------
async function acquireCallRateSlot(supabase: any): Promise<{ ok: boolean; waitSeconds: number }> {
  const usageDate = new Date().toISOString().split('T')[0];
  const now = new Date();
  const nowIso = now.toISOString();
  const guardThresholdIso = new Date(now.getTime() - KEEPA_GUARD_INTERVAL_MS).toISOString();

  const tryClaimExisting = async () => {
    const claimOld = await supabase
      .from('keepa_daily_usage')
      .update({ last_called_at: nowIso })
      .eq('usage_date', usageDate)
      .lt('last_called_at', guardThresholdIso)
      .select('usage_date')
      .maybeSingle();

    if (claimOld.data) return true;

    const claimNull = await supabase
      .from('keepa_daily_usage')
      .update({ last_called_at: nowIso })
      .eq('usage_date', usageDate)
      .is('last_called_at', null)
      .select('usage_date')
      .maybeSingle();

    return !!claimNull.data;
  };

  const insertAttempt = await supabase
    .from('keepa_daily_usage')
    .insert({ usage_date: usageDate, call_count: 0, last_called_at: nowIso })
    .select('usage_date')
    .maybeSingle();

  if (insertAttempt.data) {
    return { ok: true, waitSeconds: 0 };
  }

  if (insertAttempt.error && insertAttempt.error.code !== '23505') {
    console.warn('[Keepa] Failed to initialize usage row for guard:', insertAttempt.error);
    return { ok: false, waitSeconds: Math.ceil(KEEPA_GUARD_INTERVAL_MS / 1000) };
  }

  const claimed = await tryClaimExisting();
  if (claimed) {
    return { ok: true, waitSeconds: 0 };
  }

  const { data: latest } = await supabase
    .from('keepa_daily_usage')
    .select('last_called_at')
    .eq('usage_date', usageDate)
    .maybeSingle();

  const elapsedMs = latest?.last_called_at ? now.getTime() - new Date(latest.last_called_at).getTime() : 0;
  const waitMs = Math.max(1_000, KEEPA_GUARD_INTERVAL_MS - Math.max(0, elapsedMs));

  return { ok: false, waitSeconds: Math.ceil(waitMs / 1000) };
}
