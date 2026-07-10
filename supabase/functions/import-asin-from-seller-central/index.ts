// Fetches a single ASIN's catalog data from Amazon Seller Central (SP-API)
// for use by the "Sync from Seller Central" button in Created Listings.
// Returns title + image so the user can create a created_listings stub
// and then fill in cost/supplier manually.
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
const MARKETPLACE_CODE_BY_ID: Record<string, string> = Object.fromEntries(
  Object.entries(MARKETPLACE_ID_BY_CODE).map(([c, id]) => [id, c])
);

function hmac(key: string | Uint8Array, data: string): Uint8Array {
  const h = createHmac('sha256', key as any);
  h.update(data);
  return new Uint8Array(h.digest());
}
function signingKey(key: string, date: string, region: string, svc: string) {
  return hmac(hmac(hmac(hmac(`AWS4${key}`, date), region), svc), 'aws4_request');
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const cid = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const sec = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  if (!cid || !sec) throw new Error('Missing LWA credentials');
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: cid, client_secret: sec,
    }),
  });
  if (!r.ok) throw new Error(`LWA ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

async function callSpApi(path: string, accessToken: string, qp: Record<string, string>) {
  const ak = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const sk = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const host = 'sellingpartnerapi-na.amazon.com';
  const svc = 'execute-api';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const qs = new URLSearchParams(qp).toString();
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const headers: Record<string, string> = {
    host, 'x-amz-date': amzDate, 'x-amz-access-token': accessToken,
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonical = `GET\n${path}\n${qs}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const reqHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const reqHash = Array.from(new Uint8Array(reqHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const scope = `${dateStamp}/${region}/${svc}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${reqHash}`;
  const sig = createHmac('sha256', signingKey(sk, dateStamp, region, svc) as any);
  sig.update(stringToSign);
  const signature = sig.digest('hex');
  const authHeader = `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${host}${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { method: 'GET', headers: { ...headers, Authorization: authHeader } });
  if (!r.ok) throw new Error(`SP-API ${r.status}: ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { data: { user }, error: userErr } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const asin = String(body?.asin || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      return new Response(JSON.stringify({ error: 'Invalid ASIN' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Resolve user's marketplace + refresh token (prefer US, then primary, then any).
    const { data: auths } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, is_active')
      .eq('user_id', user.id);
    const active = (auths || []).filter((a: any) => a.is_active !== false && a.refresh_token);
    if (active.length === 0) {
      return new Response(JSON.stringify({ error: 'No active Amazon Seller authorization found.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('primary_marketplace_id')
      .eq('id', user.id)
      .maybeSingle();
    const preferredId = profile?.primary_marketplace_id
      || active.find((a: any) => a.marketplace_id === MARKETPLACE_ID_BY_CODE.US)?.marketplace_id
      || active[0].marketplace_id;
    const auth = active.find((a: any) => a.marketplace_id === preferredId) || active[0];
    const marketplaceId = auth.marketplace_id;
    const marketplaceCode = MARKETPLACE_CODE_BY_ID[marketplaceId] || 'US';

    const accessToken = await getAccessToken(auth.refresh_token);

    // Catalog Items API — title + image for the ASIN
    let title = '';
    let imageUrl: string | null = null;
    try {
      const catalog = await callSpApi(`/catalog/2022-04-01/items/${asin}`, accessToken, {
        marketplaceIds: marketplaceId,
        includedData: 'summaries,images',
      });
      const summaries = catalog?.summaries || [];
      const summary = summaries.find((s: any) => s.marketplaceId === marketplaceId) || summaries[0];
      title = summary?.itemName || '';
      const imagesGroup = (catalog?.images || []).find((g: any) => g.marketplaceId === marketplaceId)
        || catalog?.images?.[0];
      const imgs = imagesGroup?.images || [];
      // Prefer largest image
      const main = imgs.reduce((best: any, cur: any) => {
        if (!best) return cur;
        return (cur.height || 0) > (best.height || 0) ? cur : best;
      }, null);
      imageUrl = main?.link || null;
    } catch (e: any) {
      console.warn(`[IMPORT-ASIN] Catalog fetch failed for ${asin}: ${e.message}`);
    }

    // Try to find an existing inventory row for this ASIN to grab SKU + quantities
    let sku: string | null = null;
    let available: number | null = null;
    let reserved: number | null = null;
    let inbound: number | null = null;
    let myPrice: number | null = null;
    const { data: inv } = await supabase
      .from('inventory')
      .select('sku, available, reserved, inbound, my_price, price, title, image_url')
      .eq('user_id', user.id)
      .eq('asin', asin)
      .order('available', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (inv) {
      sku = inv.sku || null;
      available = inv.available ?? null;
      reserved = inv.reserved ?? null;
      inbound = inv.inbound ?? null;
      myPrice = inv.my_price ?? inv.price ?? null;
      if (!title) title = inv.title || '';
      if (!imageUrl) imageUrl = inv.image_url || null;
    }

    if (!title && !imageUrl) {
      return new Response(JSON.stringify({
        found: false,
        asin,
        marketplace: marketplaceCode,
        message: 'ASIN not found in your Seller Central catalog for this marketplace.',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      found: true,
      asin,
      sku,
      title,
      image_url: imageUrl,
      available,
      reserved,
      inbound,
      my_price: myPrice,
      price: myPrice,
      marketplace: marketplaceCode,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('[IMPORT-ASIN] Error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
