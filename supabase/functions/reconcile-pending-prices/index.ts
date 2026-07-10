// Nightly Reconciliation: Re-fetch Orders API ItemPrice for orders >48h old still
// flagged needs_price_enrich=true. If real price arrives, overwrite estimate.
// If a Keepa estimate was used and differed from actual by >5%, log it for review.
//
// Source-of-truth contract:
//  - Orders API ItemPrice (orders_itemprice) > FEC settlement = TRUTH
//  - keepa_historical = ESTIMATE only, written to estimated_price
//  - Nightly: try to upgrade estimate -> actual

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AWS SigV4 signing utilities (copied from get-order-items)
async function sha256(message: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message) as any);
}
async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const kDate = await hmac(enc.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}
async function signRequest(method: string, url: string, body: string, accessToken: string): Promise<Record<string, string>> {
  const accessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const secretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
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
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, toHex(await sha256(canonicalRequest))].join('\n');
  const signingKey = await getSignatureKey(secretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': u.host,
  };
}

async function getLWAToken(refreshToken: string): Promise<string> {
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: Deno.env.get('LWA_CLIENT_ID')!,
      client_secret: Deno.env.get('LWA_CLIENT_SECRET')!,
    }),
  });
  if (!r.ok) throw new Error(`LWA ${r.status}`);
  return (await r.json()).access_token;
}

interface OrderItemRow {
  ASIN: string;
  SellerSKU?: string;
  QuantityOrdered: number;
  ItemPrice?: { Amount: string; CurrencyCode: string };
}

