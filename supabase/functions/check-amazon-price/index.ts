import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface CheckPriceRequest {
  inventoryId: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const body: CheckPriceRequest = await req.json();
    console.log('Check Amazon price request:', body);

    // Load inventory item
    const { data: item, error: itemError } = await supabase
      .from('inventory')
      .select('*')
      .eq('id', body.inventoryId)
      .eq('user_id', user.id)
      .single();

    if (itemError || !item) {
      throw new Error('Inventory item not found or you do not have permission');
    }

    // Get all seller authorizations for this user (multi-marketplace)
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', user.id);

    // Prefer US marketplace, fallback to first available
    const sellerAuth = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (authError || !sellerAuth) {
      throw new Error('Amazon seller account not connected. Please connect your account first.');
    }

    // Get fresh access token
    const accessToken = await getAccessToken(sellerAuth.refresh_token, supabase, user.id);
    console.log('Got access token for price check');

    // Fetch live price from Amazon Pricing API
    const livePrice = await fetchLivePriceFromAmazon({
      asin: item.asin,
      sku: item.sku,
      accessToken,
      marketplaceId: sellerAuth.marketplace_id,
    });

    console.log('Fetched live price:', livePrice);

    // Update DB with amazon_price and last_price_confirmed_at
    const now = new Date().toISOString();
    await supabase
      .from('inventory')
      .update({
        amazon_price: livePrice,
        last_price_confirmed_at: now,
      })
      .eq('id', body.inventoryId);

    // Calculate propagation time if both timestamps exist
    let propagationTime: string | null = null;
    if (item.last_price_update_at) {
      const updateTime = new Date(item.last_price_update_at);
      const confirmedTime = new Date(now);
      const diffMs = confirmedTime.getTime() - updateTime.getTime();
      const diffSeconds = Math.floor(diffMs / 1000);
      const diffMinutes = Math.floor(diffSeconds / 60);

      if (diffMinutes > 0) {
        propagationTime = `${diffMinutes} minute(s) ${diffSeconds % 60} second(s)`;
      } else {
        propagationTime = `${diffSeconds} second(s)`;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        myPrice: item.my_price,
        amazonPrice: livePrice,
        lastUpdateAt: item.last_price_update_at,
        lastConfirmedAt: now,
        propagationTime,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Check Amazon price error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message || 'Failed to check Amazon price'
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});

import { exchangeLwaToken } from '../_shared/lwa-token.ts';
async function getAccessToken(refreshToken: string, supabase?: any, userId?: string | null): Promise<string> {
  return await exchangeLwaToken(refreshToken, supabase, userId);
}

async function fetchLivePriceFromAmazon(params: {
  asin: string;
  sku: string;
  accessToken: string;
  marketplaceId: string;
}): Promise<number | null> {
  const { asin, sku, accessToken, marketplaceId } = params;

  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error('AWS credentials not configured');
  }

  const endpoint = `https://sellingpartnerapi-na.amazon.com`;
  const path = `/products/pricing/v0/items/${asin}/offers`;
  const queryParams = `MarketplaceId=${marketplaceId}&ItemCondition=New`;
  const url = `${endpoint}${path}?${queryParams}`;
  const host = 'sellingpartnerapi-na.amazon.com';
  const method = 'GET';
  const service = 'execute-api';

  // Create canonical request
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const encoder = new TextEncoder();
  const payloadHash = await crypto.subtle.digest('SHA-256', encoder.encode(''));
  const payloadHashHex = Array.from(new Uint8Array(payloadHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;

  // Create string to sign
  const canonicalRequestHash = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHashHex}`;

  // Calculate signature
  const getSignatureKey = async (key: string, dateStamp: string, regionName: string, serviceName: string) => {
    const kDate = await hmacSha256(encoder.encode('AWS4' + key), encoder.encode(dateStamp));
    const kRegion = await hmacSha256(kDate, encoder.encode(regionName));
    const kService = await hmacSha256(kRegion, encoder.encode(serviceName));
    const kSigning = await hmacSha256(kService, encoder.encode('aws4_request'));
    return kSigning;
  };

  const hmacSha256 = async (key: ArrayBuffer | Uint8Array, data: Uint8Array): Promise<ArrayBuffer> => {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return await crypto.subtle.sign('HMAC', cryptoKey, data as BufferSource);
  };

  const signingKey = await getSignatureKey(awsSecretAccessKey, date, awsRegion, service);
  const signature = await hmacSha256(signingKey, encoder.encode(stringToSign));
  const signatureHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;

  console.log('Fetching price from:', url);

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
  console.log('Pricing API response status:', response.status);
  console.log('Pricing API response body:', responseText);

  if (!response.ok) {
    throw new Error(`SP-API Pricing error (${response.status}): ${responseText}`);
  }

  const data = JSON.parse(responseText);
  
  // Extract price from response - prioritize BuyBox price with highest LandedPrice
  const offers = data?.payload?.Summary?.BuyBoxPrices || [];
  if (offers.length > 0) {
    let maxPrice = 0;
    for (const offer of offers) {
      const landedPrice = offer?.LandedPrice?.Amount || offer?.ListingPrice?.Amount || 0;
      if (landedPrice > maxPrice) {
        maxPrice = landedPrice;
      }
    }
    return maxPrice > 0 ? maxPrice : null;
  }

  return null;
}
