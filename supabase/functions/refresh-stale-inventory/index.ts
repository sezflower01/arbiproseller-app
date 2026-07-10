import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * REFRESH-STALE-INVENTORY
 * 
 * Lightweight edge function called by repricer-unified-dispatch to refresh
 * inventory data for ASINs whose stock hasn't been synced in >4 hours.
 * 
 * Design constraints:
 * - Max 3 SKUs per invocation (SP-API budget protection)
 * - Deduplicates: skips if last_inventory_sync_at < 4h ago
 * - Only for HOT/priority/active ASINs (caller filters)
 * - Fire-and-forget from dispatch (does not block eval cycle)
 * - Uses same FBA Inventory Summaries API as rescue-inventory-asin
 * 
 * Called with service_role key (internal only).
 */

const MAX_ITEMS_PER_CALL = 3;
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
const INTER_CALL_DELAY_MS = 300; // Rate protection between SP-API calls

// ─── SP-API Auth (same as rescue-inventory-asin) ────────────────────────────

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
  const clientId = Deno.env.get('SPAPI_LWA_CLIENT_ID') || Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('SPAPI_LWA_CLIENT_SECRET') || Deno.env.get('LWA_CLIENT_SECRET');
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
    throw new Error(`LWA token error: ${response.status} - ${errorText}`);
  }
  return (await response.json()).access_token;
}

