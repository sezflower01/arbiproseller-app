import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AWS SigV4 signing utilities
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest('SHA-256', data as any);
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string
): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';

  const urlObj = new URL(url);
  const host = urlObj.host;
  const path = urlObj.pathname + urlObj.search;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = toHex(await sha256(body));

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    toHex(await sha256(canonicalRequest))
  ].join('\n');

  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Authorization': authorizationHeader,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': host,
  };
}

async function getLWAAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID')!;
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET')!;

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
    throw new Error(`LWA token refresh failed: ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function fetchFinancialEventGroups(
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<any[]> {
  const allGroups: any[] = [];
  let nextToken: string | null = null;

  // Amazon requires end date to be no later than 2 minutes from now
  const maxEndDate = new Date(Date.now() - 2 * 60 * 1000);
  const requestedEndDate = new Date(endDate);
  const effectiveEndDate = requestedEndDate > maxEndDate ? maxEndDate : requestedEndDate;

  do {
    const params = new URLSearchParams({
      FinancialEventGroupStartedAfter: startDate,
      FinancialEventGroupStartedBefore: effectiveEndDate.toISOString(),
      MaxResultsPerPage: '100',
    });

    if (nextToken) {
      params.set('NextToken', nextToken);
    }

    const url = `https://sellingpartnerapi-na.amazon.com/finances/v0/financialEventGroups?${params.toString()}`;
    const headers = await signRequest('GET', url, '', accessToken);

    console.log(`Fetching financial event groups: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 429) {
      console.log('Rate limited, waiting 2 seconds...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Financial event groups API error: ${response.status} - ${errorText}`);
      throw new Error(`Financial event groups API failed: ${response.status}`);
    }

    const data = await response.json();
    const groups = data.payload?.FinancialEventGroupList || [];
    allGroups.push(...groups);

    nextToken = data.payload?.NextToken || null;
    console.log(`Fetched ${groups.length} groups, total: ${allGroups.length}, hasMore: ${!!nextToken}`);

    if (nextToken) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (nextToken);

  return allGroups;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const authHeader = req.headers.get('Authorization');

    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { startDate, endDate } = await req.json();

    if (!startDate || !endDate) {
      return new Response(JSON.stringify({ error: 'startDate and endDate are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get seller authorization - fetch all and pick US or first available
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id')
      .eq('user_id', user.id);

    const authData = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];

    if (authError || !authData?.refresh_token) {
      return new Response(JSON.stringify({ error: 'No Amazon seller authorization found' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Fetching settlements for user ${user.id} from ${startDate} to ${endDate}`);

    // Get LWA access token
    const accessToken = await getLWAAccessToken(authData.refresh_token);

    // Fetch financial event groups (settlements)
    const groups = await fetchFinancialEventGroups(accessToken, startDate, endDate);

    // Transform data for frontend
    const settlements = groups.map((group: any) => ({
      id: group.FinancialEventGroupId,
      status: group.ProcessingStatus,
      fundTransferStatus: group.FundTransferStatus,
      fundTransferDate: group.FundTransferDate,
      originalTotal: group.OriginalTotal?.CurrencyAmount || 0,
      currency: group.OriginalTotal?.CurrencyCode || 'USD',
      convertedTotal: group.ConvertedTotal?.CurrencyAmount || 0,
      beginningBalance: group.BeginningBalance?.CurrencyAmount || 0,
      accountTail: group.AccountTail,
      traceId: group.TraceId,
      periodStart: group.FinancialEventGroupStart,
      periodEnd: group.FinancialEventGroupEnd,
    }));

    console.log(`Found ${settlements.length} settlements`);

    return new Response(JSON.stringify({ settlements }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error fetching settlements:', error);
    // HEALTH SIGNAL: top-level fatal — derive userId from auth header
    try {
      const authHeader = req.headers.get('Authorization');
      if (authHeader) {
        const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        const { data: { user: fatalUser } } = await sb.auth.getUser(authHeader.replace('Bearer ', ''));
        if (fatalUser?.id) {
          await HealthSignals.settlementSyncError(fatalUser.id, 'fetch-settlements', `Fatal: ${(error as Error).message}`);
        }
      }
    } catch { /* never throw */ }
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
