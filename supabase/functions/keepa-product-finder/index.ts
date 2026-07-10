import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Domain mapping: marketplace → Keepa domain ID
const DOMAIN_MAP: Record<string, number> = {
  US: 1, UK: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get('KEEPA_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'KEEPA_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Auth check using getClaims for reliable auth in edge functions
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const token = authHeader.replace('Bearer ', '');
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims?.sub) {
      console.error('[KeepaFinder] Auth failed:', claimsError?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userId = claimsData.claims.sub;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json();
    const { filters, marketplace = 'US', page = 0, perPage = 50 } = body;
    const domainId = DOMAIN_MAP[marketplace] ?? 1;

    // Build Keepa selection object from our simplified filters
    const selection: Record<string, any> = {
      page,
      perPage: Math.min(perPage, 150),
      productType: 0, // physical products only
    };

    // Map our filter fields to Keepa parameter names
    // Keepa prices are in cents for USD domains
    const priceFactor = [1, 6, 2, 3, 4, 8, 9].includes(domainId) ? 100 : 1;

    if (filters) {
      // Category
      if (filters.rootCategory) selection.rootCategory = String(filters.rootCategory);

      // Title — Keepa expects a string of keywords (case-insensitive, all must match)
      if (filters.title) selection.title = filters.title;

      // Brand / manufacturer — Keepa expects ARRAYS of names, not strings
      if (filters.brand) selection.brand = [filters.brand];
      if (filters.manufacturer) selection.manufacturer = [filters.manufacturer];

      // Sales rank
      if (filters.salesRankMin != null) selection.current_SALES_gte = filters.salesRankMin;
      if (filters.salesRankMax != null) selection.current_SALES_lte = filters.salesRankMax;

      // Drops
      if (filters.drops30Min != null) selection.salesRankDrops30_gte = filters.drops30Min;
      if (filters.drops30Max != null) selection.salesRankDrops30_lte = filters.drops30Max;
      if (filters.drops90Min != null) selection.salesRankDrops90_gte = filters.drops90Min;
      if (filters.drops90Max != null) selection.salesRankDrops90_lte = filters.drops90Max;

      // Bought in past month
      if (filters.boughtPastMonthMin != null) selection.monthlySold_gte = filters.boughtPastMonthMin;
      if (filters.boughtPastMonthMax != null) selection.monthlySold_lte = filters.boughtPastMonthMax;

      // Buy Box price (cents)
      if (filters.buyBoxMin != null) selection.current_BUY_BOX_SHIPPING_gte = Math.round(filters.buyBoxMin * priceFactor);
      if (filters.buyBoxMax != null) selection.current_BUY_BOX_SHIPPING_lte = Math.round(filters.buyBoxMax * priceFactor);

      // Amazon price
      if (filters.amazonPriceMin != null) selection.current_AMAZON_gte = Math.round(filters.amazonPriceMin * priceFactor);
      if (filters.amazonPriceMax != null) selection.current_AMAZON_lte = Math.round(filters.amazonPriceMax * priceFactor);

      // New price
      if (filters.newPriceMin != null) selection.current_NEW_gte = Math.round(filters.newPriceMin * priceFactor);
      if (filters.newPriceMax != null) selection.current_NEW_lte = Math.round(filters.newPriceMax * priceFactor);

      // FBA price
      if (filters.fbaPriceMin != null) selection.current_NEW_FBA_gte = Math.round(filters.fbaPriceMin * priceFactor);
      if (filters.fbaPriceMax != null) selection.current_NEW_FBA_lte = Math.round(filters.fbaPriceMax * priceFactor);

      // FBM price
      if (filters.fbmPriceMin != null) selection.current_NEW_FBM_gte = Math.round(filters.fbmPriceMin * priceFactor);
      if (filters.fbmPriceMax != null) selection.current_NEW_FBM_lte = Math.round(filters.fbmPriceMax * priceFactor);

      // Offer counts
      if (filters.newOfferCountMin != null) selection.current_COUNT_NEW_gte = filters.newOfferCountMin;
      if (filters.newOfferCountMax != null) selection.current_COUNT_NEW_lte = filters.newOfferCountMax;
      if (filters.fbaOfferCountMin != null) selection.current_COUNT_NEW_FBA_OFFERS_gte = filters.fbaOfferCountMin;
      if (filters.fbaOfferCountMax != null) selection.current_COUNT_NEW_FBA_OFFERS_lte = filters.fbaOfferCountMax;
      if (filters.fbmOfferCountMin != null) selection.current_COUNT_NEW_FBM_OFFERS_gte = filters.fbmOfferCountMin;
      if (filters.fbmOfferCountMax != null) selection.current_COUNT_NEW_FBM_OFFERS_lte = filters.fbmOfferCountMax;

      // Amazon availability
      if (filters.amazonAvailability === 'out_of_stock') {
        selection.outOfStockPercentage90_AMAZON_gte = 90;
      } else if (filters.amazonAvailability === 'in_stock') {
        selection.outOfStockPercentage90_AMAZON_lte = 10;
      }

      // Buy Box seller type
      if (filters.buyBoxSeller === 'amazon') {
        selection.buyBoxIsAmazon = true;
      } else if (filters.buyBoxSeller === '3rd_party') {
        selection.buyBoxIsAmazon = false;
      }

      // Risk filters
      if (filters.isHazmat === true) selection.isHazmat = true;
      if (filters.isHazmat === false) selection.isHazmat = false;
      if (filters.isAdultProduct === true) selection.isAdultProduct = true;
      if (filters.isAdultProduct === false) selection.isAdultProduct = false;
      if (filters.isMeltable === true) selection.isHeatSensitive = true;
      if (filters.isMeltable === false) selection.isHeatSensitive = false;

      // Variations
      if (filters.variations === 'no_variations') selection.hasVariations = false;
      if (filters.variations === 'is_variation') selection.isVariation = true;

      // Sort
      if (filters.sortBy) selection.sort = [[filters.sortBy, filters.sortOrder || 'asc']];
    }

    console.log(`[KeepaFinder] User ${userId}, marketplace=${marketplace}, domain=${domainId}, page=${page}`);
    console.log(`[KeepaFinder] Selection payload:`, JSON.stringify(selection));
    if (filters?.title) console.log(`[KeepaFinder] Title filter: "${filters.title}"`);
    if (filters?.brand) console.log(`[KeepaFinder] Brand filter: "${filters.brand}"`);

    const MAX_RETRY_WAIT_MS = 12_000;

    const buildKeepaRateLimitResponse = (errText: string) => {
      let refillIn: number | null = null;
      let tokensLeft: number | null = null;

      try {
        const parsed = JSON.parse(errText);
        refillIn = Number(parsed?.refillIn ?? 0) || null;
        tokensLeft = typeof parsed?.tokensLeft === 'number' ? parsed.tokensLeft : null;
      } catch {
        // Ignore parse failures and fall back to a generic message.
      }

      const retryAfterMs = refillIn && refillIn > 0 ? refillIn : null;
      const retryAfterSeconds = retryAfterMs ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null;

      return new Response(JSON.stringify({
        error: 'Keepa rate limited',
        code: 'KEEPA_RATE_LIMIT',
        message: retryAfterSeconds
          ? `Keepa tokens are temporarily exhausted. Retry in about ${retryAfterSeconds}s.`
          : 'Keepa tokens are temporarily exhausted. Retry shortly.',
        retryAfterMs,
        tokensLeft,
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          ...(retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}),
        },
      });
    };

    // Retry short transient failures, but fail fast on long Keepa cooldown windows.
    async function fetchWithRetry(url: string, opts?: RequestInit, maxRetries = 2): Promise<Response> {
      let lastResponse: Response | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const res = await fetch(url, opts);
        lastResponse = res;

        if (res.ok) {
          return res;
        }

        const retryAfterHeader = res.headers.get('Retry-After');
        let retryAfterMs = 0;
        if (retryAfterHeader) {
          const retryAfterSeconds = Number(retryAfterHeader);
          if (Number.isFinite(retryAfterSeconds)) {
            retryAfterMs = retryAfterSeconds * 1000;
          } else {
            const retryAfterDate = Date.parse(retryAfterHeader);
            if (!Number.isNaN(retryAfterDate)) {
              retryAfterMs = Math.max(0, retryAfterDate - Date.now());
            }
          }
        }

        if (res.status === 429) {
          const body = await res.text();
          let refillIn = 0;
          let tokensLeft: number | null = null;

          try {
            const parsed = JSON.parse(body);
            refillIn = Number(parsed?.refillIn ?? 0) || 0;
            tokensLeft = typeof parsed?.tokensLeft === 'number' ? parsed.tokensLeft : null;
          } catch {
            // Ignore parse failures and use generic backoff.
          }

          const backoffMs = Math.pow(2, attempt) * 1500 + Math.random() * 1000;
          const waitMs = Math.max(retryAfterMs, refillIn > 0 ? refillIn + 1000 : 0, backoffMs);
          const shouldFailFast = waitMs > MAX_RETRY_WAIT_MS || (tokensLeft != null && tokensLeft < 0) || attempt === maxRetries;

          if (shouldFailFast) {
            console.warn(`[KeepaFinder] 429 – returning cooldown to client (wait ${Math.round(waitMs / 1000)}s, tokensLeft=${tokensLeft ?? 'n/a'})`);
            return new Response(body, {
              status: 429,
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                ...(waitMs > 0 ? { 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) } : {}),
              },
            });
          }

          console.log(`[KeepaFinder] 429 – waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }

        if ([400, 401, 402, 403, 404].includes(res.status) || attempt === maxRetries) {
          return res;
        }

        const waitMs = retryAfterMs > 0
          ? retryAfterMs
          : Math.pow(2, attempt) * 1500 + Math.random() * 1000;

        console.log(`[KeepaFinder] ${res.status} – waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}`);
        await new Promise(r => setTimeout(r, waitMs));
      }

      return lastResponse ?? new Response(JSON.stringify({ error: 'Keepa request failed' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Call Keepa Product Finder API
    const keepaUrl = `https://api.keepa.com/query?domain=${domainId}&key=${apiKey}`;
    const keepaRes = await fetchWithRetry(keepaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'keep-alive' },
      body: JSON.stringify({ selection: JSON.stringify(selection) }),
    });

    if (!keepaRes.ok) {
      const errText = await keepaRes.text();
      console.error(`[KeepaFinder] API error ${keepaRes.status}: ${errText}`);

      if (keepaRes.status === 429) {
        return buildKeepaRateLimitResponse(errText);
      }

      return new Response(JSON.stringify({ error: `Keepa API error: ${keepaRes.status}`, detail: errText }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const keepaData = await keepaRes.json();
    const asinList: string[] = keepaData.asinList || [];
    const totalResults: number = keepaData.totalResults || 0;
    const tokensLeft: number = keepaData.tokensLeft ?? null;

    console.log(`[KeepaFinder] Found ${totalResults} total, ${asinList.length} ASINs on page ${page}, tokensLeft=${tokensLeft}`);

    // If no ASINs, return empty
    if (asinList.length === 0) {
      return new Response(JSON.stringify({ products: [], totalResults, tokensLeft }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch product details for the ASINs (uses ~1 token per 100 ASINs)
    const detailUrl = `https://api.keepa.com/product?key=${apiKey}&domain=${domainId}&asin=${asinList.join(',')}&stats=180&history=0&offers=20&rating=0&buybox=0`;
    const detailRes = await fetchWithRetry(detailUrl);

    let products: any[] = [];
    if (detailRes.ok) {
      const detailData = await detailRes.json();
      const rawProducts = detailData.products || [];

      products = rawProducts.map((p: any) => {
        const stats = p.stats || {};
        const buyBoxPrice = stats.current?.[18] ?? null; // BUY_BOX_SHIPPING index
        const amazonPrice = stats.current?.[0] ?? null; // AMAZON index
        const newPrice = stats.current?.[1] ?? null; // NEW index
        const salesRank = stats.current?.[3] ?? null; // SALES index
        const newFbaPrice = stats.current?.[10] ?? null; // NEW_FBA
        const newFbmPrice = stats.current?.[7] ?? null; // NEW_FBM
        const drops30 = stats.salesRankDrops30 ?? null;
        const drops90 = stats.salesRankDrops90 ?? null;
        const monthlySold = p.monthlySold ?? null;
        const newOfferCount = stats.current?.[11] ?? null; // COUNT_NEW
        const fbaOfferCount = stats.offerCountFBA ?? null;
        const fbmOfferCount = stats.offerCountFBM ?? null;
        const rating = p.csv?.[16]?.[p.csv[16].length - 1] ?? null; // last rating value
        const ratingCount = p.csv?.[17]?.[p.csv[17].length - 1] ?? null;

        return {
          asin: p.asin,
          title: p.title,
          brand: p.brand,
          manufacturer: p.manufacturer,
          category: p.categoryTree?.[0]?.name ?? p.rootCategory?.toString(),
          imageUrl: p.imagesCSV ? `https://images-na.ssl-images-amazon.com/images/I/${p.imagesCSV.split(',')[0]}` : null,
          salesRank: salesRank > 0 ? salesRank : null,
          buyBoxPrice: buyBoxPrice > 0 ? buyBoxPrice / priceFactor : null,
          amazonPrice: amazonPrice > 0 ? amazonPrice / priceFactor : null,
          newPrice: newPrice > 0 ? newPrice / priceFactor : null,
          fbaPrice: newFbaPrice > 0 ? newFbaPrice / priceFactor : null,
          fbmPrice: newFbmPrice > 0 ? newFbmPrice / priceFactor : null,
          drops30: drops30 ?? 0,
          drops90: drops90 ?? 0,
          monthlySold,
          newOfferCount: newOfferCount > 0 ? newOfferCount : 0,
          fbaOfferCount: fbaOfferCount ?? 0,
          fbmOfferCount: fbmOfferCount ?? 0,
          rating: rating ? rating / 10 : null,
          ratingCount,
          isHazmat: p.isHazmat ?? false,
          isAdultProduct: p.isAdultProduct ?? false,
          isMeltable: p.isHeatSensitive ?? false,
          amazonLink: `https://www.amazon.com/dp/${p.asin}`,
        };
      });
    } else {
      const detailErrText = await detailRes.text();

      if (detailRes.status === 429) {
        console.error(`[KeepaFinder] Detail API error 429: ${detailErrText}`);
        return buildKeepaRateLimitResponse(detailErrText);
      }

      console.warn(`[KeepaFinder] Detail fetch failed ${detailRes.status}: ${detailErrText}`);
      // Return just ASINs without details
      products = asinList.map(asin => ({ asin, title: asin }));
    }

    // Post-filter: safety net for title/brand in case Keepa query mapping didn't apply
    const beforeCount = products.length;
    if (filters?.title) {
      const keywords = filters.title.toLowerCase().split(/\s+/).filter(Boolean);
      products = products.filter((p: any) => {
        const t = (p.title || '').toLowerCase();
        return keywords.every((kw: string) => t.includes(kw));
      });
    }
    if (filters?.brand) {
      const brandLower = filters.brand.toLowerCase();
      products = products.filter((p: any) =>
        (p.brand || '').toLowerCase().includes(brandLower) ||
        (p.manufacturer || '').toLowerCase().includes(brandLower)
      );
    }
    if (filters?.manufacturer) {
      const mfgLower = filters.manufacturer.toLowerCase();
      products = products.filter((p: any) =>
        (p.manufacturer || '').toLowerCase().includes(mfgLower)
      );
    }
    if (products.length < beforeCount) {
      console.log(`[KeepaFinder] Post-filter removed ${beforeCount - products.length} non-matching products (${products.length} remaining)`);
    }

    // Log first 3 products for debugging
    if (products.length > 0) {
      console.log(`[KeepaFinder] Sample results:`, products.slice(0, 3).map((p: any) => ({ asin: p.asin, title: p.title?.slice(0, 60), brand: p.brand })));
    }

    // Save products to keepa_products table
    if (products.length > 0) {
      const dbRows = products.map((p: any) => ({
        asin: p.asin,
        marketplace: marketplace || 'US',
        title: p.title,
        brand: p.brand || null,
        manufacturer: p.manufacturer || null,
        category: p.category || null,
        image_url: p.imageUrl || null,
        sales_rank: p.salesRank || null,
        buy_box_price: p.buyBoxPrice || null,
        amazon_price: p.amazonPrice || null,
        new_price: p.newPrice || null,
        fba_price: p.fbaPrice || null,
        fbm_price: p.fbmPrice || null,
        drops_30: p.drops30 ?? 0,
        drops_90: p.drops90 ?? 0,
        monthly_sold: p.monthlySold || null,
        new_offer_count: p.newOfferCount ?? 0,
        fba_offer_count: p.fbaOfferCount ?? 0,
        fbm_offer_count: p.fbmOfferCount ?? 0,
        rating: p.rating || null,
        rating_count: p.ratingCount || null,
        is_hazmat: p.isHazmat ?? false,
        is_adult_product: p.isAdultProduct ?? false,
        is_meltable: p.isMeltable ?? false,
        amazon_link: p.amazonLink || null,
        category_id: filters?.rootCategory ? Number(filters.rootCategory) || null : null,
        updated_at: new Date().toISOString(),
      }));

      // Upsert in batches of 50
      for (let i = 0; i < dbRows.length; i += 50) {
        const batch = dbRows.slice(i, i + 50);
        const { error: upsertErr } = await supabase
          .from('keepa_products')
          .upsert(batch, { onConflict: 'asin,marketplace' });
        if (upsertErr) {
          console.warn(`[KeepaFinder] DB upsert warning:`, upsertErr.message);
        }
      }
      console.log(`[KeepaFinder] Saved ${dbRows.length} products to keepa_products`);
    }

    return new Response(JSON.stringify({ products, totalResults, tokensLeft, page, saved: products.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[KeepaFinder] Error:', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
