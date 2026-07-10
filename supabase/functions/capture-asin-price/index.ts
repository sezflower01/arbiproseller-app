import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface MarketplaceConfig {
  id: string;
  name: string;
  currency: string;
  endpoint: string;
}

const MARKETPLACES: Record<string, MarketplaceConfig> = {
  US: { id: "ATVPDKIKX0DER", name: "US", currency: "USD", endpoint: "https://sellingpartnerapi-na.amazon.com" },
  CA: { id: "A2EUQ1WTGCTBG2", name: "CA", currency: "CAD", endpoint: "https://sellingpartnerapi-na.amazon.com" },
  MX: { id: "A1AM78C64UM0Y8", name: "MX", currency: "MXN", endpoint: "https://sellingpartnerapi-na.amazon.com" },
  BR: { id: "A2Q3Y263D00KWC", name: "BR", currency: "BRL", endpoint: "https://sellingpartnerapi-na.amazon.com" },
};

// AWS SigV4 signing utilities
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

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, "aws4_request");
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string
): Promise<Record<string, string>> {
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
    const errorText = await response.text();
    throw new Error(`LWA token error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

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

// Fetch YOUR listing price via Listings Items API (not Buy Box)
async function fetchListingPrice(
  sku: string,
  sellerId: string,
  marketplaceId: string,
  accessToken: string
): Promise<{ price: number | null; currency: string | null; source: string; error?: string }> {
  try {
    const path = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`;
    const response = await callSpApi("GET", path, {
      marketplaceIds: marketplaceId,
      includedData: "offers,summaries",
    }, accessToken);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Listings API error for SKU ${sku}: ${response.status} - ${errorText}`);

      if (response.status === 429) {
        return { price: null, currency: null, source: "listings_api", error: "rate_limit" };
      }
      if (response.status === 403) {
        return { price: null, currency: null, source: "listings_api", error: "authorization_required" };
      }
      return { price: null, currency: null, source: "listings_api", error: `API ${response.status}` };
    }

    const data = await response.json();
    console.log(`Listings API response for SKU ${sku}:`, JSON.stringify(data, null, 2).slice(0, 1500));

    let price: number | null = null;
    let currency: string | null = null;

    // Extract price from offers
    if (data.offers && Array.isArray(data.offers)) {
      for (const offer of data.offers) {
        const rawAmount =
          offer.price?.amount ||
          offer.price?.listingPrice?.amount ||
          offer.listingPrice?.amount ||
          offer.ourPrice?.amount ||
          offer.regularPrice?.amount ||
          offer.offerPrice?.amount ||
          offer.purchasableOffer?.price?.amount;

        const priceValue = typeof rawAmount === "string" ? parseFloat(rawAmount) : rawAmount;

        if (priceValue && typeof priceValue === "number" && !isNaN(priceValue) && priceValue > 0) {
          price = priceValue;
          currency = offer.price?.currency || offer.listingPrice?.currency || null;
          console.log(`Found price in offers: ${price} ${currency}`);
          break;
        }
      }
    }

    // Fallback: check summaries
    if (!price && data.summaries && Array.isArray(data.summaries)) {
      for (const summary of data.summaries) {
        const priceValue = summary.price?.listingPrice?.amount || summary.price?.amount;
        if (priceValue && typeof priceValue === "number" && priceValue > 0) {
          price = priceValue;
          currency = summary.price?.listingPrice?.currency || summary.price?.currency || null;
          console.log(`Found price in summaries: ${price} ${currency}`);
          break;
        }
      }
    }

    // Fallback: check attributes
    if (!price && data.attributes) {
      const purchasableOffer = data.attributes.purchasable_offer;
      if (Array.isArray(purchasableOffer)) {
        for (const po of purchasableOffer) {
          const ourPrice = po.our_price?.[0]?.schedule?.[0]?.value_with_tax;
          if (ourPrice && typeof ourPrice === "number" && ourPrice > 0) {
            price = ourPrice;
            currency = po.our_price?.[0]?.currency || null;
            console.log(`Found price in attributes: ${price} ${currency}`);
            break;
          }
        }
      }
    }

    if (price) {
      return { price, currency, source: "listings_api" };
    }

    return { price: null, currency: null, source: "listings_api", error: "no_price_in_response" };
  } catch (err) {
    console.error(`Error fetching listing price for SKU ${sku}:`, err);
    return { price: null, currency: null, source: "listings_api", error: String(err) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = claimsData.claims.sub as string;
    const { asin, sku, marketplace = "US" } = await req.json();

    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
      return new Response(JSON.stringify({ error: "Invalid ASIN format" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const marketplaceConfig = MARKETPLACES[marketplace];
    if (!marketplaceConfig) {
      return new Response(JSON.stringify({ error: "Invalid marketplace" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get seller authorization - try marketplace-specific first, then US fallback
    const { data: authRows } = await supabase
      .from("seller_authorizations")
      .select("refresh_token, seller_id, selling_partner_id, marketplace_id")
      .eq("user_id", userId);

    if (!authRows || authRows.length === 0) {
      return new Response(JSON.stringify({ 
        error: "No Amazon authorization found. Please reconnect via Grant Us Access.",
        authorizationRequired: true 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Find correct auth for this marketplace, fallback to US
    const authData = authRows.find((a) => a.marketplace_id === marketplaceConfig.id) ||
                     authRows.find((a) => a.marketplace_id === "ATVPDKIKX0DER") ||
                     authRows[0];

    const sellerId = authData.selling_partner_id || authData.seller_id;
    if (!sellerId) {
      return new Response(JSON.stringify({ error: "No seller ID found in authorization" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If SKU not provided, try to find it from inventory
    let effectiveSku = sku;
    if (!effectiveSku) {
      const { data: invRow } = await supabase
        .from("inventory")
        .select("sku")
        .eq("user_id", userId)
        .eq("asin", asin)
        .maybeSingle();
      
      if (invRow?.sku) {
        effectiveSku = invRow.sku;
      }
    }

    if (!effectiveSku) {
      return new Response(JSON.stringify({ 
        error: "SKU required. Could not find SKU for this ASIN in your inventory.",
        needsSku: true 
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get LWA access token
    const accessToken = await getLwaAccessToken(authData.refresh_token);

    // Fetch YOUR listing price via Listings Items API
    const result = await fetchListingPrice(effectiveSku, sellerId, marketplaceConfig.id, accessToken);

    if (result.error === "authorization_required") {
      return new Response(JSON.stringify({
        error: "Product Listing permission required. Please enable 'Product Listing' role in Amazon Seller Central and reconnect.",
        authorizationRequired: true,
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (result.error === "rate_limit") {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (result.price === null) {
      return new Response(JSON.stringify({ 
        error: result.error || "No listing price found for this SKU/ASIN",
        message: "Listing may be inactive or have no price set" 
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const currency = result.currency || marketplaceConfig.currency;

    // Get FX rate if non-USD
    let fxRate: number | null = null;
    let priceUsd: number | null = null;

    if (currency !== "USD") {
      const { data: fxData } = await supabase
        .from("fx_rates")
        .select("rate")
        .eq("quote", currency)
        .maybeSingle();

      if (fxData?.rate) {
        fxRate = fxData.rate;
        priceUsd = fxRate ? result.price / fxRate : result.price;
      }
    } else {
      priceUsd = result.price;
    }

    // Upsert to asin_my_price_cache for fast UI access
    const { error: cacheError } = await supabase
      .from("asin_my_price_cache")
      .upsert({
        user_id: userId,
        asin,
        marketplace_id: marketplaceConfig.id,
        seller_sku: effectiveSku || '__NO_SKU__',
        my_price: result.price,
        currency,
        fetched_at: new Date().toISOString(),
        source: "listings_api",
        attempt_count: 0,
        last_error: null,
        next_retry_at: null,
      }, {
        onConflict: "user_id,asin,marketplace_id,seller_sku",
      });

    if (cacheError) {
      console.error("Failed to update asin_my_price_cache:", cacheError);
    }

    // Also insert to price history for tracking
    const { error: historyError } = await supabase
      .from("asin_price_history")
      .insert({
        user_id: userId,
        asin,
        marketplace,
        listing_price: result.price,
        buybox_price: null, // Listings API doesn't return Buy Box
        currency_code: currency,
        price_usd: priceUsd,
        fx_rate: fxRate,
        source: "listings_api",
      });

    if (historyError && historyError.code !== "23505") {
      console.error("Failed to insert price history:", historyError);
    }

    // ONLY update inventory.price for US marketplace - non-US prices are stored in asin_my_price_cache
    // The inventory table has a single price/my_price per SKU, which should reflect the US price
    // Non-US prices should be fetched from asin_my_price_cache using marketplace_id filter
    if (marketplace === "US") {
      const { error: invUpdateError } = await supabase
        .from("inventory")
        .update({ 
          price: result.price, 
          my_price: result.price,
          updated_at: new Date().toISOString() 
        })
        .eq("user_id", userId)
        .eq("sku", effectiveSku);

      if (invUpdateError) {
        console.error("Failed to update inventory price:", invUpdateError);
      }
    }

    console.log(`Fetched and cached price for ASIN ${asin} / SKU ${effectiveSku} in ${marketplace}: ${currency} ${result.price}`);

    return new Response(JSON.stringify({
      success: true,
      data: {
        listing_price: result.price,
        currency_code: currency,
        price_usd: priceUsd,
        fx_rate: fxRate,
        marketplace,
        sku: effectiveSku,
        source: "listings_api",
      },
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in capture-asin-price:", error);
    const message = error instanceof Error ? (error as Error).message : String(error);
    return new Response(JSON.stringify({ error: message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
