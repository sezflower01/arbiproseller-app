// Monthly Liquidation Audit — for ONE year, returns a per-month breakdown of
// liquidation revenue/fees coming from EACH SP-API source list, plus what is
// currently stored in financial_events_cache (i.e. what the P&L UI displays).
//
// Read-only on financial_events_cache. Fetches financialEvents from SP-API
// (slow — one pass per month requested).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ---------- AWS SigV4 ----------
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
  return {
    Authorization: `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    host,
  };
}
async function getLWAAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID')!;
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET')!;
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!r.ok) throw new Error('LWA token fetch failed: ' + (await r.text()));
  return (await r.json()).access_token;
}

// ---------- Per-month audit ----------
interface MonthAudit {
  year: number;
  month: number; // 1..12
  label: string; // YYYY-MM
  pages_fetched: number;
  removal_event_liquidation_revenue: number;
  removal_event_liquidation_fee: number;
  removal_event_liquidation_count: number;
  removal_adjustment_liquidation_revenue: number;
  removal_adjustment_liquidation_fee: number;
  removal_adjustment_liquidation_count: number;
  fba_liquidation_event_revenue: number;
  fba_liquidation_event_fee: number;
  fba_liquidation_event_count: number;
  service_fee_liquidation_revenue: number;
  service_fee_liquidation_count: number;
  adjustment_event_liquidation_revenue: number;
  adjustment_event_liquidation_count: number;
  other_lists_with_liquidation: { list: string; hits: number }[];
  // Total parsed by the same logic as fetch-profit-loss
  computed_liquidations_revenue: number;
  computed_liquidations_brokerage_fee: number;
  // Currently displayed (what's in financial_events_cache)
  cached_liquidations: number;
  cached_liquidations_brokerage_fee: number;
  cached_event_count: number;
  // Helpful: liquidation TransactionType values seen
  transaction_types_seen: Record<string, number>;
  error?: string;
}

function num(v: any): number { return Number.parseFloat(String(v ?? 0)) || 0; }

async function auditMonth(accessToken: string, year: number, month: number, maxPages = 200): Promise<MonthAudit> {
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 1));
  const label = `${year}-${String(month).padStart(2, '0')}`;
  const audit: MonthAudit = {
    year, month, label,
    pages_fetched: 0,
    removal_event_liquidation_revenue: 0,
    removal_event_liquidation_fee: 0,
    removal_event_liquidation_count: 0,
    removal_adjustment_liquidation_revenue: 0,
    removal_adjustment_liquidation_fee: 0,
    removal_adjustment_liquidation_count: 0,
    fba_liquidation_event_revenue: 0,
    fba_liquidation_event_fee: 0,
    fba_liquidation_event_count: 0,
    service_fee_liquidation_revenue: 0,
    service_fee_liquidation_count: 0,
    adjustment_event_liquidation_revenue: 0,
    adjustment_event_liquidation_count: 0,
    other_lists_with_liquidation: [],
    computed_liquidations_revenue: 0,
    computed_liquidations_brokerage_fee: 0,
    cached_liquidations: 0,
    cached_liquidations_brokerage_fee: 0,
    cached_event_count: 0,
    transaction_types_seen: {},
  };

  const otherCounts = new Map<string, number>();
  let nextToken: string | null = null;

  do {
    const params = new URLSearchParams({
      PostedAfter: startDate.toISOString(),
      PostedBefore: endDate.toISOString(),
      MaxResultsPerPage: '100',
    });
    if (nextToken) params.set('NextToken', nextToken);
    const url = `https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents?${params.toString()}`;
    const headers = await signRequest('GET', url, '', accessToken);

    audit.pages_fetched++;
    if (audit.pages_fetched > maxPages) break;

    const resp = await fetch(url, { method: 'GET', headers: { ...headers, 'Content-Type': 'application/json' } });
    if (resp.status === 429) {
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }
    if (!resp.ok) {
      audit.error = `SP-API ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
      return audit;
    }
    const data = await resp.json();
    const events = data.payload?.FinancialEvents || {};

    // RemovalShipmentEventList
    for (const ev of events.RemovalShipmentEventList || []) {
      const txn = String(ev.TransactionType || '').toUpperCase();
      if (!txn.includes('LIQUIDATION')) continue;
      audit.removal_event_liquidation_count++;
      audit.transaction_types_seen[txn] = (audit.transaction_types_seen[txn] || 0) + 1;
      for (const item of ev.RemovalShipmentItemList || []) {
        audit.removal_event_liquidation_revenue += num(item.Revenue?.CurrencyAmount);
        audit.removal_event_liquidation_fee += Math.abs(num(item.FeeAmount?.CurrencyAmount));
      }
    }

    // RemovalShipmentAdjustmentEventList
    for (const ev of events.RemovalShipmentAdjustmentEventList || []) {
      const txn = String(ev.TransactionType || '').toUpperCase();
      if (!txn.includes('LIQUIDATION')) continue;
      audit.removal_adjustment_liquidation_count++;
      audit.transaction_types_seen[txn] = (audit.transaction_types_seen[txn] || 0) + 1;
      for (const item of ev.RemovalShipmentItemAdjustmentList || []) {
        const rev = num(item.RevenueAdjustment?.CurrencyAmount ?? item.RevenueAmount?.CurrencyAmount);
        const fee = num(item.FeeAdjustment?.CurrencyAmount ?? item.FeeAmount?.CurrencyAmount);
        audit.removal_adjustment_liquidation_revenue += rev;
        audit.removal_adjustment_liquidation_fee += Math.abs(fee);
      }
    }

    // FBALiquidationEventList (legacy/alt list)
    for (const ev of events.FBALiquidationEventList || []) {
      audit.fba_liquidation_event_count++;
      audit.fba_liquidation_event_revenue += num(ev.LiquidationProceedsAmount?.CurrencyAmount);
      audit.fba_liquidation_event_fee += Math.abs(num(ev.LiquidationFeeAmount?.CurrencyAmount));
    }

    // ServiceFeeEventList — sometimes carries liquidation chargebacks
    for (const ev of events.ServiceFeeEventList || []) {
      for (const c of ev.FeeList || []) {
        const ft = String(c.FeeType || '');
        if (/liquid/i.test(ft)) {
          audit.service_fee_liquidation_count++;
          audit.service_fee_liquidation_revenue += num(c.FeeAmount?.CurrencyAmount);
        }
      }
    }

    // AdjustmentEventList — sometimes carries LIQUIDATION_BALANCE / similar
    for (const ev of events.AdjustmentEventList || []) {
      const at = String(ev.AdjustmentType || '').toUpperCase();
      if (!at.includes('LIQUID')) continue;
      audit.adjustment_event_liquidation_count++;
      audit.transaction_types_seen[at] = (audit.transaction_types_seen[at] || 0) + 1;
      for (const item of ev.AdjustmentItemList || []) {
        audit.adjustment_event_liquidation_revenue += num(item.PerUnitAmount?.CurrencyAmount) * (Number(item.Quantity) || 1);
      }
    }

    // Sweep every OTHER list for stray "liquid" mentions
    for (const [listName, listVal] of Object.entries(events)) {
      if (!Array.isArray(listVal)) continue;
      if ([
        'RemovalShipmentEventList',
        'RemovalShipmentAdjustmentEventList',
        'FBALiquidationEventList',
        'ServiceFeeEventList',
        'AdjustmentEventList',
      ].includes(listName)) continue;
      for (const ev of listVal as any[]) {
        if (/liquid/i.test(JSON.stringify(ev))) {
          otherCounts.set(listName, (otherCounts.get(listName) || 0) + 1);
        }
      }
    }

    nextToken = data.payload?.NextToken || null;
    if (nextToken) await new Promise(r => setTimeout(r, 600));
  } while (nextToken);

  audit.other_lists_with_liquidation = Array.from(otherCounts.entries())
    .map(([list, hits]) => ({ list, hits }))
    .sort((a, b) => b.hits - a.hits);

  audit.computed_liquidations_revenue =
    audit.removal_event_liquidation_revenue +
    audit.removal_adjustment_liquidation_revenue +
    audit.fba_liquidation_event_revenue +
    audit.adjustment_event_liquidation_revenue;
  audit.computed_liquidations_brokerage_fee =
    audit.removal_event_liquidation_fee +
    audit.removal_adjustment_liquidation_fee +
    audit.fba_liquidation_event_fee +
    Math.abs(audit.service_fee_liquidation_revenue);

  return audit;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Missing Authorization' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return new Response(JSON.stringify({ error: 'Invalid auth' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    let body: any = {};
    try { body = await req.json(); } catch { /* ignore */ }
    const year = Number(body.year) || new Date().getUTCFullYear();
    const months: number[] = Array.isArray(body.months) && body.months.length
      ? body.months.map((m: any) => Number(m)).filter((m: number) => m >= 1 && m <= 12)
      : Array.from({ length: 12 }, (_, i) => i + 1);
    const maxPagesPerMonth = Math.min(Number(body.maxPagesPerMonth) || 200, 500);

    // Refresh token
    const { data: authRows, error: authErr } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id')
      .eq('user_id', user.id);
    if (authErr || !authRows?.length) {
      return new Response(JSON.stringify({ error: 'No Amazon seller authorization found' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const authData = authRows.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows[0];
    const accessToken = await getLWAAccessToken(authData.refresh_token);

    // Cached values from financial_events_cache (what the UI currently shows)
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year + 1}-01-01`;
    const { data: cacheRows, error: cacheErr } = await supabase
      .from('financial_events_cache')
      .select('event_date, liquidations, liquidations_brokerage_fee')
      .eq('user_id', user.id)
      .gte('event_date', yearStart)
      .lt('event_date', yearEnd);
    if (cacheErr) console.error('[audit-liquidations-year] cache read error', cacheErr);

    const cachedByMonth = new Map<number, { rev: number; fee: number; count: number }>();
    for (const r of cacheRows || []) {
      const d = new Date(r.event_date);
      const m = d.getUTCMonth() + 1;
      const cur = cachedByMonth.get(m) || { rev: 0, fee: 0, count: 0 };
      cur.rev += Number(r.liquidations) || 0;
      cur.fee += Number(r.liquidations_brokerage_fee) || 0;
      cur.count += 1;
      cachedByMonth.set(m, cur);
    }

    // Run months sequentially (each takes time + token rate-limited)
    const results: MonthAudit[] = [];
    for (const m of months) {
      try {
        const a = await auditMonth(accessToken, year, m, maxPagesPerMonth);
        const c = cachedByMonth.get(m);
        if (c) {
          a.cached_liquidations = c.rev;
          a.cached_liquidations_brokerage_fee = c.fee;
          a.cached_event_count = c.count;
        }
        results.push(a);
      } catch (err: any) {
        results.push({
          year, month: m, label: `${year}-${String(m).padStart(2, '0')}`,
          pages_fetched: 0,
          removal_event_liquidation_revenue: 0, removal_event_liquidation_fee: 0, removal_event_liquidation_count: 0,
          removal_adjustment_liquidation_revenue: 0, removal_adjustment_liquidation_fee: 0, removal_adjustment_liquidation_count: 0,
          fba_liquidation_event_revenue: 0, fba_liquidation_event_fee: 0, fba_liquidation_event_count: 0,
          service_fee_liquidation_revenue: 0, service_fee_liquidation_count: 0,
          adjustment_event_liquidation_revenue: 0, adjustment_event_liquidation_count: 0,
          other_lists_with_liquidation: [],
          computed_liquidations_revenue: 0, computed_liquidations_brokerage_fee: 0,
          cached_liquidations: cachedByMonth.get(m)?.rev || 0,
          cached_liquidations_brokerage_fee: cachedByMonth.get(m)?.fee || 0,
          cached_event_count: cachedByMonth.get(m)?.count || 0,
          transaction_types_seen: {},
          error: err?.message || String(err),
        });
      }
    }

    const totals = results.reduce((acc, a) => {
      acc.removal_event_revenue += a.removal_event_liquidation_revenue;
      acc.removal_adjustment_revenue += a.removal_adjustment_liquidation_revenue;
      acc.fba_event_revenue += a.fba_liquidation_event_revenue;
      acc.adjustment_event_revenue += a.adjustment_event_liquidation_revenue;
      acc.computed_revenue += a.computed_liquidations_revenue;
      acc.computed_fee += a.computed_liquidations_brokerage_fee;
      acc.cached_revenue += a.cached_liquidations;
      acc.cached_fee += a.cached_liquidations_brokerage_fee;
      return acc;
    }, {
      removal_event_revenue: 0, removal_adjustment_revenue: 0, fba_event_revenue: 0, adjustment_event_revenue: 0,
      computed_revenue: 0, computed_fee: 0, cached_revenue: 0, cached_fee: 0,
    });

    return new Response(JSON.stringify({ ok: true, year, months: results, totals }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[audit-liquidations-year] error', err);
    return new Response(JSON.stringify({ error: err?.message || String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
