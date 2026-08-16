// CHECK-SELLER-WATCHLIST
// Resumable, fair-rotation worker (see migrations 20260815133728 and
// 20260815220000). Runs every 5 minutes, spends whatever Keepa budget is
// available on the STALEST watches, and stops cleanly when the budget or the
// clock runs out. The next run resumes from wherever this one stopped.
//
// WHY THIS SHAPE -- the previous version had three defects that combined
// into silent, permanent starvation rather than mere slowness:
//
//   1. `.limit(500)` was GLOBAL across all users, so with more than 500
//      active watches the overflow was never read from the database at all.
//   2. No ORDER BY, so the arbitrary rows Postgres returned first won the
//      rate-limit slot on EVERY run. last_checked_at was written but never
//      read, so nothing preferred a seller that hadn't been checked.
//   3. On a busy gate it did `continue`, and the skip count lived only in
//      the response JSON. The next run started from the same arbitrary order
//      with zero memory of who had been passed over.
//
// Net effect: the same handful of sellers were checked forever while the
// rest never were, and the UI showed all of them as "Watching". Users could
// not tell the difference between "checked and nothing new" and "never
// checked at all".
//
// The fix is ordering, not throughput. `last_checked_at ASC NULLS FIRST`
// makes the queue self-balancing: whoever waited longest goes next, and
// NULLS FIRST puts brand-new unseeded watches at the head so they finish
// seeding promptly. Once ordering is fair, stopping early is CORRECT rather
// than lossy -- an unprocessed seller is simply the stalest one next time.
// That is why this breaks out of the loop instead of skipping onward.
//
// Cost model (measured 2026-08-15, see _shared/keepa-rate-gate.ts):
// /seller?storefront=1 is a flat 10 tokens regardless of catalog size, and
// the plan refills 5 tokens/min, so a full check costs about two minutes of
// budget. At a 50% share that is roughly 350 checks/day across ALL watched
// sellers -- about a 3-day rotation at 1000 sellers. The seller-list diff
// deliberately never calls /product; only genuinely-new ASINs (typically
// 0-5) get a bounded detail batch, so cost scales with new-listing volume
// rather than catalog size.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { acquireKeepaGlobalSlot, reportKeepaTokensLeft, KEEPA_COST } from '../_shared/keepa-rate-gate.ts';
import { lookupAsinDetails } from '../_shared/asin-catalog-lookup.ts';
import { getCatalogAccessToken, fetchCatalogItemDetails } from '../_shared/spapi-catalog-image.ts';

// Bound on SP-API catalog lookups per run. These cost no Keepa tokens, but
// they do cost wall-clock inside the run budget, and a run only processes a
// couple of sellers anyway.
const MAX_SPAPI_IMAGE_LOOKUPS = 12;

const MAX_PRODUCT_DETAIL_ASINS = 50;

// Stalest N watches considered per run. Only a couple will actually be
// processed on a 5-tokens/min plan; the surplus is headroom so a run with
// spare budget (or a future larger plan) can keep going without a redeploy.
const CANDIDATE_BATCH = 60;

// Leave room inside the cron's 120s timeout to finish the current seller and
// write its state, rather than being killed mid-update.
const RUN_BUDGET_MS = 90_000;

// How long to wait for a token slot before ending the run. A 10-token call
// needs ~2 minutes of refill, which is longer than a run should idle -- past
// this, stopping and letting the next run pick up is cheaper than blocking.
const MAX_SLOT_WAIT_SECONDS = 25;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const KEEPA_DOMAIN: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

const NEW_ASINS_IN_EMAIL = 10;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Claim a token slot, waiting briefly if the wait is short enough to be worth
 * it and there is time left in the run. Returns the final (possibly failed)
 * claim; callers end the run rather than skipping onward, so that a refused
 * seller stays at the head of the queue for next time.
 */
