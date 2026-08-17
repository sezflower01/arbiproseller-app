// AUTO-SOURCE-NEW-LISTINGS
// Runs Find Source automatically for newly detected listings, so a detection
// arrives already researched instead of waiting for someone to click.
//
// DELIBERATELY A SEPARATE WORKER, not part of check-seller-watchlist.
// A Find Source call is slow -- one Google CSE query, up to three Gemini text
// verdicts, up to three vision compares, and a price scrape, plausibly 10-30
// seconds for a single listing. The seller sweep runs on a 90-second budget
// inside a 120s cron timeout, so folding search into it would spend that
// budget on Gemini and scraping rather than on Keepa seller checks, stalling
// the rotation exactly when detection is most productive. Same lesson as the
// image backfill: work with a different cost profile gets its own cadence.
//
// It also does NOT share the Keepa budget at all -- CSE, Gemini and the
// scraper are separate quotas -- so this worker cannot slow seller checks
// even indirectly.
//
// THE CAP IS THE POINT. Manual use ran at ~17 searches/month. Automated, the
// rate becomes (watched sellers) x (how often they list), which at ~400
// sellers could be anywhere from a handful to 100+ per day; the queue has only
// completed one rotation, so the real figure is unknown. Google CSE gives 100
// queries/day free and USD 0.005 after (confirmed in the Cloud console), so
// the cap defaults below that line and is claimed ATOMICALLY -- see
// claim_auto_source_budget in migration 20260816140000.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { readEligibility } from '../_shared/eligibility-lookup.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

// Stay inside the cron's 120s timeout with room to finish the search in
// flight. Searches are slow and variable, so this is checked between listings
// rather than assumed.
const RUN_BUDGET_MS = 95_000;

// Most a single run will attempt regardless of remaining daily budget, so one
// invocation cannot monopolise the shared Gemini/CSE quotas in a burst.
const MAX_PER_RUN = 6;

// Newest first: a listing detected minutes ago is the one someone is most
// likely about to look at.
const CANDIDATE_SCAN = 60;

