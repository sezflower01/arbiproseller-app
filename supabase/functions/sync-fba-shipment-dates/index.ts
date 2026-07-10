// Edge function: sync-fba-shipment-dates
// Pulls accurate ship/received/last-updated dates from Amazon SP-API and stores
// them on fba_shipments so Shipment Accounting can bucket shipments by their
// REAL date instead of the row's created_at (which is just when our backfill ran).
//
// Strategy:
//  1) Use the 2024-03-20 inbound API to get lastUpdatedAt (this is reliable and
//     authoritative — it's the timestamp Amazon last touched the shipment).
//  2) Parse a date from the shipment_name as a secondary hint (only when the
//     2024-03-20 API has no record of the shipment).
//  3) Use quantity_received > 0 to mark received_date = lastUpdatedAt.
//  4) Process in small batches (default 25 shipments per invocation) and
//     return progress so the UI can keep calling until done.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

// ===== AWS SigV4 helpers =====
async function sha256(message: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
}
async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function getSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}
async function signRequest(method: string, url: string, body: string, accessToken: string): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';
  const urlObj = new URL(url);
  const host = urlObj.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = toHex(await sha256(body));
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const canonicalRequest = [method, urlObj.pathname, urlObj.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, toHex(await sha256(canonicalRequest))].join('\n');
  const signingKey = await getSigningKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': host,
  };
}
async function getLwaAccessToken(refreshToken: string): Promise<string> {
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
    const text = await response.text();
    throw new Error(`LWA token error: ${response.status} - ${text}`);
  }
  const data = await response.json();
  return data.access_token;
}
async function callSpApi(method: string, url: string, accessToken: string, body = ''): Promise<{ ok: boolean; status: number; data: any }> {
  const headers = await signRequest(method, url, body, accessToken);
  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': headers['Authorization'],
      'x-amz-date': headers['x-amz-date'],
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: body || undefined,
  });
  const text = await response.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: response.ok, status: response.status, data };
}

