// sync-amazon-dispositions
// Pulls Amazon FBA Removal Order Detail data and upserts into inventory_dispositions.
//
// Source report: GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA
// Date attribution: last-updated-date  (NOT request-date)
// Dedup key: (user_id, removal_order_id, asin, msku, disposition_date) for source='amazon_report'
// Default status: pending_review (user must Accept/Ignore/Adjust to flow into P&L)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const REPORT_TYPE = 'GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA';
const MFN_RETURNS_REPORT_TYPE = 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';

// ---------- AWS SigV4 (mirrors sync-fnsku-report) ----------
async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}
async function getSigningKey(key: string, dateStamp: string, regionName: string, serviceName: string) {
  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + key), dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  return await hmacSha256(kService, 'aws4_request');
}
async function getAwsSignature(method: string, path: string, queryParams: string, headers: Record<string, string>, payload: string, accessKeyId: string, secretAccessKey: string, region: string) {
  const service = 'execute-api';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k.toLowerCase()}:${headers[k].trim()}`).join('\n') + '\n';
  const signedHeaders = Object.keys(headers).sort().map(k => k.toLowerCase()).join(';');
  const payloadHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))).map(b => b.toString(16).padStart(2, '0')).join('');
  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const canonicalRequestHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))).map(b => b.toString(16).padStart(2, '0')).join('');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;
  const signingKey = await getSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = Array.from(new Uint8Array(await hmacSha256(signingKey, stringToSign))).map(b => b.toString(16).padStart(2, '0')).join('');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_CLIENT_SECRET');
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Missing LWA credentials');
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!r.ok) throw new Error(`LWA token error: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return d.access_token;
}

async function callSpApiOnce(path: string, accessToken: string, queryParams: Record<string, string> = {}, method = 'GET', body = ''): Promise<Response> {
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const host = 'sellingpartnerapi-na.amazon.com';
  const queryString = new URLSearchParams(queryParams).toString();
  const url = `https://${host}${path}${queryString ? '?' + queryString : ''}`;
  const headers: Record<string, string> = {
    'host': host,
    'x-amz-access-token': accessToken,
    'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
    'content-type': 'application/json',
  };
  headers['Authorization'] = await getAwsSignature(method, path, queryString, headers, body, awsAccessKeyId, awsSecretAccessKey, region);
  return fetch(url, { method, headers, body: body || undefined });
}

