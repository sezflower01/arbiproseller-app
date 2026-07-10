// RECOVER-SUSPICIOUS-ZERO-INVENTORY
//
// One-shot recovery scan. Finds inventory rows currently at 0/0 (available=0
// AND reserved=0) whose inventory_history shows positive stock in the last
// 7 days, then re-queries SP-API Summaries with DOUBLE CONFIRMATION:
//   - Fetch #1
//   - Wait 1.5s
//   - Fetch #2
//   - Only restore if at least one fetch returns positive stock
//
// Preserves `inbound` from the second fetch (or current row if both zero).
// Returns a before/after report.
//
// This function is INVOKED MANUALLY by the user. It does NOT run on cron.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from 'https://deno.land/std@0.177.0/node/crypto.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_PROCESS = 500;          // hard cap per invocation
const SECOND_FETCH_DELAY_MS = 1500;
const INTER_SKU_DELAY_MS = 350;   // SP-API rate protection

// ─── SP-API helpers (mirrors refresh-stale-inventory) ────────────────────────

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
function getAwsSignature(stringToSign: string, kSigning: Uint8Array): string {
  const hmac = createHmac('sha256', kSigning as any);
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
  if (!res.ok) throw new Error(`LWA token error: ${res.status} - ${await res.text()}`);
  return (await res.json()).access_token;
}
async function callSpApi(method: string, path: string, accessToken: string, queryParams: Record<string, string>) {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
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
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(canonicalRequest));
  const reqHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${reqHash}`;
  const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, service);
  const signature = getAwsSignature(stringToSign, signingKey);
  const auth = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${host}${path}${queryString ? '?' + queryString : ''}`;
  const res = await fetch(url, { method, headers: { ...headers, Authorization: auth } });
  if (res.status === 429) return null;
  if (!res.ok) throw new Error(`SP-API ${res.status}: ${await res.text()}`);
  return await res.json();
}

function getMarketplaceId(mp: string | null | undefined): string {
  switch ((mp || 'US').toUpperCase()) {
    case 'CA': return 'A2EUQ1WTGCTBG2';
    case 'MX': return 'A1AM78C64UM0Y8';
    case 'BR': return 'A2Q3Y263D00KWC';
    default: return 'ATVPDKIKX0DER';
  }
}

