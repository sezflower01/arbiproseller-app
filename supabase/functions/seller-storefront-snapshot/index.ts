// Seller Storefront snapshot — Keepa Seller API + paginated Product API.
// With per-user 24h Supabase cache to avoid re-burning Keepa tokens.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { acquireKeepaGlobalSlot, reportKeepaTokensLeft, recordKeepa429, KEEPA_COST, type KeepaSlotOptions } from '../_shared/keepa-rate-gate.ts';

// This function used to call Keepa directly with zero awareness of other
// callers (repricer-sp-api-pricing, check-seller-watchlist) sharing the same
// account's 5-tokens/min plan -- confirmed live on 2026-08-15: a user's
// /product page-item fetch failed silently (no cache write, no error
// surfaced -- just an empty "Storefront Listings" page) right after a burst
// of Keepa calls from check-seller-watchlist testing. This gate coordinates
// with those other callers via the same keepa_daily_usage table. Since this
// is an interactive request (not a background cron), a blocked slot waits
// briefly and retries once rather than skipping outright.
async function acquireKeepaSlotWithRetry(supabase: any, options: KeepaSlotOptions = {}) {
  const first = await acquireKeepaGlobalSlot(supabase, options);
  if (first.ok) return first;
  const waitMs = Math.min(first.waitSeconds, 15) * 1000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return acquireKeepaGlobalSlot(supabase, options);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const KEEPA_DOMAIN: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

function estimateSales(bsr: number | null): string {
  if (!bsr || bsr <= 0) return '—';
  if (bsr < 100) return '10000+/mo';
  if (bsr < 500) return '5000+/mo';
  if (bsr < 1000) return '2000+/mo';
  if (bsr < 5000) return '1000+/mo';
  if (bsr < 10000) return '500+/mo';
  if (bsr < 25000) return '300+/mo';
  if (bsr < 50000) return '250+/mo';
  if (bsr < 100000) return '200+/mo';
  if (bsr < 250000) return '100+/mo';
  if (bsr < 500000) return '50+/mo';
  if (bsr < 1000000) return '25+/mo';
  return '<25/mo';
}

function pickPrice(stats: any, idx: number): number | null {
  const v = Array.isArray(stats?.current) ? stats.current[idx] : null;
  return typeof v === 'number' && v > 0 ? v / 100 : null;
}

function pickInt(stats: any, idx: number): number | null {
  const v = Array.isArray(stats?.current) ? stats.current[idx] : null;
  return typeof v === 'number' && v > 0 ? v : null;
}

function topCategoryName(p: any): string | null {
  // categoryTree is array [{catId,name},...] — take last (deepest) or root
  if (Array.isArray(p?.categoryTree) && p.categoryTree.length) {
    return p.categoryTree[0]?.name || p.categoryTree[p.categoryTree.length - 1]?.name || null;
  }
  return p?.productGroup || null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const sellerIdRaw: string = (body.sellerId || '').trim();
    const marketplace: string = (body.marketplace || 'US').toUpperCase();
    const page: number = Math.max(0, parseInt(body.page ?? '0', 10) || 0);
    const pageSize: number = Math.min(20, Math.max(6, parseInt(body.pageSize ?? '12', 10) || 12));

    // Accept either pure seller id or a full Amazon URL with me=...
    let sellerId = sellerIdRaw;
    const meMatch = sellerIdRaw.match(/[?&]me=([A-Z0-9]+)/i);
    if (meMatch) sellerId = meMatch[1];

    if (!sellerId || !/^[A-Z0-9]{6,20}$/i.test(sellerId)) {
      return new Response(JSON.stringify({ error: 'Invalid sellerId' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY');
    if (!KEEPA_KEY) {
      return new Response(JSON.stringify({ error: 'KEEPA_API_KEY not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const domain = KEEPA_DOMAIN[marketplace] ?? 1;
    const forceRefresh: boolean = !!body.forceRefresh;

    // Auth: identify user for per-user cache
    const authHeader = req.headers.get('Authorization') || '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    let userId: string | null = null;
    if (authHeader.startsWith('Bearer ')) {
      const { data: u } = await supabase.auth.getUser(authHeader.slice(7));
      userId = u?.user?.id ?? null;
    }

    // 1) Seller summary — try cache first, else Keepa /seller
    const cachedAsinList: string[] | null = Array.isArray(body.cachedAsinList) ? body.cachedAsinList : null;
    const cachedStore = body.cachedStore && typeof body.cachedStore === 'object' ? body.cachedStore : null;

    let asinList: string[] = [];
    let store: any;
    let topBrandsCached: { name: string; count: number }[] | null = null;
    let topCategoriesCached: { name: string; count: number }[] | null = null;
    let storeCacheFetchedAt: string | null = null;

    if (cachedAsinList && cachedAsinList.length && cachedStore) {
      asinList = cachedAsinList;
      store = cachedStore;
    } else {
      // Try DB cache
      if (userId && !forceRefresh) {
        const { data: row } = await supabase
          .from('seller_storefront_cache')
          .select('store, asin_list, top_brands, top_categories, fetched_at')
          .eq('user_id', userId)
          .eq('seller_id', sellerId)
          .eq('marketplace', marketplace)
          .maybeSingle();
        if (row && row.fetched_at && (Date.now() - new Date(row.fetched_at).getTime()) < CACHE_TTL_MS) {
          store = row.store;
          asinList = (row.asin_list as string[]) || [];
          topBrandsCached = (row.top_brands as any[]) || [];
          topCategoriesCached = (row.top_categories as any[]) || [];
          storeCacheFetchedAt = row.fetched_at as string;
        }
      }

      if (!store) {
        const sellerSlot = await acquireKeepaSlotWithRetry(supabase, { estimatedTokens: KEEPA_COST.sellerStorefront });
        if (!sellerSlot.ok) {
          return new Response(JSON.stringify({ error: `Keepa is busy with other requests right now. Try again in ~${sellerSlot.waitSeconds}s.` }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const sellerUrl = `https://api.keepa.com/seller?key=${KEEPA_KEY}&domain=${domain}&seller=${encodeURIComponent(sellerId)}&storefront=1`;
        const sResp = await fetch(sellerUrl);
        if (!sResp.ok) {
          const txt = await sResp.text().catch(() => '');
          console.error('[seller-storefront-snapshot] Keepa /seller failed', sResp.status, txt.slice(0, 200));
          if (sResp.status === 429) {
            let refillSec = 60;
            let tl: unknown = undefined;
            try {
              const j = JSON.parse(txt);
              if (j?.refillIn) refillSec = Math.ceil(j.refillIn / 1000);
              tl = j?.tokensLeft;
            } catch {}
            // The 429 body carries the balance AT refusal, and it is usually
            // NEGATIVE. Recording it is what stops the budget row reading
            // positive while the account is overdrawn -- the desync that let
            // the gate keep approving calls against a number that was fiction.
            await recordKeepa429(supabase, tl, 'seller-storefront-snapshot /seller');
            return new Response(JSON.stringify({ error: `Keepa rate limit reached. Try again in ~${refillSec}s (token deficit).` }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ error: `Keepa seller HTTP ${sResp.status}` }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const sJson = await sResp.json().catch(() => ({}));
        await reportKeepaTokensLeft(supabase, sJson?.tokensLeft, sJson?.refillRate);
        const seller = sJson?.sellers?.[sellerId];
        if (!seller) {
          console.error('[seller-storefront-snapshot] Seller not found in response', JSON.stringify(sJson).slice(0, 300));
          return new Response(JSON.stringify({ error: 'Seller not found (Keepa returned no data — try again, may be rate-limited)' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        asinList = Array.isArray(seller.asinList) ? seller.asinList : [];
        const totalAsins = seller.totalStorefrontAsinsCSV?.length
          ? (seller.totalStorefrontAsinsCSV[seller.totalStorefrontAsinsCSV.length - 1] ?? asinList.length)
          : asinList.length;

        store = {
          sellerId,
          sellerName: seller.sellerName || sellerId,
          rating: seller.currentRating ?? null,
          ratingCount: seller.currentRatingCount ?? null,
          totalAsins,
          isScammer: !!seller.isScammer,
          hasFBA: !!seller.hasFBA,
        };
      }
    }

    // 2) Page slice ASINs — try page cache, else fetch product details from Keepa
    const start = page * pageSize;
    const slice = asinList.slice(start, start + pageSize);

    let pageItems: any[] | null = null;
    let pageCacheFetchedAt: string | null = null;

    if (userId && !forceRefresh) {
      const { data: pageRow } = await supabase
        .from('seller_storefront_page_cache')
        .select('page_items, fetched_at')
        .eq('user_id', userId)
        .eq('seller_id', sellerId)
        .eq('marketplace', marketplace)
        .eq('page', page)
        .eq('page_size', pageSize)
        .maybeSingle();
      if (pageRow && pageRow.fetched_at && (Date.now() - new Date(pageRow.fetched_at).getTime()) < CACHE_TTL_MS) {
        pageItems = (pageRow.page_items as any[]) || [];
        pageCacheFetchedAt = pageRow.fetched_at as string;
      }
    }

    let products: any[] = [];
    if (!pageItems && slice.length) {
      // offers=20 bills on top of the 1-token-per-ASIN base rate, so this is
      // the single most expensive call in the codebase -- a 20-ASIN page can
      // cost well over 100 tokens. Reserve for that, not for "one call".
      const productSlot = await acquireKeepaSlotWithRetry(supabase, {
        estimatedTokens: slice.length * KEEPA_COST.productWithOffersPerAsin,
      });
      if (!productSlot.ok) {
        return new Response(JSON.stringify({ error: `Keepa is busy with other requests right now. Try again in ~${productSlot.waitSeconds}s.`, store, asinList, page, pageSize, totalPages: Math.max(1, Math.ceil(asinList.length / pageSize)) }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      // offers must be 0 or >=20 per Keepa's API -- offers=10 was an invalid
      // parameter that Keepa rejected with a 200-status {error:...} body
      // (not a 429), which the old code never checked, silently treating it
      // as "zero offers" and returning empty pageItems with no explanation.
      // Confirmed live 2026-08-15 via a debug response dump -- this was the
      // ACTUAL root cause of the empty-storefront-listings bug, not Keepa
      // rate limiting (tokensLeft was 290/plenty at the time).
      const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domain}&asin=${slice.join(',')}&stats=90&offers=20&buybox=1&stock=1`;
      try {
        const pResp = await fetch(url);
        if (pResp.ok) {
          const pJson = await pResp.json().catch(() => ({}));
          await reportKeepaTokensLeft(supabase, pJson?.tokensLeft, pJson?.refillRate);
          if (pJson?.error) {
            console.error('[seller-storefront-snapshot] Keepa /product returned an error payload', JSON.stringify(pJson.error).slice(0, 200));
            return new Response(JSON.stringify({ error: `Keepa product fetch failed: ${pJson.error.message || 'unknown error'}.`, store, asinList, page, pageSize, totalPages: Math.max(1, Math.ceil(asinList.length / pageSize)) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          products = Array.isArray(pJson?.products) ? pJson.products : [];
        } else {
          const txt = await pResp.text().catch(() => '');
          console.error('[seller-storefront-snapshot] Keepa /product failed', pResp.status, txt.slice(0, 200));
          if (pResp.status === 429) {
            let refillSec = 60;
            let tl: unknown = undefined;
            try {
              const j = JSON.parse(txt);
              if (j?.refillIn) refillSec = Math.ceil(j.refillIn / 1000);
              tl = j?.tokensLeft;
            } catch {}
            // This is the batched product call -- the expensive one, sized
            // slice.length * productWithOffersPerAsin. Its refusals are the
            // most important to record, because it is the shape most capable
            // of driving the balance deeply negative in a single request.
            await recordKeepa429(supabase, tl, 'seller-storefront-snapshot /product');
            return new Response(JSON.stringify({ error: `Keepa rate limit reached on product fetch. Try again in ~${refillSec}s.`, store, asinList, page, pageSize, totalPages: Math.max(1, Math.ceil(asinList.length / pageSize)) }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          // Non-429 failure -- previously fell through silently, returning
          // 200 with empty pageItems and no explanation. Surface it instead.
          return new Response(JSON.stringify({ error: `Keepa product fetch failed (HTTP ${pResp.status}). Try again.`, store, asinList, page, pageSize, totalPages: Math.max(1, Math.ceil(asinList.length / pageSize)) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      } catch (e) {
        console.error('[seller-storefront-snapshot] /product fetch threw', (e as Error).message);
        return new Response(JSON.stringify({ error: `Keepa product fetch failed: ${(e as Error).message}. Try again.`, store, asinList, page, pageSize, totalPages: Math.max(1, Math.ceil(asinList.length / pageSize)) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // 3) Aggregate brands & categories from this page only.
    const brandCounts = new Map<string, number>();
    const catCounts = new Map<string, number>();
    let computedItems: any[] = [];
    if (!pageItems) {
      computedItems = products.map((p: any) => {
        const brand = (p?.brand || p?.manufacturer || '').toString().trim();
        const cat = topCategoryName(p) || '—';
        if (brand) brandCounts.set(brand, (brandCounts.get(brand) || 0) + 1);
        catCounts.set(cat, (catCounts.get(cat) || 0) + 1);

        const stats = p?.stats || {};
        const buyBox = pickPrice(stats, 18) ?? pickPrice(stats, 1);
        const newPrice = pickPrice(stats, 1);
        const bsr = pickInt(stats, 3);
        const offerCount = pickInt(stats, 11) ?? (Array.isArray(p?.offers) ? p.offers.length : null);

        const liveOffers = Array.isArray(p?.offers) ? p.offers : [];
        const topOffers = liveOffers
          .filter((o: any) => Array.isArray(o?.offerCSV) && o.offerCSV.length >= 3)
          .map((o: any) => {
            const len = o.offerCSV.length;
            const price = (o.offerCSV[len - 2] ?? 0) / 100;
            const ship = (o.offerCSV[len - 1] ?? 0) / 100;
            return {
              sellerId: o.sellerId,
              isFBA: !!o.isFBA,
              isPrime: !!o.isPrime,
              stock: typeof o.stockCSV?.[o.stockCSV.length - 1] === 'number' ? o.stockCSV[o.stockCSV.length - 1] : null,
              price: +(price + (o.isFBA ? 0 : ship)).toFixed(2),
            };
          })
          .sort((a: any, b: any) => a.price - b.price)
          .slice(0, 5);

        const fbaCount = liveOffers.filter((o: any) => o?.isFBA).length;
        const fbmCount = Math.max(0, (offerCount ?? liveOffers.length) - fbaCount);
        const ownOffer = liveOffers.find((o: any) => o?.sellerId === sellerId);
        const storeStock = ownOffer?.stockCSV?.[ownOffer.stockCSV.length - 1] ?? null;
        const image = p?.imagesCSV ? `https://images-na.ssl-images-amazon.com/images/I/${p.imagesCSV.split(',')[0]}` : null;

        return {
          asin: p?.asin, title: p?.title || '', image,
          brand: brand || null, category: cat,
          bsr, estSales: estimateSales(bsr),
          buyBox, newPrice, reviewCount: p?.reviewCount ?? null,
          offers: offerCount, fbaOffers: fbaCount, fbmOffers: fbmCount,
          storeStock, topOffers,
          upc: Array.isArray(p?.upcList) && p.upcList.length ? p.upcList[0] : null,
        };
      });
    } else {
      // Recompute brand/category counts from cached items so charts still work
      for (const it of pageItems) {
        if (it.brand) brandCounts.set(it.brand, (brandCounts.get(it.brand) || 0) + 1);
        if (it.category) catCounts.set(it.category, (catCounts.get(it.category) || 0) + 1);
      }
    }

    const finalItems = pageItems ?? computedItems;
    const topBrands = topBrandsCached ?? [...brandCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
    const topCategories = topCategoriesCached ?? [...catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));

    // 4) Persist caches
    if (userId) {
      // Store summary
      if (!storeCacheFetchedAt) {
        await supabase.from('seller_storefront_cache').upsert({
          user_id: userId, seller_id: sellerId, marketplace,
          store, asin_list: asinList,
          top_brands: topBrands, top_categories: topCategories,
          fetched_at: new Date().toISOString(),
        }, { onConflict: 'user_id,seller_id,marketplace' });
        storeCacheFetchedAt = new Date().toISOString();
      }
      // Page items
      if (!pageCacheFetchedAt && finalItems.length) {
        await supabase.from('seller_storefront_page_cache').upsert({
          user_id: userId, seller_id: sellerId, marketplace,
          page, page_size: pageSize, page_items: finalItems,
          fetched_at: new Date().toISOString(),
        }, { onConflict: 'user_id,seller_id,marketplace,page,page_size' });
        pageCacheFetchedAt = new Date().toISOString();
      }
    }

    return new Response(JSON.stringify({
      store,
      asinList,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(asinList.length / pageSize)),
      topBrands,
      topCategories,
      pageItems: finalItems,
      cachedAt: pageCacheFetchedAt || storeCacheFetchedAt,
      fromCache: !!(pageCacheFetchedAt && !forceRefresh),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