async function callSpApi(path: string, accessToken: string, queryParams: Record<string, string> = {}, method = 'GET', body = ''): Promise<any> {
  // Retry up to 3 times on 5xx / 429 (Amazon's reports endpoint frequently returns InternalFailure)
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await callSpApiOnce(path, accessToken, queryParams, method, body);
    if (res.ok) return res.json();
    const txt = await res.text();
    lastErr = `SP-API ${method} ${path} ${res.status}: ${txt}`;
    if (res.status >= 500 || res.status === 429) {
      console.warn(`[disp] ${lastErr} — retry ${attempt}/3`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

async function callSpApiSafe(path: string, accessToken: string, queryParams: Record<string, string> = {}, method = 'GET', body = ''): Promise<any | null> {
  try { return await callSpApi(path, accessToken, queryParams, method, body); }
  catch (e: any) { console.warn(`[disp] safe-call swallowed: ${e?.message || e}`); return null; }
}

// ---------- Removal report parsing ----------

function normalizeHeader(h: string) {
  return h.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickDispositionType(orderType: string, disposition: string): 'removal' | 'disposal' | 'liquidation' | 'mfn_return' {
  const t = (orderType || '').toLowerCase();
  const d = (disposition || '').toLowerCase();
  if (t.includes('mfn')) return 'mfn_return';
  if (t.includes('disposal') || d.includes('disposed')) return 'disposal';
  if (t.includes('liquidat') || d.includes('liquidat')) return 'liquidation';
  // FBA "Return" order-type = items shipped back to merchant (not a customer return)
  return 'removal';
}

// Sellable bucket per Amazon's "disposition" column.
function isSellableDisposition(disposition: string): boolean {
  const d = (disposition || '').toLowerCase().replace(/[\s_]/g, '-');
  return d === 'sellable' || d.includes('sellable') && !d.includes('un');
}
function isUnsellableDisposition(disposition: string): boolean {
  const d = (disposition || '').toLowerCase().replace(/[\s_]/g, '-');
  if (!d) return false;
  return (
    d === 'unsellable' ||
    d.includes('unsellable') ||
    d.includes('damaged') ||      // damaged, customer-damaged, carrier-damaged, distributor-damaged, warehouse-damaged
    d.includes('defective') ||
    d.includes('expired') ||
    d.includes('disposed') ||
    d.includes('liquidat')
  );
}

interface ParsedRow {
  removal_order_id: string;
  request_date: string | null;
  last_updated_date: string | null;
  order_type: string;
  asin: string;
  msku: string;
  fnsku: string;
  disposition: string;
  qty: number;
  recovery: number;
}

function parseRemovalReport(text: string): ParsedRow[] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(normalizeHeader);
  const idx = (aliases: string[]) => {
    const n = aliases.map(normalizeHeader);
    return headers.findIndex(h => n.includes(h));
  };
  const I = {
    requestDate: idx(['request-date', 'requestdate']),
    lastUpdated: idx(['last-updated-date', 'lastupdateddate']),
    orderId: idx(['order-id', 'removal-order-id', 'orderid', 'removalorderid']),
    orderType: idx(['order-type', 'ordertype']),
    asin: idx(['asin']),
    msku: idx(['sku', 'msku', 'merchant-sku']),
    fnsku: idx(['fnsku']),
    disposition: idx(['disposition']),
    requestedQty: idx(['requested-quantity', 'requestedquantity']),
    cancelledQty: idx(['cancelled-quantity', 'cancelledquantity']),
    actualReturnQty: idx(['actual-return-quantity', 'actualreturnquantity']),
    actualDisposalQty: idx(['actual-disposal-quantity', 'actualdisposalquantity']),
    shippedQty: idx(['shipped-quantity', 'shippedquantity']),
  };
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    const get = (n: number) => (n >= 0 ? (c[n] ?? '').trim() : '');
    // Best-effort qty: prefer actual-return / actual-disposal / shipped, fall back to requested - cancelled.
    const actualReturn = parseInt(get(I.actualReturnQty) || '0', 10) || 0;
    const actualDisposal = parseInt(get(I.actualDisposalQty) || '0', 10) || 0;
    const shipped = parseInt(get(I.shippedQty) || '0', 10) || 0;
    const requested = parseInt(get(I.requestedQty) || '0', 10) || 0;
    const cancelled = parseInt(get(I.cancelledQty) || '0', 10) || 0;
    const qty = actualReturn + actualDisposal + shipped || Math.max(0, requested - cancelled);
    if (qty <= 0) continue;
    const orderId = get(I.orderId);
    if (!orderId) continue;
    rows.push({
      removal_order_id: orderId,
      request_date: get(I.requestDate) || null,
      last_updated_date: get(I.lastUpdated) || null,
      order_type: get(I.orderType),
      asin: get(I.asin),
      msku: get(I.msku),
      fnsku: get(I.fnsku),
      disposition: get(I.disposition),
      qty,
      recovery: 0, // not present in this report; future: link to financial events
    });
  }
  return rows;
}

function toIsoDate(raw: string | null): string {
  if (!raw) return new Date().toISOString().slice(0, 10);
  // Amazon returns "YYYY-MM-DDThh:mm:ss+00:00" or similar
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // fallback to slice
  return raw.slice(0, 10);
}

async function lookupUnitCost(supabase: any, userId: string, asin: string, msku: string): Promise<number> {
  // 1) created_listings (Contract A: amount = unit cost; or cost/units)
  if (asin) {
    const { data } = await supabase
      .from('created_listings')
      .select('amount, cost, units, updated_at')
      .eq('user_id', userId)
      .eq('asin', asin)
      .order('updated_at', { ascending: false })
      .limit(1);
    const row = data?.[0];
    if (row) {
      if (row.amount != null && Number(row.amount) >= 0) return Number(row.amount);
      if (Number(row.cost) > 0 && Number(row.units) > 0) return Number(row.cost) / Number(row.units);
    }
  }
  // 2) inventory.cost (by SKU first, then ASIN)
  if (msku) {
    const { data } = await supabase
      .from('inventory').select('cost').eq('user_id', userId).eq('sku', msku).limit(1);
    if (data?.[0]?.cost && Number(data[0].cost) > 0) return Number(data[0].cost);
  }
  if (asin) {
    const { data } = await supabase
      .from('inventory').select('cost').eq('user_id', userId).eq('asin', asin).limit(1);
    if (data?.[0]?.cost && Number(data[0].cost) > 0) return Number(data[0].cost);
  }
  return 0;
}

// MFN returns come from real customer orders → best cost source is sales_orders.unit_cost
async function lookupMfnReturnUnitCost(supabase: any, userId: string, asin: string, msku: string): Promise<number> {
  // Prefer most recent sale of the same ASIN with a real unit_cost
  if (asin) {
    const { data } = await supabase
      .from('sales_orders')
      .select('unit_cost, order_date')
      .eq('user_id', userId)
      .eq('asin', asin)
      .gt('unit_cost', 0)
      .order('order_date', { ascending: false })
      .limit(1);
    if (data?.[0]?.unit_cost && Number(data[0].unit_cost) > 0) return Number(data[0].unit_cost);
  }
  if (msku) {
    const { data } = await supabase
      .from('sales_orders')
      .select('unit_cost, order_date')
      .eq('user_id', userId)
      .eq('seller_sku', msku)
      .gt('unit_cost', 0)
      .order('order_date', { ascending: false })
      .limit(1);
    if (data?.[0]?.unit_cost && Number(data[0].unit_cost) > 0) return Number(data[0].unit_cost);
  }
  return 0;
}

// ---------- Generic report runner ----------

async function fetchReportText(
  accessToken: string,
  reportType: string,
  marketplaceId: string,
  daysBack: number,
  explicitStart?: string,
  explicitEnd?: string,
  forceFresh = false,
): Promise<{ text: string | null; reportId: string | null; status: 'ok' | 'empty' | 'fatal' | 'forbidden' | 'timeout' | 'error'; reason?: string }> {
  const useExplicit = !!(explicitStart && explicitEnd);
  const dataStartTime = useExplicit
    ? new Date(explicitStart!).toISOString()
    : new Date(Date.now() - daysBack * 86400000).toISOString();
  const dataEndTime = useExplicit
    ? new Date(explicitEnd!).toISOString()
    : new Date().toISOString();

  // 1) Try to reuse a recent DONE report — ONLY for the default rolling window.
  // Explicit date ranges, and manual Sync Now, must create a fresh report.
  let report: any = null;
  let amazonReportId: string | null = null;
  if (!useExplicit && !forceFresh) {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const list = await callSpApiSafe('/reports/2021-06-30/reports', accessToken, {
      reportTypes: reportType,
      processingStatuses: 'DONE',
      pageSize: '10',
      createdSince: since,
    });
    report = (list?.reports || []).find((r: any) => r.reportDocumentId);
    amazonReportId = report?.reportId ?? null;
  }

  if (!report) {
    console.log(`[disp] creating ${reportType} report (${dataStartTime} → ${dataEndTime})`);
    const createBody = JSON.stringify({
      reportType,
      marketplaceIds: [marketplaceId],
      dataStartTime,
      dataEndTime,
    });
    let created: any;
    try {
      created = await callSpApi('/reports/2021-06-30/reports', accessToken, {}, 'POST', createBody);
    } catch (e: any) {
      const msg = String(e?.message || e);
      const forbidden = /\b403\b|Unauthorized|forbidden/i.test(msg);
      console.warn(`[disp] could not create ${reportType}: ${msg}`);
      return {
        text: null,
        reportId: null,
        status: forbidden ? 'forbidden' : 'error',
        reason: forbidden
          ? `${reportType}: SP-API role missing (403). Re-authorize Amazon with the required report roles.`
          : `${reportType}: ${msg.slice(0, 200)}`,
      };
    }
    amazonReportId = created.reportId;
    let status = 'IN_QUEUE';
    let attempts = 0;
    while (status !== 'DONE' && attempts < 60) {
      await new Promise(r => setTimeout(r, 5000));
      attempts++;
      const s = await callSpApi(`/reports/2021-06-30/reports/${amazonReportId}`, accessToken);
      status = s.processingStatus;
      if (status === 'CANCELLED') {
        console.warn(`[disp] ${reportType} cancelled`);
        return { text: null, reportId: amazonReportId, status: 'error', reason: `${reportType} cancelled by Amazon` };
      }
      if (status === 'FATAL') {
        // FATAL almost always means "no data for this window" for FBA reports.
        // Amazon does not produce a document and returns FATAL instead of an empty file.
        console.warn(`[disp] ${reportType} FATAL — treating as empty window`);
        return { text: null, reportId: amazonReportId, status: 'empty', reason: `${reportType}: no data in selected window` };
      }
      if (status === 'DONE') { report = s; break; }
    }
    if (!report) {
      console.warn(`[disp] ${reportType} timed out`);
      return { text: null, reportId: amazonReportId, status: 'timeout', reason: `${reportType} timed out after 5 minutes` };
    }
  }

  const doc = await callSpApi(`/reports/2021-06-30/documents/${report.reportDocumentId}`, accessToken);
  const docRes = await fetch(doc.url);
  if (!docRes.ok) {
    console.warn(`[disp] download failed: ${docRes.status}`);
    return { text: null, reportId: amazonReportId, status: 'error', reason: `Document download failed: ${docRes.status}` };
  }
  let text: string;
  if (doc.compressionAlgorithm === 'GZIP') {
    const buf = new Uint8Array(await docRes.arrayBuffer());
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf as any]).stream().pipeThrough(ds);
    const decompressed = await new Response(stream).arrayBuffer();
    text = new TextDecoder('utf-8').decode(decompressed);
  } else {
    text = await docRes.text();
  }
  return { text, reportId: amazonReportId, status: 'ok' };
}

