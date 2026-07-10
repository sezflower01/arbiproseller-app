import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Fetch with retry for network errors
async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, options);
    } catch (e: any) {
      if (i === retries - 1) throw e;
      console.log(`Retry ${i + 1}/${retries} for ${url}: ${(e as Error).message}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error('All retries failed');
}

// AWS SigV4 signing helpers
async function getAwsSignature(
  method: string,
  url: string,
  accessToken: string,
  region: string,
  body?: string
): Promise<{ Authorization: string; 'x-amz-date': string; 'x-amz-security-token': string }> {
  const accessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const secretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const roleArn = Deno.env.get('AWS_ROLE_ARN')!;

  // Get STS credentials
  const stsUrl = 'https://sts.amazonaws.com/';
  const stsParams = new URLSearchParams({
    Action: 'AssumeRole',
    RoleArn: roleArn,
    RoleSessionName: 'sp-api-session',
    DurationSeconds: '3600',
    Version: '2011-06-15',
  });

  const stsDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const stsDateShort = stsDate.substring(0, 8);
  
  const encoder = new TextEncoder();
  
  async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey('raw', key as any,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  }

  async function hash(data: string): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getSigningKey(secretKey: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
    const kDate = await hmacSha256(encoder.encode('AWS4' + secretKey), date);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    return hmacSha256(kService, 'aws4_request');
  }

  // Sign STS request
  const stsPayload = stsParams.toString();
  const stsPayloadHash = await hash(stsPayload);
  const stsCanonicalRequest = [
    'POST',
    '/',
    '',
    'content-type:application/x-www-form-urlencoded',
    'host:sts.amazonaws.com',
    `x-amz-date:${stsDate}`,
    '',
    'content-type;host;x-amz-date',
    stsPayloadHash,
  ].join('\n');

  const stsStringToSign = [
    'AWS4-HMAC-SHA256',
    stsDate,
    `${stsDateShort}/us-east-1/sts/aws4_request`,
    await hash(stsCanonicalRequest),
  ].join('\n');

  const stsSigningKey = await getSigningKey(secretAccessKey, stsDateShort, 'us-east-1', 'sts');
  const stsSignature = Array.from(new Uint8Array(await hmacSha256(stsSigningKey, stsStringToSign)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const stsAuthHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${stsDateShort}/us-east-1/sts/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${stsSignature}`;

  const stsResponse = await fetchWithRetry(stsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-amz-date': stsDate,
      Authorization: stsAuthHeader,
    },
    body: stsPayload,
  });

  const stsText = await stsResponse.text();
  
  const tempAccessKeyId = stsText.match(/<AccessKeyId>([^<]+)<\/AccessKeyId>/)?.[1];
  const tempSecretAccessKey = stsText.match(/<SecretAccessKey>([^<]+)<\/SecretAccessKey>/)?.[1];
  const sessionToken = stsText.match(/<SessionToken>([^<]+)<\/SessionToken>/)?.[1];

  if (!tempAccessKeyId || !tempSecretAccessKey || !sessionToken) {
    throw new Error('Failed to get STS credentials');
  }

  // Now sign the SP-API request
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const path = parsedUrl.pathname + parsedUrl.search;
  const service = 'execute-api';

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);

  const payloadHash = await hash(body || '');
  
  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-access-token:${accessToken}`,
    `x-amz-date:${amzDate}`,
    `x-amz-security-token:${sessionToken}`,
  ].join('\n') + '\n';

  const signedHeaders = 'host;x-amz-access-token;x-amz-date;x-amz-security-token';

  const canonicalRequest = [
    method,
    parsedUrl.pathname,
    parsedUrl.search.substring(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await hash(canonicalRequest),
  ].join('\n');

  const signingKey = await getSigningKey(tempSecretAccessKey, dateStamp, region, service);
  const signature = Array.from(new Uint8Array(await hmacSha256(signingKey, stringToSign)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${tempAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    Authorization: authHeader,
    'x-amz-date': amzDate,
    'x-amz-security-token': sessionToken,
  };
}

// Get LWA access token
async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('SPAPI_LWA_CLIENT_ID') || Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('SPAPI_LWA_CLIENT_SECRET') || Deno.env.get('LWA_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('Missing LWA client credentials (SPAPI_LWA_CLIENT_ID/SECRET or LWA_CLIENT_ID/SECRET)');
  }

  const response = await fetchWithRetry('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error('LWA token endpoint error:', response.status, data);
    throw new Error(`Failed to get LWA access token (HTTP ${response.status})`);
  }

  if (!data?.access_token) {
    console.error('LWA token endpoint missing access_token:', data);
    throw new Error('Failed to get LWA access token');
  }

  return data.access_token;
}

// Call SP-API
async function callSpApi(
  path: string,
  accessToken: string,
  params: Record<string, string> = {},
  region = 'us-east-1',
  endpoint = 'https://sellingpartnerapi-na.amazon.com'
): Promise<any> {
  const url = new URL(path, endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const sigHeaders = await getAwsSignature('GET', url.toString(), accessToken, region);

  const response = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: {
      ...sigHeaders,
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SP-API error ${response.status}: ${errorText}`);
  }

  return response.json();
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

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );

    if (authError || !user) {
      throw new Error('Unauthorized');
    }

    const { asin } = await req.json();
    if (!asin) {
      throw new Error('ASIN is required');
    }

    console.log(`Fetching BSR for ASIN: ${asin}, user: ${user.id}`);

    // Get seller authorization
    const { data: authData, error: authDataError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id')
      .eq('user_id', user.id)
      .single();

    if (authDataError || !authData) {
      throw new Error('Amazon account not connected');
    }

    const marketplaceId = authData.marketplace_id || 'ATVPDKIKX0DER';
    
    // Get LWA access token
    const accessToken = await getLwaAccessToken(authData.refresh_token);

    // Fetch catalog item with salesRanks
    const result = await callSpApi(
      `/catalog/2022-04-01/items/${asin}`,
      accessToken,
      {
        marketplaceIds: marketplaceId,
        includedData: 'summaries,salesRanks'
      }
    );

    // Extract BSR from salesRanks
    const salesRanks = result?.salesRanks || [];
    let bsr: number | null = null;
    let category: string | null = null;

    for (const rankSet of salesRanks) {
      if (rankSet.marketplaceId === marketplaceId) {
        // Prefer displayGroupRanks (main category BSR)
        if (rankSet.displayGroupRanks && rankSet.displayGroupRanks.length > 0) {
          bsr = rankSet.displayGroupRanks[0].rank;
          category = rankSet.displayGroupRanks[0].title || null;
          break;
        }
        // Fallback to classificationRanks (subcategory BSR)
        if (!bsr && rankSet.classificationRanks && rankSet.classificationRanks.length > 0) {
          bsr = rankSet.classificationRanks[0].rank;
          category = rankSet.classificationRanks[0].title || null;
        }
      }
    }

    console.log(`BSR for ${asin}: ${bsr} in ${category}`);

    // Update inventory table with BSR
    if (bsr !== null) {
      await supabase
        .from('inventory')
        .update({ 
          bsr, 
          last_bsr_sync_at: new Date().toISOString() 
        })
        .eq('asin', asin)
        .eq('user_id', user.id);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        asin, 
        bsr, 
        category 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('fetch-bsr error:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { 
        status: (error as Error).message === 'Unauthorized' ? 401 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