async function fetchSummaries(accessToken: string, marketplaceId: string, sku: string) {
  const response = await callSpApi('GET', '/fba/inventory/v1/summaries', accessToken, {
    marketplaceIds: marketplaceId,
    details: 'true',
    granularityType: 'Marketplace',
    granularityId: marketplaceId,
    sellerSkus: sku,
  });
  if (!response) return null;
  const summaries = response?.payload?.inventorySummaries || [];
  let stock = { available: 0, reserved: 0, inbound: 0, matched: false };
  for (const s of summaries) {
    if ((s?.sellerSku || '').toLowerCase() !== sku.toLowerCase()) continue;
    const d = s?.inventoryDetails || s || {};
    const inboundReceiving = d?.inboundReceivingQuantity ?? s?.inboundReceivingQuantity ?? 0;
    const inboundShipped = d?.inboundShippedQuantity ?? s?.inboundShippedQuantity ?? 0;
    stock = {
      available: d?.fulfillableQuantity ?? s?.totalFulfillableQuantity ?? s?.fulfillableQuantity ?? 0,
      reserved: d?.reservedQuantity?.totalReservedQuantity ?? s?.reservedQuantity?.totalReservedQuantity ?? 0,
      inbound: inboundReceiving + inboundShipped,
      matched: true,
    };
  }
  return stock;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const t0 = Date.now();

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({}));
    const dryRun: boolean = !!body.dry_run;
    const userIdFilter: string | null = body.user_id || null;
    const limit: number = Math.min(body.limit || 200, MAX_PROCESS);
    // Optional: caller-supplied SKU list. When provided, we skip the
    // history scan and target exactly these rows (already vetted upstream).
    const skuList: string[] | null = Array.isArray(body.skus) && body.skus.length > 0
      ? body.skus.map((s: any) => String(s)).slice(0, MAX_PROCESS)
      : null;

    // Authenticate caller — accept user JWT (resolve user_id) OR service role
    const authHeader = req.headers.get('Authorization') || '';
    let callerUserId: string | null = null;
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) callerUserId = user.id;
    }

    const targetUserId = userIdFilter || callerUserId;
    if (!targetUserId) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[recovery] Starting scan user=${targetUserId} dry_run=${dryRun} limit=${limit} skuList=${skuList?.length || 0}`);

    // 1) Find candidate rows
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let zeroRows: any[] | null;
    let zeroErr: any;

    if (skuList) {
      // Targeted mode: caller already knows which SKUs to recover
      const res = await supabase
        .from('inventory')
        .select('id, sku, asin, available, reserved, inbound, listing_status, source, last_summaries_at')
        .eq('user_id', targetUserId)
        .in('sku', skuList);
      zeroRows = res.data;
      zeroErr = res.error;
    } else {
      const scanLimit = Math.min(limit * 10, 5000);
      const res = await supabase
        .from('inventory')
        .select('id, sku, asin, available, reserved, inbound, listing_status, source, last_summaries_at')
        .eq('user_id', targetUserId)
        .eq('available', 0)
        .eq('reserved', 0)
        .neq('listing_status', 'NOT_IN_CATALOG')
        .neq('listing_status', 'DELETED')
        .order('last_summaries_at', { ascending: false, nullsFirst: false })
        .limit(scanLimit);
      zeroRows = res.data;
      zeroErr = res.error;
    }

    if (zeroErr) throw new Error(`Failed to load zero rows: ${zeroErr.message}`);
    if (!zeroRows || zeroRows.length === 0) {
      return new Response(JSON.stringify({ ok: true, message: 'No matching rows found', candidates: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // When caller passed an explicit SKU list, trust it (already vetted upstream).
    // Otherwise filter to only those with positive history in the last 7 days.
    const candidates: typeof zeroRows = [];
    if (skuList) {
      for (const row of zeroRows) {
        candidates.push(row);
        if (candidates.length >= limit) break;
      }
    } else {
      for (const row of zeroRows) {
        const { data: hist } = await supabase
          .from('inventory_history')
          .select('available, reserved, captured_at')
          .eq('user_id', targetUserId)
          .eq('sku', row.sku)
          .gte('captured_at', sevenDaysAgo)
          .order('captured_at', { ascending: false })
          .limit(20);
        const hadStock = (hist || []).some((h: any) => (h.available || 0) + (h.reserved || 0) > 0);
        if (hadStock) candidates.push(row);
        if (candidates.length >= limit) break; // cap SP-API volume
      }
    }

    console.log(`[recovery] ${candidates.length}/${zeroRows.length} rows are suspicious-zero candidates`);

    if (candidates.length === 0) {
      return new Response(JSON.stringify({
        ok: true,
        message: 'No suspicious-zero rows (no recent positive history)',
        zero_rows_scanned: zeroRows.length,
        candidates: 0,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (dryRun) {
      return new Response(JSON.stringify({
        ok: true,
        dry_run: true,
        zero_rows_scanned: zeroRows.length,
        candidates: candidates.length,
        sample: candidates.slice(0, 20).map(c => ({ asin: c.asin, sku: c.sku })),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 2) Determine primary marketplace
    const { data: settings } = await supabase
      .from('repricer_settings')
      .select('primary_marketplace')
      .eq('user_id', targetUserId)
      .maybeSingle();
    const marketplaceId = getMarketplaceId(settings?.primary_marketplace || 'US');

    // 3) Get refresh token from seller_authorizations
    const { data: auths } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, is_active')
      .eq('user_id', targetUserId)
      .eq('is_active', true)
      .limit(1);
    const refreshToken = auths?.[0]?.refresh_token;
    if (!refreshToken) {
      return new Response(JSON.stringify({ error: 'No active SP-API authorization found' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await getLwaAccessToken(refreshToken);

    // 4) Process each candidate with double-confirmation
    const results: any[] = [];
    let restored = 0;
    let stillZero = 0;
    let throttled = 0;
    let errors = 0;

    for (let i = 0; i < candidates.length; i++) {
      const row = candidates[i];
      if (i > 0) await new Promise(r => setTimeout(r, INTER_SKU_DELAY_MS));

      try {
        const first = await fetchSummaries(accessToken, marketplaceId, row.sku);
        if (!first) {
          throttled++;
          results.push({ asin: row.asin, sku: row.sku, status: 'throttled' });
          continue;
        }

        await new Promise(r => setTimeout(r, SECOND_FETCH_DELAY_MS));
        const second = await fetchSummaries(accessToken, marketplaceId, row.sku);
        if (!second) {
          throttled++;
          results.push({ asin: row.asin, sku: row.sku, status: 'throttled_second' });
          continue;
        }

        const firstTotal = first.available + first.reserved;
        const secondTotal = second.available + second.reserved;

        // Pick the higher of the two (a non-zero proves Amazon glitched on the other)
        const winner = firstTotal >= secondTotal ? first : second;
        const winnerTotal = winner.available + winner.reserved;

        if (winnerTotal === 0) {
          stillZero++;
          results.push({
            asin: row.asin,
            sku: row.sku,
            status: 'still_zero_both_fetches',
            first, second,
          });
          continue;
        }

        // Restore. Preserve previous inbound if winner.inbound is 0 (Reports API only).
        const newInbound = winner.inbound > 0 ? winner.inbound : (row.inbound || 0);
        const nowIso = new Date().toISOString();
        const { error: updateError } = await supabase
          .from('inventory')
          .update({
            available: winner.available,
            reserved: winner.reserved,
            inbound: newInbound,
            listing_status: 'ACTIVE',
            source: 'live_api',
            last_inventory_sync_at: nowIso,
            last_summaries_at: nowIso,
          })
          .eq('id', row.id);

        if (updateError) {
          errors++;
          results.push({ asin: row.asin, sku: row.sku, status: 'db_error', error: updateError.message });
        } else {
          restored++;
          results.push({
            asin: row.asin,
            sku: row.sku,
            status: 'restored',
            before: { available: row.available, reserved: row.reserved, inbound: row.inbound },
            after: { available: winner.available, reserved: winner.reserved, inbound: newInbound },
            first, second,
          });
          console.log(`[recovery] ✅ ${row.asin}/${row.sku}: 0/0 → ${winner.available}/${winner.reserved} (inbound=${newInbound})`);
        }
      } catch (err: any) {
        errors++;
        results.push({ asin: row.asin, sku: row.sku, status: 'error', error: (err as Error).message });
        console.error(`[recovery] Error ${row.asin}/${row.sku}:`, (err as Error).message);
      }
    }

    const summary = {
      ok: true,
      elapsed_ms: Date.now() - t0,
      zero_rows_scanned: zeroRows.length,
      candidates: candidates.length,
      restored,
      still_zero: stillZero,
      throttled,
      errors,
      results,
    };
    console.log(`[recovery] Done: restored=${restored} still_zero=${stillZero} throttled=${throttled} errors=${errors}`);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error(`[recovery] Fatal:`, (err as Error).message, err.stack);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