// ---------- MFN customer returns parser ----------
// Headers vary; common ones: return-date, order-id, sku, asin, fnsku, quantity, detailed-disposition,
// reason, status (Approved/Reimbursed), refunded-amount
function parseMfnReturnsReport(text: string): ParsedRow[] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(normalizeHeader);
  const idx = (aliases: string[]) => {
    const n = aliases.map(normalizeHeader);
    return headers.findIndex(h => n.includes(h));
  };
  const I = {
    returnDate: idx(['return-date', 'returndate']),
    orderId: idx(['order-id', 'amazon-order-id', 'orderid']),
    sku: idx(['sku', 'merchant-sku', 'msku']),
    asin: idx(['asin']),
    fnsku: idx(['fnsku']),
    qty: idx(['quantity', 'return-quantity']),
    disposition: idx(['detailed-disposition', 'item-condition', 'disposition']),
    refunded: idx(['refunded-amount', 'refund-amount']),
  };
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    const get = (n: number) => (n >= 0 ? (c[n] ?? '').trim() : '');
    const qty = parseInt(get(I.qty) || '0', 10) || 0;
    if (qty <= 0) continue;
    const orderId = get(I.orderId);
    rows.push({
      removal_order_id: orderId || `mfn-${get(I.returnDate)}-${get(I.asin)}-${get(I.sku)}`,
      request_date: get(I.returnDate) || null,
      last_updated_date: get(I.returnDate) || null,
      order_type: 'MFN-Return',
      asin: get(I.asin),
      msku: get(I.sku),
      fnsku: get(I.fnsku),
      disposition: get(I.disposition) || 'unknown',
      qty,
      recovery: parseFloat(get(I.refunded) || '0') || 0,
    });
  }
  return rows;
}

