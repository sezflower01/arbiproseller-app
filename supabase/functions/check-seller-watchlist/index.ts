// CHECK-SELLER-WATCHLIST
// Hourly cron worker (see migration 20260815133728_add_seller_watchlist.sql).
// For every active seller watch, re-pulls the seller's current storefront
// ASIN list from Keepa (ONE minimal /seller?storefront=1 call per DISTINCT
// seller+marketplace, shared across however many users are watching the
// same seller -- mirrors check-price-alerts' asin+marketplace grouping) and
// diffs it against the last-known list. New ASINs fire a
// seller-watch-new-listings email; the very first check for a watch just
// seeds the baseline (known_asin_list starts NULL) so a brand-new watch
// doesn't immediately "discover" the seller's entire existing catalog.
//
// The seller-list diff itself deliberately does NOT call Keepa's /product
// endpoint -- it only needs ASINs, so cost stays flat regardless of catalog
// size. Once genuinely NEW asins are found (typically 0-5, not the whole
// catalog), a SEPARATE bounded /product batch call fetches title/brand/
// image/upc for just those -- needed for the seller_watch_new_listings feed
// (see migration 20260815140759) and the Find Source search query. Cost
// here scales with actual new-listing volume, not catalog size.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { acquireKeepaGlobalSlot, reportKeepaTokensLeft, KEEPA_COST } from '../_shared/keepa-rate-gate.ts';

const MAX_PRODUCT_DETAIL_ASINS = 50;

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

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY')?.trim();
    if (!KEEPA_KEY) return jsonResponse({ error: 'KEEPA_API_KEY not configured' }, 500);
    const admin = createClient(SUPABASE_URL, serviceRoleKey);

    const { data: watches, error } = await admin
      .from('seller_watchlist')
      .select('id, user_id, seller_id, seller_name, marketplace, notify_email, known_asin_list')
      .eq('status', 'active')
      .limit(500);
    if (error) return jsonResponse({ error: error.message }, 500);
    if (!watches?.length) return jsonResponse({ ok: true, checked: 0, alertsFired: 0, distinctSellers: 0 });

    // Group by seller_id+marketplace so N watches on the same seller cost
    // ONE Keepa call, not N.
    const groups = new Map<string, { sellerId: string; marketplace: string; watches: typeof watches }>();
    for (const w of watches) {
      const key = `${w.seller_id}|${w.marketplace}`;
      if (!groups.has(key)) groups.set(key, { sellerId: w.seller_id, marketplace: w.marketplace, watches: [] });
      groups.get(key)!.watches.push(w);
    }

    let checked = 0;
    let alertsFired = 0;
    let skippedRateLimit = 0;
    const nowIso = new Date().toISOString();

    for (const { sellerId, marketplace, watches: group } of groups.values()) {
      // Background sweep: leave the default repricer reserve in place so a
      // large watchlist can never drain the budget live repricing needs.
      const slot = await acquireKeepaGlobalSlot(admin, { estimatedTokens: KEEPA_COST.sellerStorefront });
      if (!slot.ok) {
        console.warn(`[check-seller-watchlist] ${slot.blockedBy} guard: skipping ${sellerId}/${marketplace}, next slot in ~${slot.waitSeconds}s`);
        skippedRateLimit += group.length;
        continue;
      }

      const domainId = KEEPA_DOMAIN[marketplace] ?? 1;
      let currentAsins: string[] | null = null;
      let currentSellerName: string | null = null;
      try {
        const url = `https://api.keepa.com/seller?key=${KEEPA_KEY}&domain=${domainId}&seller=${encodeURIComponent(sellerId)}&storefront=1`;
        const res = await fetch(url);
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          await reportKeepaTokensLeft(admin, json?.tokensLeft);
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

      // Fetch failed entirely -- leave these watches untouched, they'll
      // retry next hour rather than silently losing their baseline.
      if (currentAsins === null) continue;

      // Pass 1: compute each watch's own newAsins (their known_asin_list
      // may differ if they subscribed at different times) and accumulate
      // the union so product details are fetched once per ASIN, not once
      // per watch.
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

      // One bounded batch call for whatever's genuinely new across the
      // whole group -- title/brand/image/upc, needed for the new-listings
      // feed and Find Source's search query.
      const productDetails = new Map<string, { title: string | null; brand: string | null; image: string | null; upc: string | null }>();
      if (unionNewAsins.size > 0) {
        // /product bills 1 token PER ASIN, so this batch is worth up to
        // MAX_PRODUCT_DETAIL_ASINS tokens -- reserve for the real size, not
        // for "one call".
        const asinsToFetch = Array.from(unionNewAsins).slice(0, MAX_PRODUCT_DETAIL_ASINS);
        const detailSlot = await acquireKeepaGlobalSlot(admin, {
          estimatedTokens: asinsToFetch.length * KEEPA_COST.productPerAsin,
        });
        if (detailSlot.ok) {
          try {
            const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domainId}&asin=${asinsToFetch.join(',')}`;
            const res = await fetch(url);
            if (res.ok) {
              const json = await res.json().catch(() => ({}));
              await reportKeepaTokensLeft(admin, json?.tokensLeft);
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
          console.warn(`[check-seller-watchlist] rate limit guard: skipping product-detail fetch for ${sellerId}/${marketplace}`);
        }
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

    return jsonResponse({ ok: true, checked, alertsFired, distinctSellers: groups.size, skippedRateLimit });
  } catch (e) {
    console.error('[check-seller-watchlist] error', (e as Error).message);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
