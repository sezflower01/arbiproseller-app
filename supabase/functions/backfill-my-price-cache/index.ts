import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalOrUser } from '../_shared/require-internal.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// AWS SigV4 signing utilities (aligned with repair-pending-prices for reliability)
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest("SHA-256", data as any);
}

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", key as any,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, "aws4_request");
}

async function signRequest(method: string, url: string, body: string, accessToken: string): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID")!;
  const awsSecretKey = Deno.env.get("AWS_SECRET_ACCESS_KEY")!;
  const region = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";
  const service = "execute-api";

  const urlObj = new URL(url);
  const host = urlObj.host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = toHex(await sha256(body));

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-access-token;x-amz-date";

  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, toHex(await sha256(canonicalRequest))].join("\n");

  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    Authorization: authHeader,
    "x-amz-date": amzDate,
    "x-amz-access-token": accessToken,
    host,
  };
}

// Get LWA access token
async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("LWA_CLIENT_ID") || Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("LWA_CLIENT_SECRET") || Deno.env.get("SPAPI_LWA_CLIENT_SECRET");

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId!,
      client_secret: clientSecret!,
    }),
  });

  if (!response.ok) {
    throw new Error(`LWA token error: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Call SP-API with signature
async function callSpApi(
  method: string,
  path: string,
  queryParams: Record<string, string>,
  accessToken: string,
  body: string = ""
): Promise<Response> {
  const url = new URL(`https://sellingpartnerapi-na.amazon.com${path}`);
  Object.entries(queryParams).forEach(([k, v]) => url.searchParams.set(k, v));

  const signedHeaders = await signRequest(method, url.toString(), body, accessToken);

  return fetch(url.toString(), {
    method,
    headers: {
      ...signedHeaders,
      "Content-Type": "application/json",
    },
    body: body || undefined,
  });
}

// Resolve marketplace code (US/CA/etc.) to SP-API marketplaceId (ATVPDKIKX0DER/etc.)
function resolveMarketplaceId(marketplace: string | null | undefined, fallbackMarketplaceId?: string | null): string {
  const m = (marketplace || "").trim();

  // Already looks like a marketplaceId
  if (/^A[A-Z0-9]{5,}$/.test(m)) return m;

  const upper = m.toUpperCase();
  const map: Record<string, string> = {
    US: "ATVPDKIKX0DER",
    CA: "A2EUQ1WTGCTBG2",
    MX: "A1AM78C64UM0Y8",
    BR: "A2Q3Y263D00KWC",
    GB: "A1F83G8C2ARO7P",
    DE: "A1PA6795UKMFR9",
    FR: "A13V1IB3VIYZZH",
    IT: "APJ6JRA9NG5V4",
    ES: "A1RKKUPIHCS9HS",
    JP: "A1VC38T7YXB528",
    AU: "A39IBJ37TRP1C6",
  };

  return map[upper] || fallbackMarketplaceId || "ATVPDKIKX0DER";
}

// Fetch listing price from Listings API
async function fetchListingPrice(
  sku: string,
  sellerId: string,
  marketplaceId: string,
  accessToken: string
): Promise<{ price: number | null; source: string; error?: string }> {
  try {
    // Use Listings Items API v2021-08-01
    const path = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`;
    const response = await callSpApi("GET", path, {
      marketplaceIds: marketplaceId,
      includedData: "offers,summaries",
    }, accessToken);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Listings API error for SKU ${sku}: ${response.status} - ${errorText}`);
      
      if (response.status === 429) {
        return { price: null, source: "listings_api", error: "rate_limit" };
      }
      // Specific error for 403 Unauthorized - requires Product Listing role
      if (response.status === 403) {
        return { price: null, source: "listings_api", error: "authorization_required" };
      }
      return { price: null, source: "listings_api", error: `API ${response.status}` };
    }
    
    const data = await response.json();
    
    // Log the raw response structure for debugging
    console.log(`Listings API raw response for SKU ${sku}:`, JSON.stringify(data, null, 2).slice(0, 2000));
    
    // Extract price from offers
    let price: number | null = null;
    
    if (data.offers && Array.isArray(data.offers)) {
      for (const offer of data.offers) {
        console.log(`Checking offer for SKU ${sku}:`, JSON.stringify(offer, null, 2).slice(0, 500));
        
        // Try multiple price paths - Amazon returns amount as STRING, not number!
        const rawAmount = 
          offer.price?.amount ||
          offer.price?.listingPrice?.amount ||
          offer.listingPrice?.amount ||
          offer.ourPrice?.amount ||
          offer.regularPrice?.amount ||
          offer.offerPrice?.amount ||
          offer.purchasableOffer?.price?.amount;
        
        // Parse string amounts to number
        const priceValue = typeof rawAmount === 'string' ? parseFloat(rawAmount) : rawAmount;
        
        if (priceValue && typeof priceValue === 'number' && !isNaN(priceValue) && priceValue > 0) {
          price = priceValue;
          console.log(`Found price in offers: $${price}`);
          break;
        }
      }
    }
    
    // Fallback: check summaries for price
    if (!price && data.summaries && Array.isArray(data.summaries)) {
      for (const summary of data.summaries) {
        console.log(`Checking summary for SKU ${sku}:`, JSON.stringify(summary, null, 2).slice(0, 500));
        const priceValue = summary.price?.listingPrice?.amount || summary.price?.amount;
        if (priceValue && typeof priceValue === 'number' && priceValue > 0) {
          price = priceValue;
          console.log(`Found price in summaries: $${price}`);
          break;
        }
      }
    }
    
    // Fallback: check attributes for price
    if (!price && data.attributes) {
      const purchasableOffer = data.attributes.purchasable_offer;
      if (Array.isArray(purchasableOffer)) {
        for (const po of purchasableOffer) {
          const ourPrice = po.our_price?.[0]?.schedule?.[0]?.value_with_tax;
          if (ourPrice && typeof ourPrice === 'number' && ourPrice > 0) {
            price = ourPrice;
            console.log(`Found price in attributes.purchasable_offer: $${price}`);
            break;
          }
        }
      }
    }
    
    if (price) {
      console.log(`Found listing price for SKU ${sku}: $${price}`);
      return { price, source: "listings_api" };
    }
    
    console.log(`No price found in Listings API response for SKU ${sku}. Listing may be inactive or have no price set.`);
    return { price: null, source: "listings_api", error: "no_price_in_response" };
    
  } catch (err) {
    console.error(`Error fetching listing price for SKU ${sku}:`, err);
    return { price: null, source: "listings_api", error: String(err) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;


  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const internalSecret = Deno.env.get("INTERNAL_SYNC_SECRET");
    
    let batchSize = 5;
    let delayMs = 2500;
    let maxRetries = 3;
    let requestedAsins: string[] | null = null;
    let requestedItems: Array<{ asin: string; sku: string }> | null = null;
    let requestedUserId: string | null = null;

    try {
      const body = await req.json();
      if (body?.batchSize) batchSize = Math.min(body.batchSize, 10);
      if (body?.delayMs) delayMs = Math.max(body.delayMs, 2000);
      if (typeof body?.user_id === "string" && /^[0-9a-f-]{36}$/i.test(body.user_id)) {
        requestedUserId = body.user_id;
      }

      if (Array.isArray(body?.asins)) {
        requestedAsins = body.asins
          .map((a: any) => String(a || "").trim())
          .filter(Boolean)
          .slice(0, 50);
      }

      // Precise multi-SKU refresh (avoid ASIN collisions)
      // items = [{ asin: "B00...", sku: "5E-DSE3-MP6A" }]
      if (Array.isArray(body?.items)) {
        requestedItems = body.items
          .map((it: any) => ({
            asin: String(it?.asin || "").trim(),
            sku: String(it?.sku || "").trim(),
          }))
          .filter((it: any) => it.asin && it.sku)
          .slice(0, 200);
      }
    } catch {
      // No body, use defaults
    }

    // Check for internal cron/function call. Internal callers may safely scope a
    // targeted SKU refresh by user_id; unauthenticated public callers may not.
    const authHeaderForInternal = req.headers.get("Authorization") || "";
    const isInternalCall =
      (Boolean(internalSecret) && req.headers.get("x-internal-secret") === internalSecret) ||
      authHeaderForInternal === `Bearer ${supabaseServiceKey}`;
    
    let userId: string | null = null;
    
    if (isInternalCall) {
      // For cron: process all users with pending orders missing prices, unless
      // an internal function supplies a specific user_id + item worklist.
      userId = requestedUserId;
      console.log(userId ? `Internal targeted call for user ${userId}` : "Internal cron call - processing all users");
    } else {
      // For user call: authenticate
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Missing authorization" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      const supabaseClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      
      const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      userId = user.id;
    }
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    // If user explicitly requested SKU items, process them directly (SKU-first)
    if (userId && requestedItems && requestedItems.length > 0) {
      const { data: authRows } = await supabase
        .from("seller_authorizations")
        .select("refresh_token, seller_id, selling_partner_id, marketplace_id")
        .eq("user_id", userId);

      const authData = authRows?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
      if (!authData) {
        return new Response(JSON.stringify({ error: "No seller authorization found" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const refreshToken = authData.refresh_token;
      const sellerId = authData.selling_partner_id || authData.seller_id;
      const marketplaceId = authData.marketplace_id || 'ATVPDKIKX0DER';

      const accessToken = await getLwaAccessToken(refreshToken);

      const results = {
        processed: 0,
        updated: 0,
        errors: 0,
        skipped: 0,
        authorizationErrors: 0,
        preflightFailed: false,
      };

      for (const it of requestedItems) {
        results.processed++;
        const listing = await fetchListingPrice(it.sku, sellerId, marketplaceId, accessToken);
        if (listing.error === 'authorization_required') {
          results.authorizationErrors++;
        }

        try {
          await processResult(supabase, userId, it.asin, marketplaceId, listing, { skuOverride: it.sku });
          console.log(`[TARGETED-SKU] user=${userId} marketplace=${marketplaceId} asin=${it.asin} sku=${it.sku} price=${listing.price ?? 'none'} error=${listing.error ?? 'none'}`);
          if (listing.price) results.updated++;
          else results.skipped++;
        } catch (e) {
          console.error('Error processing requested SKU item:', e);
          results.errors++;
        }
      }

      return new Response(JSON.stringify({ success: true, ...results, authorizationRequired: results.authorizationErrors > 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If user explicitly requested ASINs, build a worklist from inventory (not from pending orders)
    if (userId && requestedAsins && requestedAsins.length > 0) {
      const { data: invRows, error: invErr } = await supabase
        .from("inventory")
        .select("asin, sku")
        .eq("user_id", userId)
        .in("asin", requestedAsins);

      if (invErr) {
        console.error("Error fetching inventory for requested ASINs:", invErr);
        throw invErr;
      }

      const asinMap = new Map<string, { sku: string; marketplace: string }>();
      for (const row of invRows || []) {
        if (!row?.asin) continue;
        // NOTE: multi-SKU ASINs are handled via body.items for precision.
        // This ASIN-only path will still use a single SKU per ASIN.
        if (!asinMap.has(String(row.asin))) {
          asinMap.set(String(row.asin), {
            sku: String(row.sku || ""),
            marketplace: "", // resolved later using seller_authorizations.marketplace_id
          });
        }
      }

      const userAsinMap = new Map<string, Map<string, { sku: string; marketplace: string }>>();
      userAsinMap.set(userId, asinMap);

      const results = await processUserAsinMap({
        supabase,
        userAsinMap,
        userIdFilter: userId,
        batchSize: requestedAsins.length,
        delayMs,
        skipFreshCacheCheck: true,
      });

      return new Response(JSON.stringify({ success: true, ...results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Otherwise: Find ASINs that need price cache updates
    // Priority: pending orders with sold_price=0 and no fresh my_price_cache
    
    // Find ASINs that need price cache updates (pending orders mode)
    // Priority: pending orders with sold_price=0 and no fresh my_price_cache
    let query = supabase
      .from("sales_orders")
      .select("user_id, asin, sku, marketplace")
      .eq("sold_price", 0)
      .not("asin", "eq", "PENDING")
      .not("asin", "is", null);

    if (userId) {
      query = query.eq("user_id", userId);
    }

    const { data: pendingOrders, error: ordersError } = await query.limit(100);

    if (ordersError) {
      console.error("Error fetching pending orders:", ordersError);
      throw ordersError;
    }

    if (!pendingOrders || pendingOrders.length === 0) {
      console.log("No pending orders need price enrichment");
      return new Response(
        JSON.stringify({
          success: true,
          message: "No pending orders need price enrichment",
          processed: 0,
          updated: 0,
          errors: 0,
          skipped: 0,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Group by user_id and get unique ASINs
    const userAsinMap = new Map<string, Map<string, { sku: string; marketplace: string }>>();

    for (const order of pendingOrders) {
      if (!order.asin || !order.user_id) continue;

      if (!userAsinMap.has(order.user_id)) {
        userAsinMap.set(order.user_id, new Map());
      }

      const asinMap = userAsinMap.get(order.user_id)!;
      if (!asinMap.has(order.asin)) {
        asinMap.set(order.asin, {
          sku: order.sku || "",
          marketplace: order.marketplace || "",
        });
      }
    }

    const results = await processUserAsinMap({
      supabase,
      userAsinMap,
      userIdFilter: userId,
      batchSize,
      delayMs,
      skipFreshCacheCheck: false,
    });

    return new Response(JSON.stringify({ success: true, ...results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
    
  } catch (error) {
    console.error("Error in backfill-my-price-cache:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

type ProcessUserAsinMapOptions = {
  supabase: any;
  userAsinMap: Map<string, Map<string, { sku: string; marketplace: string }>>;
  userIdFilter: string | null;
  batchSize: number;
  delayMs: number;
  skipFreshCacheCheck: boolean;
};

async function processUserAsinMap(options: ProcessUserAsinMapOptions) {
  const { supabase, userAsinMap, userIdFilter, batchSize, delayMs, skipFreshCacheCheck } = options;

  // Check which ASINs already have fresh cache (< 2 hours old)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const results = {
    processed: 0,
    updated: 0,
    errors: 0,
    skipped: 0,
    authorizationErrors: 0, // Track 403 errors specifically
    preflightFailed: false, // Preflight check detected missing permission
  };

  for (const [currentUserId, asinMap] of userAsinMap) {
    if (userIdFilter && currentUserId !== userIdFilter) continue;

    // Get all seller authorizations for this user (multi-marketplace)
    const { data: authRows } = await supabase
      .from("seller_authorizations")
      .select("refresh_token, seller_id, selling_partner_id, marketplace_id")
      .eq("user_id", currentUserId);

    // Prefer US marketplace, fallback to first available
    const authData = authRows?.find((a: { marketplace_id: string }) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (!authData) {
      console.log(`No seller authorization for user ${currentUserId}`);
      continue;
    }

    // Use selling_partner_id if available (required for Listings API)
    const sellerId = authData.selling_partner_id || authData.seller_id;
    console.log(
      `Using seller ID: ${sellerId} (selling_partner_id: ${authData.selling_partner_id}, seller_id: ${authData.seller_id})`
    );

    const asins = Array.from(asinMap.keys());
    let asinsToProcess = asins.slice(0, batchSize);

    if (!skipFreshCacheCheck) {
      const { data: existingCache } = await supabase
        .from("asin_my_price_cache")
        .select("asin")
        .eq("user_id", currentUserId)
        .in("asin", asins)
        .gte("fetched_at", twoHoursAgo);

      const freshAsins = new Set(existingCache?.map((c: any) => c.asin) || []);
      asinsToProcess = asins.filter((a) => !freshAsins.has(a)).slice(0, batchSize);
    }

    if (asinsToProcess.length === 0) {
      console.log(`All ASINs for user ${currentUserId} have fresh cache`);
      results.skipped += asins.length;
      continue;
    }

    // Get access token
    let accessToken: string;
    try {
      accessToken = await getLwaAccessToken(authData.refresh_token);
    } catch (err) {
      console.error(`Failed to get access token for user ${currentUserId}:`, err);
      results.errors++;
      continue;
    }

    // ========== PREFLIGHT CHECK ==========
    // Test one ASIN first to detect 403 authorization errors before processing the full batch
    // This provides immediate feedback without wasting API calls
    const firstAsin = asinsToProcess[0];
    const firstAsinData = asinMap.get(firstAsin)!;
    const preflightMarketplaceId = resolveMarketplaceId(firstAsinData.marketplace, authData.marketplace_id);
    
    let preflightSku = firstAsinData.sku;
    if (!preflightSku) {
      const { data: invData } = await supabase
        .from("inventory")
        .select("sku")
        .eq("user_id", currentUserId)
        .eq("asin", firstAsin)
        .maybeSingle();
      preflightSku = invData?.sku || "";
    }
    
    if (preflightSku) {
      console.log(`Running preflight check for ASIN ${firstAsin} (SKU: ${preflightSku})`);
      const preflightResult = await fetchListingPrice(preflightSku, sellerId, preflightMarketplaceId, accessToken);
      
      if (preflightResult.error === "authorization_required") {
        console.log("PREFLIGHT FAILED: Missing Product Listing permission (403). Aborting batch.");
        results.preflightFailed = true;
        results.authorizationErrors = asinsToProcess.length; // Mark all as auth errors
        
        // Store the failure in cache for visibility
        await processResult(supabase, currentUserId, firstAsin, preflightMarketplaceId, preflightResult, { sellerSku: preflightSku });
        
        // Do not process remaining ASINs - return early
        continue;
      }
      
      // Preflight passed or had a different error - process the first result
      await processResult(supabase, currentUserId, firstAsin, preflightMarketplaceId, preflightResult, { sellerSku: preflightSku });
      results.processed++;
      if (preflightResult.price) results.updated++;
      else if (preflightResult.error) results.errors++;
      
      // Remove first ASIN from batch (already processed)
      asinsToProcess = asinsToProcess.slice(1);
      
      // Delay after preflight
      if (asinsToProcess.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // Process remaining ASINs with delay
    for (const asin of asinsToProcess) {
      const { sku, marketplace } = asinMap.get(asin)!;
      const marketplaceId = resolveMarketplaceId(marketplace, authData.marketplace_id);

      if (!sku) {
        // Try to get SKU from inventory
        const { data: invData } = await supabase
          .from("inventory")
          .select("sku")
          .eq("user_id", currentUserId)
          .eq("asin", asin)
          .maybeSingle();

        if (!invData?.sku) {
          console.log(`No SKU found for ASIN ${asin}, skipping`);
          results.skipped++;
          continue;
        }

        const result = await fetchListingPrice(invData.sku, sellerId, marketplaceId, accessToken);
        await processResult(supabase, currentUserId, asin, marketplaceId, result, { sellerSku: invData.sku });

        results.processed++;
        if (result.price) results.updated++;
        if (result.error === "authorization_required") results.authorizationErrors++;
        else if (result.error) results.errors++;
      } else {
        const result = await fetchListingPrice(sku, sellerId, marketplaceId, accessToken);
        await processResult(supabase, currentUserId, asin, marketplaceId, result, { sellerSku: sku });

        results.processed++;
        if (result.price) results.updated++;
        if (result.error === "authorization_required") results.authorizationErrors++;
        else if (result.error) results.errors++;
      }

      if (asinsToProcess.indexOf(asin) < asinsToProcess.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  console.log(
    `Backfill complete: processed=${results.processed}, updated=${results.updated}, errors=${results.errors}, authErrors=${results.authorizationErrors}, preflightFailed=${results.preflightFailed}`
  );

  // Return authorizationRequired flag if any 403 errors occurred OR preflight failed
  return {
    ...results,
    authorizationRequired: results.authorizationErrors > 0 || results.preflightFailed,
  };
}

// Helper to upsert cache result
// Map marketplaceId to currency code
const MARKETPLACE_CURRENCY_MAP: Record<string, string> = {
  'ATVPDKIKX0DER': 'USD', // US
  'A2EUQ1WTGCTBG2': 'CAD', // CA
  'A1AM78C64UM0Y8': 'MXN', // MX
  'A2Q3Y263D00KWC': 'BRL', // BR
  'A1F83G8C2ARO7P': 'GBP', // GB
  'A1PA6795UKMFR9': 'EUR', // DE
  'A13V1IB3VIYZZH': 'EUR', // FR
  'APJ6JRA9NG5V4': 'EUR',  // IT
  'A1RKKUPIHCS9HS': 'EUR', // ES
  'A1VC38T7YXB528': 'JPY', // JP
  'A39IBJ37TRP1C6': 'AUD', // AU
};

async function processResult(
  supabase: any,
  userId: string,
  asin: string,
  marketplaceId: string,
  result: { price: number | null; source: string; error?: string },
  options?: { skuOverride?: string; sellerSku?: string }
) {
  const now = new Date().toISOString();
  
  // Determine correct currency based on marketplace
  const currency = MARKETPLACE_CURRENCY_MAP[marketplaceId] || 'USD';
  const isUsMarketplace = marketplaceId === 'ATVPDKIKX0DER';
  
  // Resolve seller_sku: explicit override > passed SKU > default
  const resolvedSku = options?.skuOverride || options?.sellerSku || '__NO_SKU__';
  
  // Get existing cache entry for attempt tracking (now SKU-aware)
  const { data: existing } = await supabase
    .from("asin_my_price_cache")
    .select("attempt_count")
    .eq("user_id", userId)
    .eq("asin", asin)
    .eq("marketplace_id", marketplaceId)
    .eq("seller_sku", resolvedSku)
    .maybeSingle();
  
  const attemptCount = (existing?.attempt_count || 0) + 1;
  
  // Calculate next retry with exponential backoff (5min, 15min, 45min, etc.)
  let nextRetry = null;
  if (result.error && attemptCount < 5) {
    const backoffMinutes = 5 * Math.pow(3, attemptCount - 1);
    nextRetry = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();
  }
  
  await supabase
    .from("asin_my_price_cache")
    .upsert({
      user_id: userId,
      asin,
      marketplace_id: marketplaceId,
      seller_sku: resolvedSku,
      my_price: result.price,
      currency: currency,
      fetched_at: now,
      source: result.source,
      attempt_count: attemptCount,
      last_error: result.error || null,
      next_retry_at: nextRetry,
      updated_at: now,
    }, {
      onConflict: "user_id,asin,marketplace_id,seller_sku",
    });
  
  console.log(`[SKU-CACHE] Upserted asin_my_price_cache: ASIN=${asin}, SKU=${resolvedSku}, price=${result.price}`);
  
  // CRITICAL FIX: Only update inventory.price for US marketplace prices!
  // Non-US prices (MXN, CAD, BRL) should NOT update the inventory table
  // as it would corrupt USD-based sales calculations
  if (result.price && isUsMarketplace) {
    // If caller provided an explicit SKU, update that exact inventory row (multi-SKU safe)
    if (options?.skuOverride) {
      await supabase
        .from("inventory")
        .update({
          price: result.price,
          my_price: result.price,
          updated_at: now,
        })
        .eq("user_id", userId)
        .eq("sku", options.skuOverride);

      console.log(`Updated inventory.price for explicit SKU ${options.skuOverride} (ASIN ${asin}) to $${result.price}`);
      return;
    }

    // SKU-FIRST PRICING: If we got a price, update inventory by SKU first (more accurate), then fall back to ASIN
    // This ensures that when multiple SKUs exist for the same ASIN (New/Used/Open Box), 
    // only the specific SKU's inventory is updated, not all offers for that ASIN.
    
    // First, try to get the SKU that was used for this fetch
    const { data: invData } = await supabase
      .from("inventory")
      .select("sku")
      .eq("user_id", userId)
      .eq("asin", asin)
      .limit(10); // Get all SKUs for this ASIN
    
    const skus = (invData || []).map((r: any) => r.sku).filter(Boolean);
    
    if (skus.length === 1) {
      // Single SKU for this ASIN - safe to update by ASIN
      await supabase
        .from("inventory")
        .update({ 
          price: result.price,
          my_price: result.price,
          updated_at: now,
        })
        .eq("user_id", userId)
        .eq("asin", asin);
      
      console.log(`Updated inventory.price for ASIN ${asin} (single SKU) to $${result.price}`);
    } else if (skus.length > 1) {
      // Multiple SKUs for this ASIN - only update the first one, log warning
      // In practice, the caller should pass the specific SKU to update
      console.warn(`[SKU-FIRST] Multiple SKUs found for ASIN ${asin}: ${skus.join(', ')}. Updating only first SKU to avoid overwriting wrong offer.`);
      
      await supabase
        .from("inventory")
        .update({ 
          price: result.price,
          my_price: result.price,
          updated_at: now,
        })
        .eq("user_id", userId)
        .eq("sku", skus[0]);
      
      console.log(`Updated inventory.price for SKU ${skus[0]} (ASIN ${asin}, multi-SKU) to $${result.price}`);
    } else {
      // No inventory record found - update by ASIN as fallback
      await supabase
        .from("inventory")
        .update({ 
          price: result.price,
          my_price: result.price,
          updated_at: now,
        })
        .eq("user_id", userId)
        .eq("asin", asin);
      
      console.log(`Updated inventory.price for ASIN ${asin} (no SKU in inventory) to $${result.price}`);
    }
  } else if (result.price && !isUsMarketplace) {
    console.log(`[SKIP] Not updating inventory.price for ASIN ${asin} - price is ${currency} ${result.price} from marketplace ${marketplaceId} (non-US)`);
  }
}
