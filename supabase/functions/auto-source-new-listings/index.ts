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
import { withCronLock } from '../_shared/cron-lock.ts';
import { evaluateStrictMode, STRICT_DEFAULTS } from '../_shared/strict-mode.ts';

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

// Do not START a search unless there is time to FINISH it.
//
// Checking `now >= deadline` alone only proves the budget has not run out yet,
// not that the next search fits: a search beginning at 94s of a 95s budget
// still runs its full length and blows through the cron's 120s wall, killing
// the function mid-flight and stranding the listing in source_status
// 'sourcing' with nothing to move it on.
//
// Measured 2026-08-17 on a live run: 58.6s for a three-candidate search
// (one candidate hit a Firecrawl phase2_timeout, which is the slow path).
// Pricing all three candidates instead of only the top one made searches
// materially longer, so the reserve is sized from that observed worst case.
// The practical effect is one search per invocation; at a run every 10
// minutes that is still ~144 opportunities a day against an 80/day cap, so
// the cap keeps binding and throughput is unchanged.
const SEARCH_RESERVE_MS = 70_000;

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

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Wrapped so every run leaves a record in cron_run_history.
  //
  // Auditing today's cap consumption was impossible: search_count said 80, but
  // last_searched_at lives on the listing rows and those had been deleted, so
  // "was that 80 real searches" had no answer at all. Per-run granted/ran/failed
  // is now persisted independently of the listings, so the same question is
  // answerable tomorrow even if every row is cleared.
  //
  // The lock matters on its own too: runs are every 10 minutes but a single run
  // can take ~60s per search, and two overlapping runs would each claim budget
  // against the same daily cap.
  let outcome: Record<string, unknown> = {};
  const lock = await withCronLock(admin, 'auto-source-new-listings', 300, async () => {

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
      .select('id, user_id, asin, marketplace, detected_at, sales_rank, fba_offer_count, seller_offer_is_fba, new_price_cents, amazon_price_cents')
      .eq('source_status', 'unsourced')
      // Rows already withheld by strict mode keep source_status 'unsourced' --
      // honestly, since no search ran -- but must not be re-evaluated on every
      // pass. The partial index idx_swnl_source_status_strict covers this.
      .is('strict_reason', null)
      // Only rows that passed qualification at detection time. The verdict is
      // stamped once by check-seller-watchlist rather than re-derived here, so
      // this stays a cheap indexed read -- and a disqualified row keeps its
      // reason for auditing instead of silently never being picked up.
      .eq('qualified', true)
      .order('detected_at', { ascending: false })
      .limit(CANDIDATE_SCAN);
    if (error) throw new Error(error.message);
    if (!pending?.length) {
      outcome = { ok: true, pending: 0, searched: 0, expired, elapsedMs: Date.now() - startedAt };
      return { items_processed: 0, detail: { expired, pending: 0 } };
    }

    // Group by user: the cap is per user, and claiming once per user beats one
    // round-trip per listing.
    const byUser = new Map<string, typeof pending>();
    for (const row of pending) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id)!.push(row);
    }

    // ── STRICT MODE: withhold search budget from commercially weak listings ──
    //
    // Applied HERE, before claim_auto_source_budget, because the scarce thing
    // is the 80/day search cap -- it read 80/80 consumed on 2026-08-17. A row
    // rejected here is still a real, qualified detection with its price and
    // fees; it simply does not buy a search. Filtering after the claim would
    // spend the budget and then throw the result away.
    const { data: strictCfgs } = await admin
      .from('auto_source_config')
      .select('user_id, strict_mode, strict_min_fba_offers, strict_min_monthly_sales, strict_require_rank, strict_require_seller_fba, strict_min_price_cents')
      .in('user_id', [...byUser.keys()]);
    const strictByUser = new Map<string, any>();
    for (const c of strictCfgs || []) strictByUser.set(c.user_id, c);

    const strictHeld: Record<string, number> = {};
    for (const [userId, rows] of byUser) {
      const cfg = strictByUser.get(userId);
      if (!cfg?.strict_mode) continue; // OFF by default; absent row means off.

      const thresholds = {
        minFbaOffers: cfg.strict_min_fba_offers ?? STRICT_DEFAULTS.minFbaOffers,
        minMonthlySales: cfg.strict_min_monthly_sales ?? STRICT_DEFAULTS.minMonthlySales,
        requireRank: cfg.strict_require_rank ?? STRICT_DEFAULTS.requireRank,
        requireSellerFba: cfg.strict_require_seller_fba ?? STRICT_DEFAULTS.requireSellerFba,
        minPriceCents: cfg.strict_min_price_cents ?? STRICT_DEFAULTS.minPriceCents,
      };

      const keep: typeof rows = [];
      const rejects: Array<{ id: string; reason: string }> = [];
      for (const r of rows) {
        const v = evaluateStrictMode({
          salesRank: (r as any).sales_rank,
          fbaOfferCount: (r as any).fba_offer_count,
          sellerOfferIsFba: (r as any).seller_offer_is_fba,
          // Lowest New first, Amazon's own price as backup -- the same
          // precedence the ROI calculation uses, so the filter and the ROI
          // shown in the UI cannot disagree about what the item sells for.
          priceCents: (r as any).new_price_cents ?? (r as any).amazon_price_cents,
        }, thresholds);
        if (v.pass) keep.push(r);
        else rejects.push({ id: r.id, reason: v.reason! });
      }

      // Stamp the reason so a shrinking queue is diagnosable rather than
      // mysterious, and so these rows are skipped by the select above next run.
      // Grouped by reason to keep this to a handful of updates, not one per row.
      if (rejects.length) {
        const byReason = new Map<string, string[]>();
        for (const rj of rejects) {
          if (!byReason.has(rj.reason)) byReason.set(rj.reason, []);
          byReason.get(rj.reason)!.push(rj.id);
        }
        for (const [reason, ids] of byReason) {
          const { error: upErr } = await admin
            .from('seller_watch_new_listings')
            .update({ strict_reason: reason })
            .in('id', ids);
          if (upErr) console.warn('[auto-source] strict stamp failed:', upErr.message);
        }
        strictHeld[userId] = rejects.length;
        console.log(`[auto-source] strict mode held ${rejects.length}/${rows.length} for ${userId}: ` +
          [...byReason.entries()].map(([k, v]) => `${k}=${v.length}`).join(' '));
      }

      byUser.set(userId, keep);
    }
    for (const [u, rows] of [...byUser]) if (!rows.length) byUser.delete(u);

    let searched = 0;
    let capped = 0;
    let failed = 0;
    // Counted separately from `failed` so a total search outage is one obvious
    // number in cron_run_history rather than something to infer from a pile of
    // per-row warnings. This is the signal that was missing when Google CSE
    // returned 403 on every call for days.
    let searchBackendDown = 0;
    // Dedup accounting, reported in cron_run_history. dedupSaved is searches
    // NOT bought; dedupFannedOut is listings that got an answer without one.
    // Both are logged because "the queue drained faster than the budget" should
    // be explainable rather than surprising.
    let dedupSaved = 0;
    let dedupFannedOut = 0;
    const perUser: Record<string, { granted: number; ran: number; skippedRestricted?: number }> = {};

    for (const [userId, rows] of byUser) {
      if (Date.now() >= deadlineAt) break;

      // Claim only what there is TIME to run, not just what the cap allows.
      // claim_auto_source_budget decrements the daily counter at claim time, so
      // granting 6 and then running 1 before the deadline would silently spend
      // five searches that never happened -- exhausting an 80/day cap in about
      // fourteen runs while performing fourteen searches.
      // ── ASIN DEDUPLICATION ──
      //
      // seller_watch_new_listings is unique on (watch_id, asin), so N watched
      // sellers listing the SAME product produce N rows. Before 2026-08-19 the
      // picker iterated rows, and find-source-candidates has no cache, so each
      // of those rows issued its own CSE/SerpAPI queries -- same UPC, same
      // title, same results. N-1 of every N were pure waste: not lower-value
      // searches, ZERO information gain.
      //
      // Grouped by asin+marketplace because candidates are marketplace
      // specific -- the same ASIN in US and MX is genuinely two searches.
      //
      // This is the only volume filter here that loses nothing. Every listing
      // still gets its candidates; they are copied from the one search instead
      // of being bought again.
      const groups = new Map<string, typeof rows>();
      for (const r of rows) {
        const k = `${r.asin}|${r.marketplace || 'US'}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }
      const groupList = [...groups.values()];
      const dupSaved = rows.length - groupList.length;
      if (dupSaved > 0) {
        console.log(`[auto-source] dedup: ${rows.length} listings -> ${groupList.length} searches (${dupSaved} redundant avoided)`);
        dedupSaved += dupSaved;
      }

      // Budget is claimed per SEARCH, not per listing -- claiming per row would
      // spend the daily cap on work that is never performed.
      const timeCapacity = Math.max(0, Math.floor((deadlineAt - Date.now()) / SEARCH_RESERVE_MS));
      const wanted = Math.min(groupList.length, MAX_PER_RUN - searched, timeCapacity);
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

      // `granted` counts SEARCHES. claimedGroups are the groups we may search;
      // every row inside them still gets an answer via the fan-out below.
      const claimedGroups = groupList.slice(0, granted);

      // SAFETY RE-CHECK. Qualification is stamped at detection, when a
      // verdict often does not exist yet -- unknown deliberately qualifies, so
      // a row can be marked searchable and only later be revealed as
      // restricted (typically when the user opens the page and the badge
      // resolves). Re-reading the cache immediately before spending is a cheap
      // table read that stops the one case the detection-time check cannot
      // catch. No API call: cached verdicts only.
      // One representative per group -- the row we actually search.
      const claimed = claimedGroups.map((g) => g[0]);
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
        if (Date.now() + SEARCH_RESERVE_MS > deadlineAt) break;
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
            // 503 is find-source-candidates reporting that EVERY search backend
            // refused -- an outage, not a per-listing miss. It deliberately
            // leaves source_status alone so the row retries, and `ran` staying
            // put means release_auto_source_budget below refunds the claim.
            // Logged at error level because one of these means every search in
            // the system is failing, which is not a per-row problem.
            if (res.status === 503) {
              searchBackendDown++;
              console.error(`[auto-source] ❌ SEARCH BACKENDS DOWN — ${row.asin} left unsourced for retry, budget refunded`);
            } else {
              console.warn(`[auto-source] search failed for ${row.asin}: HTTP ${res.status}`);
            }
          } else {
            ran++;
            searched++;

            // ── FAN-OUT ──
            // The search wrote its result to `row`. Every sibling watching the
            // same ASIN in the same marketplace gets the identical answer, so
            // copy it rather than buying it again. find-source-candidates
            // returns the candidates in its response body, so no re-read.
            const siblings = (groups.get(`${row.asin}|${row.marketplace || 'US'}`) ?? [])
              .filter((s) => s.id !== row.id);
            if (siblings.length) {
              try {
                const body = await res.json().catch(() => null) as
                  | { status?: string; candidates?: unknown }
                  | null;
                // Only mirror a real verdict. If the shape is unexpected the
                // siblings stay 'unsourced' and are retried -- never guess a
                // status, since 'no_candidates' is terminal.
                if (body?.status === 'candidates_found' || body?.status === 'no_candidates') {
                  const { error: fanErr } = await admin
                    .from('seller_watch_new_listings')
                    .update({ source_status: body.status, candidates: body.candidates ?? [] })
                    .in('id', siblings.map((s) => s.id))
                    // Guard against clobbering a row that changed underneath us
                    // between the pick and now.
                    .eq('source_status', 'unsourced');
                  if (fanErr) {
                    console.warn(`[auto-source] fan-out failed for ${row.asin}: ${fanErr.message}`);
                  } else {
                    dedupFannedOut += siblings.length;
                  }
                }
              } catch (e) {
                console.warn(`[auto-source] fan-out error for ${row.asin}:`, (e as Error).message);
              }
            }
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

    outcome = {
      ok: true,
      pending: pending.length,
      expired,
      searched,
      cappedListings: capped,
      failed,
      perUser,
      elapsedMs: Date.now() - startedAt,
    };
    if (searchBackendDown) {
      console.error(`[auto-source] ❌ ${searchBackendDown}/${pending.length} listings could not be searched — SEARCH BACKENDS ARE DOWN. All budget refunded, all rows left for retry.`);
    }
    // granted vs ran per user is the pair that makes the daily count auditable:
    // a gap between them is budget claimed and not spent. searchBackendDown is
    // the third number that matters: nonzero means the searches did not fail to
    // find things, they failed to happen.
    return {
      items_processed: searched,
      detail: { pending: pending.length, expired, searched, capped, failed, searchBackendDown, dedupSaved, dedupFannedOut, perUser },
    };
  });

  if (lock.skipped) {
    return jsonResponse({ ok: true, skipped_locked: true, reason: 'a previous run is still in flight' });
  }
  if (lock.status === 'failed') {
    console.error('[auto-source-new-listings] error', lock.error);
    return jsonResponse({ error: lock.error || 'run failed' }, 500);
  }
  return jsonResponse(outcome);
});
