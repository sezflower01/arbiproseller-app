import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface MarketplaceConfig {
  id: string;
  name: string;
  currency: string;
  endpoint: string;
}

const MARKETPLACES: MarketplaceConfig[] = [
  { id: 'ATVPDKIKX0DER', name: 'US', currency: 'USD', endpoint: 'https://sellingpartnerapi-na.amazon.com' },
  { id: 'A2EUQ1WTGCTBG2', name: 'CA', currency: 'CAD', endpoint: 'https://sellingpartnerapi-na.amazon.com' },
  { id: 'A1AM78C64UM0Y8', name: 'MX', currency: 'MXN', endpoint: 'https://sellingpartnerapi-na.amazon.com' },
  { id: 'A2Q3Y263D00KWC', name: 'BR', currency: 'BRL', endpoint: 'https://sellingpartnerapi-na.amazon.com' },
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const { asin } = await req.json();
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
      throw new Error('Invalid ASIN format');
    }

    console.log(`Fetching listing prices AND FEES for ASIN: ${asin} across all marketplaces`);

    // Get seller authorizations
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', user.id);

    if (authError || !authRows || authRows.length === 0) {
      throw new Error('No Amazon seller authorization found. Please connect your Amazon account first.');
    }

    // Get access token (use any valid refresh token)
    const refreshToken = authRows[0].refresh_token;
    const accessToken = await getAccessToken(refreshToken);

    // Fetch FX rates from database
    const { data: fxRatesData } = await supabase
      .from('fx_rates')
      .select('quote, rate')
      .eq('base', 'USD');

    const fxRates: Record<string, number> = { USD: 1 };
    if (fxRatesData) {
      for (const fx of fxRatesData) {
        fxRates[fx.quote] = fx.rate;
      }
    }
    console.log('FX rates loaded:', fxRates);

    // Fetch prices AND FEES from all marketplaces in parallel
    const results = await Promise.all(
      MARKETPLACES.map(async (mp) => {
        try {
          const priceData = await fetchMarketplacePrice(asin, mp, accessToken);
          const fxRate = fxRates[mp.currency] || 1;
          
          // Fetch fees using the LISTING PRICE (consistent for comparison)
          // CRITICAL: Use the LOCAL CURRENCY price, not USD
          const referencePrice = priceData.listingPrice || priceData.buyBoxPrice || priceData.landedPrice;
          let feesData = null;
          
          if (referencePrice && referencePrice > 0) {
            console.log(`[FEES] Fetching fees for ${asin} in ${mp.name} at ${mp.currency} ${referencePrice} (using listing price)`);
            feesData = await fetchMarketplaceFees(asin, mp.id, mp.currency, referencePrice, accessToken);
          }
          
          return {
            marketplace: mp.name,
            marketplaceId: mp.id,
            currency: mp.currency,
            fxRate,
            // Prices in USD
            listingPriceUsd: priceData.listingPrice !== null ? +(priceData.listingPrice / fxRate).toFixed(2) : null,
            buyBoxPriceUsd: priceData.buyBoxPrice !== null ? +(priceData.buyBoxPrice / fxRate).toFixed(2) : null,
            landedPriceUsd: priceData.landedPrice !== null ? +(priceData.landedPrice / fxRate).toFixed(2) : null,
            // Raw local prices
            ...priceData,
            // Fees in local currency AND USD
            fees: feesData ? {
              referralFeeLocal: feesData.referralFee,
              fbaFeeLocal: feesData.fbaFee,
              totalFeesLocal: feesData.totalFees,
              referralFeeUsd: +(feesData.referralFee / fxRate).toFixed(2),
              fbaFeeUsd: +(feesData.fbaFee / fxRate).toFixed(2),
              totalFeesUsd: +(feesData.totalFees / fxRate).toFixed(2),
              feeCurrency: feesData.currency,
              feeSource: 'fees_api',
            } : null,
          };
        } catch (error: any) {
          console.error(`Error fetching ${mp.name}:`, (error as Error).message);
          return {
            marketplace: mp.name,
            marketplaceId: mp.id,
            currency: mp.currency,
            fxRate: fxRates[mp.currency] || 1,
            error: (error as Error).message,
            listingPrice: null,
            buyBoxPrice: null,
            landedPrice: null,
            shippingPrice: null,
            condition: null,
            listingPriceUsd: null,
            buyBoxPriceUsd: null,
            landedPriceUsd: null,
            fees: null,
          };
        }
      })
    );

    // Also fetch product title from US marketplace
    let productTitle = null;
    try {
      productTitle = await fetchProductTitle(asin, accessToken, 'ATVPDKIKX0DER');
    } catch (e) {
      console.error('Failed to fetch product title:', e);
    }

    return new Response(
      JSON.stringify({
        success: true,
        asin,
        productTitle,
        fxRates,
        prices: results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Fetch listing prices error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message || 'Failed to fetch listing prices',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function getAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('LWA credentials not configured');
  }

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('LWA token error:', errorText);
    throw new Error('Failed to get access token');
  }

  const data = await response.json();
  return data.access_token;
}

