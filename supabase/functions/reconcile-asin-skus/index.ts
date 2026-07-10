// reconcile-asin-skus
// Discover the real Amazon seller SKU for an ASIN via SP-API and rewrite
// created_listings.sku + repricer_assignments.sku to match. Resolves the
// "synthetic SKU" problem caused by the create-listing tool minting local
// SKUs that don't exist on Amazon, which makes update-amazon-price 404.
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
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`LWA token error: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function callSpApi(method: string, path: string, accessToken: string, queryParams: Record<string, string>) {
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
  const headers: Record<string, string> = { host, 'x-amz-date': amzDate, 'x-amz-access-token': accessToken };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const requestHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest))))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${requestHash}`;
  const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, service);
  const signature = getAwsSignature(stringToSign, signingKey);
  const res = await fetch(`https://${host}${path}?${queryString}`, {
    method,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  if (!res.ok) throw new Error(`SP-API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

async function discoverSkusForAsin(supabase: any, userId: string, asin: string, marketplace: string): Promise<string[]> {
  const mpId = MARKETPLACE_ID_BY_CODE[marketplace] || MARKETPLACE_ID_BY_CODE.US;
  const { data: authRows } = await supabase
    .from('seller_authorizations')
    .select('refresh_token, marketplace_id, seller_id, selling_partner_id, is_active')
    .eq('user_id', userId);
  const active = (authRows || []).filter((r: any) => r.is_active !== false && r.refresh_token);
  const auth = active.find((r: any) => r.marketplace_id === mpId) || active[0];
  if (!auth?.refresh_token) throw new Error(`No active SP-API auth for ${marketplace}`);
  const sellerId = auth.seller_id || auth.selling_partner_id;
  if (!sellerId) throw new Error('Seller ID missing');
  const accessToken = await getLwaAccessToken(auth.refresh_token);
  const skus: string[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 5; page++) {
    const data = await callSpApi('GET', `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`, accessToken, {
      marketplaceIds: auth.marketplace_id,
      identifiers: asin,
      identifiersType: 'ASIN',
      includedData: 'summaries',
      pageSize: '20',
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of data?.items || []) {
      const s = String(it?.sku || '').trim();
      if (s) skus.push(s);
    }
    pageToken = data?.pagination?.nextToken || data?.nextToken || null;
    if (!pageToken) break;
  }
  return Array.from(new Set(skus));
}

async function reconcileOne(supabase: any, userId: string, asin: string, marketplace: string) {
  const realSkus = await discoverSkusForAsin(supabase, userId, asin, marketplace);
  if (realSkus.length === 0) {
    return { asin, marketplace, status: 'no_amazon_listing', message: 'ASIN not found on Amazon for this seller — cannot reconcile' };
  }
  if (realSkus.length > 1) {
    return { asin, marketplace, status: 'ambiguous', realSkus, message: 'Multiple SKUs on Amazon — manual mapping required' };
  }
  const realSku = realSkus[0];

  // Rewrite created_listings rows for this user+asin (FBM only — US listings)
  const { data: clRows } = await supabase
    .from('created_listings')
    .select('id, sku')
    .eq('user_id', userId)
    .eq('asin', asin);
  const clChanges: any[] = [];
  for (const r of clRows || []) {
    if (r.sku === realSku) continue;
    const { error } = await supabase.from('created_listings').update({ sku: realSku }).eq('id', r.id);
    clChanges.push({ id: r.id, from: r.sku, to: realSku, error: error?.message || null });
  }

  // Rewrite repricer_assignments — must respect uniq (user, sku, marketplace)
  const { data: asgnRows } = await supabase
    .from('repricer_assignments')
    .select('id, sku, last_applied_at, last_applied_price, updated_at, created_at, is_enabled')
    .eq('user_id', userId)
    .eq('asin', asin)
    .eq('marketplace', marketplace);

  const asgnChanges: any[] = [];
  if (asgnRows && asgnRows.length > 0) {
    // Pick the keeper: row already on real_sku > most recent last_applied_at > newest updated_at
    const sorted = [...asgnRows].sort((a, b) => {
      if (a.sku === realSku && b.sku !== realSku) return -1;
      if (b.sku === realSku && a.sku !== realSku) return 1;
      const at = a.last_applied_at ? new Date(a.last_applied_at).getTime() : 0;
      const bt = b.last_applied_at ? new Date(b.last_applied_at).getTime() : 0;
      if (at !== bt) return bt - at;
      return new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime();
    });
    const keeper = sorted[0];
    const losers = sorted.slice(1);

    // Delete losers first to free the unique constraint slot
    for (const l of losers) {
      const { error } = await supabase.from('repricer_assignments').delete().eq('id', l.id);
      asgnChanges.push({ id: l.id, action: 'deleted_duplicate', sku: l.sku, error: error?.message || null });
    }
    if (keeper.sku !== realSku) {
      const { error } = await supabase
        .from('repricer_assignments')
        .update({ sku: realSku })
        .eq('id', keeper.id);
      asgnChanges.push({ id: keeper.id, action: 'sku_rewritten', from: keeper.sku, to: realSku, error: error?.message || null });
    } else {
      asgnChanges.push({ id: keeper.id, action: 'kept_as_is', sku: realSku });
    }
  }

  return {
    asin,
    marketplace,
    status: 'reconciled',
    realSku,
    created_listings_changes: clChanges,
    assignment_changes: asgnChanges,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization');
    const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const body = await req.json().catch(() => ({}));
    const targets: Array<{ asin: string; marketplace: string }> = [];

    if (body?.asin) {
      targets.push({ asin: String(body.asin).toUpperCase(), marketplace: String(body.marketplace || 'US').toUpperCase() });
    } else if (body?.bulk === true) {
      // Find all ASINs whose assignments still point at SKUs that don't appear in inventory
      const { data: assigns } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace')
        .eq('user_id', user.id);
      const { data: invRows } = await supabase
        .from('inventory')
        .select('asin, sku')
        .eq('user_id', user.id);
      const invSkus = new Set((invRows || []).map((r: any) => `${r.asin}|${r.sku}`));
      const seen = new Set<string>();
      for (const a of assigns || []) {
        const key = `${a.asin}|${a.marketplace}`;
        if (seen.has(key)) continue;
        // Only reconcile when assignment SKU isn't a real Amazon-known SKU (no inventory row)
        if (!invSkus.has(`${a.asin}|${a.sku}`)) {
          targets.push({ asin: a.asin, marketplace: a.marketplace });
          seen.add(key);
        }
      }
    } else {
      return new Response(JSON.stringify({ error: 'Provide { asin, marketplace } or { bulk: true }' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const results: any[] = [];
    for (const t of targets) {
      try {
        const r = await reconcileOne(supabase, user.id, t.asin, t.marketplace);
        results.push(r);
      } catch (e: any) {
        results.push({ asin: t.asin, marketplace: t.marketplace, status: 'error', message: e?.message || String(e) });
      }
      // small delay between SP-API calls to be polite
      await new Promise((r) => setTimeout(r, 250));
    }

    return new Response(JSON.stringify({ ok: true, count: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[reconcile-asin-skus] Error:', error?.message || error);
    return new Response(JSON.stringify({ error: error?.message || 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
