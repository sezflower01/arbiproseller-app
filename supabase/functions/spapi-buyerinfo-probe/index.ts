// Diagnostic probe: shows exactly what Amazon returns for GetOrder with and
// without a Restricted Data Token. Values are redacted; we only report which
// fields are present so we can compare against what tools like Sellerboard use.
//
// POST { userId, orderId?: string }
//   If orderId omitted, picks the newest US settled order.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const enc = new TextEncoder();
async function sha256(input: string) { return await crypto.subtle.digest('SHA-256', enc.encode(input)); }
function toHex(buf: ArrayBuffer) { return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function hmac(key: ArrayBuffer, msg: string) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
async function signingKey(secret: string, dateStamp: string, region: string, service: string) {
  const kDate = await hmac(enc.encode('AWS4' + secret).buffer, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}
async function signRequest(method: string, url: string, body: string, accessToken: string) {
  const ak = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const sk = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';
  const u = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = toHex(await sha256(body));
  const canonicalHeaders = `host:${u.host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const canonicalRequest = [method, u.pathname, u.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, toHex(await sha256(canonicalRequest))].join('\n');
  const key = await signingKey(sk, dateStamp, region, service);
  const sig = toHex(await hmac(key, stringToSign));
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    host: u.host,
  } as Record<string, string>;
}
async function lwaToken(refresh: string, cid?: string, csec?: string) {
  const clientId = cid || Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_CLIENT_ID')!;
  const clientSecret = csec || Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_CLIENT_SECRET')!;
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: clientSecret }),
  });
  if (!r.ok) throw new Error('lwa:' + (await r.text()));
  return (await r.json()).access_token as string;
}

const HOST_NA = 'https://sellingpartnerapi-na.amazon.com';

// Redact a string value into a short shape descriptor
function shape(v: any): any {
  if (v === null) return null;
  if (v === undefined) return undefined;
  if (typeof v === 'string') {
    if (v.includes('@marketplace.amazon.com')) return `marketplace_alias(len=${v.length})`;
    if (v.includes('@')) return `email(len=${v.length})`;
    return `string(len=${v.length})`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return typeof v;
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === 'object') {
    const o: any = {};
    for (const k of Object.keys(v)) o[k] = shape(v[k]);
    return o;
  }
  return typeof v;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const body = await req.json().catch(() => ({}));
    const userId: string = body?.userId;
    let orderId: string | undefined = body?.orderId;
    if (!userId) throw new Error('userId required');

    if (!orderId) {
      const { data } = await supabase.from('sales_orders')
        .select('order_id, marketplace, order_date')
        .eq('user_id', userId)
        .eq('marketplace', 'US')
        .not('order_id', 'like', '%-REFUND%')
        .order('order_date', { ascending: false })
        .limit(1);
      orderId = data?.[0]?.order_id;
    }
    if (!orderId) throw new Error('no order found');

    // credentials
    let refresh: string | null = Deno.env.get('SPAPI_REFRESH_TOKEN') || null;
    let cid: string | null = Deno.env.get('LWA_CLIENT_ID') || null;
    let csec: string | null = Deno.env.get('LWA_CLIENT_SECRET') || null;
    const { data: credRows } = await supabase.rpc('get_spapi_credentials_decrypted', { p_user_id: userId });
    const cred = (credRows as any[])?.[0];
    if (cred?.refresh_token) refresh = cred.refresh_token;
    if (cred?.lwa_client_id) cid = cred.lwa_client_id;
    if (cred?.lwa_client_secret) csec = cred.lwa_client_secret;
    if (!refresh) throw new Error('no spapi credentials for user');

    const access = await lwaToken(refresh, cid || undefined, csec || undefined);
    const url = `${HOST_NA}/orders/v0/orders/${encodeURIComponent(orderId)}`;

    // === Step 1: unscoped GetOrder ===
    const unscopedResult: any = { attempted: true };
    try {
      const h = await signRequest('GET', url, '', access);
      const r = await fetch(url, { method: 'GET', headers: h });
      unscopedResult.status = r.status;
      const text = await r.text();
      try {
        const j = JSON.parse(text);
        const p = j?.payload || {};
        unscopedResult.top_keys = Object.keys(p);
        unscopedResult.BuyerInfo_keys = p.BuyerInfo ? Object.keys(p.BuyerInfo) : null;
        unscopedResult.BuyerInfo_shape = p.BuyerInfo ? shape(p.BuyerInfo) : null;
        unscopedResult.ShippingAddress_keys = p.ShippingAddress ? Object.keys(p.ShippingAddress) : null;
        unscopedResult.ShippingAddress_shape = p.ShippingAddress ? shape(p.ShippingAddress) : null;
        unscopedResult.errors = j?.errors || null;
      } catch {
        unscopedResult.raw_snippet = text.slice(0, 500);
      }
    } catch (e: any) {
      unscopedResult.error = e.message;
    }

    // === Step 2: request RDT — try each data element separately to see which are approved ===
    const rdtRequest: any = { attempted: true, per_element: {} };
    let rdt: string | null = null;
    for (const elem of ['buyerInfo', 'shippingAddress']) {
      try {
        const tokenUrl = `${HOST_NA}/tokens/2021-03-01/restrictedDataToken`;
        const b = JSON.stringify({
          restrictedResources: [{
            method: 'GET',
            path: `/orders/v0/orders/${orderId}`,
            dataElements: [elem],
          }],
        });
        const h = await signRequest('POST', tokenUrl, b, access);
        const r = await fetch(tokenUrl, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: b });
        const text = await r.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        rdtRequest.per_element[elem] = {
          status: r.status,
          got_token: !!parsed?.restrictedDataToken,
          errors: parsed?.errors || null,
        };
        if (!rdt && parsed?.restrictedDataToken) rdt = parsed.restrictedDataToken;
      } catch (e: any) {
        rdtRequest.per_element[elem] = { error: e.message };
      }
    }
    rdtRequest.got_token = !!rdt;

    // === Step 3: scoped GetOrder with RDT (if we got one) ===
    const scopedResult: any = { attempted: !!rdt };
    if (rdt) {
      try {
        const h = await signRequest('GET', url, '', rdt);
        const r = await fetch(url, { method: 'GET', headers: h });
        scopedResult.status = r.status;
        const text = await r.text();
        try {
          const j = JSON.parse(text);
          const p = j?.payload || {};
          scopedResult.top_keys = Object.keys(p);
          scopedResult.BuyerInfo_keys = p.BuyerInfo ? Object.keys(p.BuyerInfo) : null;
          scopedResult.BuyerInfo_shape = p.BuyerInfo ? shape(p.BuyerInfo) : null;
          scopedResult.ShippingAddress_keys = p.ShippingAddress ? Object.keys(p.ShippingAddress) : null;
          scopedResult.ShippingAddress_shape = p.ShippingAddress ? shape(p.ShippingAddress) : null;
          scopedResult.errors = j?.errors || null;
        } catch { scopedResult.raw_snippet = text.slice(0, 500); }
      } catch (e: any) {
        scopedResult.error = e.message;
      }
    }

    // === Step 4: also try getOrderBuyerInfo endpoint (Sellerboard-style path) ===
    const buyerInfoEndpoint: any = { attempted: true };
    try {
      const biUrl = `${HOST_NA}/orders/v0/orders/${encodeURIComponent(orderId)}/buyerInfo`;
      const useToken = rdt || access;
      const h = await signRequest('GET', biUrl, '', useToken);
      const r = await fetch(biUrl, { method: 'GET', headers: h });
      buyerInfoEndpoint.status = r.status;
      buyerInfoEndpoint.used_rdt = !!rdt;
      const text = await r.text();
      try {
        const j = JSON.parse(text);
        const p = j?.payload || {};
        buyerInfoEndpoint.payload_keys = Object.keys(p);
        buyerInfoEndpoint.payload_shape = shape(p);
        buyerInfoEndpoint.errors = j?.errors || null;
      } catch { buyerInfoEndpoint.raw_snippet = text.slice(0, 500); }
    } catch (e: any) {
      buyerInfoEndpoint.error = e.message;
    }

    return new Response(JSON.stringify({
      ok: true,
      orderId,
      userId,
      unscopedGetOrder: unscopedResult,
      rdtRequest,
      scopedGetOrder: scopedResult,
      buyerInfoEndpoint,
      interpretation_hint: 'Look at BuyerInfo_keys / payload_keys. If unscoped returns BuyerEmail even as marketplace_alias, we can group by it without PII approval.',
    }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