// An unsearched listing older than this has lost its arbitrage window; holding
// it forever only grows a queue nobody will work through. Terminal status
// 'expired' stays distinguishable from a real "no candidates" result.
const EXPIRE_AFTER_DAYS = 5;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const INTERNAL_SECRET = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

  // Cron or service-role only. This spends CSE/Gemini/scrape budget on behalf
  // of users and must never be publicly callable.
  const providedSecret = req.headers.get('x-internal-secret') || '';
  const authHeader = req.headers.get('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const authorized =
    (!!INTERNAL_SECRET && providedSecret === INTERNAL_SECRET) ||
    (!!SERVICE_ROLE && bearer === SERVICE_ROLE);
  if (!authorized) return jsonResponse({ error: 'Unauthorized' }, 401);

  const startedAt = Date.now();
  const deadlineAt = startedAt + RUN_BUDGET_MS;

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Retire listings that were never searched. Runs first and unconditionally:
    // it is a cheap single UPDATE, and if it sat after the search loop an
    // exhausted cap would skip it and the queue would never drain.
    let expired = 0;
    try {
      const { data } = await admin.rpc('expire_stale_new_listings', { p_days: EXPIRE_AFTER_DAYS });
      expired = typeof data === 'number' ? data : 0;
      if (expired) console.log(`[auto-source] expired ${expired} unsearched listing(s) older than ${EXPIRE_AFTER_DAYS}d`);
    } catch (e) {
      console.warn('[auto-source] expiry sweep failed:', (e as Error).message);
    }

    // Listings never searched. 'unsourced' is the only status meaning "no
    // search has run" -- candidates_found / no_candidates / sourced have all
    // been through it, and re-searching them automatically would spend budget
    // re-answering settled questions.
    const { data: pending, error } = await admin
      .from('seller_watch_new_listings')
      .select('id, user_id, asin, marketplace, detected_at')
      .eq('source_status', 'unsourced')
      // Only rows that passed qualification at detection time. The verdict is
      // stamped once by check-seller-watchlist rather than re-derived here, so
      // this stays a cheap indexed read -- and a disqualified row keeps its
      // reason for auditing instead of silently never being picked up.
      .eq('qualified', true)
      .order('detected_at', { ascending: false })
      .limit(CANDIDATE_SCAN);
    if (error) return jsonResponse({ error: error.message }, 500);
    if (!pending?.length) {
      return jsonResponse({ ok: true, pending: 0, searched: 0, expired, elapsedMs: Date.now() - startedAt });
    }

    // Group by user: the cap is per user, and claiming once per user beats one
    // round-trip per listing.
    const byUser = new Map<string, typeof pending>();
    for (const row of pending) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id)!.push(row);
    }

    let searched = 0;
    let capped = 0;
    let failed = 0;
    const perUser: Record<string, { granted: number; ran: number; skippedRestricted?: number }> = {};

    for (const [userId, rows] of byUser) {
      if (Date.now() >= deadlineAt) break;

      const wanted = Math.min(rows.length, MAX_PER_RUN - searched);
      if (wanted <= 0) break;

      const { data: grantedRaw, error: claimErr } = await admin.rpc('claim_auto_source_budget', {
        p_user_id: userId,
        p_wanted: wanted,
      });
      if (claimErr) {
        console.warn('[auto-source] budget claim failed:', claimErr.message);
        continue;
      }
      const granted = typeof grantedRaw === 'number' ? grantedRaw : 0;
      perUser[userId] = { granted, ran: 0 };
      if (granted <= 0) { capped += rows.length; continue; }

      // SAFETY RE-CHECK. Qualification is stamped at detection, when a
      // verdict often does not exist yet -- unknown deliberately qualifies, so
      // a row can be marked searchable and only later be revealed as
      // restricted (typically when the user opens the page and the badge
      // resolves). Re-reading the cache immediately before spending is a cheap
      // table read that stops the one case the detection-time check cannot
      // catch. No API call: cached verdicts only.
      const claimed = rows.slice(0, granted);
      const byMarket = new Map<string, string[]>();
      for (const r of claimed) {
        const m = r.marketplace || 'US';
        if (!byMarket.has(m)) byMarket.set(m, []);
        byMarket.get(m)!.push(r.asin);
      }
      const nowRestricted = new Set<string>();
      for (const [m, asins] of byMarket) {
        const verdicts = await readEligibility(admin, userId, m, asins);
        for (const [asin, v] of verdicts) if (v === 'restricted') nowRestricted.add(asin);
      }
      if (nowRestricted.size) {
        // Record WHY, so a row that vanishes from the queue is explainable
        // rather than mysteriously never searched.
        await admin
          .from('seller_watch_new_listings')
          .update({ qualified: false, disqualified_reason: 'restricted' })
          .eq('user_id', userId)
          .in('asin', Array.from(nowRestricted))
          .eq('source_status', 'unsourced');
        console.log(`[auto-source] skipped ${nowRestricted.size} newly-restricted ASIN(s) before searching`);
      }

      let ran = 0;
      let skippedRestricted = 0;
      for (const row of claimed) {
        if (Date.now() >= deadlineAt) break;
        if (nowRestricted.has(row.asin)) { skippedRestricted++; continue; }
        try {
          // Both headers, deliberately. find-source-candidates keeps
          // verify_jwt = true because it is called from the browser with a
          // user JWT, so the PLATFORM needs a valid Authorization header
          // before the request reaches the function at all -- the service-role
          // bearer satisfies that. The x-internal-secret is what the
          // function's own logic checks to accept `userId` from the body
          // instead of deriving it from a session.
          //
          // Sending only the internal secret fails with the gateway's
          // UNAUTHORIZED_NO_AUTH_HEADER, which is not a response this function
          // ever produces -- the shape of that error is what identified the
          // problem.
          const res = await fetch(`${SUPABASE_URL}/functions/v1/find-source-candidates`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-secret': INTERNAL_SECRET,
              Authorization: `Bearer ${SERVICE_ROLE}`,
            },
            body: JSON.stringify({ listingId: row.id, userId }),
          });
          if (!res.ok) {
            failed++;
            console.warn(`[auto-source] search failed for ${row.asin}: HTTP ${res.status}`);
          } else {
            ran++;
            searched++;
          }
        } catch (e) {
          failed++;
          console.warn(`[auto-source] search error for ${row.asin}:`, (e as Error).message);
        }
      }
      perUser[userId].ran = ran;
      if (skippedRestricted) perUser[userId].skippedRestricted = skippedRestricted;

      // Give back what was claimed but never spent -- a claim that did not
      // become a search would otherwise silently shrink today's allowance.
      if (ran < granted) {
        await admin.rpc('release_auto_source_budget', { p_user_id: userId, p_count: granted - ran });
      }
    }

    return jsonResponse({
      ok: true,
      pending: pending.length,
      expired,
      searched,
      cappedListings: capped,
      failed,
      perUser,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    console.error('[auto-source-new-listings] error', (e as Error).message);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
