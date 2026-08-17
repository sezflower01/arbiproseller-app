// Read listing-eligibility verdicts for the auto-source filter.
//
// Reads user_approved_products, which check-product-eligibility already
// populates -- the SAME rows that drive the EligibilityBadge in the UI. No
// second store, so the badge a user sees and the filter the worker applies can
// never disagree about a product.
//
// When an ASIN has no verdict, the caller can ask for one to be fetched. That
// costs one listings_api call (5 req/s, ample headroom) and prevents spending
// the far more expensive chain -- a CSE query, up to three Gemini text
// verdicts, three vision compares and a scrape -- on something unsellable.
import type { EligibilityVerdict } from './source-qualification.ts';

const VALID: ReadonlySet<string> = new Set(['approved', 'approval_required', 'restricted']);

/** Cached verdicts for these ASINs, keyed by ASIN. Missing = never checked. */
export async function readEligibility(
  supabase: any,
  userId: string,
  marketplace: string,
  asins: string[],
): Promise<Map<string, EligibilityVerdict>> {
  const out = new Map<string, EligibilityVerdict>();
  if (!asins.length) return out;
  try {
    const { data, error } = await supabase
      .from('user_approved_products')
      .select('asin, approval_status')
      .eq('user_id', userId)
      .eq('marketplace', marketplace)
      .in('asin', asins);
    if (error) {
      console.warn('[eligibility-lookup] read failed:', error.message);
      return out;
    }
    for (const row of data || []) {
      const v = String(row?.approval_status || '').toLowerCase();
      // Anything outside the known set is treated as UNKNOWN rather than
      // guessed at -- an unrecognised value must not silently disqualify.
      if (VALID.has(v)) out.set(row.asin, v as EligibilityVerdict);
    }
  } catch (e) {
    console.warn('[eligibility-lookup] read error:', (e as Error).message);
  }
  return out;
}

/**
 * Ask check-product-eligibility to resolve ASINs with no cached verdict, then
 * return the freshly written rows.
 *
 * Sends BOTH headers deliberately: that function keeps verify_jwt = true
 * because the browser calls it, so the service-role bearer satisfies the
 * platform gateway while x-internal-secret is what its own logic checks.
 * Sending only the secret fails at the gateway with
 * UNAUTHORIZED_NO_AUTH_HEADER, before the function runs at all.
 */
export async function resolveEligibility(
  supabase: any,
  supabaseUrl: string,
  serviceRole: string,
  internalSecret: string,
  userId: string,
  marketplace: string,
  asins: string[],
): Promise<Map<string, EligibilityVerdict>> {
  if (!asins.length) return new Map();
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/check-product-eligibility`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': internalSecret,
        Authorization: `Bearer ${serviceRole}`,
      },
      body: JSON.stringify({ userId, marketplace, asins, force_rescan: false }),
    });
    if (!res.ok) {
      console.warn(`[eligibility-lookup] resolve HTTP ${res.status}`);
      // Fall through to a re-read: a partial run may still have written rows.
    }
  } catch (e) {
    console.warn('[eligibility-lookup] resolve failed:', (e as Error).message);
  }
  // Re-read rather than trusting the response shape -- the table is the thing
  // the UI reads too, so agreeing with it matters more than the payload.
  return readEligibility(supabase, userId, marketplace, asins);
}