// Parse a date out of common shipment name patterns.
// Examples that match: "(03/20/2025) - Lift", "Box (3/5/25) - 2.50", "03/20/2024-3.56"
function parseDateFromShipmentName(name: string | null | undefined): string | null {
  if (!name) return null;
  // Look for M/D/YYYY anywhere in the name
  const m = name.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let [_, mm, dd, yy] = m;
  let year = parseInt(yy, 10);
  if (year < 100) year = 2000 + year;
  const month = parseInt(mm, 10);
  const day = parseInt(dd, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2015 || year > 2030) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Sanity check
  const d = new Date(iso + 'T12:00:00Z');
  if (isNaN(d.getTime())) return null;
  return iso;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const requestBody: any = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(requestBody?.batchSize) || 25, 1), 50);
    const requestedShipmentId: string | null =
      typeof requestBody?.shipmentId === 'string' ? requestBody.shipmentId.trim() : null;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth: JWT or internal-secret + body.user_id
    const internalSecret = req.headers.get('x-internal-secret');
    const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    let userId: string | null = null;
    if (internalSecret && expectedSecret && internalSecret === expectedSecret) {
      const bodyUserId = typeof requestBody?.user_id === 'string' ? requestBody.user_id.trim() : '';
      if (!bodyUserId) throw new Error('user_id required when using internal-secret auth');
      userId = bodyUserId;
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) throw new Error('Missing authorization header');
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: userError } = await supabase.auth.getUser(token);
      if (userError || !user) throw new Error('Unauthorized');
      userId = user.id;
    }

    // Pick the next batch of shipments needing date sync
    let shipmentIds: string[] = [];
    if (requestedShipmentId) {
      shipmentIds = [requestedShipmentId];
    } else {
      const { data: rows, error: listErr } = await supabase
        .rpc('list_shipments_needing_date_sync', { p_user_id: userId, p_limit: batchSize });
      if (listErr) throw new Error(`list rpc error: ${listErr.message}`);
      shipmentIds = (rows || []).map((r: any) => r.shipment_id).filter(Boolean);
    }

    // Compute total remaining (for UI progress) — include unresolved rows so
    // the user can see how many shipments still need a successful date pass.
    const { count: remaining } = await supabase
      .from('fba_shipments')
      .select('shipment_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .or('dates_synced_at.is.null,unresolved_date.eq.true');

    if (shipmentIds.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        processed: 0,
        updated: 0,
        remaining: remaining || 0,
        done: true,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    // Get auth token
    const { data: authRows } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id')
      .eq('user_id', userId);
    if (!authRows || authRows.length === 0) {
      throw new Error('No Amazon seller authorization found');
    }
    const NA_MARKETPLACES = ['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC'];
    const auth =
      authRows.find((r: any) => r.marketplace_id === 'ATVPDKIKX0DER') ||
      authRows.find((r: any) => NA_MARKETPLACES.includes(r.marketplace_id)) ||
      authRows[0];
    const marketplaceId = auth.marketplace_id || 'ATVPDKIKX0DER';
    const accessToken = await getLwaAccessToken(auth.refresh_token);

    let updated = 0;
    let withNameDate = 0;
    let withNeedByFallback = 0;
    let unresolved = 0;
    const errors: string[] = [];

    for (const shipmentId of shipmentIds) {
      try {
        let shipDate: string | null = null;
        let receivedDate: string | null = null;
        let lastUpdatedIso: string | null = null;

        // 1) Try the v0 endpoint with single shipment lookup — this is what we already use.
        // It returns ConfirmedNeedByDate among other things; ShipDate is NOT returned.
        // We use it primarily to know the shipment_status (CLOSED/RECEIVING/etc.)
        const v0Url = `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments?MarketplaceId=${marketplaceId}&QueryType=SHIPMENT&ShipmentIdList=${encodeURIComponent(shipmentId)}`;
        const v0Resp = await callSpApi('GET', v0Url, accessToken);
        let v0Status: string | null = null;
        let v0NeedBy: string | null = null;
        if (v0Resp.ok) {
          const sd = v0Resp.data?.payload?.ShipmentData?.[0];
          if (sd) {
            v0Status = sd.ShipmentStatus || null;
            v0NeedBy = sd.ConfirmedNeedByDate || null;
          }
        }
        await new Promise(r => setTimeout(r, 250));

        // 2) Fetch items — if any item has quantity_received > 0, the shipment was received
        //    and we can use the items API's lastUpdated info as a proxy.
        let anyReceived = false;
        try {
          const itemsUrl = `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments/${shipmentId}/items?MarketplaceId=${marketplaceId}`;
          const itemsResp = await callSpApi('GET', itemsUrl, accessToken);
          if (itemsResp.ok) {
            const items = Array.isArray(itemsResp.data?.payload?.ItemData) ? itemsResp.data.payload.ItemData : [];
            anyReceived = items.some((it: any) => Number(it.QuantityReceived || 0) > 0);
          }
        } catch (e) {
          // non-fatal
        }
        await new Promise(r => setTimeout(r, 250));

        // 3) Try the 2024-03-20 inbound API for lastUpdatedAt
        try {
          const newUrl = `https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/inboundPlans?shipmentId=${encodeURIComponent(shipmentId)}`;
          const newResp = await callSpApi('GET', newUrl, accessToken);
          if (newResp.ok) {
            // Best-effort: pull any ISO dates we can find in the response
            const blob = JSON.stringify(newResp.data);
            const isoMatch = blob.match(/"lastUpdatedAt"\s*:\s*"([^"]+)"/);
            if (isoMatch) lastUpdatedIso = isoMatch[1];
          }
        } catch (e) {
          // non-fatal — older shipments may not exist in 2024-03-20 API
        }

        // Decide ship_date and received_date — STRICT rules to avoid contamination.
        //
        // RULE: Amazon's `lastUpdatedAt` is the API call/sync timestamp, NOT a real
        // ship date. We previously used it as a ship_date fallback and ended up
        // with 144 shipments mis-bucketed into April 2026. We now keep it ONLY in
        // last_updated_date and never let it influence ship_date / received_date.
        //
        // Allowed ship_date sources, in priority order:
        //   1) A date parsed from the shipment_name (e.g. "(03/20/2025) - Lift")
        //   2) confirmed_need_by_date IF the shipment is in a received-ish status
        //      AND we have at least one item with quantity_received > 0
        //      (this means the shipment really arrived, so need-by is a reasonable
        //      proxy for ship-by-need-by)
        // Otherwise: mark the row as unresolved_date so it's excluded from totals.
        const shipmentRow = (await supabase
          .from('fba_shipments')
          .select('shipment_name')
          .eq('user_id', userId)
          .eq('shipment_id', shipmentId)
          .maybeSingle()).data;
        const nameDate = parseDateFromShipmentName(shipmentRow?.shipment_name);

        let isUnresolved = false;
        if (nameDate) {
          shipDate = nameDate;
          withNameDate++;
        } else if (anyReceived && v0NeedBy) {
          shipDate = v0NeedBy;
          withNeedByFallback++;
        } else {
          isUnresolved = true;
          unresolved++;
        }

        // Received date: ONLY when items confirm receipt. Never derive from
        // lastUpdatedAt (sync timestamp) — that gave us false 2026 dates.
        if (anyReceived && shipDate) {
          receivedDate = shipDate;
        }

        const updateRow: any = {
          dates_synced_at: new Date().toISOString(),
          unresolved_date: isUnresolved,
        };
        if (shipDate) updateRow.ship_date = shipDate;
        if (receivedDate) updateRow.received_date = receivedDate;
        // Keep lastUpdatedAt ONLY here — never as ship_date.
        if (lastUpdatedIso) updateRow.last_updated_date = lastUpdatedIso;
        if (v0Status) updateRow.shipment_status = v0Status;
        if (v0NeedBy) updateRow.confirmed_need_by_date = v0NeedBy;

        const { error: updErr } = await supabase
          .from('fba_shipments')
          .update(updateRow)
          .eq('user_id', userId)
          .eq('shipment_id', shipmentId);

        if (updErr) {
          errors.push(`${shipmentId}: update error ${updErr.message}`);
        } else {
          updated++;
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(`${shipmentId}: ${msg}`);
        // Mark as synced anyway (with no date) so we don't loop forever on bad shipments
        await supabase
          .from('fba_shipments')
          .update({ dates_synced_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('shipment_id', shipmentId);
      }
    }

    // Recount remaining after this batch
    const { count: remainingAfter } = await supabase
      .from('fba_shipments')
      .select('shipment_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('dates_synced_at', null);

    return new Response(JSON.stringify({
      success: true,
      processed: shipmentIds.length,
      updated,
      withNameDate,
      withNeedByFallback,
      unresolved,
      remaining: remainingAfter || 0,
      done: (remainingAfter || 0) === 0,
      errors: errors.slice(0, 10),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });

  } catch (e) {
    console.error('[sync-fba-shipment-dates] error:', (e as Error).message);
    return new Response(JSON.stringify({
      success: false,
      error: (e as Error).message,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});
