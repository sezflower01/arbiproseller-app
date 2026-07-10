import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from 'https://deno.land/std@0.177.0/node/crypto.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MARKETPLACE_ID_BY_CODE: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

const normalizeCondition = (raw: unknown) => {
  const normalized = String(raw || '').trim().toLowerCase().replace(/[_\s-]+/g, '');
  if (!normalized) return 'NEW';
  const map: Record<string, string> = {
    new: 'NEW',
    newnew: 'NEW',
    newitem: 'NEW',
    usedlikenew: 'USED - LIKE NEW',
    usedverygood: 'USED - VERY GOOD',
    usedgood: 'USED - GOOD',
    usedacceptable: 'USED - ACCEPTABLE',
    collectiblelikenew: 'COLLECTIBLE - LIKE NEW',
    collectibleverygood: 'COLLECTIBLE - VERY GOOD',
    collectiblegood: 'COLLECTIBLE - GOOD',
    collectibleacceptable: 'COLLECTIBLE - ACCEPTABLE',
    refurbished: 'RENEWED',
    renewed: 'RENEWED',
  };
  return map[normalized] || String(raw).trim().toUpperCase();
};

function hmacSha256(key: string | Uint8Array, data: string): Uint8Array {
  const hmac = createHmac('sha256', key as any);
  hmac.update(data);
  return new Uint8Array(hmac.digest());
}

function getSigningKey(key: string, dateStamp: string, region: string, service: string): Uint8Array {
  const kDate = hmacSha256(`AWS4${key}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function getAwsSignature(stringToSign: string, signingKey: Uint8Array): string {
  const hmac = createHmac('sha256', signingKey as any);
  hmac.update(stringToSign);
  return hmac.digest('hex');
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Missing LWA credentials');

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const clientIdPrefix = clientId.slice(0, 12);
    const refreshPrefix = refreshToken.slice(0, 8);
    throw new Error(`LWA token error: ${response.status} client_id_prefix=${clientIdPrefix} refresh_prefix=${refreshPrefix} body=${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function callSpApi(
  method: string,
  path: string,
  accessToken: string,
  queryParams: Record<string, string>,
): Promise<any> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  if (!awsAccessKeyId || !awsSecretAccessKey) throw new Error('Missing AWS SP-API credentials');

  const host = 'sellingpartnerapi-na.amazon.com';
  const service = 'execute-api';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const queryString = new URLSearchParams(queryParams).toString();
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const headers: Record<string, string> = {
    host,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
  };

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((key) => `${key}:${headers[key]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');
  const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const requestHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${requestHash}`;
  const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, service);
  const signature = getAwsSignature(stringToSign, signingKey);

  const response = await fetch(`https://${host}${path}?${queryString}`, {
    method,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SP-API ${response.status}: ${errorText.slice(0, 500)}`);
  }

  return await response.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization');

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const asin = String(body?.asin || '').trim().toUpperCase();
    const requestedMarketplaceId = body?.marketplaceId ? String(body.marketplaceId).trim() : null;
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      return new Response(JSON.stringify({ error: 'Invalid ASIN' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id, selling_partner_id, is_active')
      .eq('user_id', user.id);
    if (authError) throw authError;

    const activeRows = (authRows || []).filter((row: any) => row.is_active !== false && row.refresh_token);
    const sellerAuth = requestedMarketplaceId
      ? activeRows.find((row: any) => row.marketplace_id === requestedMarketplaceId)
      : activeRows.find((row: any) => row.marketplace_id === MARKETPLACE_ID_BY_CODE.US) || activeRows[0];

    if (!sellerAuth?.refresh_token) {
      return new Response(JSON.stringify({ error: 'Seller authorization not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const sellerId = sellerAuth.seller_id || sellerAuth.selling_partner_id || Deno.env.get('SPAPI_SELLER_ID');
    if (!sellerId) throw new Error('Seller ID not found');

    const accessToken = await getLwaAccessToken(sellerAuth.refresh_token);
    const listings: Array<Record<string, unknown>> = [];
    let pageToken: string | null = null;

    for (let page = 0; page < 5; page++) {
      const data = await callSpApi(
        'GET',
        `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
        accessToken,
        {
          marketplaceIds: sellerAuth.marketplace_id,
          identifiers: asin,
          identifiersType: 'ASIN',
          includedData: 'summaries,attributes,fulfillmentAvailability',
          pageSize: '20',
          ...(pageToken ? { pageToken } : {}),
        },
      );

      for (const item of data?.items || []) {
        const summary = Array.isArray(item?.summaries) ? item.summaries[0] : null;
        const sku = String(item?.sku || '').trim();
        if (!sku) continue;
        listings.push({
          sku,
          asin,
          title: summary?.itemName || null,
          condition: normalizeCondition(summary?.conditionType || summary?.condition || null),
          status: summary?.status || null,
        });
      }

      pageToken = data?.pagination?.nextToken || data?.nextToken || null;
      if (!pageToken) break;
    }

    const deduped = Array.from(new Map(listings.map((item) => [String(item.sku).toUpperCase(), item])).values());

    return new Response(JSON.stringify({
      asin,
      marketplaceId: sellerAuth.marketplace_id,
      sellerId,
      listings: deduped,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[discover-asin-listings] Error:', error?.message || error);
    return new Response(JSON.stringify({ error: error?.message || 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
