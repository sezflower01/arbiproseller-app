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
