// Diagnostic probe: read-only. Fetches `getListingsItem` with includedData=summaries,issues
// for up to 5 enabled+rule-assigned SKUs per marketplace (US/CA/MX/BR) and returns the
// raw response so we can verify:
//   - HTTP status per marketplace (403 vs 200 vs 200-with-empty)
//   - summaries[] non-empty (proves auth scope, not silent-empty)
//   - real Amazon `issues[].code` strings vs our mapping table
// No writes. No mutation. Safe to run repeatedly.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from 'https://deno.land/std@0.177.0/node/crypto.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MARKETPLACES: Array<{ code: string; id: string }> = [
  { code: 'US', id: 'ATVPDKIKX0DER' },
  { code: 'CA', id: 'A2EUQ1WTGCTBG2' },
  { code: 'MX', id: 'A1AM78C64UM0Y8' },
  { code: 'BR', id: 'A2Q3Y263D00KWC' },
];

const SAMPLE_LIMIT = 5;

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
function sig(stringToSign: string, signingKey: Uint8Array): string {
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
    const t = await response.text();
    throw new Error(`LWA ${response.status}: ${t.slice(0, 300)}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function callGetListingsItem(
  accessToken: string,
  sellerId: string,
  sku: string,
  marketplaceId: string,
): Promise<{ http_status: number; body: any; error?: string }> {
  const awsKey = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecret = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  if (!awsKey || !awsSecret) throw new Error('Missing AWS creds');

  const host = 'sellingpartnerapi-na.amazon.com';
  const service = 'execute-api';
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: 'summaries,issues',
  }).toString();

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const headers: Record<string, string> = {
    host,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = `GET\n${path}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const reqHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest))),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${reqHash}`;
  const signingKey = getSigningKey(awsSecret, dateStamp, region, service);
  const signature = sig(stringToSign, signingKey);

  const resp = await fetch(`https://${host}${path}?${query}`, {
    method: 'GET',
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${awsKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  const text = await resp.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    return { http_status: resp.status, body: null, error: `Non-JSON body: ${text.slice(0, 300)}` };
  }
  return { http_status: resp.status, body };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const jwt = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: auths } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id, selling_partner_id, is_active')
      .eq('user_id', user.id);

    const activeAuths = (auths || []).filter((a: any) => a.is_active !== false && a.refresh_token);

    const probes: any[] = [];

    for (const mp of MARKETPLACES) {
      const auth = activeAuths.find((a: any) => a.marketplace_id === mp.id);
      if (!auth) {
        probes.push({
          marketplace: mp.code,
          marketplace_id: mp.id,
          status: 'NO_AUTH',
          note: 'No active seller_authorization row for this marketplace',
          samples: [],
        });
        continue;
      }

      const sellerId = auth.seller_id || auth.selling_partner_id;
      if (!sellerId) {
        probes.push({
          marketplace: mp.code,
          marketplace_id: mp.id,
          status: 'NO_SELLER_ID',
          samples: [],
        });
        continue;
      }

      // Pick up to SAMPLE_LIMIT enabled+rule-assigned SKUs for this marketplace.
      const { data: assignmentsRaw } = await supabase
        .from('repricer_assignments')
        .select('sku, asin, marketplace, is_enabled, rule_id')
        .eq('user_id', user.id)
        .eq('marketplace', mp.code)
        .eq('is_enabled', true)
        .not('rule_id', 'is', null)
        .not('sku', 'is', null)
        .limit(SAMPLE_LIMIT * 3);

      const assignments = (assignmentsRaw || []).filter((r: any) => r.sku).slice(0, SAMPLE_LIMIT);

      if (assignments.length === 0) {
        probes.push({
          marketplace: mp.code,
          marketplace_id: mp.id,
          status: 'NO_SAMPLES',
          note: 'No enabled+rule-assigned SKUs available to sample',
          samples: [],
        });
        continue;
      }

      let accessToken: string;
      try {
        accessToken = await getLwaAccessToken(auth.refresh_token);
      } catch (e: any) {
        probes.push({
          marketplace: mp.code,
          marketplace_id: mp.id,
          status: 'LWA_ERROR',
          error: String(e?.message || e),
          samples: [],
        });
        continue;
      }

      const samples: any[] = [];
      for (const a of assignments) {
        try {
          const { http_status, body, error } = await callGetListingsItem(
            accessToken,
            sellerId,
            a.sku,
            mp.id,
          );
          const summaries = Array.isArray(body?.summaries) ? body.summaries : [];
          const issues = Array.isArray(body?.issues) ? body.issues : [];
          samples.push({
            sku: a.sku,
            asin: a.asin,
            http_status,
            summaries_count: summaries.length,
            summaries_first: summaries[0] || null,
            issues_count: issues.length,
            issues, // full raw array — this is the payload we're verifying
            error: error || (body?.errors ? body.errors : null),
          });
        } catch (e: any) {
          samples.push({
            sku: a.sku,
            asin: a.asin,
            http_status: 0,
            error: String(e?.message || e),
          });
        }
        // ~4 req/s throttle inside a single marketplace
        await new Promise((r) => setTimeout(r, 250));
      }

      probes.push({
        marketplace: mp.code,
        marketplace_id: mp.id,
        seller_id: sellerId,
        status: 'OK',
        samples,
      });
    }

    return new Response(
      JSON.stringify({ probed_at: new Date().toISOString(), user_id: user.id, probes }, null, 2),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e: any) {
    console.error('[probe-listings-issues] error:', e?.message || e);
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