async function fetchMarketplacePrice(
  asin: string,
  marketplace: MarketplaceConfig,
  accessToken: string
): Promise<{
  listingPrice: number | null;
  buyBoxPrice: number | null;
  landedPrice: number | null;
  shippingPrice: number | null;
  condition: string | null;
}> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  const path = `/products/pricing/v0/items/${asin}/offers`;
  const queryParams = `MarketplaceId=${marketplace.id}&ItemCondition=New`;
  const url = `${marketplace.endpoint}${path}?${queryParams}`;
  const host = new URL(marketplace.endpoint).host;

  // AWS SigV4 signing
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const service = 'execute-api';

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const payloadHash = await sha256('');

  const canonicalRequest = `GET\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const canonicalRequestHash = await sha256(canonicalRequest);

  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHash}`;

  const signingKey = await getSigningKey(awsSecretAccessKey, date, awsRegion, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': authorizationHeader,
      'x-amz-access-token': accessToken,
      'x-amz-date': timestamp,
      'host': host,
    },
  });

  const responseText = await response.text();
  console.log(`${marketplace.name} Pricing API status: ${response.status}`);

  if (!response.ok) {
    if (response.status === 404) {
      return { listingPrice: null, buyBoxPrice: null, landedPrice: null, shippingPrice: null, condition: null };
    }
    throw new Error(`API error ${response.status}: ${responseText.substring(0, 200)}`);
  }

  const data = JSON.parse(responseText);
  
  // Extract prices from response
  const summary = data?.payload?.Summary;
  const offers = data?.payload?.Offers || [];

  let listingPrice: number | null = null;
  let buyBoxPrice: number | null = null;
  let landedPrice: number | null = null;
  let shippingPrice: number | null = null;
  let condition: string | null = null;

  // Get BuyBox price from Summary
  const buyBoxPrices = summary?.BuyBoxPrices || [];
  if (buyBoxPrices.length > 0) {
    const newBuyBox = buyBoxPrices.find((p: any) => p.condition === 'New');
    if (newBuyBox) {
      buyBoxPrice = newBuyBox.LandedPrice?.Amount || newBuyBox.ListingPrice?.Amount || null;
      landedPrice = newBuyBox.LandedPrice?.Amount || null;
    }
  }

  // Get listing price from first offer
  if (offers.length > 0) {
    const firstOffer = offers[0];
    listingPrice = firstOffer.ListingPrice?.Amount || null;
    shippingPrice = firstOffer.Shipping?.Amount || null;
    condition = firstOffer.SubCondition || firstOffer.ItemCondition || null;
    if (!landedPrice && firstOffer.ListingPrice?.Amount) {
      landedPrice = (firstOffer.ListingPrice?.Amount || 0) + (firstOffer.Shipping?.Amount || 0);
    }
  }

  // Fallback to LowestPrices
  if (!listingPrice && summary?.LowestPrices) {
    const newLowest = summary.LowestPrices.find((p: any) => p.condition === 'New' && p.fulfillmentChannel === 'Amazon');
    if (newLowest) {
      listingPrice = newLowest.ListingPrice?.Amount || newLowest.LandedPrice?.Amount || null;
    }
  }

  return { listingPrice, buyBoxPrice, landedPrice, shippingPrice, condition };
}