const SPAPI_HOSTS: Record<string, string> = {
  US: 'sellingpartnerapi-na.amazon.com',
  CA: 'sellingpartnerapi-na.amazon.com',
  MX: 'sellingpartnerapi-na.amazon.com',
  BR: 'sellingpartnerapi-na.amazon.com',
  GB: 'sellingpartnerapi-eu.amazon.com',
  DE: 'sellingpartnerapi-eu.amazon.com',
  FR: 'sellingpartnerapi-eu.amazon.com',
  IT: 'sellingpartnerapi-eu.amazon.com',
  ES: 'sellingpartnerapi-eu.amazon.com',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    // Parse body once
    let body: any = {};
    try { body = await req.json(); } catch { /* no body */ }

    // Internal-secret enforcement: if INTERNAL_SYNC_SECRET is set, allow either
    // (a) caller passes matching x-internal-secret header (cron path), or
    // (b) caller has a Supabase JWT (manual/admin invoke from dashboard).
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    const callerSecret = req.headers.get('x-internal-secret');
    const hasJwt = !!req.headers.get('authorization');
    if (internalSecret && !hasJwt && callerSecret !== internalSecret) {
      return new Response(JSON.stringify({ ok: false, error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userFilter: string | null = body?.user_id ? String(body.user_id) : null;
    const orderFilter: string | null = body?.order_id ? String(body.order_id) : null;
    const asinFilter: string | null = body?.asin ? String(body.asin) : null;
    const dryRun: boolean = body?.dry_run === true;
    const bypassAge: boolean = body?.bypass_age === true;

    // Find orders >48h old, still needing enrichment (bypass_age skips cutoff for testing)
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    let query = supabase
      .from('sales_orders')
      .select('user_id, order_id, asin, quantity, marketplace, order_date, estimated_price, price_source')
      .eq('needs_price_enrich', true)
      .limit(500);
    if (!bypassAge) query = query.lt('order_date', cutoff);
    if (userFilter) query = query.eq('user_id', userFilter);
    if (orderFilter) query = query.eq('order_id', orderFilter);
    if (asinFilter) query = query.eq('asin', asinFilter);

    const { data: pending, error: fetchErr } = await query;
    if (fetchErr) throw fetchErr;

    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({
        ok: true, processed: 0, upgraded: 0, flagged: 0, message: 'No stale pending orders',
        elapsed_ms: Date.now() - startedAt,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    console.log(`[RECONCILE] Processing ${pending.length} stale pending orders`);

    // Group by user (each user has own SP-API token)
    const byUser = new Map<string, typeof pending>();
    for (const row of pending) {
      const arr = byUser.get(row.user_id) || [];
      arr.push(row);
      byUser.set(row.user_id, arr);
    }

    let upgraded = 0;
    let flagged = 0;
    let skipped = 0;

    for (const [userId, rows] of byUser.entries()) {
      // Get auth for this user's marketplaces
      const { data: auths } = await supabase
        .from('seller_authorizations')
        .select('refresh_token, marketplace_id')
        .eq('user_id', userId);
      if (!auths || auths.length === 0) {
        skipped += rows.length;
        continue;
      }

      // Group orders by marketplace
      const byMp = new Map<string, typeof rows>();
      for (const r of rows) {
        const mp = (r.marketplace || 'US').toUpperCase();
        const arr = byMp.get(mp) || [];
        arr.push(r);
        byMp.set(mp, arr);
      }

      for (const [mp, mpRows] of byMp.entries()) {
        const auth = auths.find(a => a.marketplace_id?.toUpperCase().endsWith(mp)) || auths[0];
        if (!auth?.refresh_token) { skipped += mpRows.length; continue; }

        const host = SPAPI_HOSTS[mp] || SPAPI_HOSTS.US;
        let token: string;
        try {
          token = await getLWAToken(auth.refresh_token);
        } catch (e) {
          console.warn(`[RECONCILE] LWA failed for ${userId} mp=${mp}: ${(e as Error).message}`);
          skipped += mpRows.length;
          continue;
        }

        // Dedup by order_id (one API call per order, may have multiple ASINs)
        const uniqueOrders = Array.from(new Set(mpRows.map(r => r.order_id)));

        for (const orderId of uniqueOrders) {
          const url = `https://${host}/orders/v0/orders/${orderId}/orderItems`;
          try {
            const headers = await signRequest('GET', url, '', token);
            const r = await fetch(url, { method: 'GET', headers: { ...headers, 'Content-Type': 'application/json' } });

            if (r.status === 429) {
              await new Promise(res => setTimeout(res, 2000));
              continue;
            }
            if (!r.ok) {
              await r.text().catch(() => '');
              continue;
            }

            const data = await r.json();
            const items = (data?.payload?.OrderItems || []) as OrderItemRow[];

            for (const item of items) {
              const itemPrice = item.ItemPrice ? parseFloat(item.ItemPrice.Amount) : 0;
              if (!itemPrice || itemPrice <= 0) continue; // still no price

              const qty = item.QuantityOrdered || 1;
              const perUnit = itemPrice / qty;

              // Find matching DB row
              const dbRow = mpRows.find(x => x.order_id === orderId && x.asin === item.ASIN);
              if (!dbRow) continue;

              const oldEstimate = Number(dbRow.estimated_price || 0);
              const wasKeepa = String(dbRow.price_source || '').includes('keepa_historical');

              // Upgrade estimate -> actual (skip mutation in dry-run)
              if (dryRun) {
                console.log(`[RECONCILE][DRY] would upgrade ${orderId}/${item.ASIN}: estimate=$${oldEstimate} -> actual=$${perUnit}`);
                upgraded++;
              } else {
                const { error: updErr } = await supabase
                  .from('sales_orders')
                  .update({
                    sold_price: perUnit,
                    item_price: perUnit,
                    total_sale_amount: itemPrice,
                    price_source: 'orders_itemprice',
                    needs_price_enrich: false,
                    estimated_price: 0,
                  })
                  .eq('user_id', userId)
                  .eq('order_id', orderId)
                  .eq('asin', item.ASIN);

                if (updErr) {
                  console.error(`[RECONCILE] Update failed ${orderId}/${item.ASIN}: ${updErr.message}`);
                  continue;
                }
                upgraded++;
              }

              // Log accuracy if Keepa was used
              if (wasKeepa && oldEstimate > 0) {
                const deltaPct = Math.abs(perUnit - oldEstimate) / perUnit;
                const isFlagged = deltaPct > 0.05;
                if (isFlagged) flagged++;
                if (dryRun) {
                  console.log(`[RECONCILE][DRY] would log accuracy: keepa=$${oldEstimate} actual=$${perUnit} delta=${(deltaPct*100).toFixed(1)}% flagged=${isFlagged}`);
                  continue;
                }
                await supabase.from('keepa_estimate_accuracy').insert({
                  user_id: userId,
                  order_id: orderId,
                  asin: item.ASIN,
                  marketplace: mp,
                  order_date: dbRow.order_date,
                  keepa_estimate: oldEstimate,
                  actual_price: perUnit,
                  flagged: isFlagged,
                  notes: isFlagged ? `Delta ${(deltaPct * 100).toFixed(1)}% exceeds 5% threshold` : null,
                });
              }
            }

            // Rate limit: ~2 req/s
            await new Promise(res => setTimeout(res, 600));
          } catch (e) {
            console.warn(`[RECONCILE] Order ${orderId} failed: ${(e as Error).message}`);
          }
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      processed: pending.length,
      upgraded,
      flagged,
      skipped,
      elapsed_ms: Date.now() - startedAt,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[RECONCILE] Fatal:', e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