async function acquireSlotOrGiveUp(admin: any, estimatedTokens: number, deadlineAt: number) {
  const first = await acquireKeepaGlobalSlot(admin, { estimatedTokens });
  if (first.ok) return first;

  const waitSeconds = Math.min(first.waitSeconds ?? MAX_SLOT_WAIT_SECONDS, MAX_SLOT_WAIT_SECONDS);
  if (Date.now() + waitSeconds * 1000 >= deadlineAt) return first;

  await sleep(waitSeconds * 1000);
  return acquireKeepaGlobalSlot(admin, { estimatedTokens });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // Same auth gate as check-price-alerts: internal secret (cron) or
  // service-role bearer (manual/internal trigger). Never open to the public
  // -- this reads every user's active watches and spends Keepa tokens.
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const providedSecret = req.headers.get('x-internal-secret') || '';
  const authHeader = req.headers.get('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const okSecret = !!internalSecret && providedSecret === internalSecret;
  const okServiceBearer = !!serviceRoleKey && bearer === serviceRoleKey;
  if (!okSecret && !okServiceBearer) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + RUN_BUDGET_MS;

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY')?.trim();
    if (!KEEPA_KEY) return jsonResponse({ error: 'KEEPA_API_KEY not configured' }, 500);
    const admin = createClient(SUPABASE_URL, serviceRoleKey);

    // Plan mode: report the queue order WITHOUT calling Keepa or mutating
    // anything. This is how fair rotation is verified against real data --
    // run it, run the worker, run it again, and watch the just-checked seller
    // move to the back.
    //
    // Accepted BOTH as ?plan=true and as {"plan":true}. The query parameter
    // exists because PowerShell strips inner quotes when passing a JSON body
    // to native curl, so a bash-shaped `-d '{"plan":true}'` silently arrives
    // as invalid JSON. A query string has no such hazard.
    //
    // An unparseable body is now a 400 rather than an empty object. It
    // previously fell back to `{}`, which meant a mangled --data turned a
    // read-only request into a live run that spent real Keepa tokens -- the
    // exact opposite of what the caller asked for. Cron sends well-formed
    // JSON, and a bodyless POST is still fine, so failing closed here costs
    // nothing and removes a foot-gun.
    const rawBody = await req.text().catch(() => '');
    let body: Record<string, unknown> = {};
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return jsonResponse({
          error: 'Request body was not valid JSON. Nothing was run and no Keepa tokens were spent. On PowerShell, prefer the query form: ?plan=true',
          receivedBody: rawBody.slice(0, 200),
        }, 400);
      }
    }

    const planParam = new URL(req.url).searchParams.get('plan');
    const planOnly = body?.plan === true || planParam === 'true' || planParam === '1';

    // --- Step 1: the stalest watches, oldest first, unseeded ahead of all ---
    // No global cap. The bound is "what one run can plausibly process",
    // applied in staleness order, rather than an arbitrary slice of the table.
    const { data: candidates, error } = await admin
      .from('seller_watchlist')
      .select('id, seller_id, marketplace, last_checked_at')
      .eq('status', 'active')
      .order('last_checked_at', { ascending: true, nullsFirst: true })
      .limit(CANDIDATE_BATCH);
    if (error) return jsonResponse({ error: error.message }, 500);

    const { count: totalActive } = await admin
      .from('seller_watchlist')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');

    if (!candidates?.length) {
      return jsonResponse({ ok: true, checked: 0, alertsFired: 0, distinctSellers: 0, totalActive: totalActive ?? 0 });
    }

    // Distinct seller+marketplace pairs, preserving staleness order.
    const orderedPairs: { sellerId: string; marketplace: string; stalest: string | null }[] = [];
    const seenPair = new Set<string>();
    for (const c of candidates) {
      const key = `${c.seller_id}|${c.marketplace}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      orderedPairs.push({ sellerId: c.seller_id, marketplace: c.marketplace, stalest: c.last_checked_at });
    }

    if (planOnly) {
      return jsonResponse({
        ok: true,
        planOnly: true,
        totalActive: totalActive ?? 0,
        queue: orderedPairs.map((p, i) => ({
          position: i + 1,
          sellerId: p.sellerId,
          marketplace: p.marketplace,
          lastCheckedAt: p.stalest,
          seeded: p.stalest !== null,
        })),
        note: 'Order is last_checked_at ASC NULLS FIRST. Unseeded watches (null) sort first, then longest-waiting. Nothing was called or modified.',
      });
    }

    // --- Step 2: all watchers of those sellers, so one Keepa call still
    // serves everyone watching the same storefront (the original cost-sharing
    // property). Fetched by the pair components then filtered exactly, since
    // PostgREST cannot express a composite IN cleanly.
    const { data: allWatches, error: fetchErr } = await admin
      .from('seller_watchlist')
      .select('id, user_id, seller_id, seller_name, marketplace, notify_email, known_asin_list')
      .eq('status', 'active')
      .in('seller_id', orderedPairs.map((p) => p.sellerId))
      .in('marketplace', Array.from(new Set(orderedPairs.map((p) => p.marketplace))));
    if (fetchErr) return jsonResponse({ error: fetchErr.message }, 500);

    const groups = new Map<string, typeof allWatches>();
    for (const w of allWatches || []) {
      const key = `${w.seller_id}|${w.marketplace}`;
      if (!seenPair.has(key)) continue; // over-fetch from the cross-product
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(w);
    }

    let checked = 0;
    let alertsFired = 0;
    let processedSellers = 0;
    let stoppedReason: string | null = null;
    const nowIso = new Date().toISOString();

    for (const pair of orderedPairs) {
      const key = `${pair.sellerId}|${pair.marketplace}`;
      const group = groups.get(key);
      if (!group?.length) continue;

      if (Date.now() >= deadlineAt) { stoppedReason = 'run-time-budget'; break; }

      const { sellerId, marketplace } = pair;

      const slot = await acquireSlotOrGiveUp(admin, KEEPA_COST.sellerStorefront, deadlineAt);
      if (!slot.ok) {
        // Deliberately BREAK, not continue. With fair ordering this seller is
        // simply the stalest next run; grinding through the rest would spend
        // the remaining budget on fresher sellers and re-starve this one.
        stoppedReason = `keepa-${slot.blockedBy ?? 'budget'}`;
        break;
      }

      const domainId = KEEPA_DOMAIN[marketplace] ?? 1;
      let currentAsins: string[] | null = null;
      let currentSellerName: string | null = null;
      try {
        const url = `https://api.keepa.com/seller?key=${KEEPA_KEY}&domain=${domainId}&seller=${encodeURIComponent(sellerId)}&storefront=1`;
        const res = await fetch(url);
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          await reportKeepaTokensLeft(admin, json?.tokensLeft, json?.refillRate);
          const seller = json?.sellers?.[sellerId];
          if (seller) {
            currentAsins = Array.isArray(seller.asinList) ? seller.asinList : [];
            currentSellerName = seller.sellerName || null;
          } else {
            console.warn(`[check-seller-watchlist] seller not found in Keepa response: ${sellerId}`);
          }
        } else {
          console.warn(`[check-seller-watchlist] Keepa HTTP ${res.status} for ${sellerId}`);
        }
      } catch (e) {
        console.warn(`[check-seller-watchlist] Keepa fetch failed for ${sellerId}`, (e as Error).message);
      }

      // Fetch failed entirely -- leave these watches untouched so they keep
      // their place at the head of the queue and retry next run, rather than
      // silently losing their baseline.
      if (currentAsins === null) continue;

      processedSellers++;

      // Pass 1: compute each watch's own newAsins (their known_asin_list may
      // differ if they subscribed at different times) and accumulate the union
      // so product details are fetched once per ASIN, not once per watch.
      const perWatchNew = new Map<string, string[]>();
      const unionNewAsins = new Set<string>();
      for (const w of group) {
        const priorList = w.known_asin_list as string[] | null;
        if (priorList === null || priorList === undefined) continue; // first check -- seeds below, no diff
        const priorSet = new Set(priorList);
        const newAsins = currentAsins.filter((a) => !priorSet.has(a));
        if (newAsins.length > 0) {
          perWatchNew.set(w.id, newAsins);
          for (const a of newAsins) unionNewAsins.add(a);
        }
      }

      // One bounded batch call for whatever's genuinely new across the whole
      // group -- title/brand/image/upc, needed for the new-listings feed and
      // Find Source's search query. /product bills 1 token PER ASIN, so this
      // reserves for the real batch size rather than "one call".
      const productDetails = new Map<string, { title: string | null; brand: string | null; image: string | null; upc: string | null }>();
      if (unionNewAsins.size > 0) {
        const asinsToFetch = Array.from(unionNewAsins).slice(0, MAX_PRODUCT_DETAIL_ASINS);
        const detailSlot = await acquireSlotOrGiveUp(
          admin,
          asinsToFetch.length * KEEPA_COST.productPerAsin,
          deadlineAt,
        );
        if (detailSlot.ok) {
          try {
            const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domainId}&asin=${asinsToFetch.join(',')}`;
            const res = await fetch(url);
            if (res.ok) {
              const json = await res.json().catch(() => ({}));
              await reportKeepaTokensLeft(admin, json?.tokensLeft, json?.refillRate);
              const products = Array.isArray(json?.products) ? json.products : [];
              for (const p of products) {
                if (!p?.asin) continue;
                const image = p?.imagesCSV ? `https://images-na.ssl-images-amazon.com/images/I/${String(p.imagesCSV).split(',')[0]}` : null;
                const upc = Array.isArray(p?.upcList) && p.upcList.length ? String(p.upcList[0]) : null;
                productDetails.set(p.asin, {
                  title: p?.title || null,
                  brand: p?.brand || p?.manufacturer || null,
                  image,
                  upc,
                });
              }
            } else {
              console.warn(`[check-seller-watchlist] Keepa /product HTTP ${res.status} for new-asin batch`);
            }
          } catch (e) {
            console.warn(`[check-seller-watchlist] Keepa /product fetch failed for new-asin batch`, (e as Error).message);
          }
        } else {
          // Detail fetch is optional: the new-listing rows still get written
          // with null metadata and the seller-level diff is not lost.
          console.warn(`[check-seller-watchlist] no token budget for product-detail fetch for ${sellerId}/${marketplace}`);
        }

        // Fill whatever Keepa left blank from catalogs we already populate.
        // A brand-new listing is exactly when Keepa's record is thinnest --
        // a title often arrives before imagesCSV does -- and this costs no
        // tokens, so it runs whether or not the fetch above was skipped.
        const missing = Array.from(unionNewAsins).filter((a) => !productDetails.get(a)?.image);
        if (missing.length) {
          const fromCatalog = await lookupAsinDetails(admin, missing);
          for (const [asin, details] of fromCatalog) {
            const existing = productDetails.get(asin);
            productDetails.set(asin, {
              title: existing?.title ?? details.title,
              brand: existing?.brand ?? null,
              image: existing?.image ?? details.image,
              upc: existing?.upc ?? null,
            });
          }
        }
      }

      // Backfill rows already stored without a picture. Keepa fills images in
      // as it crawls, and Find Source writes candidates that carry one, so a
      // row that had nothing at detection time can often be completed later.
      // Free -- catalog reads only, no Keepa call.
      try {
        const { data: blankRows } = await admin
          .from('seller_watch_new_listings')
          .select('id, asin')
          .eq('seller_id', sellerId)
          .eq('marketplace', marketplace)
          .is('image_url', null)
          .limit(100);

        if (blankRows?.length) {
          const details = await lookupAsinDetails(admin, blankRows.map((r: any) => r.asin));

          // Anything the local catalogs could not supply goes to SP-API --
          // Amazon's own catalog, and a SEPARATE quota from Keepa, so this
          // cannot slow the rotation or starve the repricer. Same call shape
          // enrich-missing-titles already uses.
          const stillBlank = blankRows.filter((r: any) => !details.get(r.asin)?.image);
          if (stillBlank.length) {
            const token = await getCatalogAccessToken(admin, group[0].user_id, marketplace);
            if (token) {
              for (const row of stillBlank.slice(0, MAX_SPAPI_IMAGE_LOOKUPS)) {
                const spapi = await fetchCatalogItemDetails(admin, token, row.asin, marketplace);
                if (spapi.image || spapi.title) {
                  const prev = details.get(row.asin);
                  details.set(row.asin, {
                    title: prev?.title ?? spapi.title,
                    image: prev?.image ?? spapi.image,
                  });
                }
              }
            }
          }

          for (const row of blankRows) {
            const found = details.get(row.asin);
            if (!found?.image && !found?.title) continue;
            const patch: Record<string, unknown> = {};
            if (found.image) patch.image_url = found.image;
            if (found.title) patch.title = found.title;
            await admin.from('seller_watch_new_listings').update(patch).eq('id', row.id);
          }
        }
      } catch (e) {
        console.warn('[check-seller-watchlist] image backfill failed', (e as Error).message);
      }

      // Pass 2: seed first-check watches, persist new-listing rows, email, update.
      for (const w of group) {
        checked++;
        const patch: Record<string, unknown> = { last_checked_at: nowIso, known_asin_list: currentAsins };
        if (currentSellerName && !w.seller_name) patch.seller_name = currentSellerName;

        const priorList = w.known_asin_list as string[] | null;
        if (priorList === null || priorList === undefined) {
          // First check for this watch -- seed the baseline, don't alert.
          await admin.from('seller_watchlist').update(patch).eq('id', w.id);
          continue;
        }

        const newAsins = perWatchNew.get(w.id) || [];

        if (newAsins.length > 0) {
          const rows = newAsins.map((asin) => {
            const details = productDetails.get(asin);
            return {
              watch_id: w.id,
              user_id: w.user_id,
              seller_id: sellerId,
              marketplace,
              asin,
              title: details?.title ?? null,
              brand: details?.brand ?? null,
              image_url: details?.image ?? null,
              upc: details?.upc ?? null,
              detected_at: nowIso,
            };
          });
          const { error: insertErr } = await admin
            .from('seller_watch_new_listings')
            .upsert(rows, { onConflict: 'watch_id,asin', ignoreDuplicates: true });
          if (insertErr) console.error(`[check-seller-watchlist] new-listing insert failed for watch ${w.id}`, insertErr.message);

          try {
            const emailRes = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceRoleKey}` },
              body: JSON.stringify({
                to: w.notify_email,
                name: 'there',
                emailType: 'seller-watch-new-listings',
                sellerWatch: {
                  sellerId,
                  sellerName: w.seller_name || currentSellerName,
                  marketplace,
                  newAsins: newAsins.slice(0, NEW_ASINS_IN_EMAIL),
                  totalNew: newAsins.length,
                },
              }),
            });
            if (!emailRes.ok) console.error(`[check-seller-watchlist] alert email send failed for watch ${w.id}`, await emailRes.text());
          } catch (e) {
            console.error(`[check-seller-watchlist] alert email send error for watch ${w.id}`, (e as Error).message);
          }
          patch.last_alert_at = nowIso;
          alertsFired++;
        }

        await admin.from('seller_watchlist').update(patch).eq('id', w.id);
      }
    }

    return jsonResponse({
      ok: true,
      checked,
      alertsFired,
      processedSellers,
      queuedSellers: orderedPairs.length,
      totalActive: totalActive ?? 0,
      stoppedReason,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    console.error('[check-seller-watchlist] error', (e as Error).message);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
