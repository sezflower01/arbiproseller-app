// Diagnostic: Fetch one month of SP-API financial events and report
// EXACTLY which event lists contain liquidation-related data for this account.
// Read-only — does NOT write to financial_events_cache.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ---------- AWS SigV4 (mirrors fetch-profit-loss) ----------
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return await crypto.subtle.digest('SHA-256', encoder.encode(message) as any);
}
async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode('AWS4' + secretKey), dateStamp);
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
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = toHex(await sha256(body));
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const canonicalRequest = [method, urlObj.pathname, urlObj.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, toHex(await sha256(canonicalRequest))].join('\n');
  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));
  const authHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { 'Authorization': authHeader, 'x-amz-date': amzDate, 'x-amz-access-token': accessToken, 'host': host };
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
  if (!response.ok) throw new Error('LWA token fetch failed: ' + (await response.text()));
  return (await response.json()).access_token;
}

// ---------- Diagnostic logic ----------
const LIQUIDATION_KEYWORDS = ['liquid', 'LIQUID', 'Liquid'];

function jsonContainsLiquidation(obj: any): boolean {
  if (obj === null || obj === undefined) return false;
  const s = JSON.stringify(obj);
  return /liquid/i.test(s);
}

interface ListReport {
  list_name: string;
  total_events: number;
  events_with_liquidation_keyword: number;
  sample_event: any | null;
  charge_types_seen: Record<string, number>;
  adjustment_types_seen: Record<string, number>;
  removal_dispositions_seen: Record<string, number>;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Authenticate caller
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Missing Authorization header' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return new Response(JSON.stringify({ error: 'Invalid auth' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Parse body { year, month } — defaults to 2025-01 if missing
    let body: any = {};
    try { body = await req.json(); } catch { /* ignore */ }
    const year = Number(body.year) || 2025;
    const month = Number(body.month) || 1; // 1..12
    const maxPages = Math.min(Number(body.maxPages) || 50, 500);

    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 1));
    const monthLabel = `${year}-${String(month).padStart(2, '0')}`;

    // Look up refresh token (prefer US)
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id')
      .eq('user_id', user.id);
    if (authError || !authRows?.length) {
      return new Response(JSON.stringify({ error: 'No Amazon seller authorization found' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const authData = authRows.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows[0];

    const accessToken = await getLWAAccessToken(authData.refresh_token);

    // Track every list seen
    const reports = new Map<string, ListReport>();
    const ensureReport = (name: string): ListReport => {
      if (!reports.has(name)) {
        reports.set(name, {
          list_name: name,
          total_events: 0,
          events_with_liquidation_keyword: 0,
          sample_event: null,
          charge_types_seen: {},
          adjustment_types_seen: {},
          removal_dispositions_seen: {},
        });
      }
      return reports.get(name)!;
    };

    let nextToken: string | null = null;
    let pageCount = 0;
    let totalEvents = 0;
    let liquidationHits = 0;
    const liquidationSamples: any[] = []; // up to 5 full-event samples that mention 'liquid'

    do {
      const params = new URLSearchParams({
        PostedAfter: startDate.toISOString(),
        PostedBefore: endDate.toISOString(),
        MaxResultsPerPage: '100',
      });
      if (nextToken) params.set('NextToken', nextToken);

      const url = `https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents?${params.toString()}`;
      const headers = await signRequest('GET', url, '', accessToken);

      pageCount++;
      console.log(`[diagnose-liquidations ${monthLabel}] page ${pageCount}`);
      if (pageCount > maxPages) {
        console.warn(`[diagnose-liquidations ${monthLabel}] hit maxPages=${maxPages}, stopping`);
        break;
      }

      const resp = await fetch(url, { method: 'GET', headers: { ...headers, 'Content-Type': 'application/json' } });
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      if (!resp.ok) {
        const errText = await resp.text();
        return new Response(JSON.stringify({ error: 'SP-API error', status: resp.status, body: errText.slice(0, 500) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const data = await resp.json();
      const events = data.payload?.FinancialEvents || {};

      // Walk every key on FinancialEvents — they are all *EventList arrays
      for (const [listName, listValue] of Object.entries(events)) {
        if (!Array.isArray(listValue)) continue;
        const r = ensureReport(listName);
        for (const ev of listValue) {
          r.total_events++;
          totalEvents++;

          // Charge types (works for ServiceFee, AdjustmentEvent, etc.)
          const chargeList = (ev as any).ChargeComponentList || (ev as any).ChargeList;
          if (Array.isArray(chargeList)) {
            for (const c of chargeList) {
              const ct = c?.ChargeType;
              if (ct) r.charge_types_seen[ct] = (r.charge_types_seen[ct] || 0) + 1;
            }
          }
          // Adjustment type
          const adjType = (ev as any).AdjustmentType;
          if (adjType) r.adjustment_types_seen[adjType] = (r.adjustment_types_seen[adjType] || 0) + 1;

          // Removal disposition (RemovalShipmentEvent items)
          const items = (ev as any).RemovalShipmentItemList || (ev as any).AdjustmentItemList;
          if (Array.isArray(items)) {
            for (const it of items) {
              const disp = it?.RemovalDisposition || it?.Disposition;
              if (disp) r.removal_dispositions_seen[disp] = (r.removal_dispositions_seen[disp] || 0) + 1;
            }
          }
          // Order-level disposition
          const orderDisp = (ev as any).RemovalDisposition;
          if (orderDisp) r.removal_dispositions_seen[orderDisp] = (r.removal_dispositions_seen[orderDisp] || 0) + 1;

          // Liquidation keyword check
          if (jsonContainsLiquidation(ev)) {
            r.events_with_liquidation_keyword++;
            liquidationHits++;
            if (!r.sample_event) r.sample_event = ev;
            if (liquidationSamples.length < 5) {
              liquidationSamples.push({ list: listName, event: ev });
            }
          }
        }
      }

      nextToken = data.payload?.NextToken || null;
    } while (nextToken);

    // Build summary sorted by hit count
    const reportArr = Array.from(reports.values()).sort(
      (a, b) => b.events_with_liquidation_keyword - a.events_with_liquidation_keyword || b.total_events - a.total_events
    );

    const summary = {
      month: monthLabel,
      pages_fetched: pageCount,
      total_events: totalEvents,
      events_with_liquidation_keyword: liquidationHits,
      lists_with_liquidation_data: reportArr.filter(r => r.events_with_liquidation_keyword > 0).map(r => r.list_name),
      lists_present: reportArr.map(r => ({ name: r.list_name, count: r.total_events, liquidation_hits: r.events_with_liquidation_keyword })),
    };

    return new Response(JSON.stringify({
      ok: true,
      summary,
      reports: reportArr,
      liquidation_samples: liquidationSamples,
    }, null, 2), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[diagnose-liquidations] error', err);
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
