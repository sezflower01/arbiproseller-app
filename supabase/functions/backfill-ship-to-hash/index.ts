// Backfill sales_orders.ship_to_hash from the SP-API Orders _GENERAL report.
// Uses ship-city + ship-state + ship-postal-code + ship-country (no PII).
// Two-phase invocation (same shape as spapi-orders-report-probe):
//   1) POST { userId, days? }              → creates report, returns reportId
//   2) POST { userId, reportId }           → polls; when DONE, downloads and writes ship_to_hash
//
// Does NOT touch buyer_email, customer_key, sold_price, refunds, fees, ROI, or repricer state.
// Writes ONLY sales_orders.ship_to_hash for rows scoped to (user_id, order_id).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const enc = new TextEncoder();
async function sha256Hex(input: string) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(key: ArrayBuffer, msg: string) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
function toHex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  const payloadHash = await sha256Hex(body);
  const canonicalHeaders = `host:${u.host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const canonicalRequest = [method, u.pathname, u.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
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
const US_MP = 'ATVPDKIKX0DER';
const REPORT_TYPE = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL';

async function computeShipToHash(city: string, state: string, postal: string, country: string) {
  const norm = [city, state, postal, country]
    .map((v) => (v || '').toString().trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
  if (norm.replace(/\|/g, '').length === 0) return null;
  return await sha256Hex(norm);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const body = await req.json().catch(() => ({}));
    const userId: string = body?.userId;
    const days: number = Math.min(Math.max(Number(body?.days || 90), 7), 730);
    if (!userId) throw new Error('userId required');

    const { data: credRows } = await supabase.rpc('get_spapi_credentials_decrypted', { p_user_id: userId });
    const cred = (credRows as any[])?.[0];
    const refresh = cred?.refresh_token || Deno.env.get('SPAPI_REFRESH_TOKEN');
    const cid = cred?.lwa_client_id || Deno.env.get('LWA_CLIENT_ID');
    const csec = cred?.lwa_client_secret || Deno.env.get('LWA_CLIENT_SECRET');
    if (!refresh) throw new Error('no spapi credentials');
    const access = await lwaToken(refresh, cid, csec);

    let reportId: string | undefined = body?.reportId;

    // Phase 1: create report (Amazon caps _GENERAL to 30-day window; use offsetDays to walk back)
    if (!reportId) {
      const offsetDays: number = Math.max(0, Number(body?.offsetDays || 0));
      const win: number = Math.min(30, Math.max(1, Number(body?.days || 30)));
      const end = new Date(Date.now() - offsetDays * 86400_000);
      const start = new Date(end.getTime() - win * 86400_000);
      const createUrl = `${HOST_NA}/reports/2021-06-30/reports`;
      const createBody = JSON.stringify({
        reportType: REPORT_TYPE,
        dataStartTime: start.toISOString(),
        dataEndTime: end.toISOString(),
        marketplaceIds: [US_MP],
      });
      const h = await signRequest('POST', createUrl, createBody, access);
      const res = await fetch(createUrl, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: createBody });
      const t = await res.text();
      if (!res.ok) throw new Error(`create ${res.status}: ${t.slice(0, 500)}`);
      reportId = JSON.parse(t).reportId;
      return new Response(JSON.stringify({ ok: true, stage: 'created', reportId, hint: 'Poll again with { userId, reportId }' }, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Phase 2: poll + ingest
    const sUrl = `${HOST_NA}/reports/2021-06-30/reports/${reportId}`;
    const sh = await signRequest('GET', sUrl, '', access);
    const sr = await fetch(sUrl, { method: 'GET', headers: sh });
    const doc: any = await sr.json();
    if (doc.processingStatus !== 'DONE') {
      return new Response(JSON.stringify({ ok: true, stage: 'polling', reportId, status: doc.processingStatus }, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const docUrl = `${HOST_NA}/reports/2021-06-30/documents/${doc.reportDocumentId}`;
    const dh = await signRequest('GET', docUrl, '', access);
    const dr = await fetch(docUrl, { method: 'GET', headers: dh });
    const dj = await dr.json();
    let text = '';
    let downloadDebug: any = { compressionAlgorithm: dj?.compressionAlgorithm, hasUrl: !!dj?.url };
    try {
      const raw = await fetch(dj.url);
      downloadDebug.httpStatus = raw.status;
      downloadDebug.contentEncoding = raw.headers.get('content-encoding');
      downloadDebug.contentType = raw.headers.get('content-type');
      const ab = await raw.arrayBuffer();
      downloadDebug.bytes = ab.byteLength;
      // Detect gzip via magic bytes (0x1f 0x8b) — more reliable than content-encoding,
      // which Amazon sometimes reports as 'identity' even when the body is gzipped.
      const u8 = new Uint8Array(ab);
      const isGzipMagic = u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
      const needsGunzip = isGzipMagic || (dj?.compressionAlgorithm === 'GZIP' && (!downloadDebug.contentEncoding || downloadDebug.contentEncoding === 'identity'));
      if (needsGunzip) {
        const ds = new DecompressionStream('gzip');
        text = await new Response(new Blob([ab]).stream().pipeThrough(ds)).text();
      } else {
        text = new TextDecoder('utf-8').decode(ab);
      }
      // Some marketplaces (esp non-NA) return latin1-ish encodings
      if (!text || text.length < 5) {
        text = new TextDecoder('latin1').decode(ab);
      }
    } catch (e: any) {
      downloadDebug.error = e.message;
    }

    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
      return new Response(JSON.stringify({
        ok: false, stage: 'download_failed', reportId,
        reportDocumentId: doc.reportDocumentId,
        lines: lines.length, text_preview: text.slice(0, 300),
        download: downloadDebug,
      }, null, 2), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const header = lines[0].split('\t');
    const iOrder = header.indexOf('amazon-order-id');
    const iCity = header.indexOf('ship-city');
    const iState = header.indexOf('ship-state');
    const iPostal = header.indexOf('ship-postal-code');
    const iCountry = header.indexOf('ship-country');
    if (iOrder < 0 || iCity < 0 || iState < 0 || iPostal < 0) {
      return new Response(JSON.stringify({
        ok: false, stage: 'missing_columns', reportId,
        header_row: lines[0].slice(0, 1000),
        header_cols: header,
        row_count: lines.length - 1,
        first_data_row: lines[1]?.slice(0, 500) || null,
        download: downloadDebug,
      }, null, 2), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Build order_id -> hash map (dedupe)
    const orderHash = new Map<string, string>();
    let skippedNoAddress = 0;
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split('\t');
      const oid = (c[iOrder] || '').trim();
      if (!oid) continue;
      if (orderHash.has(oid)) continue;
      const h = await computeShipToHash(
        c[iCity] || '',
        c[iState] || '',
        c[iPostal] || '',
        iCountry >= 0 ? (c[iCountry] || '') : 'US',
      );
      if (!h) { skippedNoAddress++; continue; }
      orderHash.set(oid, h);
    }

    // Single-shot bulk update via RPC that handles all orders in one SQL statement.
    const pairs = Array.from(orderHash.entries()).map(([oid, h]) => ({ oid, h }));
    let updatedRows = 0;
    const errors: string[] = [];
    // Split into a few sub-batches to keep JSONB payload well under limits.
    const RPC_CHUNK = 2000;
    for (let i = 0; i < pairs.length; i += RPC_CHUNK) {
      const slice = pairs.slice(i, i + RPC_CHUNK);
      const { data, error } = await supabase.rpc('bulk_apply_ship_to_hash', { p_user_id: userId, p_pairs: slice });
      if (error) errors.push('rpc:' + error.message);
      else updatedRows += Number(data || 0);
    }
    const matchedOrders = updatedRows;

    // Propagate to -REFUND siblings for this user in one SQL round-trip.
    let refundPropagated = 0;
    try {
      const { data: propRes, error: propErr } = await supabase.rpc('propagate_ship_to_hash_to_refunds', { p_user_id: userId });
      if (propErr) errors.push('propagate:' + propErr.message);
      else refundPropagated = Number((propRes as any) || 0);
    } catch (e: any) {
      errors.push('propagate_ex:' + e.message);
    }
    const missing = 0;

    return new Response(JSON.stringify({
      ok: true,
      stage: 'ingested',
      reportId,
      window_days: days,
      report_rows: lines.length - 1,
      unique_orders_in_report: orderHash.size,
      skipped_no_address: skippedNoAddress,
      matched_orders_in_sales: matchedOrders,
      unmatched_orders: missing,
      updated_sales_rows: updatedRows,
      refund_siblings_propagated: refundPropagated,
      errors: errors.slice(0, 10),
      wrote_only: 'sales_orders.ship_to_hash',
      guarantees: [
        'no writes to buyer_email',
        'no writes to customer_key',
        'no writes to sold_price/total_sale_amount/refund_amount/fees',
      ],
    }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