async function runReportAndCollect(supabase: any, userId: string, refreshToken: string, marketplaceId: string, daysBack: number, startDate?: string, endDate?: string, includeMfnReturns = false, forceFresh = false) {
  const accessToken = await getLwaAccessToken(refreshToken);

  const removal = await fetchReportText(accessToken, REPORT_TYPE, marketplaceId, daysBack, startDate, endDate, forceFresh);
  const mfn = includeMfnReturns
    ? await fetchReportText(accessToken, MFN_RETURNS_REPORT_TYPE, marketplaceId, daysBack, startDate, endDate, forceFresh)
    : { text: null, reportId: null, status: 'empty' as const, reason: 'MFN returns not requested' };

  const removalRows = removal.text ? parseRemovalReport(removal.text) : [];
  const mfnRows = mfn.text ? parseMfnReturnsReport(mfn.text) : [];
  const parsed: ParsedRow[] = [...removalRows, ...mfnRows];

  // Build a clear status report so the client can show the user *why* a sync returned 0 rows.
  const reportStatuses = {
    removal: { status: removal.status, reason: removal.reason || null },
    mfn_returns: { status: mfn.status, reason: mfn.reason || null },
  };
  // A "hard error" only if both reports failed for non-empty reasons (forbidden/error/timeout).
  const hardErrorStatuses = new Set(['forbidden', 'error', 'timeout']);
  const removalHardError = hardErrorStatuses.has(removal.status);
  const mfnHardError = hardErrorStatuses.has(mfn.status);

  // Raw diagnostics: what did Amazon actually send us?
  const diag: Record<string, number> = {
    total_rows: parsed.length,
    removal_report_rows: removalRows.length,
    mfn_returns_report_rows: mfnRows.length,
    sellable: 0,
    unsellable: 0,
    unknown_disposition: 0,
    order_type_return: 0,
    order_type_disposal: 0,
    order_type_liquidation: 0,
    order_type_mfn_return: 0,
    order_type_other: 0,
  };
  const dispositionCounts: Record<string, number> = {};
  const orderTypeCounts: Record<string, number> = {};
  for (const r of parsed) {
    const d = (r.disposition || '(empty)').toLowerCase();
    const ot = (r.order_type || '(empty)').toLowerCase();
    dispositionCounts[d] = (dispositionCounts[d] || 0) + r.qty;
    orderTypeCounts[ot] = (orderTypeCounts[ot] || 0) + r.qty;
    if (isSellableDisposition(r.disposition)) diag.sellable += r.qty;
    else if (isUnsellableDisposition(r.disposition)) diag.unsellable += r.qty;
    else diag.unknown_disposition += r.qty;
    if (ot.includes('mfn')) diag.order_type_mfn_return += r.qty;
    else if (ot.includes('return')) diag.order_type_return += r.qty;
    else if (ot.includes('disposal')) diag.order_type_disposal += r.qty;
    else if (ot.includes('liquidat')) diag.order_type_liquidation += r.qty;
    else diag.order_type_other += r.qty;
  }
  console.log(`[disp] parsed ${parsed.length} rows (removal=${removalRows.length}, mfn=${mfnRows.length}). Statuses:`, JSON.stringify(reportStatuses));
  return {
    parsed,
    amazonReportId: removal.reportId || mfn.reportId,
    diag,
    dispositionCounts,
    orderTypeCounts,
    reportStatuses,
    removalHardError,
    mfnHardError,
  };
}