async function callSpApi(
  method: string,
  path: string,
  accessToken: string,
  queryParams: Record<string, string> = {},
): Promise<any> {
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
    'host': host,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
  };

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');
  const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const requestHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${requestHash}`;
  const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, service);
  const signature = getAwsSignature(stringToSign, signingKey);
  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${path}${queryString ? '?' + queryString : ''}`;
  const response = await fetch(url, {
    method,
    headers: { ...headers, 'Authorization': authorizationHeader },
  });

  if (response.status === 429) {
    console.warn(`[refresh-stale] SP-API 429 throttled`);
    return null; // Graceful degradation
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SP-API ${response.status}: ${errorText}`);
  }
  return await response.json();
}

function getMarketplaceId(marketplace: string): string {
  switch (marketplace) {
    case 'CA': return 'A2EUQ1WTGCTBG2';
    case 'MX': return 'A1AM78C64UM0Y8';
    case 'BR': return 'A2Q3Y263D00KWC';
    default: return 'ATVPDKIKX0DER'; // US
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const t0 = Date.now();

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Validate internal-only call (service role key in auth header)
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.includes(supabaseKey.slice(0, 20))) {
      // Also accept internal secret
      const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
      const reqSecret = req.headers.get('x-internal-secret');
      if (!internalSecret || reqSecret !== internalSecret) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const body = await req.json();
    const items: Array<{ user_id: string; sku: string; asin: string; marketplace: string }> = body.items || [];

    if (!items.length) {
      return new Response(JSON.stringify({ refreshed: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Enforce max items per call
    const toProcess = items.slice(0, MAX_ITEMS_PER_CALL);

    console.log(`[refresh-stale] Processing ${toProcess.length} stale items`);

    // Deduplication: re-check last_inventory_sync_at to avoid race with other writers
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    const validItems: typeof toProcess = [];

    for (const item of toProcess) {
      const { data: inv } = await supabase
        .from('inventory')
        .select('id, last_inventory_sync_at, listing_status')
        .eq('user_id', item.user_id)
        .eq('sku', item.sku)
        .maybeSingle();

      if (!inv) {
        console.log(`[refresh-stale] ${item.asin}/${item.sku}: no inventory row, skipping`);
        continue;
      }

      // Skip tombstoned items
      if (inv.listing_status === 'NOT_IN_CATALOG' || inv.listing_status === 'DELETED') {
        console.log(`[refresh-stale] ${item.asin}/${item.sku}: tombstoned (${inv.listing_status}), skipping`);
        continue;
      }

      // Skip if recently synced (another writer beat us)
      if (inv.last_inventory_sync_at && inv.last_inventory_sync_at > staleThreshold) {
        console.log(`[refresh-stale] ${item.asin}/${item.sku}: recently synced (${inv.last_inventory_sync_at}), skipping`);
        continue;
      }

      validItems.push({ ...item, ...({ inv_id: inv.id } as any) });
    }

    if (validItems.length === 0) {
      console.log(`[refresh-stale] All items already fresh, nothing to do`);
      return new Response(JSON.stringify({ refreshed: 0, reason: 'all_fresh' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get LWA token once for all calls
    const refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN')!;
    const accessToken = await getLwaAccessToken(refreshToken);

    const results: Array<{ asin: string; sku: string; status: string; prev: any; now: any }> = [];

    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i];
      if (i > 0) await new Promise(r => setTimeout(r, INTER_CALL_DELAY_MS));

      try {
        const marketplaceId = getMarketplaceId(item.marketplace);

        // Read previous DB state for suspicious-zero detection
        const { data: prevRow } = await supabase
          .from('inventory')
          .select('available, reserved, inbound, listing_status')
          .eq('user_id', item.user_id)
          .eq('sku', item.sku)
          .maybeSingle();

        const prevTotal = (prevRow?.available || 0) + (prevRow?.reserved || 0);

        const fetchSummariesOnce = async () => {
          const response = await callSpApi('GET', '/fba/inventory/v1/summaries', accessToken, {
            marketplaceIds: marketplaceId,
            details: 'true',
            granularityType: 'Marketplace',
            granularityId: marketplaceId,
            sellerSkus: item.sku,
          });
          if (!response) return null;
          const summaries = response?.payload?.inventorySummaries || [];
          let stock = { available: 0, reserved: 0, inbound: 0 };
          for (const summary of summaries) {
            const details = summary?.inventoryDetails || summary || {};
            const inboundReceiving = details?.inboundReceivingQuantity ?? summary?.inboundReceivingQuantity ?? 0;
            const inboundShipped = details?.inboundShippedQuantity ?? summary?.inboundShippedQuantity ?? 0;
            stock = {
              available: details?.fulfillableQuantity ?? summary?.totalFulfillableQuantity ?? summary?.fulfillableQuantity ?? 0,
              reserved: details?.reservedQuantity?.totalReservedQuantity ?? summary?.reservedQuantity?.totalReservedQuantity ?? 0,
              inbound: inboundReceiving + inboundShipped,
            };
          }
          return stock;
        };

        const liveStock = await fetchSummariesOnce();

        if (!liveStock) {
          results.push({ asin: item.asin, sku: item.sku, status: 'throttled', prev: null, now: null });
          continue;
        }

        let totalLive = liveStock.available + liveStock.reserved;

        // ── SUSPICIOUS ZERO GUARD ──
        // If we previously had positive stock and Amazon now returns 0/0, do NOT
        // trust a single response. Require a second back-to-back independent fetch
        // that ALSO returns 0/0 before writing. SP-API Summaries returns
        // intermittent false-zeros — one zero alone is never enough.
        if (totalLive === 0 && prevTotal > 0) {
          console.warn(`[refresh-stale] ⚠️ ${item.asin}/${item.sku}: suspicious zero (prev avail=${prevRow?.available} res=${prevRow?.reserved}). Requesting second confirmation...`);
          await new Promise(r => setTimeout(r, 1500));
          const second = await fetchSummariesOnce();
          if (!second) {
            results.push({ asin: item.asin, sku: item.sku, status: 'suspicious_zero_blocked_throttled', prev: prevRow, now: liveStock });
            continue;
          }
          const secondTotal = second.available + second.reserved;
          if (secondTotal > 0) {
            console.log(`[refresh-stale] ✅ ${item.asin}/${item.sku}: false-zero confirmed; second fetch returned avail=${second.available} res=${second.reserved}. Using second value.`);
            liveStock.available = second.available;
            liveStock.reserved = second.reserved;
            liveStock.inbound = second.inbound;
            totalLive = secondTotal;
          } else {
            console.warn(`[refresh-stale] 🛑 ${item.asin}/${item.sku}: BOTH fetches returned 0/0 but prev was ${prevTotal}. BLOCKING write — manual verification required.`);
            HealthSignals.inventoryStale(item.user_id, 'refresh-stale-inventory', item.asin, item.sku, item.marketplace);
            results.push({ asin: item.asin, sku: item.sku, status: 'suspicious_zero_blocked', prev: prevRow, now: liveStock });
            continue;
          }
        }

        const newListingStatus = totalLive > 0 ? 'ACTIVE' : 'INACTIVE';

        const nowIso = new Date().toISOString();
        const { error: updateError } = await supabase
          .from('inventory')
          .update({
            available: liveStock.available,
            reserved: liveStock.reserved,
            inbound: liveStock.inbound,
            listing_status: newListingStatus,
            source: 'live_api',
            last_inventory_sync_at: nowIso,
            last_summaries_at: nowIso,
          })
          .eq('user_id', item.user_id)
          .eq('sku', item.sku);

        if (updateError) {
          console.error(`[refresh-stale] DB update failed for ${item.asin}/${item.sku}:`, updateError);
          results.push({ asin: item.asin, sku: item.sku, status: 'db_error', prev: prevRow, now: null });
        } else {
          console.log(`[refresh-stale] ✅ ${item.asin}/${item.sku} → avail=${liveStock.available} res=${liveStock.reserved} in=${liveStock.inbound}`);
          results.push({
            asin: item.asin,
            sku: item.sku,
            status: 'refreshed',
            prev: prevRow,
            now: liveStock,
          });
        }
      } catch (err: any) {
        console.error(`[refresh-stale] Error for ${item.asin}/${item.sku}:`, (err as Error).message);
        results.push({ asin: item.asin, sku: item.sku, status: 'error', prev: null, now: null });
      }
    }

    const refreshed = results.filter(r => r.status === 'refreshed').length;
    console.log(`[refresh-stale] Done: ${refreshed}/${validItems.length} refreshed in ${Date.now() - t0}ms`);

    return new Response(JSON.stringify({ refreshed, results, elapsed_ms: Date.now() - t0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error(`[refresh-stale] Fatal error:`, (err as Error).message, err.stack);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
