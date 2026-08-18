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
   * Plain /seller (no storefront=1) -- 1 token, MEASURED 2026-08-15 on
   * A1B0EBOAJDDILW: tokensConsumed 1, and no storefront ASIN list returned.
   * Do NOT confuse with sellerStorefront above: the flat 10 is the price of
   * storefront=1 specifically. analyzer-product-snapshot's /seller batch
   * carried a comment claiming "a flat 10 tokens per call" until 2026-08-18;
   * it was conflating the two endpoints.
   *
   * Per-seller because the endpoint accepts a comma-separated batch. Billing
   * for N sellers in one call was never measured, so this errs on the side of
   * linear -- over-reserving self-corrects on the next reportKeepaTokensLeft,
   * under-reserving is what produces 429s.
   */
  sellerLookupPerSeller: 1,
  /**
   * /product with offers=N. Offers are billed on top of the per-ASIN cost;
   * the exact multiplier is not published, so this errs high. Over-reserving
   * is corrected within one call by reportKeepaTokensLeft(); under-reserving
   * is what causes 429s.
   */
  productWithOffersPerAsin: 6,
  /**
   * /product with stats+history+offers=20+buybox -- the price-history call
   * shape. MEASURED 2026-08-17 across four ASINs: consistently 5 tokens.
   *
   * offers=100 measured 6 on every one of them while returning an IDENTICAL
   * offer list (84 / 162 / 363 / 400 offers), identical buyBoxSellerIdHistory
   * and identical csv[18]. The parameter is a billing tier, not a result cap,
   * so asking for 100 bought nothing and cost 20% more.
   */
  productPriceHistory: 5,
} as const;

/**
 * Tokens to leave untouched for repricer-sp-api-pricing. Background callers
 * (seller monitoring, source search) pass this so they cannot drain the
 * bucket that live repricing depends on. The repricer itself passes 0.
 */
export const KEEPA_REPRICER_RESERVE = 60;

/**
 * Priority tiers, expressed as reserve floors.
 *
 * claim_keepa_tokens allows a claim when `balance - cost >= minReserve`, so a
 * caller passing a LOWER floor outranks one passing a higher floor: the
 * high-floor caller is refused while tokens remain, and those tokens are still
 * there when the low-floor caller asks. The parameter has existed since
 * migration 20260815210000; until 2026-08-18 no caller passed it, so every
 * caller sat at the same default 60 and "priority" was theoretical.
 *
 * Why this matters right now: gating mobile-scan-price-history on 2026-08-17
 * fixed it taking tokens without asking, but at the default floor it became
 * refusable for the first time -- at equal priority with a background sweep
 * that can happily wait five minutes. That was a regression in the analyzer's
 * effective priority, masked only by the overnight window keeping the sweep
 * out of the way. These tiers repair it.
 *
 *   interactive (0)  -- a person is waiting on this response. Allowed to spend
 *                      the bucket down. Safe in practice because interactive
 *                      traffic is human-paced: the panel costs 5 tokens per
 *                      product view against a 5/min refill, so draining ~300
 *                      tokens would take ~60 views inside a minute. It also
 *                      means the analyzer may dip below KEEPA_REPRICER_RESERVE
 *                      -- accepted deliberately, since repricer-sp-api-pricing
 *                      does not claim tokens at all (its inline gate is
 *                      call-rate only) and made 0 Keepa calls in the 30 days
 *                      to 2026-08-17.
 *   background (120) -- cron sweeps and fan-out jobs. Twice the old floor, so
 *                      they stop early and leave a real cushion rather than
 *                      grinding the balance down to the repricer's line.
 *
 * NOTE: these tiers apply to Layer 2 (tokens) ONLY. Layer 1 (the 4 calls/min
 * claim) is a single last_called_at timestamp with no notion of who is asking,
 * so an interactive caller can still lose a call-rate race to a background one.
 * Deliberately not addressed here -- fixing it means redesigning a primitive
 * the live repricer shares, and there is no measurement yet showing Layer 1
 * contention is what degrades the panel.
 */
export const KEEPA_RESERVE = {
  interactive: 0,
  background: 120,
} as const;

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
 * response carries tokensLeft AND refillRate; pass both right after each
 * call so neither the balance nor the rate can drift from reality.
 *
 * The refill rate matters as much as the balance. It is a property of the
 * account's Keepa billing, not of this codebase -- the Data subscription
 * advertises 1 token/min with higher rates requiring a separate API plan --
 * so it can change with no deploy. Measured 2026-08-15 it is 5/min (refill
 * arrived in lumps of exactly +5, and tokensLeft peaked near 300, which a
 * 1/min plan could not hold since a bucket caps at rate x 60). Reading it
 * from each response means nobody has to be right about the plan.
 */
export async function reportKeepaTokensLeft(
  supabase: any,
  tokensLeft: unknown,
  refillRate?: unknown,
): Promise<void> {
  if (typeof tokensLeft !== 'number' || !Number.isFinite(tokensLeft)) return;
  const rate = typeof refillRate === 'number' && Number.isFinite(refillRate) && refillRate > 0
    ? refillRate
    : null;
  const { error } = await supabase.rpc('observe_keepa_tokens', {
    p_tokens_left: tokensLeft,
    p_refill_rate: rate,
  });
  if (error) console.warn('[Keepa] failed to record observed tokensLeft:', error.message);
}

/**
 * Record that Keepa refused a call with 429, and the balance at that moment.
 *
 * PURELY OBSERVATIONAL -- changes no behaviour, gates nothing. It exists
 * because a real failure ("the analyzer page fails to load most of the time")
 * could not be diagnosed: keepa_daily_usage.keepa_429_count read 0 on every
 * row because only repricer-sp-api-pricing ever incremented it, and
 * keepa_token_budget is service-role-only, so every past failure left no
 * trace at all. Plausible was as far as the analysis could get.
 *
 * Pass tokensLeft when the 429 body carries it -- the balance AT the moment of
 * refusal is the number that turns "the background workers might be starving
 * interactive requests" into a measurement.
 */
export async function recordKeepa429(
  supabase: any,
  tokensLeft?: unknown,
  caller?: string,
): Promise<void> {
  const usageDate = new Date().toISOString().split('T')[0];
  try {
    const { data: row } = await supabase
      .from('keepa_daily_usage')
      .select('keepa_429_count')
      .eq('usage_date', usageDate)
      .maybeSingle();

    await supabase
      .from('keepa_daily_usage')
      .upsert(
        { usage_date: usageDate, keepa_429_count: (row?.keepa_429_count ?? 0) + 1 },
        { onConflict: 'usage_date' },
      );

    // Logged as well as counted: the counter shows how often, the log line
    // shows when and with what balance, which is what a correlation needs.
    console.warn(
      `[Keepa] 429 refused${caller ? ` for ${caller}` : ''}` +
      `${typeof tokensLeft === 'number' ? ` (tokensLeft=${tokensLeft})` : ''} at ${new Date().toISOString()}`,
    );
  } catch (e) {
    console.warn('[Keepa] failed to record 429:', (e as Error).message);
  }

  if (typeof tokensLeft === 'number') await reportKeepaTokensLeft(supabase, tokensLeft);
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
