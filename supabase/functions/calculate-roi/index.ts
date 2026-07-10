import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface FeeBreakdown {
  referralFee: number;
  fbaFee: number;
  variableClosingFee: number;
  otherFees: number;
  totalFees: number;
  profit: number;
  roi: number;
  margin: number;
}

function feesAndRoi(
  amzPrice: number,
  buyCost: number,
  actualFees?: { referralFee: number; fbaFee: number; variableClosingFee: number; otherFees: number }
): FeeBreakdown {
  // STRICT: This calculator REQUIRES actual fees - if not provided, return zeros
  // No hardcoded fallbacks (15%, $3.22) - caller must provide real fee data
  const referralFee = actualFees?.referralFee ?? 0;
  const fbaFee = actualFees?.fbaFee ?? 0;
  const variableClosingFee = actualFees?.variableClosingFee ?? 0;
  const otherFees = actualFees?.otherFees ?? 0;
  const totalFees = referralFee + fbaFee + variableClosingFee + otherFees;
  const profit = amzPrice - buyCost - totalFees;
  const roi = buyCost > 0 ? (profit / buyCost) * 100 : 0;
  const margin = amzPrice > 0 ? (profit / amzPrice) * 100 : 0;

  return {
    referralFee: parseFloat(referralFee.toFixed(2)),
    fbaFee: parseFloat(fbaFee.toFixed(2)),
    variableClosingFee: parseFloat(variableClosingFee.toFixed(2)),
    otherFees: parseFloat(otherFees.toFixed(2)),
    totalFees: parseFloat(totalFees.toFixed(2)),
    profit: parseFloat(profit.toFixed(2)),
    roi: parseFloat(roi.toFixed(2)),
    margin: parseFloat(margin.toFixed(2)),
  };
}

