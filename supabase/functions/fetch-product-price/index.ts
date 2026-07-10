import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Retry helper for network/DNS errors
async function fetchWithRetry(url: string, options: any, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (error: any) {
      lastError = error;
      const errorMessage = error?.message || String(error);
      
      if (errorMessage.includes('dns error') || 
          errorMessage.includes('name resolution') ||
          errorMessage.includes('client error')) {
        
        if (attempt < maxRetries - 1) {
          const delayMs = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
      }
      
      throw error;
    }
  }
  
  throw lastError || new Error('All retry attempts failed');
}

// AWS SigV4 signing
function getAwsSignature(stringToSign: string, kSigning: Uint8Array): string {
  const hmac = createHmac('sha256', kSigning as any);
  hmac.update(stringToSign);
  return hmac.digest('hex');
}

function hmacSha256(key: string | Uint8Array, data: string): Uint8Array {
  const hmac = createHmac('sha256', key as any);
  hmac.update(data);
  return new Uint8Array(hmac.digest());
}

function getSigningKey(key: string, dateStamp: string, region: string, service: string): Uint8Array {
  const kDate = hmacSha256(`AWS4${key}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return kSigning;
}

async function getLwaAccessToken(): Promise<string> {
  const clientId = Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  const refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing LWA credentials');
  }

  const response = await fetchWithRetry('https://api.amazon.com/auth/o2/token', {
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
    throw new Error(`LWA token error: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function callSpApi(path: string, accessToken: string, queryParams: Record<string, string> = {}): Promise<any> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error('Missing AWS credentials');
  }

  const host = 'sellingpartnerapi-na.amazon.com';
  const service = 'execute-api';
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const queryString = new URLSearchParams(queryParams).toString();
  const canonicalUri = path;
  const canonicalQueryString = queryString;
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const canonicalRequest = `GET\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  
  const encoder = new TextEncoder();
  const data = encoder.encode(canonicalRequest);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as any);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const requestHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${requestHash}`;
  const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, service);
  const signature = getAwsSignature(stringToSign, signingKey);

  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}${queryString ? '?' + queryString : ''}`;
  
  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: {
      'host': host,
      'x-amz-date': amzDate,
      'x-amz-access-token': accessToken,
      'Authorization': authorizationHeader,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('SP-API Error:', errorText);
    throw new Error(`SP-API request failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // NOTE: This function does not access user-private data.
    // We rely on Supabase's JWT verification at the edge (verify_jwt=true by default)
    // and avoid calling supabase.auth.getUser() here to prevent intermittent network/auth failures
    // from crashing the UI with 500 errors.

    const { asin, marketplaceId = 'ATVPDKIKX0DER' } = await req.json();

    if (!asin) {
      throw new Error('ASIN is required');
    }

    // Validate ASIN format: must be exactly 10 alphanumeric characters (typically starts with B0 for products)
    const asinRegex = /^[A-Z0-9]{10}$/i;
    if (!asinRegex.test(asin)) {
      console.warn(`Invalid ASIN format rejected: ${asin}`);
      return new Response(
        JSON.stringify({
          error: 'INVALID_ASIN',
          message: `"${asin}" is not a valid ASIN format. ASINs must be exactly 10 alphanumeric characters.`,
          asin,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Fetching product price for ASIN: ${asin}`);

    const accessToken = await getLwaAccessToken();

    // Get product details from Catalog Items API
    let catalogData: any;
    try {
      catalogData = await callSpApi(
        `/catalog/2022-04-01/items/${asin}`,
        accessToken,
        { marketplaceIds: marketplaceId, includedData: 'attributes,images,summaries' }
      );
    } catch (err) {
      const message = err instanceof Error ? (err as Error).message : String(err);
      console.error('Catalog API error for ASIN', asin, message);

      if (message.includes('404') || message.includes('NOT_FOUND')) {
        console.log(`ASIN ${asin} not found in marketplace ${marketplaceId}`);
        return new Response(
          JSON.stringify({
            error: 'NOT_FOUND',
            message: `Requested item ${asin} not found in marketplace ${marketplaceId}`,
            asin,
            marketplaceId,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (message.includes('429') || message.includes('QuotaExceeded')) {
        console.warn('SP-API quota exceeded for ASIN', asin, message);
        return new Response(
          JSON.stringify({
            error: 'QUOTA_EXCEEDED',
            message: 'You exceeded your SP-API quota for this resource.',
            asin,
            marketplaceId,
            statusCode: 429,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      throw err;
    }

    const item = catalogData;
    const title = item?.summaries?.[0]?.itemName || item?.attributes?.item_name?.[0]?.value || 'Unknown Product';
    const imageUrl = item?.images?.[0]?.images?.[0]?.link || '';

    // Get competitive pricing
    let price = 0;
    try {
      const pricingData = await callSpApi(
        '/products/pricing/v0/items/' + asin + '/offers',
        accessToken,
        { MarketplaceId: marketplaceId, ItemCondition: 'New' }
      );

      console.log('Pricing API response:', JSON.stringify(pricingData, null, 2));

      const summary = pricingData?.payload?.Summary;
      const buyBoxPrices = summary?.BuyBoxPrices || [];

      if (buyBoxPrices.length > 0) {
        const validPrices = buyBoxPrices
          .map((bp: any) => bp?.LandedPrice?.Amount || bp?.ListingPrice?.Amount || 0)
          .filter((p: number) => p > 0);
        
        if (validPrices.length > 0) {
          price = Math.max(...validPrices);
          console.log('Using highest Buy Box price (with shipping):', price);
        }
      } else {
        const lowestPrices = summary?.LowestPrices || [];
        const fbmLowest = lowestPrices.find((p: any) => p.fulfillmentChannel === 'Merchant') || lowestPrices[0];

        if (fbmLowest) {
          price = fbmLowest?.LandedPrice?.Amount || fbmLowest?.ListingPrice?.Amount || 0;
          console.log('Using lowest FBM price (with shipping if available):', price);
        } else {
          const offers = pricingData?.payload?.Offers || [];
          if (offers.length > 0) {
            price = offers[0]?.LandedPrice?.Amount || offers[0]?.ListingPrice?.Amount || 0;
            console.log('Using first offer price (with shipping if available):', price);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching pricing:', error);
    }

    // Fetch fees using Product Fees API if we have a price
    let totalFees = 0;
    let feesBreakdown: any = null;
    if (price > 0) {
      try {
        const feesBody = {
          FeesEstimateRequest: {
            MarketplaceId: marketplaceId,
            IsAmazonFulfilled: true,
            PriceToEstimateFees: {
              ListingPrice: { CurrencyCode: 'USD', Amount: price },
              Shipping: { CurrencyCode: 'USD', Amount: 0 }
            },
            Identifier: asin
          }
        };

        // POST request for fees
        const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
        const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
        const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
        const host = 'sellingpartnerapi-na.amazon.com';
        const service = 'execute-api';
        
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
        const dateStamp = amzDate.slice(0, 8);
        
        const feesPath = `/products/fees/v0/items/${asin}/feesEstimate`;
        const bodyStr = JSON.stringify(feesBody);
        
        const encoder = new TextEncoder();
        const bodyBuffer = encoder.encode(bodyStr);
        const bodyHashBuffer = await crypto.subtle.digest('SHA-256', bodyBuffer as any);
        const bodyHashArray = Array.from(new Uint8Array(bodyHashBuffer));
        const payloadHash = bodyHashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        
        const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
        const signedHeaders = 'content-type;host;x-amz-date';
        const canonicalRequest = `POST\n${feesPath}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
        
        const algorithm = 'AWS4-HMAC-SHA256';
        const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
        
        const requestData = encoder.encode(canonicalRequest);
        const requestHashBuffer = await crypto.subtle.digest('SHA-256', requestData as any);
        const requestHashArray = Array.from(new Uint8Array(requestHashBuffer));
        const requestHash = requestHashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        
        const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${requestHash}`;
        const signingKey = getSigningKey(awsSecretAccessKey!, dateStamp, region, service);
        const signature = getAwsSignature(stringToSign, signingKey);
        
        const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
        
        const feesUrl = `https://${host}${feesPath}`;
        
        const feesResponse = await fetchWithRetry(feesUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'host': host,
            'x-amz-date': amzDate,
            'x-amz-access-token': accessToken,
            'Authorization': authorizationHeader,
          },
          body: bodyStr
        });
        
        if (feesResponse.ok) {
          const feesData = await feesResponse.json();
          console.log('Fees API response:', JSON.stringify(feesData, null, 2));
          
          const feesDetail = feesData?.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList || [];
          feesBreakdown = {};
          
          for (const fee of feesDetail) {
            const feeType = fee.FeeType;
            const feeAmount = fee.FeeAmount?.Amount || 0;
            feesBreakdown[feeType] = feeAmount;
            totalFees += feeAmount;
          }
          
          console.log('Total fees calculated:', totalFees, 'Breakdown:', feesBreakdown);
        } else {
          const errorText = await feesResponse.text();
          console.error('Fees API error:', feesResponse.status, errorText);
        }
      } catch (feesError) {
        console.error('Error fetching fees:', feesError);
      }
    }

    return new Response(
      JSON.stringify({
        asin,
        title,
        imageUrl,
        price,
        totalFees,
        feesBreakdown
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