async function upsertDispositions(supabase: any, userId: string, parsed: ParsedRow[]) {
  // Group by (removal_order_id, asin, msku, disposition_date) and split sellable vs unsellable.
  type Bucket = { sellable: number; unsellable: number; fnsku: string; type: 'removal' | 'disposal' | 'liquidation' | 'mfn_return'; recovery: number; };
  const buckets = new Map<string, Bucket>();
  for (const r of parsed) {
    const date = toIsoDate(r.last_updated_date || r.request_date);
    const key = `${r.removal_order_id}|${r.asin}|${r.msku}|${date}`;
    const b = buckets.get(key) || { sellable: 0, unsellable: 0, fnsku: r.fnsku, type: pickDispositionType(r.order_type, r.disposition), recovery: 0 };
    if (isSellableDisposition(r.disposition)) b.sellable += r.qty;
    else if (isUnsellableDisposition(r.disposition)) b.unsellable += r.qty;
    else b.unsellable += r.qty; // unknown disposition → unsellable (conservative for P&L)
    if (!b.fnsku && r.fnsku) b.fnsku = r.fnsku;
    b.recovery += r.recovery || 0;
    buckets.set(key, b);
  }

  // unit cost cache keyed by `${type}|${asin}|${msku}` so MFN returns get sales_orders cost
  const costCache = new Map<string, number>();
  let inserted = 0, skipped = 0, errors = 0;

  for (const [key, b] of buckets) {
    const [removal_order_id, asin, msku, disposition_date] = key.split('|');
    const cacheKey = `${b.type}|${asin}|${msku}`;
    if (!costCache.has(cacheKey)) {
      let cost = 0;
      if (b.type === 'mfn_return') {
        cost = await lookupMfnReturnUnitCost(supabase, userId, asin, msku);
        if (cost === 0) cost = await lookupUnitCost(supabase, userId, asin, msku); // fallback
      } else {
        cost = await lookupUnitCost(supabase, userId, asin, msku);
      }
      costCache.set(cacheKey, cost);
    }
    const unit_cost = costCache.get(cacheKey) || 0;
    const total_qty = b.sellable + b.unsellable;

    // Auto-accept zero-loss rows (fully sellable, no unsellable units → no P&L impact, no review needed)
    const isZeroLoss = b.unsellable === 0 && b.sellable > 0;
    const status: 'pending_review' | 'accepted' = isZeroLoss ? 'accepted' : 'pending_review';

    const row = {
      user_id: userId,
      disposition_date,
      disposition_type: b.type,
      removal_order_id,
      asin: asin || null,
      msku: msku || null,
      fnsku: b.fnsku || null,
      sellable_qty: b.sellable,
      unsellable_qty: b.unsellable,
      total_qty,
      unit_cost,
      cost_adjustment: 0,
      returned_to_inventory_qty: b.sellable, // sellable returns go back to inventory
      recovery_amount: b.recovery || 0,
      status,
      source: 'amazon_report' as const,
    };

    const { error } = await supabase
      .from('inventory_dispositions')
      .insert(row);

    if (error) {
      // Duplicate via unique partial index → skip silently.
      if ((error.code === '23505') || /duplicate key|uq_inventory_dispositions_amazon_dedup/i.test(error.message || '')) {
        skipped++;
      } else {
        errors++;
        console.error('[disp] insert error:', error.message, row);
      }
    } else {
      inserted++;
    }
  }
  return { inserted, skipped, errors, groups: buckets.size };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    let body: any = {};
    try { body = await req.json(); } catch { /* no-op */ }

    let userId: string;
    let refreshToken: string;
    let marketplaceId: string;

    const isAutomated = body.user_id && body.refresh_token;
    if (isAutomated) {
      userId = body.user_id;
      refreshToken = body.refresh_token;
      marketplaceId = body.marketplace_id || 'ATVPDKIKX0DER';
    } else {
      const auth = req.headers.get('Authorization');
      if (!auth) return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const { data: { user }, error: aerr } = await supabase.auth.getUser(auth.replace('Bearer ', ''));
      if (aerr || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      userId = user.id;

      const { data: rows } = await supabase
        .from('seller_authorizations')
        .select('seller_id, marketplace_id, refresh_token')
        .eq('user_id', userId);
      const sa = rows?.find((r: any) => r.marketplace_id === 'ATVPDKIKX0DER') || rows?.[0];
      if (!sa?.refresh_token) {
        return new Response(JSON.stringify({ error: 'Amazon not connected. Please connect your Amazon account first.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      refreshToken = sa.refresh_token;
      marketplaceId = sa.marketplace_id || 'ATVPDKIKX0DER';
    }

    const daysBack = Math.min(Math.max(parseInt(body.days_back || '60', 10), 1), 365);
    const startDate: string | undefined = body.start_date || undefined;
    const endDate: string | undefined = body.end_date || undefined;
    const includeMfnReturns = body.include_mfn_returns === true;
    const forceFresh = body.force_fresh === true;

    const { parsed, amazonReportId, diag, dispositionCounts, orderTypeCounts, reportStatuses, removalHardError, mfnHardError } = await runReportAndCollect(
      supabase, userId, refreshToken, marketplaceId, daysBack, startDate, endDate, includeMfnReturns, forceFresh
    );
    const result = await upsertDispositions(supabase, userId, parsed);

    // Build a human-readable error summary if a report failed for a non-empty reason.
    const reportErrors: string[] = [];
    if (removalHardError && reportStatuses.removal.reason) reportErrors.push(reportStatuses.removal.reason);
    if (mfnHardError && reportStatuses.mfn_returns.reason) reportErrors.push(reportStatuses.mfn_returns.reason);
    const reportErrorSummary = reportErrors.length ? reportErrors.join(' | ') : null;

    // Only update last_synced_at for the rolling window — backfill chunks shouldn't
    // overwrite the "last sync" indicator the user sees in the UI.
    if (!startDate && !endDate) {
      await supabase.from('disposition_sync_state').upsert({
        user_id: userId,
        last_synced_at: new Date().toISOString(),
        last_amazon_report_id: amazonReportId,
        last_rows_inserted: result.inserted,
        last_rows_skipped: result.skipped,
        last_error: reportErrorSummary,
        updated_at: new Date().toISOString(),
      });
    }

    return new Response(JSON.stringify({
      success: true,
      amazon_report_id: amazonReportId,
      parsed_rows: parsed.length,
      grouped: result.groups,
      inserted: result.inserted,
      skipped_duplicates: result.skipped,
      errors: result.errors,
      days_back: daysBack,
      start_date: startDate || null,
      end_date: endDate || null,
      report_statuses: reportStatuses,
      report_error: reportErrorSummary,
      diagnostics: { ...diag, dispositionCounts, orderTypeCounts },
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[sync-amazon-dispositions] error', e);
    try {
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const auth = req.headers.get('Authorization');
      if (auth) {
        const { data: { user } } = await supabase.auth.getUser(auth.replace('Bearer ', ''));
        if (user) {
          await supabase.from('disposition_sync_state').upsert({
            user_id: user.id,
            last_error: String(e?.message || e),
            updated_at: new Date().toISOString(),
          });
        }
      }
    } catch { /* swallow */ }
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