// AWS SigV4 signing implementation
async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string
): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const awsSecretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const awsRegion = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error("Missing AWS credentials");
  }

  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname;
  const path = parsedUrl.pathname + parsedUrl.search;
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  // Create canonical request
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  
  const encoder = new TextEncoder();
  const bodyHash = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  const payloadHash = Array.from(new Uint8Array(bodyHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  
  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${awsRegion}/execute-api/aws4_request`;
  
  const canonicalRequestHash = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHashHex}`;
  
  // Calculate signature
  const getSignatureKey = async (key: string, dateStamp: string, regionName: string, serviceName: string) => {
    const kDate = await hmac(`AWS4${key}`, dateStamp);
    const kRegion = await hmac(kDate, regionName);
    const kService = await hmac(kRegion, serviceName);
    const kSigning = await hmac(kService, 'aws4_request');
    return kSigning;
  };
  
  const hmac = async (key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> => {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      typeof key === 'string' ? encoder.encode(key) : key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  };
  
  const signingKey = await getSignatureKey(awsSecretAccessKey, dateStamp, awsRegion, 'execute-api');
  const signature = await hmac(signingKey, stringToSign);
  const signatureHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;
  
  return {
    "Authorization": authorizationHeader,
    "x-amz-access-token": accessToken,
    "x-amz-date": amzDate,
    "Content-Type": "application/json",
  };
}

async function getLWAAccessToken(): Promise<string> {
  const clientId = Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("SPAPI_LWA_CLIENT_SECRET");
  const refreshToken = Deno.env.get("SPAPI_REFRESH_TOKEN");

  console.log("[calculate-roi] LWA creds check:", {
    hasClientId: !!clientId,
    clientIdPrefix: clientId?.substring(0, 20),
    hasClientSecret: !!clientSecret,
    secretPrefix: clientSecret?.substring(0, 25),
    hasRefreshToken: !!refreshToken,
  });

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing SP-API credentials");
  }

  const tokenUrl = "https://api.amazon.com/auth/o2/token";
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error("[calculate-roi] LWA token error:", response.status, errBody);
    throw new Error(`LWA token error: ${response.status} - ${errBody}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Marketplace configuration for multi-region support
const MARKETPLACE_CONFIG: Record<string, { id: string; currency: string; endpoint: string }> = {
  US: { id: "ATVPDKIKX0DER", currency: "USD", endpoint: "sellingpartnerapi-na.amazon.com" },
  CA: { id: "A2EUQ1WTGCTBG2", currency: "CAD", endpoint: "sellingpartnerapi-na.amazon.com" },
  MX: { id: "A1AM78C64UM0Y8", currency: "MXN", endpoint: "sellingpartnerapi-na.amazon.com" },
  BR: { id: "A2Q3Y263D00KWC", currency: "BRL", endpoint: "sellingpartnerapi-na.amazon.com" },
};

function getMarketplaceConfig(marketplace: string) {
  return MARKETPLACE_CONFIG[marketplace] || MARKETPLACE_CONFIG.US;
}

function isQuotaExceededError(message: string): boolean {
  return /quota[_ ]?exceeded|429|rate limit/i.test(message);
}

async function getCachedBuyBoxData(
  supabase: ReturnType<typeof createClient>,
  asin: string,
  marketplace: string,
): Promise<{ price: number; totalFees: number | null } | null> {
  const config = getMarketplaceConfig(marketplace);
  const { data, error } = await supabase
    .from("buy_box_cache")
    .select("price, total_fees, fetched_at")
    .eq("asin", asin)
    .eq("marketplace_id", config.id)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data || !Number.isFinite(Number(data.price)) || Number(data.price) <= 0) {
    return null;
  }

  return {
    price: Number(data.price),
    totalFees: data.total_fees == null || !Number.isFinite(Number(data.total_fees))
      ? null
      : Number(data.total_fees),
  };
}

async function getCachedFeeFallback(
  supabase: ReturnType<typeof createClient>,
  userId: string | null,
  asin: string,
  marketplace: string,
  price: number,
  cachedTotalFees: number | null,
): Promise<{ referralFee: number; fbaFee: number; variableClosingFee: number; otherFees: number } | null> {
  if (userId) {
    const { data } = await supabase
      .from("asin_fee_cache")
      .select("referral_rate, fba_fee_fixed")
      .eq("user_id", userId)
      .eq("asin", asin)
      .eq("marketplace", marketplace)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      const referralFee = Number(price) * Number(data.referral_rate ?? 0);
      const fbaFee = Number(data.fba_fee_fixed ?? 0);
      const knownFees = referralFee + fbaFee;
      const otherFees = cachedTotalFees != null && cachedTotalFees > knownFees
        ? cachedTotalFees - knownFees
        : 0;

      return {
        referralFee,
        fbaFee,
        variableClosingFee: 0,
        otherFees,
      };
    }
  }

  if (cachedTotalFees != null && cachedTotalFees > 0) {
    return {
      referralFee: 0,
      fbaFee: 0,
      variableClosingFee: 0,
      otherFees: cachedTotalFees,
    };
  }

  return null;
}

async function getProductFees(asin: string, price: number, accessToken: string, marketplace: string = "US", maxRetries = 3) {
  const config = getMarketplaceConfig(marketplace);
  const marketplaceId = config.id;
  const currency = config.currency;
  const endpoint = config.endpoint;
  
  const feesUrl = `https://${endpoint}/products/fees/v0/items/${asin}/feesEstimate`;
  const feesBody = JSON.stringify({
    FeesEstimateRequest: {
      MarketplaceId: marketplaceId,
      IsAmazonFulfilled: true,
      PriceToEstimateFees: {
        ListingPrice: { CurrencyCode: currency, Amount: price }
      },
      Identifier: asin
    }
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const feesHeaders = await signRequest("POST", feesUrl, feesBody, accessToken);
    const feesResp = await fetch(feesUrl, {
      method: "POST",
      headers: feesHeaders,
      body: feesBody,
    });

    if (feesResp.ok) {
      const feesData = await feesResp.json();
      console.log('Amazon Fees API full response:', JSON.stringify(feesData, null, 2));
      const feeDetails = feesData.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList;
      if (!feeDetails) return null;

      let referralFee = 0, fbaFee = 0, variableClosingFee = 0, otherFees = 0;
      for (const fee of feeDetails) {
        const amount = parseFloat(fee.FeeAmount?.Amount || 0);
        console.log(`Fee: ${fee.FeeType} = $${amount}`);
        if (fee.FeeType === "ReferralFee") referralFee = amount;
        else if (fee.FeeType === "FBAFees") fbaFee = amount;
        else if (fee.FeeType === "VariableClosingFee") variableClosingFee = amount;
        else otherFees += amount;
      }
      console.log(`Total extracted fees - Referral: $${referralFee}, FBA: $${fbaFee}, Variable Closing: $${variableClosingFee}, Other: $${otherFees}`);
      return { referralFee, fbaFee, variableClosingFee, otherFees };
    }

    if (feesResp.status === 429 && attempt < maxRetries) {
      const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
      console.log(`[calculate-roi] Fees 429 rate limit, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const errorText = await feesResp.text();
    console.error(`Fees API error ${feesResp.status}:`, errorText);
    if (feesResp.status === 429) {
      throw new Error('QUOTA_EXCEEDED: Amazon SP-API rate limit reached. Please wait a few minutes and try again.');
    } else if (feesResp.status === 403 || feesResp.status === 401) {
      throw new Error(`SP-API authentication failed: ${feesResp.status} - Invalid AWS credentials or LWA token`);
    } else {
      throw new Error(`SP-API Fees calculation failed: ${feesResp.status}`);
    }
  }
  return null;
}

async function getRainforestPriceHistory(asin: string): Promise<Array<{ date: string; price: number }>> {
  // Rainforest price history disabled by configuration; return empty history to rely solely on SP-API data
  console.log('Price history via Rainforest disabled; returning empty history for ASIN', asin);
  return [];
}

async function getRainforestLowestNewPrice(asin: string): Promise<{ price: number; source: string } | null> {
  // Rainforest lowest-new-price fallback disabled; rely exclusively on SP-API pricing
  console.log('Rainforest lowest new price disabled; skipping fallback for ASIN', asin);
  return null;
}

async function enrichAsinWithSPAPI(
  asin: string,
  marketplace: string = "US",
  supabase?: ReturnType<typeof createClient>,
  userId?: string | null,
) {
  const accessToken = await getLWAAccessToken();
  const config = getMarketplaceConfig(marketplace);
  const marketplaceId = config.id;
  const endpoint = config.endpoint;
  const domain = marketplace === "US" ? "amazon.com" : 
                 marketplace === "CA" ? "amazon.ca" :
                 marketplace === "MX" ? "amazon.com.mx" :
                 marketplace === "BR" ? "amazon.com.br" : "amazon.com";
  let cachedTotalFees: number | null = null;

  // Get product info
  const catalogUrl = `https://${endpoint}/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=summaries,images`;
  const catalogHeaders = await signRequest("GET", catalogUrl, "", accessToken);

  const catalogResp = await fetch(catalogUrl, {
    method: "GET",
    headers: catalogHeaders,
  });

  let title = "";
  let imageUrl = `https://images-na.ssl-images-amazon.com/images/I/41qN3q3KPUL.jpg`;
  const link = `https://www.${domain}/dp/${asin}`;

  if (!catalogResp.ok) {
    const errorText = await catalogResp.text();
    console.error(`Catalog API error ${catalogResp.status}:`, errorText);
    
    if (catalogResp.status === 403 || catalogResp.status === 401) {
      throw new Error(`SP-API authentication failed: ${catalogResp.status} - Invalid AWS credentials or LWA token`);
    } else if (catalogResp.status === 404) {
      throw new Error(`Product not found: ASIN may be invalid or not available in this marketplace`);
    } else {
      console.warn(`[calculate-roi] Catalog unavailable for ${asin}; continuing without catalog metadata`);
    }
  } else {
    const catalogData = await catalogResp.json();
    title = catalogData.summaries?.[0]?.itemName || "";
    imageUrl =
      catalogData.images?.[0]?.images?.[0]?.link ||
      imageUrl;
  }

  // Get pricing info - Try multiple API endpoints
  let price = 0;
  let priceSource = "unavailable";
  
  // Method 1: Try GetPricing API (Competitive Pricing)
  const competitivePricingUrl = `https://${endpoint}/products/pricing/v0/price?MarketplaceId=${marketplaceId}&Asins=${asin}&ItemType=Asin`;
  const compPricingHeaders = await signRequest("GET", competitivePricingUrl, "", accessToken);
  
  const compPricingResp = await fetch(competitivePricingUrl, {
    method: "GET",
    headers: compPricingHeaders,
  });

  if (compPricingResp.ok) {
    const compPricingData = await compPricingResp.json();
    console.log('Competitive Pricing API response:', JSON.stringify(compPricingData, null, 2));
    
    // Try to get lowest landed price from competitive pricing
    const priceInfo = compPricingData.payload?.[0];
    if (priceInfo?.Product?.CompetitivePricing?.CompetitivePrices) {
      const competitivePrices = priceInfo.Product.CompetitivePricing.CompetitivePrices;
      // Look for Amazon or Featured Offer (Buy Box)
      const lowestCompPrice = competitivePrices.find((cp: any) => 
        cp.CompetitivePriceId === "1" || cp.belongsToRequester === false
      );
      
      if (lowestCompPrice?.Price?.LandedPrice?.Amount) {
        price = parseFloat(lowestCompPrice.Price.LandedPrice.Amount);
        priceSource = "competitive_pricing";
        console.log(`Using Competitive Pricing API price: $${price}`);
      }
    }
    
    // If still no price, try OfferListingCount
    if (price === 0 && priceInfo?.Product?.Offers) {
      const offers = priceInfo.Product.Offers;
      if (offers?.length > 0) {
        const lowestOffer = offers.sort((a: any, b: any) => {
          const priceA = parseFloat(a.ListingPrice?.Amount || "999999");
          const priceB = parseFloat(b.ListingPrice?.Amount || "999999");
          return priceA - priceB;
        })[0];
        
        if (lowestOffer?.ListingPrice?.Amount) {
          price = parseFloat(lowestOffer.ListingPrice.Amount);
          priceSource = "offer_listing";
          console.log(`Using Offer Listing price: $${price}`);
        }
      }
    }
  } else {
    const errorText = await compPricingResp.text();
    console.error('Competitive Pricing API failed:', compPricingResp.status, errorText);
    
    if (compPricingResp.status === 403 || compPricingResp.status === 401) {
      throw new Error(`SP-API authentication failed: ${compPricingResp.status} - Invalid AWS credentials or LWA token`);
    } else {
      console.warn(`[calculate-roi] Competitive pricing unavailable for ${asin}; trying offers/cache fallback`);
    }
  }
  
  // Method 2: Always call GetItemOffers — needed for both fallback pricing AND
  // Amazon-as-seller detection (used by Store Scan to filter out listings where
  // Amazon itself is the dominant seller).
  let amazonPresence: {
    isAmazonOnListing: boolean;
    isAmazonBuyBoxWinner: boolean;
    amazonOfferCount: number;
    totalOfferCount: number;
    nonAmazonOfferCount: number;
    isAmazonDominant: boolean;
  } | null = null;

  {
    const offersUrl = `https://${endpoint}/products/pricing/v0/items/${asin}/offers?MarketplaceId=${marketplaceId}&ItemCondition=New`;
    const offersHeaders = await signRequest("GET", offersUrl, "", accessToken);

    const offersResp = await fetch(offersUrl, {
      method: "GET",
      headers: offersHeaders,
    });

    if (offersResp.ok) {
      const offersData = await offersResp.json();
      console.log('Item Offers API response:', JSON.stringify(offersData, null, 2));

      // ─── Amazon-as-seller detection (always parse, regardless of price source) ───
      try {
        const AMAZON_SELLER_ID = "ATVPDKIKX0DER";
        const allOffers = (offersData.payload?.Offers ?? []) as any[];
        const totalOfferCount = allOffers.length;
        const amazonOfferCount = allOffers.filter((o) => o?.SellerId === AMAZON_SELLER_ID).length;
        const nonAmazonOfferCount = totalOfferCount - amazonOfferCount;

        // Buy Box winner detection: BuyBoxPrices entries carry sellerId; also
        // check the offers list for IsBuyBoxWinner === true on Amazon.
        const bbSellerIds: string[] = (offersData.payload?.Summary?.BuyBoxPrices ?? [])
          .map((b: any) => b?.sellerId || b?.SellerId)
          .filter(Boolean);
        const isAmazonBuyBoxWinner =
          bbSellerIds.includes(AMAZON_SELLER_ID) ||
          allOffers.some((o) => o?.SellerId === AMAZON_SELLER_ID && (o?.IsBuyBoxWinner === true));

        const isAmazonOnListing = amazonOfferCount > 0;

        // Dominant = Amazon owns Buy Box AND has effectively no real 3P competition.
        // Conservative threshold: ≤1 non-Amazon offer means Amazon controls supply.
        const isAmazonDominant = isAmazonBuyBoxWinner && nonAmazonOfferCount <= 1;

        amazonPresence = {
          isAmazonOnListing,
          isAmazonBuyBoxWinner,
          amazonOfferCount,
          totalOfferCount,
          nonAmazonOfferCount,
          isAmazonDominant,
        };
        console.log(`[calculate-roi] amazonPresence ASIN=${asin} bb=${isAmazonBuyBoxWinner} amzOffers=${amazonOfferCount}/${totalOfferCount} dominant=${isAmazonDominant}`);
      } catch (e) {
        console.warn(`[calculate-roi] Failed to parse amazonPresence for ${asin}:`, e);
      }

      // ─── Price fallback (only if comp-pricing didn't yield one) ───
      if (price === 0) {
      // Try 1: Buy Box price (best case)
      const buyBoxPrice = offersData.payload?.Summary?.BuyBoxPrices?.[0]?.LandedPrice?.Amount;
      if (buyBoxPrice) {
        price = parseFloat(buyBoxPrice);
        priceSource = "buybox";
        console.log(`Using Buy Box price: $${price}`);
      } 
      // Try 2: Lowest New offer price from Summary
      else {
        // Try 2: Lowest New offer price from Summary (case-insensitive)
        const lowestNewSummaryPrices = (offersData.payload?.Summary?.LowestPrices || [])
          .filter((p: any) => {
            const cond = (p?.condition || p?.conditionType || '').toString().toLowerCase();
            return cond === 'new';
          })
          .map((p: any) => parseFloat(p?.LandedPrice?.Amount || p?.ListingPrice?.Amount || '0'))
          .filter((n: number) => Number.isFinite(n) && n > 0);

        if (lowestNewSummaryPrices.length > 0) {
          price = Math.min(...lowestNewSummaryPrices);
          priceSource = "lowest_new";
          console.log(`Using Lowest New offer price from Summary: $${price}`);
        }
        // Try 3: Check individual offers (compute landed = Listing + Shipping when needed)
        else if (offersData.payload?.Offers?.length > 0) {
          const offerPrices: number[] = (offersData.payload.Offers as any[])
            .filter((o: any) => {
              const cond = (o?.SubCondition || o?.ItemCondition || '').toString().toLowerCase();
              return cond === 'new';
            })
            .map((o: any) => {
              const landed = parseFloat(o?.BuyingPrice?.LandedPrice?.Amount || '0');
              if (Number.isFinite(landed) && landed > 0) return landed;
              const listing = parseFloat(o?.ListingPrice?.Amount || '0');
              const shipping = parseFloat(o?.Shipping?.Amount || '0');
              const total = listing + shipping;
              return Number.isFinite(total) && total > 0 ? total : 0;
            })
            .filter((n: number) => Number.isFinite(n) && n > 0);

          if (offerPrices.length > 0) {
            price = Math.min(...offerPrices);
            priceSource = "seller_offer";
            console.log(`Using lowest seller offer (landed): $${price}`);
          }
        }
      }
      } // end if (price === 0) — price fallback block
    } else {
      const errorText = await offersResp.text();
      console.error('Item Offers API failed:', offersResp.status, errorText);

      if (offersResp.status === 403 || offersResp.status === 401) {
        throw new Error(`SP-API authentication failed: ${offersResp.status} - Invalid AWS credentials or LWA token`);
      } else {
        console.warn(`[calculate-roi] Item offers unavailable for ${asin}; trying cache fallback`);
      }
    }
  } // end always-on GetItemOffers block

  if (price === 0 && supabase) {
    const cached = await getCachedBuyBoxData(supabase, asin, marketplace);
    if (cached) {
      price = cached.price;
      cachedTotalFees = cached.totalFees;
      priceSource = "buy_box_cache";
      console.log(`[calculate-roi] Using cached Buy Box price for ${asin}: $${price}`);
    }
  }
  
  if (price === 0) {
    // Fallback to Rainforest API lowest new offer
    const rf = await getRainforestLowestNewPrice(asin);
    if (rf && rf.price > 0) {
      price = rf.price;
      priceSource = rf.source;
      console.log(`Using Rainforest lowest new price: $${price}`);
    } else {
      console.log('No price found from any API endpoint for ASIN:', asin);
    }
  }
 
  // Get actual fees from Amazon using the correct marketplace
  let fees = null;
  if (price > 0) {
    try {
      fees = await getProductFees(asin, price, accessToken, marketplace);
    } catch (error) {
      const message = error instanceof Error ? (error as Error).message : String(error);
      if (!isQuotaExceededError(message)) throw error;
      console.warn(`[calculate-roi] Fees rate-limited for ${asin}; trying fee cache fallback`);
    }

    if (!fees && supabase) {
      fees = await getCachedFeeFallback(supabase, userId ?? null, asin, marketplace, price, cachedTotalFees);
      if (fees) {
        console.log(`[calculate-roi] Using cached fees for ${asin}`);
      }
    }
  }

  return { title, price, imageUrl, link, fees, priceSource, amazonPresence };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Accept optional 'price' and 'marketplace' parameters
    // marketplace: US, CA, MX, BR - determines which Amazon marketplace to use
    // price: Override the fetched price (for "Actual ROI" calculations)
    const { asin, cost, price: overridePrice, marketplace = "US" } = await req.json();
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') || '';
    const { data: { user: authUser } } = await supabase.auth.getUser(token);
    const resolvedUserId = authUser?.id ?? null;

    if (!asin) {
      return new Response(
        JSON.stringify({ error: "ASIN is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[calculate-roi] ASIN: ${asin}, Marketplace: ${marketplace}, Cost (USD): ${cost}, Override Price: ${overridePrice}`);

    // Fetch product data from Amazon using the correct marketplace
    const productData = await enrichAsinWithSPAPI(asin, marketplace, supabase as any, resolvedUserId);

    // If caller provided a price override, use it instead of the fetched Buy Box price
    // This is used for "Actual ROI" which uses the user's listing price
    if (overridePrice && overridePrice > 0) {
      console.log(`Using override price: ${overridePrice} instead of fetched price: ${productData.price}`);
      productData.price = overridePrice;
      productData.priceSource = "override";
      
      // Recalculate fees based on the override price using correct marketplace
      const accessToken = await getLWAAccessToken();
        try {
          const newFees = await getProductFees(asin, overridePrice, accessToken, marketplace);
          if (newFees) {
            productData.fees = newFees;
          }
        } catch (error) {
          const message = error instanceof Error ? (error as Error).message : String(error);
          if (!isQuotaExceededError(message)) throw error;
          const cachedFees = await getCachedFeeFallback(supabase as any, resolvedUserId, asin, marketplace, overridePrice, null);
          if (cachedFees) {
            productData.fees = cachedFees;
            console.log(`[calculate-roi] Using cached override fees for ${asin}`);
          }
      }
    }

    // Fetch price history in parallel
    console.log('Fetching price history from Rainforest...');
    const priceHistory = await getRainforestPriceHistory(asin);

    // If cost is provided, calculate ROI
    // === HOME-CURRENCY-AWARE FX CONVERSION ===
    // Cost is in seller's home currency — convert to marketplace currency
    const { convertCurrency, getSellerHomeCurrency } = await import('../_shared/fx-utils.ts');
    const homeCurrency = resolvedUserId ? await getSellerHomeCurrency(supabase, resolvedUserId) : 'USD';
    
    let calculation = null;
    const usdCost = cost ? parseFloat(cost) : null;
    let localCost = usdCost;
    let fxRateUsed = 1;
    const config = getMarketplaceConfig(marketplace);
    
    if (usdCost !== null && homeCurrency !== config.currency) {
      const fxResult = await convertCurrency(usdCost, homeCurrency, config.currency, supabase);
      fxRateUsed = fxResult.fxRate;
      localCost = fxResult.converted;
      console.log(`[calculate-roi] FX conversion: ${homeCurrency} ${usdCost} → ${config.currency} ${localCost!.toFixed(2)} (rate: ${fxRateUsed.toFixed(4)})`);
    }
    
    // Calculate ROI using SAME FORMULA as calculate-roi-range:
    // ROI = (LocalPrice - LocalCost - LocalFees) / LocalCost * 100
    if (localCost !== null && localCost > 0 && productData.price > 0) {
      calculation = feesAndRoi(productData.price, localCost, productData.fees || undefined);
      console.log(`[calculate-roi] Calculation: price=${config.currency}${productData.price}, localCost=${config.currency}${localCost.toFixed(2)}, fees=${config.currency}${calculation.totalFees}, ROI=${calculation.roi}%`);
    }

    // Refresh asin_fee_cache with the live SP-API fees so the repricer table
    // ROI display matches the calculator.
    //
    // CURRENCY CONTRACT (2026-06-22): asin_fee_cache.fba_fee_fixed is USD.
    // productData.fees.fbaFee is in MARKETPLACE-LOCAL currency (same as
    // productData.price). For non-US marketplaces we MUST convert local→USD
    // before upserting, otherwise sync-sales-orders enrichment will treat
    // e.g. R$18.45 as $18.45 and inflate fees / break ROI.
    // referral_rate is a currency-neutral fraction so it doesn't need FX.
    if (
      resolvedUserId &&
      productData.fees &&
      productData.price > 0 &&
      ((productData.fees.referralFee ?? 0) > 0 || (productData.fees.fbaFee ?? 0) > 0)
    ) {
      try {
        const refRate = (productData.fees.referralFee ?? 0) / productData.price;
        const fbaFeeLocal = productData.fees.fbaFee ?? 0;
        let fbaFeeUsd = fbaFeeLocal;
        let fxOk = true;
        if (config.currency && config.currency !== 'USD' && fbaFeeLocal > 0) {
          const fxToUsd = await convertCurrency(fbaFeeLocal, config.currency, 'USD', supabase);
          if (fxToUsd && Number.isFinite(fxToUsd.converted) && fxToUsd.converted > 0) {
            fbaFeeUsd = fxToUsd.converted;
            console.log(`[calculate-roi] FEE_CACHE FX: ${config.currency} ${fbaFeeLocal.toFixed(2)} → USD ${fbaFeeUsd.toFixed(2)} (rate=${fxToUsd.fxRate})`);
          } else {
            fxOk = false;
            console.warn(`[calculate-roi] FEE_CACHE FX unavailable for ${config.currency}→USD; SKIPPING cache upsert to avoid native-as-USD corruption`);
          }
        }
        if (fxOk) {
          await (supabase as any)
            .from('asin_fee_cache')
            .upsert({
              user_id: resolvedUserId,
              asin,
              marketplace,
              referral_rate: Number.isFinite(refRate) && refRate > 0 ? refRate : 0.15,
              fba_fee_fixed: fbaFeeUsd,
              fee_source: 'sp_api_live',
              last_verified_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id,asin,marketplace' });
          console.log(`[calculate-roi] Refreshed asin_fee_cache for ${asin}/${marketplace} fba_usd=$${fbaFeeUsd.toFixed(2)} (local ${config.currency} ${fbaFeeLocal.toFixed(2)})`);
        }
      } catch (cacheErr) {
        console.warn('[calculate-roi] Failed to refresh asin_fee_cache:', cacheErr);
      }
    }

    return new Response(
      JSON.stringify({
        asin,
        title: productData.title,
        imageUrl: productData.imageUrl,
        price: productData.price,
        priceSource: productData.priceSource,
        link: productData.link,
        calculation,
        priceHistory,
        amazonPresence: productData.amazonPresence ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in calculate-roi:", error);
    const message = error instanceof Error ? (error as Error).message : String(error);
    const status = message?.includes('QUOTA_EXCEEDED') ? 429 : 500;
    return new Response(
      JSON.stringify({ error: message }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