// NEW: Fetch fees from Amazon Fees API using LOCAL CURRENCY price
async function fetchMarketplaceFees(
  asin: string,
  marketplaceId: string,
  currency: string,
  priceLocal: number,
  accessToken: string
): Promise<{ referralFee: number; fbaFee: number; totalFees: number; currency: string } | null> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = `/products/fees/v0/items/${asin}/feesEstimate`;
  const url = `${endpoint}${path}`;
  const host = 'sellingpartnerapi-na.amazon.com';

  // Build request body with LOCAL CURRENCY price
  const requestBody = JSON.stringify({
    FeesEstimateRequest: {
      MarketplaceId: marketplaceId,
      IsAmazonFulfilled: true,
      PriceToEstimateFees: {
        ListingPrice: {
          CurrencyCode: currency,
          Amount: priceLocal,
        },
      },
      Identifier: asin,
    },
  });

  console.log(`[FEES API] Request for ${asin}: marketplace=${marketplaceId}, price=${currency} ${priceLocal}`);

  // AWS SigV4 signing for POST
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const service = 'execute-api';

  const payloadHash = await sha256(requestBody);
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const canonicalRequestHash = await sha256(canonicalRequest);

  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHash}`;

  const signingKey = await getSigningKey(awsSecretAccessKey, date, awsRegion, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authorizationHeader,
      'x-amz-access-token': accessToken,
      'x-amz-date': timestamp,
      'host': host,
      'Content-Type': 'application/json',
    },
    body: requestBody,
  });

  const responseText = await response.text();
  console.log(`[FEES API] ${marketplaceId} status: ${response.status}`);

  if (!response.ok) {
    console.error(`[FEES API] Error for ${asin} in ${marketplaceId}: ${responseText.substring(0, 300)}`);
    return null;
  }

  try {
    const data = JSON.parse(responseText);
    const result = data?.payload?.FeesEstimateResult;
    const status = String(result?.Status ?? '').toLowerCase();
    
    if (status && status !== 'success') {
      console.warn(`[FEES API] Non-success status for ${asin}: ${result?.Status}`);
      return null;
    }

    const feeDetails = result?.FeesEstimate?.FeeDetailList;
    if (!Array.isArray(feeDetails) || feeDetails.length === 0) {
      console.warn(`[FEES API] No fee details for ${asin}`);
      return null;
    }

    let referralFee = 0;
    let fbaFee = 0;
    let feeCurrency = currency;

    for (const fee of feeDetails) {
      const type = String(fee?.FeeType ?? '');
      const amount = parseFloat(fee?.FeeAmount?.Amount ?? '0') || 0;
      const curr = fee?.FeeAmount?.CurrencyCode;
      if (curr) feeCurrency = curr;

      console.log(`[FEES API] ${asin} ${marketplaceId} fee: ${type} = ${amount} ${feeCurrency}`);

      if (type === 'ReferralFee' || type.includes('Referral')) {
        referralFee += amount;
      } else if (type === 'FBAFees' || type.startsWith('FBA') || type.includes('Fulfillment')) {
        fbaFee += amount;
      }
      // Skip ClosingFee for now (not charged on pending orders)
    }

    const totalFees = referralFee + fbaFee;
    console.log(`[FEES API] ✅ ${asin} ${marketplaceId}: referral=${referralFee}, fba=${fbaFee}, total=${totalFees} ${feeCurrency}`);

    return { referralFee, fbaFee, totalFees, currency: feeCurrency };
  } catch (err) {
    console.error(`[FEES API] Parse error for ${asin}:`, err);
    return null;
  }
}

async function fetchProductTitle(asin: string, accessToken: string, marketplaceId: string): Promise<string | null> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = `/catalog/2022-04-01/items/${asin}`;
  const queryParams = `marketplaceIds=${marketplaceId}&includedData=summaries`;
  const url = `${endpoint}${path}?${queryParams}`;
  const host = 'sellingpartnerapi-na.amazon.com';

  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const service = 'execute-api';

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const payloadHash = await sha256('');
  const canonicalRequest = `GET\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const canonicalRequestHash = await sha256(canonicalRequest);

  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHash}`;

  const signingKey = await getSigningKey(awsSecretAccessKey, date, awsRegion, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': authorizationHeader,
      'x-amz-access-token': accessToken,
      'x-amz-date': timestamp,
      'host': host,
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const summaries = data?.summaries || [];
  if (summaries.length > 0) {
    return summaries[0].itemName || null;
  }
  return null;
}

// Crypto helpers
async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data as any);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function hmacHex(key: ArrayBuffer, message: string): Promise<string> {
  const sig = await hmac(key, message);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSigningKey(secret: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode('AWS4' + secret), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  return kSigning;
}
