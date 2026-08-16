/**
 * Shared API token-bucket rate limiter.
 *
 * Backed by `public.api_rate_limits` + `public.consume_api_token(bucket, count)`.
 * Lets multiple edge functions (sync-sales-orders, calculate-roi-range, ...) share
 * a single budget for upstream Amazon endpoints (Fees API, Order Items API)
 * instead of each function independently throttling and producing 429 storms.
 *
 * Usage:
 *   await waitForApiToken(supabase, 'fees_api');
 *   // ... call Amazon Fees API ...
 *
 * ---------------------------------------------------------------------------
 * KNOWN GAP -- 'pricing_api' is NOT the only gate on Amazon's pricing quota.
 * Investigated 2026-08-16; deliberately not yet fixed.
 *
 * `getItemOffers` (GET /products/pricing/v0/items/{asin}/offers) is limited by
 * Amazon to 0.5 req/s burst 1, enforced PER SELLER ACCOUNT and shared across
 * marketplaces. It is currently gated in TWO independent ways that have no
 * awareness of each other:
 *
 *   1. this 'pricing_api' bucket, at 0.5/s GLOBALLY, used by ~10 functions
 *      (check-amazon-price, fetch-listing-prices, calculate-roi,
 *      fetch-product-price, fetch-live-orders, repair-pending-prices,
 *      mobile-scan-price-history, admin-process-asin-batch,
 *      fetch-listing-snapshot, sync-sales-orders)
 *   2. repricer-sp-api-pricing's inline acquireSpApiSlot, on
 *      `sp_api_rate_limit_state` keyed (user_id, operation), also ~0.5/s
 *
 * Run both at once and the account can reach ~1.0 req/s against a 0.5 limit.
 * Same class of bug as the Keepa gate fixed the same night: two limiters, one
 * shared upstream budget, neither aware of the other.
 *
 * Two further notes for whoever fixes this:
 *   * This bucket is GLOBAL, but Amazon's quota is per seller account and
 *     `seller_authorizations` holds a refresh token per user_id. So the bucket
 *     is the wrong SHAPE as well as uncoordinated -- it throttles users
 *     against each other.
 *   * `getCompetitivePricing` is a DIFFERENT operation with its own quota, yet
 *     shares this bucket with getItemOffers. That over-throttles rather than
 *     endangering anything, but a per-operation key fixes it for free.
 *
 * Preferred fix is to coordinate at the TABLE, not the code: have the other
 * callers claim the same `sp_api_rate_limit_state` row the repricer already
 * claims, rather than refactoring a live critical path. That is how the Keepa
 * gate was done -- the repricer kept its inline copy and the shared module
 * claimed the same row.
 * ---------------------------------------------------------------------------
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WaitOptions {
  maxWaitMs?: number;   // total time we are willing to block (default 8s)
  jitterMs?: number;    // extra jitter added to each wait (default up to 250ms)
}

/**
 * Block until a token is available, or give up after maxWaitMs.
 * Returns true if a token was consumed, false if we timed out (caller may
 * still proceed but should expect throttling).
 */
export async function waitForApiToken(
  supabase: any,
  bucket: string,
  opts: WaitOptions = {},
): Promise<boolean> {
  const maxWaitMs = opts.maxWaitMs ?? 8000;
  const jitterMs = opts.jitterMs ?? 250;
  const started = Date.now();

  while (true) {
    try {
      const { data, error } = await supabase.rpc('consume_api_token', {
        p_bucket: bucket,
        p_count: 1,
      });
      if (error) {
        // Don't block callers on infra error.
        console.warn(`[RATE_LIMITER] ${bucket} RPC error, allowing:`, error.message);
        return true;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.allowed) return true;

      const elapsed = Date.now() - started;
      const remaining = maxWaitMs - elapsed;
      if (remaining <= 0) {
        console.warn(`[RATE_LIMITER] ${bucket} timed out waiting for token after ${elapsed}ms`);
        return false;
      }
      const waitMs = Math.min(
        remaining,
        Math.max(50, (row?.wait_ms ?? 250)) + Math.floor(Math.random() * jitterMs),
      );
      await sleep(waitMs);
    } catch (err: any) {
      console.warn(`[RATE_LIMITER] ${bucket} exception, allowing:`, err?.message || err);
      return true;
    }
  }
}

/**
 * Exponential backoff with jitter, capped at maxMs.
 * attempt is 1-indexed.
 */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(500, exp / 2));
  return exp + jitter;
}
