import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

// Keepa rate limiting: plan gives 5 tokens/min, guard at 4 to avoid 429 spikes
const KEEPA_GUARD_LIMIT = 4;
const KEEPA_GUARD_INTERVAL_MS = Math.ceil(60_000 / KEEPA_GUARD_LIMIT);
const KEEPA_DAILY_SOFT_CAP = 500; // Soft daily cap to protect budget

type KeepaFetchResult =
  | {
      ok: true;
      data: {
        buyboxPrice: number | null;
        lowestFbaPrice: number | null;
        lowestFbmPrice: number | null;
        lowestOverallPrice: number | null;
        fbaOfferCount: number;
        fbmOfferCount: number;
        totalOfferCount: number;
        amazonSelling: boolean;
        offerBreakdown: OfferBreakdownItem[];
        buyboxSellerId: string | null;
      };
    }
  | {
      ok: false;
      reason: string;
    };

async function acquireKeepaGlobalSlot(supabase: any, usageDate: string): Promise<{ ok: boolean; waitSeconds: number }> {
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

// Keepa API fallback for when SP-API is throttled
async function fetchKeepaFallback(
  asin: string,
  _marketplaceId: string,
  supabase: any,
): Promise<KeepaFetchResult> {
  const apiKey = Deno.env.get('KEEPA_API_KEY');
  if (!apiKey) {
    const reason = 'skipped: config missing (KEEPA_API_KEY)';
    console.warn(`[Keepa] ${reason}`);
    return { ok: false, reason };
  }

  // Check daily soft cap
  const today = new Date().toISOString().split('T')[0];
  const { data: usage } = await supabase
    .from('keepa_daily_usage')
    .select('call_count')
    .eq('usage_date', today)
    .maybeSingle();

  const currentCount = usage?.call_count ?? 0;
  if (currentCount >= KEEPA_DAILY_SOFT_CAP) {
    const reason = `skipped: daily cap reached (${currentCount}/${KEEPA_DAILY_SOFT_CAP})`;
    console.warn(`[Keepa] ${reason}`);
    await incrementKeepaCounter(supabase, 'keepa_skipped_token_budget');
    return { ok: false, reason };
  }

  // Cross-invocation global guard: max 4 Keepa calls/minute
  const slot = await acquireKeepaGlobalSlot(supabase, today);
  if (!slot.ok) {
    const reason = `keepa_rate_limit_guard: next slot in ~${slot.waitSeconds}s`;
    console.warn(`[Keepa] ${reason}`);
    await incrementKeepaCounter(supabase, 'keepa_skipped_token_budget');
    return { ok: false, reason };
  }

  // Map marketplace to Keepa domain ID
  // 1=com, 2=co.uk, 3=de, 4=fr, 5=co.jp, 6=ca, 8=it, 9=es, 10=in, 11=com.mx, 12=com.br
  const domainMap: Record<string, number> = {
    'ATVPDKIKX0DER': 1,    // amazon.com
    'A2EUQ1WTGCTBG2': 6,   // amazon.ca
    'A1AM78C64UM0Y8': 11,  // amazon.com.mx
    'A2Q3Y263D00KWC': 12,  // amazon.com.br
  };
  const domainId = domainMap[_marketplaceId] ?? 1;

  try {
    // Keepa Product API - request offers data
    const url = `https://api.keepa.com/product?key=${apiKey}&domain=${domainId}&asin=${asin}&offers=20&history=0&rating=0`;
    console.log(`[Keepa] Fetching fallback pricing for ${asin} domain=${domainId} (usage: ${currentCount + 1}/${KEEPA_DAILY_SOFT_CAP})`);


    // Attempt with retry on 429
    let response: Response | null = null;
    let lastErrorText = '';
    let hadRetry429 = false;
    const MAX_KEEPA_ATTEMPTS = 2; // initial + 1 retry

    for (let attempt = 0; attempt < MAX_KEEPA_ATTEMPTS; attempt++) {
      response = await fetch(url);

      if (response.ok) break;

      lastErrorText = await response.text();

      if (response.status === 429 && attempt < MAX_KEEPA_ATTEMPTS - 1) {
        // Retry after 12-15s backoff
        const backoffMs = 12_000 + Math.random() * 3_000;
        hadRetry429 = true;
        console.warn(`[Keepa] 429 rate limited for ${asin}, retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${MAX_KEEPA_ATTEMPTS})`);
        await incrementKeepaCounter(supabase, 'keepa_429_count');
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }

      if (response.status === 429) {
        await incrementKeepaCounter(supabase, 'keepa_429_count');
        const reason = 'keepa_retry_failed: 429 after retry';
        console.error(`[Keepa] 429 persisted after retry for ${asin}`);
        return { ok: false, reason };
      }

      const reason = response.status === 402
        ? 'failed: API 402 payment required'
        : `failed: API ${response.status}`;
      console.error(`[Keepa] API error ${response.status}: ${lastErrorText}`);
      return { ok: false, reason };
    }

    if (!response || !response.ok) {
      return { ok: false, reason: `failed: API ${response?.status || 'unknown'}` };
    }

    const respData = await response.json();

    // Check Keepa token stats from response header
    const tokensLeft = respData.tokensLeft;
    const refillIn = respData.refillIn; // ms until next refill
    if (tokensLeft !== undefined) {
      console.log(`[Keepa] Tokens remaining: ${tokensLeft}, refill in ${Math.round((refillIn || 0) / 1000)}s`);
    }

    // Increment usage counter
    await supabase
      .from('keepa_daily_usage')
      .upsert({ usage_date: today, call_count: currentCount + 1, last_called_at: new Date().toISOString() }, { onConflict: 'usage_date' });

    const products = respData?.products;
    if (!products || products.length === 0) {
      return { ok: false, reason: 'failed: no product data returned' };
    }

    const product = products[0];

    // Extract pricing from Keepa product data
    let buyboxPrice: number | null = null;
    let lowestFbaPrice: number | null = null;
    let lowestFbmPrice: number | null = null;
    let buyboxSellerId: string | null = null;
    let fbaOfferCount = 0;
    let fbmOfferCount = 0;
    let amazonSelling = false;
    const offerBreakdown: OfferBreakdownItem[] = [];

    // Keepa stats object has current Buy Box price (index 18 = BUY_BOX_SHIPPING)
    // stats.current contains [csv_type] = price in cents (-1 = unavailable)
    const stats = product.stats?.current;
    if (stats) {
      // Index 18 = BUY_BOX_SHIPPING (Buy Box price including shipping, in cents)
      const bbCents = stats[18];
      if (bbCents && bbCents > 0) {
        buyboxPrice = bbCents / 100;
      }
      // Index 0 = AMAZON (Amazon's own price)
      const amzCents = stats[0];
      if (amzCents && amzCents > 0) {
        amazonSelling = true;
      }
      // Index 1 = NEW (lowest new price)
      const newCents = stats[1];
      if (newCents && newCents > 0) {
        lowestFbmPrice = newCents / 100;
      }
      // Index 10 = NEW_FBA (lowest FBA price)
      const fbaCents = stats[10];
      if (fbaCents && fbaCents > 0) {
        lowestFbaPrice = fbaCents / 100;
      }
    }

    // Process live offers if available
    const offers = product.offers || [];
    for (const offer of offers) {
      if (offer.condition !== 1) continue; // 1 = New condition only (Keepa always fetches New for now)
      
      const priceCents = offer.offerCSV?.[offer.offerCSV.length - 1]; // Last price entry
      const price = priceCents && priceCents > 0 ? priceCents / 100 : null;
      const isFba = offer.isFBA === true;
      const sellerId = offer.sellerId || null;

      if (sellerId === 'ATVPDKIKX0DER') amazonSelling = true;

      if (isFba) {
        fbaOfferCount++;
        if (price && (!lowestFbaPrice || price < lowestFbaPrice)) lowestFbaPrice = price;
      } else {
        fbmOfferCount++;
        if (price && (!lowestFbmPrice || price < lowestFbmPrice)) lowestFbmPrice = price;
      }

      // Check if this is the buy box winner
      if (offer.isBuyBoxWinner) {
        buyboxSellerId = sellerId;
        if (price && !buyboxPrice) buyboxPrice = price;
      }

      offerBreakdown.push({
        seller_id: sellerId,
        fulfillment: isFba ? 'FBA' : 'FBM',
        is_fba: isFba,
        is_buybox_winner: offer.isBuyBoxWinner === true,
        price,
        shipping: offer.shippingCents ? offer.shippingCents / 100 : 0,
        total_price: price,
      });
    }

    // If no individual offers parsed, use offer counts from product stats
    if (fbaOfferCount === 0 && fbmOfferCount === 0) {
      fbaOfferCount = product.stats?.offerCountFBA ?? 0;
      fbmOfferCount = product.stats?.offerCountFBM ?? 0;
    }

    let lowestOverallPrice: number | null = null;
    if (lowestFbaPrice && lowestFbmPrice) lowestOverallPrice = Math.min(lowestFbaPrice, lowestFbmPrice);
    else lowestOverallPrice = lowestFbaPrice ?? lowestFbmPrice;

    const totalOfferCount = fbaOfferCount + fbmOfferCount;
    console.log(`[Keepa] Success for ${asin}: BB=$${buyboxPrice}, FBA=$${lowestFbaPrice}, FBM=$${lowestFbmPrice}, offers=${totalOfferCount}`);

    // Track whether this was a retry success
    await incrementKeepaCounter(supabase, 'keepa_success_count');
    if (hadRetry429) await incrementKeepaCounter(supabase, 'keepa_retry_success_count');

    return {
      ok: true,
      data: {
        buyboxPrice,
        lowestFbaPrice,
        lowestFbmPrice,
        lowestOverallPrice,
        fbaOfferCount,
        fbmOfferCount,
        totalOfferCount,
        amazonSelling,
        offerBreakdown,
        buyboxSellerId,
      },
    };
  } catch (err) {
    console.error(`[Keepa] Fetch error for ${asin}:`, err);
    return { ok: false, reason: 'failed: request error' };
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SpApiPricingRequest {
  asin: string;
  sku?: string;
  marketplace?: string;
  max_retries?: number;
  lane?: string;
  is_priority?: boolean;
  last_snapshot_age_minutes?: number;
  item_condition?: 'New' | 'Used';
  fulfillment_type?: 'FBA' | 'FBM' | null;
}

interface MyPriceData {
  price: number | null;
  fulfillment: 'FBA' | 'FBM' | null;
  itemCondition: string | null;
  conditionRaw?: string | null;
  sellerSku?: string | null;
  sellerId?: string | null;
  asin?: string | null;
  status?: string | null;
  source: 'listings_item_by_sku' | 'missing_sku' | 'not_found';
}

interface OfferIdentityDiagnostics {
  requested_sku: string | null;
  detected_sku: string | null;
  expected_condition: string | null;
  detected_condition: string | null;
  expected_fulfillment: 'FBA' | 'FBM' | null;
  detected_fulfillment: 'FBA' | 'FBM' | null;
  seller_id: string | null;
  detected_asin: string | null;
  mapping_source: MyPriceData['source'];
  condition_match: boolean | null;
  fulfillment_match: boolean | null;
  sku_match: boolean | null;
  is_correct_offer_match: boolean;
  is_ambiguous: boolean;
  block_reason: string | null;
}

interface OfferBreakdownItem {
  seller_id: string | null;
  fulfillment: 'FBA' | 'FBM';
  is_fba: boolean;
  is_buybox_winner: boolean;
  price: number | null;
  shipping: number;
  total_price: number | null;
  is_self?: boolean;
  qualifies_competitor?: boolean;
}

interface SpApiPricingResult {
  asin: string;
  marketplace: string;
  buyboxPrice: number | null;
  buyboxSellerId: string | null;
  buyboxSellerType: 'Amazon' | 'FBA' | 'FBM' | null;
  buyboxIsFba: boolean | null;
  isBuyboxOwner: boolean;
  isBuyboxEligible: boolean;
  bbSource: 'winner_offer' | 'summary_fallback' | 'missing';
  lowestFbaPrice: number | null;
  lowestFbmPrice: number | null;
  lowestOverallPrice: number | null;
  myPrice: number | null;
  myFulfillment: 'FBA' | 'FBM' | null;
  fbaOfferCount: number;
  fbmOfferCount: number;
  totalOfferCount: number;
  qualifyingCompetitorCount: number;
  qualifyingFbaCompetitorCount: number;
  amazonSelling: boolean;
  offerBreakdown: OfferBreakdownItem[];
  fetchedAt: string;
  source: 'sp-api';
  pricingSource: 'sp-api' | 'keepa' | 'empty';
  keepaNote: string | null;
  // Legacy alias for scheduler compatibility
  rainforestNote?: string | null;
  detectedItemCondition?: string | null;
  detectedFulfillment?: 'FBA' | 'FBM' | null;
  detectedSku?: string | null;
  offerIdentity?: OfferIdentityDiagnostics;
}

function summarizeOfferBreakdown(offerBreakdown: OfferBreakdownItem[]) {
  const pricedOffers = offerBreakdown.filter(
    (offer) => typeof offer.total_price === 'number' && offer.total_price !== null && offer.total_price > 0,
  );
  const buyboxWinner = pricedOffers.find((offer) => offer.is_buybox_winner);
  const fbaOffers = pricedOffers.filter((offer) => offer.is_fba);
  const fbmOffers = pricedOffers.filter((offer) => !offer.is_fba);

  const lowestFbaPrice = fbaOffers.length > 0
    ? Math.min(...fbaOffers.map((offer) => offer.total_price as number))
    : null;
  const lowestFbmPrice = fbmOffers.length > 0
    ? Math.min(...fbmOffers.map((offer) => offer.total_price as number))
    : null;

  return {
    buyboxPrice: buyboxWinner?.total_price ?? null,
    buyboxSellerId: buyboxWinner?.seller_id ?? null,
    buyboxIsFba: buyboxWinner?.is_fba ?? null,
    buyboxSellerType: buyboxWinner
      ? (buyboxWinner.seller_id === 'ATVPDKIKX0DER' ? 'Amazon' : buyboxWinner.is_fba ? 'FBA' : 'FBM')
      : null,
    lowestFbaPrice,
    lowestFbmPrice,
    fbaOfferCount: offerBreakdown.filter((offer) => offer.is_fba).length,
    fbmOfferCount: offerBreakdown.filter((offer) => !offer.is_fba).length,
    amazonSelling: offerBreakdown.some((offer) => offer.seller_id === 'ATVPDKIKX0DER'),
  };
}

const MARKETPLACE_IDS: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

const REGION_ENDPOINTS: Record<string, string> = {
  US: 'https://sellingpartnerapi-na.amazon.com',
  CA: 'https://sellingpartnerapi-na.amazon.com',
  MX: 'https://sellingpartnerapi-na.amazon.com',
  BR: 'https://sellingpartnerapi-na.amazon.com',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: SpApiPricingRequest & { user_id?: string; internal?: boolean } = await req.json();
    const { asin, sku, marketplace = 'US', user_id, internal, max_retries, lane, is_priority, last_snapshot_age_minutes, item_condition = 'New' } = body;

    let userId: string;
    const authHeader = req.headers.get('Authorization');
    
    if (internal && user_id) {
      console.log(`[repricer-sp-api-pricing] Internal call for user ${user_id}`);
      userId = user_id;
    } else if (authHeader) {
      const token = authHeader.replace('Bearer ', '');

      try {
        const authAny = supabase.auth as any;
        if (typeof authAny.getClaims === 'function') {
          const { data, error: claimsError } = await authAny.getClaims(token);
          if (!claimsError && data?.claims?.sub) {
            userId = data.claims.sub;
          }
        }
      } catch {
        // Ignore
      }

      if (!userId!) {
        try {
          const payloadB64Url = token.split('.')[1];
          const payloadB64 = payloadB64Url.replace(/-/g, '+').replace(/_/g, '/');
          const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
          const payload = JSON.parse(atob(padded));
          if (payload?.sub) {
            userId = payload.sub;
          }
        } catch {
          // Continue
        }
      }

      if (!userId!) {
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
          throw new Error('Unauthorized');
        }
        userId = user.id;
      }
    } else {
      throw new Error('No authorization header');
    }

    // ── BATCH MODE: Fetch pricing for up to 20 ASINs in one SP-API call ──
    if ((body as any).batch === true) {
      const items: Array<{ asin: string; sku?: string; marketplace?: string; item_condition?: string }> = (body as any).items || [];
      if (items.length === 0) {
        return new Response(JSON.stringify({ success: false, error: 'No items in batch' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (items.length > 20) {
        return new Response(JSON.stringify({ success: false, error: 'Batch max 20 items' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const batchMarketplace = (body as any).marketplace || 'US';
      const batchMarketplaceId = MARKETPLACE_IDS[batchMarketplace] || MARKETPLACE_IDS.US;
      const batchEndpoint = REGION_ENDPOINTS[batchMarketplace] || REGION_ENDPOINTS.US;

      // Get seller auth
      const { data: authRowsBatch, error: authErrorBatch } = await supabase
        .from('seller_authorizations')
        .select('*')
        .eq('user_id', userId!);
      if (authErrorBatch) throw new Error(`Failed to load seller auth: ${authErrorBatch.message}`);
      const sellerAuthBatch = authRowsBatch?.find((a: any) => a.marketplace_id === batchMarketplaceId) || authRowsBatch?.[0];
      if (!sellerAuthBatch) throw new Error('Amazon seller account not connected');

      const batchAccessToken = await getAccessToken(sellerAuthBatch.refresh_token, supabase, userId);
      const selfSellerIdsBatch = new Set(
        [sellerAuthBatch.seller_id, sellerAuthBatch.selling_partner_id].filter(Boolean)
      );

      // Step 1: Batch fetch myPrice for all SKUs in parallel.
      // CRITICAL: key by SKU (not ASIN) — different SKUs of the same ASIN
      // (e.g. New vs Used) must not overwrite each other.
      const myPriceMap = new Map<string, MyPriceData>();
      const skuItems = items.filter(it => it.sku);
      if (skuItems.length > 0) {
        const myPricePromises = skuItems.map(async (it) => {
          try {
            const data = await fetchMyPrice({
              sku: it.sku!,
              accessToken: batchAccessToken,
              marketplaceId: batchMarketplaceId,
              endpoint: batchEndpoint,
              sellerId: sellerAuthBatch.selling_partner_id || sellerAuthBatch.seller_id,
            });
            myPriceMap.set(it.sku!, data);
          } catch (e) {
            console.warn(`[batch] myPrice failed for ${it.asin}/${it.sku}:`, e);
          }
        });
        await Promise.all(myPricePromises);
      }

      // Step 2: Build batch request for getItemOffersBatch — one request per item,
      // condition resolved from this item's own SKU/myPrice (never another SKU's).
      const batchRequests = items.map(it => {
        const myPriceData = it.sku ? myPriceMap.get(it.sku) : undefined;
        const skuValue = String(it.sku || '');
        const isUsedSku = skuValue.startsWith('amzn.gr.') || skuValue.toLowerCase().startsWith('used_');
        // SKU identity is authoritative for split New/Used sibling listings.
        let effectiveCondition: 'New' | 'Used' = isUsedSku ? 'Used' : 'New';
        if (!it.sku && myPriceData?.itemCondition) {
          const det = myPriceData.itemCondition.toLowerCase();
          if (det.startsWith('used') || det.startsWith('refurbished') || det.startsWith('collectible')) {
            effectiveCondition = 'Used';
          }
        }
        return {
          uri: `/products/pricing/v0/items/${it.asin}/offers`,
          method: 'GET',
          MarketplaceId: batchMarketplaceId,
          ItemCondition: effectiveCondition,
        };
      });

      const batchUrl = `${batchEndpoint}/batches/products/pricing/v0/itemOffers`;
      const batchBody = JSON.stringify({ requests: batchRequests });

      console.log(`[repricer-sp-api-pricing] BATCH fetching ${items.length} ASINs in ${batchMarketplace}`);

      let batchResponse: Response;
      let batchData: any;
      const MAX_BATCH_RETRIES = 2;
      for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
        batchResponse = await signedFetchPost(batchUrl, batchAccessToken, batchBody);
        batchData = await batchResponse.json();
        if (batchResponse.ok) break;
        const errCode = batchData?.errors?.[0]?.code;
        const isQuota = errCode === 'QuotaExceeded' || batchResponse.status === 429;
        if (isQuota && attempt < MAX_BATCH_RETRIES) {
          const delay = 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 300) + 100;
          console.warn(`[batch] QuotaExceeded, retry ${attempt + 1} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.error(`[batch] SP-API batch error:`, batchData);
        return new Response(JSON.stringify({ success: false, error: batchData?.errors?.[0]?.message || `HTTP ${batchResponse.status}` }), {
          status: batchResponse.status === 429 ? 429 : 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Step 3: Parse batch responses — results keyed by `${asin}::${sku}` so
      // New + Used SKUs on the same ASIN never collapse into one entry.
      const responses = batchData?.responses || [];
      const results: Record<string, any> = {};
      const itemKey = (it: { asin: string; sku?: string }) => `${it.asin}::${it.sku || ''}`;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const resp = responses[i];
        const key = itemKey(item);
        if (!resp || resp.status?.statusCode !== 200) {
          const errMsg = resp?.status?.reasonPhrase || resp?.body?.errors?.[0]?.message || 'batch_item_error';
          console.warn(`[batch] ${item.asin}/${item.sku || ''}: error - ${errMsg}`);
          results[key] = { success: false, asin: item.asin, sku: item.sku || null, error: errMsg };
          continue;
        }

        // Parse the individual response body (same format as single getItemOffers)
        const payload = resp.body?.payload || {};
        const summary = payload?.Summary || {};
        const offers = payload?.Offers || [];

        // Re-use existing parsing logic inline
        const buyboxPrices = summary?.BuyBoxPrices || [];
        const lowestPrices = summary?.LowestPrices || [];

        const rawOfferBreakdown: OfferBreakdownItem[] = offers.map((offer: any) => {
          const listingPrice = offer.ListingPrice?.Amount ?? null;
          const shipping = offer.Shipping?.Amount ?? 0;
          const isSelf = offer.SellerId ? selfSellerIdsBatch.has(offer.SellerId) : false;
          return {
            seller_id: offer.SellerId || null,
            fulfillment: offer.IsFulfilledByAmazon ? 'FBA' as const : 'FBM' as const,
            is_fba: offer.IsFulfilledByAmazon === true,
            is_buybox_winner: offer.IsBuyBoxWinner === true,
            price: listingPrice,
            shipping,
            total_price: listingPrice != null ? listingPrice + shipping : null,
            is_self: isSelf,
            qualifies_competitor: !isSelf,
          };
        });
        const offerBreakdown = rawOfferBreakdown.slice(0, 30);
        const offerSummary = summarizeOfferBreakdown(rawOfferBreakdown);

        let buyboxPrice: number | null = offerSummary.buyboxPrice;
        let buyboxSellerId: string | null = offerSummary.buyboxSellerId;
        let buyboxSellerType: 'Amazon' | 'FBA' | 'FBM' | null = offerSummary.buyboxSellerType as 'Amazon' | 'FBA' | 'FBM' | null;
        let buyboxIsFba: boolean | null = offerSummary.buyboxIsFba;
        let bbSource: 'winner_offer' | 'summary_fallback' | 'missing' = buyboxPrice ? 'winner_offer' : 'missing';

        if (!buyboxPrice) {
          const newBuybox = buyboxPrices.find((bp: any) => bp.condition === 'New' || bp.condition === 'Used');
          if (newBuybox) {
            buyboxPrice = newBuybox.LandedPrice?.Amount || newBuybox.ListingPrice?.Amount || null;
            buyboxIsFba = newBuybox.fulfillmentChannel === 'Amazon';
            buyboxSellerType = newBuybox.sellerId === 'ATVPDKIKX0DER' ? 'Amazon' : buyboxIsFba ? 'FBA' : 'FBM';
            bbSource = 'summary_fallback';
          }
        }

        let lowestFbaPrice: number | null = offerSummary.lowestFbaPrice;
        let lowestFbmPrice: number | null = offerSummary.lowestFbmPrice;
        for (const lp of lowestPrices) {
          if (lp.condition !== 'New' && lp.condition !== 'Used') continue;
          const price = lp.LandedPrice?.Amount || lp.ListingPrice?.Amount;
          if (!price) continue;
          if (lp.fulfillmentChannel === 'Amazon') {
            if (!lowestFbaPrice || price < lowestFbaPrice) lowestFbaPrice = price;
          } else {
            if (!lowestFbmPrice || price < lowestFbmPrice) lowestFbmPrice = price;
          }
        }

        let fbaOfferCount = offerSummary.fbaOfferCount;
        let fbmOfferCount = offerSummary.fbmOfferCount;
        const amazonSelling = offerSummary.amazonSelling;
        const numOfferListings = summary?.NumberOfOffers || [];
        for (const nol of numOfferListings) {
          if (nol.condition === 'New' || nol.condition === 'Used') {
            if (nol.fulfillmentChannel === 'Amazon') fbaOfferCount = Math.max(fbaOfferCount, nol.OfferCount || 0);
            else fbmOfferCount = Math.max(fbmOfferCount, nol.OfferCount || 0);
          }
        }
        const totalOfferCount = summary?.TotalOfferCount || (fbaOfferCount + fbmOfferCount);

        let lowestOverallPrice: number | null = null;
        if (lowestFbaPrice && lowestFbmPrice) lowestOverallPrice = Math.min(lowestFbaPrice, lowestFbmPrice);
        else if (lowestFbaPrice) lowestOverallPrice = lowestFbaPrice;
        else if (lowestFbmPrice) lowestOverallPrice = lowestFbmPrice;

        const isBuyboxOwner = buyboxSellerId ? selfSellerIdsBatch.has(buyboxSellerId) : false;
        const qualifyingFbaCompetitorCount = offerBreakdown.filter(o => o.qualifies_competitor && o.is_fba).length;
        const qualifyingCompetitorCount = offerBreakdown.filter(o => o.qualifies_competitor).length;

        const myPriceData = item.sku ? myPriceMap.get(item.sku) : undefined;

        // Offer-identity diagnostics — proves which seller offer we used and
        // whether it really matches the requested condition / fulfillment / SKU.
        const expectedCondition = (item.item_condition as string) || null;
        const detectedConditionRaw = myPriceData?.itemCondition || null;
        const detectedFulfillment = myPriceData?.fulfillment ?? null;
        const conditionMatches = expectedCondition && detectedConditionRaw
          ? detectedConditionRaw.toLowerCase().startsWith(expectedCondition.toLowerCase())
          : null;
        const fulfillmentMatches = (item as any).fulfillment_type && detectedFulfillment
          ? detectedFulfillment === (item as any).fulfillment_type
          : null;
        const skuMatches = item.sku && myPriceData?.sellerSku
          ? myPriceData.sellerSku === item.sku
          : (item.sku ? null : null);
        const isAmbiguous = conditionMatches === false || fulfillmentMatches === false || skuMatches === false;
        const blockReason = !item.sku
          ? 'missing_sku'
          : !myPriceData
            ? 'self_offer_not_found'
            : conditionMatches === false
              ? `condition_mismatch_expected_${expectedCondition}_detected_${detectedConditionRaw}`
              : fulfillmentMatches === false
                ? `fulfillment_mismatch_expected_${(item as any).fulfillment_type}_detected_${detectedFulfillment}`
                : skuMatches === false
                  ? 'sku_mismatch'
                  : null;

        const offerIdentity: OfferIdentityDiagnostics = {
          requested_sku: item.sku || null,
          detected_sku: myPriceData?.sellerSku || (item.sku || null),
          expected_condition: expectedCondition,
          detected_condition: detectedConditionRaw,
          expected_fulfillment: ((item as any).fulfillment_type as 'FBA' | 'FBM' | null) || null,
          detected_fulfillment: detectedFulfillment,
          seller_id: myPriceData?.sellerId || null,
          detected_asin: myPriceData?.asin || item.asin,
          mapping_source: myPriceData?.source || (item.sku ? 'missing_sku' : 'not_found'),
          condition_match: conditionMatches,
          fulfillment_match: fulfillmentMatches,
          sku_match: skuMatches,
          is_correct_offer_match: !isAmbiguous && !!myPriceData,
          is_ambiguous: !!isAmbiguous,
          block_reason: blockReason,
        };

        const result: SpApiPricingResult = {
          asin: item.asin,
          marketplace: batchMarketplace,
          buyboxPrice,
          buyboxSellerId,
          buyboxSellerType,
          buyboxIsFba,
          isBuyboxOwner,
          isBuyboxEligible: (summary?.NumberOfOfferListings || []).length > 0,
          bbSource,
          lowestFbaPrice,
          lowestFbmPrice,
          lowestOverallPrice,
          myPrice: myPriceData?.price ?? null,
          myFulfillment: myPriceData?.fulfillment ?? null,
          fbaOfferCount,
          fbmOfferCount,
          totalOfferCount,
          qualifyingCompetitorCount,
          qualifyingFbaCompetitorCount,
          amazonSelling,
          offerBreakdown,
          fetchedAt: new Date().toISOString(),
          source: 'sp-api',
          pricingSource: 'sp-api',
          keepaNote: null,
          rainforestNote: null,
          detectedItemCondition: myPriceData?.itemCondition || null,
          detectedFulfillment,
          detectedSku: myPriceData?.sellerSku || (item.sku || null),
          offerIdentity,
        };

        results[key] = { success: true, asin: item.asin, sku: item.sku || null, data: result };
      }

      console.log(`[repricer-sp-api-pricing] BATCH complete: ${Object.keys(results).length} results`);
      return new Response(JSON.stringify({ success: true, batch: true, results }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!asin) {
      throw new Error('ASIN is required');
    }

    const marketplaceId = MARKETPLACE_IDS[marketplace] || MARKETPLACE_IDS.US;
    const endpoint = REGION_ENDPOINTS[marketplace] || REGION_ENDPOINTS.US;

    console.log(`[repricer-sp-api-pricing] Fetching pricing for ${asin} in ${marketplace} (user=${userId})`);

    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', userId);

    if (authError) {
      throw new Error(`Failed to load seller authorization: ${authError.message || 'unknown error'}`);
    }

    const sellerAuth = authRows?.find(a => a.marketplace_id === marketplaceId) || authRows?.[0];
    if (!sellerAuth) {
      throw new Error('Amazon seller account not connected');
    }

    const accessToken = await getAccessToken(sellerAuth.refresh_token, supabase, userId);

    const effectiveMaxRetries = max_retries !== undefined ? max_retries : 2;

    // STEP 1: Fetch myPrice FIRST to detect the actual item condition
    // This prevents condition mismatch (e.g., Used item fetching New offers)
    let myPrice: number | null = null;
    let myFulfillment: 'FBA' | 'FBM' | null = null;
    let detectedItemCondition: string | null = null;
    
    if (sku) {
      try {
        const myPriceData = await fetchMyPrice({
          sku,
          accessToken,
          marketplaceId,
          endpoint,
          sellerId: sellerAuth.selling_partner_id || sellerAuth.seller_id,
        });
        myPrice = myPriceData.price;
        myFulfillment = myPriceData.fulfillment;
        detectedItemCondition = myPriceData.itemCondition;
      } catch (e) {
        console.warn(`[repricer-sp-api-pricing] Could not fetch my price for SKU ${sku}:`, e);
      }
    }

    // STEP 2: Determine effective condition. SKU identity is authoritative for
    // split New/Used sibling listings: plain merchant SKU = New, amzn.gr.* = Used.
    const skuValue = String(sku || '');
    const isUsedSku = skuValue.startsWith('amzn.gr.') || skuValue.toLowerCase().startsWith('used_');
    let effectiveCondition: 'New' | 'Used' = sku ? (isUsedSku ? 'Used' : 'New') : ((item_condition as 'New' | 'Used') || 'New');
    if (!sku && detectedItemCondition) {
      const detected = detectedItemCondition.toLowerCase();
      if (detected.startsWith('used') || detected.startsWith('refurbished') || detected.startsWith('collectible')) {
        effectiveCondition = 'Used';
      } else if (detected.startsWith('new')) {
        effectiveCondition = 'New';
      }
    }

    // STEP 3: Fetch competitive pricing with the correct condition
    const competitivePricing = await fetchCompetitivePricing({
      asin,
      accessToken,
      marketplaceId,
      endpoint,
      maxRetries: effectiveMaxRetries,
      supabase,
      lane: lane || 'COLD',
      isPriority: is_priority || false,
      lastSnapshotAgeMinutes: last_snapshot_age_minutes,
      itemCondition: effectiveCondition,
    });

    const isBuyboxOwner = competitivePricing.buyboxSellerId === sellerAuth.seller_id ||
                          competitivePricing.buyboxSellerId === sellerAuth.selling_partner_id;

    const selfSellerIds = new Set(
      [sellerAuth.seller_id, sellerAuth.selling_partner_id].filter((value): value is string => Boolean(value))
    );

    const offerBreakdown = (competitivePricing.offerBreakdown || []).map((offer) => {
      const isSelf = offer.seller_id ? selfSellerIds.has(offer.seller_id) : false;
      return {
        ...offer,
        is_self: isSelf,
        qualifies_competitor: !isSelf,
      };
    });

    const fallbackQualifyingFba = Math.max(
      0,
      competitivePricing.fbaOfferCount - (isBuyboxOwner && competitivePricing.buyboxIsFba ? 1 : 0)
    );
    const fallbackQualifyingTotal = Math.max(0, competitivePricing.totalOfferCount - (isBuyboxOwner ? 1 : 0));

    const qualifyingFbaCompetitorCount = offerBreakdown.length > 0
      ? offerBreakdown.filter((offer) => offer.qualifies_competitor && offer.is_fba).length
      : fallbackQualifyingFba;

    const qualifyingCompetitorCount = offerBreakdown.length > 0
      ? offerBreakdown.filter((offer) => offer.qualifies_competitor).length
      : fallbackQualifyingTotal;

    const keepaNote = competitivePricing.keepaNote || null;

    const result: SpApiPricingResult = {
      asin,
      marketplace,
      buyboxPrice: competitivePricing.buyboxPrice,
      buyboxSellerId: competitivePricing.buyboxSellerId,
      buyboxSellerType: competitivePricing.buyboxSellerType,
      buyboxIsFba: competitivePricing.buyboxIsFba,
      isBuyboxOwner,
      isBuyboxEligible: competitivePricing.isBuyboxEligible,
      bbSource: competitivePricing.bbSource,
      lowestFbaPrice: competitivePricing.lowestFbaPrice,
      lowestFbmPrice: competitivePricing.lowestFbmPrice,
      lowestOverallPrice: competitivePricing.lowestOverallPrice,
      myPrice,
      myFulfillment,
      fbaOfferCount: competitivePricing.fbaOfferCount,
      fbmOfferCount: competitivePricing.fbmOfferCount,
      totalOfferCount: competitivePricing.totalOfferCount,
      qualifyingCompetitorCount,
      qualifyingFbaCompetitorCount,
      amazonSelling: competitivePricing.amazonSelling,
      offerBreakdown,
      fetchedAt: new Date().toISOString(),
      source: 'sp-api',
      pricingSource: competitivePricing.pricingSource || 'sp-api',
      keepaNote,
      // Legacy alias so scheduler can read either field
      rainforestNote: keepaNote,
      detectedItemCondition: effectiveCondition,
    };

    console.log(`[repricer-sp-api-pricing] Result for ${asin}:`, {
      buyboxPrice: result.buyboxPrice,
      lowestFba: result.lowestFbaPrice,
      lowestFbm: result.lowestFbmPrice,
      isBuyboxOwner: result.isBuyboxOwner,
      offers: result.totalOfferCount,
      qualifyingCompetitors: result.qualifyingCompetitorCount,
      qualifyingFbaCompetitors: result.qualifyingFbaCompetitorCount,
      pricingSource: result.pricingSource,
      keepaNote: result.keepaNote,
    });

    return new Response(JSON.stringify({ success: true, data: result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[repricer-sp-api-pricing] Error:', error);
    const isQuota = (error as Error).message?.includes('exceeded your quota') || (error as Error).message?.includes('QuotaExceeded');
    const status = isQuota ? 429 : 500;
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message || 'Failed to fetch pricing' }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

import { exchangeLwaToken } from '../_shared/lwa-token.ts';
async function getAccessToken(
  refreshToken: string,
  supabase?: any,
  userId?: string | null,
): Promise<string> {
  return await exchangeLwaToken(refreshToken, supabase, userId);
}

async function incrementKeepaCounter(supabase: any, field: string) {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data: existing } = await supabase
      .from('keepa_daily_usage')
      .select('*')
      .eq('usage_date', today)
      .maybeSingle();

    if (existing) {
      await supabase
        .from('keepa_daily_usage')
        .update({ [field]: (existing[field] || 0) + 1 })
        .eq('usage_date', today);
    } else {
      await supabase
        .from('keepa_daily_usage')
        .insert({ usage_date: today, call_count: 0, [field]: 1 });
    }
  } catch (e) {
    console.warn(`[Keepa] Failed to increment ${field}:`, e);
  }
}

async function fetchCompetitivePricing(params: {
  asin: string;
  accessToken: string;
  marketplaceId: string;
  endpoint: string;
  maxRetries?: number;
  supabase?: any;
  lane?: string;
  isPriority?: boolean;
  lastSnapshotAgeMinutes?: number;
  itemCondition?: 'New' | 'Used';
}): Promise<{
  buyboxPrice: number | null;
  buyboxSellerId: string | null;
  buyboxSellerType: 'Amazon' | 'FBA' | 'FBM' | null;
  buyboxIsFba: boolean | null;
  isBuyboxEligible: boolean;
  bbSource: 'winner_offer' | 'summary_fallback' | 'missing';
  lowestFbaPrice: number | null;
  lowestFbmPrice: number | null;
  lowestOverallPrice: number | null;
  fbaOfferCount: number;
  fbmOfferCount: number;
  totalOfferCount: number;
  amazonSelling: boolean;
  offerBreakdown: OfferBreakdownItem[];
  pricingSource?: 'sp-api' | 'keepa' | 'empty';
  keepaNote?: string;
}> {
  const { asin, accessToken, marketplaceId, endpoint, maxRetries = 2 } = params;
  const itemCondition = params.itemCondition || 'New';

  const path = `/products/pricing/v0/items/${asin}/offers`;
  const queryParams = `MarketplaceId=${marketplaceId}&ItemCondition=${itemCondition}`;
  const url = `${endpoint}${path}?${queryParams}`;
  console.log(`[fetchCompetitivePricing] Fetching ${itemCondition} offers for ${asin}`);

  const MAX_RETRIES = maxRetries;
  let response: Response | null = null;
  let data: any = null;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    response = await signedFetch(url, accessToken);
    data = await response.json();
    
    if (response.ok) break;
    
    const errorCode = data?.errors?.[0]?.code;
    const errorMsg = data?.errors?.[0]?.message || '';
    const isQuotaError = errorCode === 'QuotaExceeded' || response.status === 429 || errorMsg.includes('exceeded your quota');
    
    if (isQuotaError && attempt < MAX_RETRIES) {
      // Exponential backoff with jitter: base * 2^attempt + random(100-400ms)
      const baseDelay = 1500;
      const delayMs = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 300) + 100;
      console.warn(`[fetchCompetitivePricing] QuotaExceeded for ${asin}, retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }

    // After exhausting all retries for quota errors, try Keepa fallback
    if (isQuotaError && attempt >= MAX_RETRIES) {
      // Track throttle count
      if (params.supabase) {
        await incrementKeepaCounter(params.supabase, 'sp_api_throttled_count');
      }

      const isHotOrPriority = params.isPriority || params.lane === 'HOT';
      const isManualRun = params.lane === 'MANUAL';
      // Keepa eligible: HOT, Priority, or Manual runs only
      const isKeepaEligible = isHotOrPriority || isManualRun;
      // Priority ASINs get tighter cache threshold (10min), manual runs 15min, HOT 30min
      const cacheThresholdMinutes = params.isPriority ? 10 : isManualRun ? 15 : 30;
      const cacheIsTooOld = !params.lastSnapshotAgeMinutes || params.lastSnapshotAgeMinutes > cacheThresholdMinutes;

      // GATE: Only use Keepa for eligible lanes when cache is stale
      if (!isKeepaEligible) {
        const skipReason = `skipped: not eligible (lane=${params.lane}, priority=${params.isPriority})`;
        console.warn(`[fetchCompetitivePricing] QuotaExceeded for ${asin} — Keepa ${skipReason}`);
        if (params.supabase) await incrementKeepaCounter(params.supabase, 'keepa_skipped_not_eligible');
        return {
          buyboxPrice: null, buyboxSellerId: null, buyboxSellerType: null, buyboxIsFba: null,
          isBuyboxEligible: false, bbSource: 'missing' as const,
          lowestFbaPrice: null, lowestFbmPrice: null, lowestOverallPrice: null,
          fbaOfferCount: 0, fbmOfferCount: 0, totalOfferCount: 0, amazonSelling: false,
          offerBreakdown: [], pricingSource: 'empty' as const,
          keepaNote: skipReason,
        };
      }

      if (!cacheIsTooOld) {
        const skipReason = `skipped: cache fresh (${params.lastSnapshotAgeMinutes}m <= ${cacheThresholdMinutes}m threshold)`;
        console.warn(`[fetchCompetitivePricing] QuotaExceeded for ${asin} — Keepa ${skipReason}`);
        if (params.supabase) await incrementKeepaCounter(params.supabase, 'keepa_skipped_cache_fresh');
        return {
          buyboxPrice: null, buyboxSellerId: null, buyboxSellerType: null, buyboxIsFba: null,
          isBuyboxEligible: false, bbSource: 'missing' as const,
          lowestFbaPrice: null, lowestFbmPrice: null, lowestOverallPrice: null,
          fbaOfferCount: 0, fbmOfferCount: 0, totalOfferCount: 0, amazonSelling: false,
          offerBreakdown: [], pricingSource: 'empty' as const,
          keepaNote: skipReason,
        };
      }

      console.log(`[fetchCompetitivePricing] QuotaExceeded for ${asin} — eligible for Keepa (lane=${params.lane}, priority=${params.isPriority}, cache_age=${params.lastSnapshotAgeMinutes}m)`);

      if (params.supabase) {
        const keepaResult = await fetchKeepaFallback(asin, marketplaceId, params.supabase);

        if (keepaResult.ok) {
          const keepaData = keepaResult.data;
          if (keepaData.buyboxPrice || keepaData.totalOfferCount > 0) {
            console.log(`[DECISION_SOURCE] asin=${asin} source=KEEPA sp_api=throttled cache=stale bb=$${keepaData.buyboxPrice} fba=$${keepaData.lowestFbaPrice} offers=${keepaData.totalOfferCount}`);
            return {
              ...keepaData,
              buyboxSellerId: keepaData.buyboxSellerId || null,
              buyboxSellerType: null,
              buyboxIsFba: keepaData.buyboxPrice ? true : null,
              isBuyboxEligible: keepaData.totalOfferCount > 0,
              bbSource: keepaData.buyboxPrice ? 'summary_fallback' as const : 'missing' as const,
              pricingSource: 'keepa' as const,
              keepaNote: 'used successfully',
            };
          }

          const emptyReason = 'failed: no usable pricing payload';
          console.warn(`[DECISION_SOURCE] asin=${asin} source=EMPTY sp_api=throttled keepa=${emptyReason}`);
          return {
            buyboxPrice: null, buyboxSellerId: null, buyboxSellerType: null, buyboxIsFba: null,
            isBuyboxEligible: false, bbSource: 'missing' as const,
            lowestFbaPrice: null, lowestFbmPrice: null, lowestOverallPrice: null,
            fbaOfferCount: 0, fbmOfferCount: 0, totalOfferCount: 0, amazonSelling: false,
            offerBreakdown: [], pricingSource: 'empty' as const,
            keepaNote: emptyReason,
          };
        }

        console.warn(`[DECISION_SOURCE] asin=${asin} source=EMPTY sp_api=throttled keepa=${keepaResult.reason}`);
        return {
          buyboxPrice: null, buyboxSellerId: null, buyboxSellerType: null, buyboxIsFba: null,
          isBuyboxEligible: false, bbSource: 'missing' as const,
          lowestFbaPrice: null, lowestFbmPrice: null, lowestOverallPrice: null,
          fbaOfferCount: 0, fbmOfferCount: 0, totalOfferCount: 0, amazonSelling: false,
          offerBreakdown: [], pricingSource: 'empty' as const,
          keepaNote: keepaResult.reason,
        };
      }

      const fallbackReason = 'skipped: fallback client unavailable';
      console.warn(`[DECISION_SOURCE] asin=${asin} source=EMPTY sp_api=throttled keepa=${fallbackReason}`);
      return {
        buyboxPrice: null, buyboxSellerId: null, buyboxSellerType: null, buyboxIsFba: null,
        isBuyboxEligible: false, bbSource: 'missing' as const,
        lowestFbaPrice: null, lowestFbmPrice: null, lowestOverallPrice: null,
        fbaOfferCount: 0, fbmOfferCount: 0, totalOfferCount: 0, amazonSelling: false,
        offerBreakdown: [], pricingSource: 'empty' as const,
        keepaNote: fallbackReason,
      };
    }

    const isInvalidAsin = data?.errors?.[0]?.code === 'InvalidInput' || data?.errors?.[0]?.code === 'NOT_FOUND';
    if (isInvalidAsin) {
      console.warn(`[fetchCompetitivePricing] ASIN ${asin} is invalid/not found in marketplace ${marketplaceId}, returning empty data`);
      return {
        buyboxPrice: null, buyboxSellerId: null, buyboxSellerType: null, buyboxIsFba: null,
        isBuyboxEligible: false, bbSource: 'missing' as const,
        lowestFbaPrice: null, lowestFbmPrice: null, lowestOverallPrice: null,
        fbaOfferCount: 0, fbmOfferCount: 0, totalOfferCount: 0, amazonSelling: false,
        offerBreakdown: [],
      };
    }

    console.error('[fetchCompetitivePricing] API error:', data);
    throw new Error(`SP-API error: ${data?.errors?.[0]?.message || response!.status}`);
  }

  const summary = data?.payload?.Summary || {};
  const offers = data?.payload?.Offers || [];
  const buyboxPrices = summary?.BuyBoxPrices || [];
  const lowestPrices = summary?.LowestPrices || [];

  const rawOfferBreakdown: OfferBreakdownItem[] = offers.map((offer: any) => {
    const listingPrice = offer.ListingPrice?.Amount ?? null;
    const shipping = offer.Shipping?.Amount ?? 0;
    const totalPrice = listingPrice != null ? listingPrice + shipping : null;

    return {
      seller_id: offer.SellerId || null,
      fulfillment: offer.IsFulfilledByAmazon ? 'FBA' : 'FBM',
      is_fba: offer.IsFulfilledByAmazon === true,
      is_buybox_winner: offer.IsBuyBoxWinner === true,
      price: listingPrice,
      shipping,
      total_price: totalPrice,
    };
  });
  const offerBreakdown = rawOfferBreakdown.slice(0, 30);
  const offerSummary = summarizeOfferBreakdown(rawOfferBreakdown);

  let buyboxPrice: number | null = offerSummary.buyboxPrice;
  let buyboxSellerId: string | null = offerSummary.buyboxSellerId;
  let buyboxSellerType: 'Amazon' | 'FBA' | 'FBM' | null = offerSummary.buyboxSellerType as 'Amazon' | 'FBA' | 'FBM' | null;
  let buyboxIsFba: boolean | null = offerSummary.buyboxIsFba;
  let bbSource: 'winner_offer' | 'summary_fallback' | 'missing' = buyboxPrice ? 'winner_offer' : 'missing';

  if (buyboxPrice) {
    console.log(`[fetchCompetitivePricing] Buy Box winner from Offers: seller=${buyboxSellerId}, price=$${buyboxPrice}, type=${buyboxSellerType}, source=winner_offer`);
  }

  if (!buyboxPrice) {
    const newBuybox = buyboxPrices.find((bp: any) => bp.condition === 'New');
    if (newBuybox) {
      buyboxPrice = newBuybox.LandedPrice?.Amount || newBuybox.ListingPrice?.Amount || null;
      buyboxIsFba = newBuybox.fulfillmentChannel === 'Amazon';
      
      if (newBuybox.sellerId === 'ATVPDKIKX0DER') {
        buyboxSellerType = 'Amazon';
        buyboxSellerId = 'ATVPDKIKX0DER';
      } else if (buyboxIsFba) {
        buyboxSellerType = 'FBA';
      } else {
        buyboxSellerType = 'FBM';
      }
      bbSource = 'summary_fallback';
    }
  }

  let lowestFbaPrice: number | null = offerSummary.lowestFbaPrice;
  let lowestFbmPrice: number | null = offerSummary.lowestFbmPrice;

  for (const lp of lowestPrices) {
    if (lp.condition !== 'New') continue;
    const price = lp.LandedPrice?.Amount || lp.ListingPrice?.Amount;
    if (!price) continue;

    if (lp.fulfillmentChannel === 'Amazon') {
      if (!lowestFbaPrice || price < lowestFbaPrice) lowestFbaPrice = price;
    } else {
      if (!lowestFbmPrice || price < lowestFbmPrice) lowestFbmPrice = price;
    }
  }

  let fbaOfferCount = offerSummary.fbaOfferCount;
  let fbmOfferCount = offerSummary.fbmOfferCount;
  const amazonSelling = offerSummary.amazonSelling;

  const numOfferListings = summary?.NumberOfOffers || [];
  if (numOfferListings.length > 0) {
    let summaryFba = 0;
    let summaryFbm = 0;
    for (const nol of numOfferListings) {
      if (nol.condition === 'New') {
        if (nol.fulfillmentChannel === 'Amazon') summaryFba = nol.OfferCount || 0;
        else summaryFbm = nol.OfferCount || 0;
      }
    }
    fbaOfferCount = Math.max(fbaOfferCount, summaryFba);
    fbmOfferCount = Math.max(fbmOfferCount, summaryFbm);
  }

  const totalOfferCount = summary?.TotalOfferCount || (fbaOfferCount + fbmOfferCount);
  
  let lowestOverallPrice: number | null = null;
  if (lowestFbaPrice && lowestFbmPrice) lowestOverallPrice = Math.min(lowestFbaPrice, lowestFbmPrice);
  else if (lowestFbaPrice) lowestOverallPrice = lowestFbaPrice;
  else if (lowestFbmPrice) lowestOverallPrice = lowestFbmPrice;

  const offerListings = summary?.NumberOfOfferListings || [];
  const isBuyboxEligible = offerListings.length > 0;

  if (!buyboxPrice && totalOfferCount > 0) {
    console.log(`[fetchCompetitivePricing] Buy Box SUPPRESSED for ${asin}: offers=${totalOfferCount}, lowestOverall=$${lowestOverallPrice}`);
  }

  return {
    buyboxPrice,
    buyboxSellerId,
    buyboxSellerType,
    buyboxIsFba,
    isBuyboxEligible,
    bbSource,
    lowestFbaPrice,
    lowestFbmPrice,
    lowestOverallPrice,
    fbaOfferCount,
    fbmOfferCount,
    totalOfferCount,
    amazonSelling,
    offerBreakdown,
  };
}

async function fetchMyPrice(params: {
  sku: string;
  accessToken: string;
  marketplaceId: string;
  endpoint: string;
  sellerId: string;
}): Promise<MyPriceData> {
  const { sku, accessToken, marketplaceId, endpoint, sellerId } = params;
  const encodedSku = encodeURIComponent(sku);
  const path = `/listings/2021-08-01/items/${sellerId}/${encodedSku}`;
  const queryParams = `marketplaceIds=${marketplaceId}&includedData=summaries,attributes`;
  const url = `${endpoint}${path}?${queryParams}`;

  const response = await signedFetch(url, accessToken);

  if (!response.ok) {
    const text = await response.text();
    console.warn('[fetchMyPrice] API error:', text);
    return { price: null, fulfillment: null, itemCondition: null, conditionRaw: null, sellerSku: sku, sellerId, asin: null, status: null, source: 'not_found' };
  }

  const data = await response.json();
  const summary = data?.summaries?.[0];
  const priceAttr = data?.attributes?.purchasable_offer;
  let actualPrice: number | null = null;
  let fulfillment: 'FBA' | 'FBM' | null = null;

  if (priceAttr && priceAttr.length > 0) {
    const offer = priceAttr[0];
    actualPrice = offer?.our_price?.[0]?.schedule?.[0]?.value_with_tax ||
                  offer?.our_price?.[0]?.schedule?.[0]?.value || null;
    fulfillment = summary?.fulfillmentChannel === 'AMAZON_NA' ? 'FBA' : 'FBM';
  }

  if (!fulfillment && summary?.fulfillmentChannel) {
    fulfillment = summary.fulfillmentChannel.includes('AMAZON') ? 'FBA' : 'FBM';
  }

  const conditionType = summary?.conditionType || summary?.condition || null;
  let itemCondition: string | null = null;
  if (conditionType) {
    const ct = String(conditionType).toLowerCase();
    if (ct.startsWith('new')) itemCondition = 'New';
    else if (ct.startsWith('used')) itemCondition = 'Used';
    else if (ct.startsWith('refurbished')) itemCondition = 'Refurbished';
    else if (ct.startsWith('collectible')) itemCondition = 'Collectible';
    else itemCondition = String(conditionType);
    console.log(`[fetchMyPrice] sku=${sku} condition=${itemCondition} (raw: ${conditionType}) fulfillment=${fulfillment}`);
  }

  return {
    price: actualPrice,
    fulfillment,
    itemCondition,
    conditionRaw: conditionType ? String(conditionType) : null,
    sellerSku: summary?.sellerSku || sku,
    sellerId,
    asin: summary?.asin || null,
    status: summary?.status?.[0] || null,
    source: 'listings_item_by_sku',
  };
}

async function signedFetchWithMethod(url: string, accessToken: string, method: string = 'GET', body?: string): Promise<Response> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error('AWS credentials not configured');
  }

  const urlObj = new URL(url);
  const host = urlObj.host;
  const pathName = urlObj.pathname;
  const queryString = urlObj.search.slice(1);
  const service = 'execute-api';

  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);

  const encoder = new TextEncoder();
  
  async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  }

  async function sha256(data: string): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const payloadHash = await sha256(body || '');
  const headers: Record<string, string> = {
    'host': host,
    'x-amz-access-token': accessToken,
    'x-amz-date': timestamp,
  };
  if (body) {
    headers['content-type'] = 'application/json';
  }
  const signedHeaderKeys = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  const canonicalRequest = `${method}\n${pathName}\n${queryString}\n${canonicalHeaders}\n${signedHeaderKeys}\n${payloadHash}`;
  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${await sha256(canonicalRequest)}`;

  const kDate = await hmacSha256(encoder.encode(`AWS4${awsSecretAccessKey}`), date);
  const kRegion = await hmacSha256(kDate, awsRegion);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = Array.from(new Uint8Array(await hmacSha256(kSigning, stringToSign)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;

  const fetchHeaders: Record<string, string> = {
    'Host': host,
    'x-amz-access-token': accessToken,
    'x-amz-date': timestamp,
    'Authorization': authorizationHeader,
  };
  if (body) {
    fetchHeaders['Content-Type'] = 'application/json';
  }

  return fetch(url, {
    method,
    headers: fetchHeaders,
    body: body || undefined,
  });
}

async function signedFetch(url: string, accessToken: string): Promise<Response> {
  return signedFetchWithMethod(url, accessToken, 'GET');
}

async function signedFetchPost(url: string, accessToken: string, body: string): Promise<Response> {
  return signedFetchWithMethod(url, accessToken, 'POST', body);
}
