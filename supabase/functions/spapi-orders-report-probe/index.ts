// Diagnostic probe: requests an Orders report from SP-API Reports v2021-06-30
// and returns the list of columns + whether buyer-email/buyer-name/ship-* are
// populated for FBA vs FBM rows. Values are redacted to shape descriptors.
//
// POST { userId, reportType?: string, days?: number }
//   Defaults: reportType='GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', days=30

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
const US_MP = 'ATVPDKIKX0DER';

function shape(v: string | null | undefined): string {
  if (v === null || v === undefined) return 'null';
  const s = String(v).trim();
  if (s === '') return 'empty';
  if (s.includes('@marketplace.amazon.com')) return `marketplace_alias(len=${s.length})`;
  if (s.includes('@')) return `real_email(len=${s.length})`;
  return `nonempty(len=${s.length})`;
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const body = await req.json().catch(() => ({}));
    const userId: string = body?.userId;
    const reportType: string = body?.reportType || 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL';
    const days: number = Number(body?.days || 30);
    if (!userId) throw new Error('userId required');

    // creds
    const { data: credRows } = await supabase.rpc('get_spapi_credentials_decrypted', { p_user_id: userId });
    const cred = (credRows as any[])?.[0];
    const refresh = cred?.refresh_token || Deno.env.get('SPAPI_REFRESH_TOKEN');
    const cid = cred?.lwa_client_id || Deno.env.get('LWA_CLIENT_ID');
    const csec = cred?.lwa_client_secret || Deno.env.get('LWA_CLIENT_SECRET');
    if (!refresh) throw new Error('no spapi credentials');
    const access = await lwaToken(refresh, cid, csec);

    let reportId: string | undefined = body?.reportId;

    if (!reportId) {
      const end = new Date();
      const start = new Date(end.getTime() - days * 86400_000);
      const createUrl = `${HOST_NA}/reports/2021-06-30/reports`;
      const createBody = JSON.stringify({
        reportType,
        dataStartTime: start.toISOString(),
        dataEndTime: end.toISOString(),
        marketplaceIds: [US_MP],
      });
      const createHeaders = await signRequest('POST', createUrl, createBody, access);
      const createRes = await fetch(createUrl, { method: 'POST', headers: { ...createHeaders, 'Content-Type': 'application/json' }, body: createBody });
      const createText = await createRes.text();
      if (!createRes.ok) throw new Error(`create ${createRes.status}: ${createText.slice(0, 500)}`);
      reportId = JSON.parse(createText).reportId;
      return new Response(JSON.stringify({ ok: true, stage: 'created', reportId, hint: 'Poll by calling again with { userId, reportId }' }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Poll once
    const sUrl = `${HOST_NA}/reports/2021-06-30/reports/${reportId}`;
    const sh = await signRequest('GET', sUrl, '', access);
    const sr = await fetch(sUrl, { method: 'GET', headers: sh });
    const doc: any = await sr.json();
    const status = doc.processingStatus;
    if (status !== 'DONE') {
      return new Response(JSON.stringify({ ok: true, stage: 'polling', reportId, status }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // === 3. Fetch document ===
    const docUrl = `${HOST_NA}/reports/2021-06-30/documents/${doc.reportDocumentId}`;
    const dh = await signRequest('GET', docUrl, '', access);
    const dr = await fetch(docUrl, { method: 'GET', headers: dh });
    const dj = await dr.json();
    const fileRes = await fetch(dj.url);
    let text = await fileRes.text();
    if (dj.compressionAlgorithm === 'GZIP') {
      // Amazon may pre-decompress via presigned URL; if not, decompress manually.
      try {
        const ab = await (await fetch(dj.url)).arrayBuffer();
        const ds = new DecompressionStream('gzip');
        const stream = new Response(new Blob([ab]).stream().pipeThrough(ds));
        text = await stream.text();
      } catch { /* fall back to text */ }
    }

    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) throw new Error('empty report');
    const header = lines[0].split('\t');
    const idx = (name: string) => header.indexOf(name);
    const iEmail = idx('buyer-email');
    const iName = idx('buyer-name');
    const iRecipient = idx('recipient-name');
    const iCity = idx('ship-city');
    const iState = idx('ship-state');
    const iPostal = idx('ship-postal-code');
    const iOrderId = idx('amazon-order-id');
    const iChannel = idx('fulfillment-channel');

    const samples: any[] = [];
    let fbaTotal = 0, fbmTotal = 0;
    let fbaEmailPop = 0, fbmEmailPop = 0;
    let fbaAliasPop = 0, fbmAliasPop = 0;
    let fbaRecipientPop = 0, fbmRecipientPop = 0;

    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split('\t');
      const channel = iChannel >= 0 ? (c[iChannel] || '').toUpperCase() : '';
      const isFba = channel === 'AMAZON' || channel === 'AFN';
      const isFbm = channel === 'MERCHANT' || channel === 'MFN';
      const email = iEmail >= 0 ? c[iEmail] : '';
      const name = iName >= 0 ? c[iName] : '';
      const recipient = iRecipient >= 0 ? c[iRecipient] : '';
      const emailShape = shape(email);
      if (isFba) {
        fbaTotal++;
        if (emailShape !== 'null' && emailShape !== 'empty') fbaEmailPop++;
        if (emailShape.startsWith('marketplace_alias') || emailShape.startsWith('real_email')) fbaAliasPop++;
        if (shape(recipient) !== 'null' && shape(recipient) !== 'empty') fbaRecipientPop++;
      } else if (isFbm) {
        fbmTotal++;
        if (emailShape !== 'null' && emailShape !== 'empty') fbmEmailPop++;
        if (emailShape.startsWith('marketplace_alias') || emailShape.startsWith('real_email')) fbmAliasPop++;
        if (shape(recipient) !== 'null' && shape(recipient) !== 'empty') fbmRecipientPop++;
      }
      if (samples.length < 6) {
        samples.push({
          channel,
          order_id_present: iOrderId >= 0 && !!c[iOrderId],
          'buyer-email': emailShape,
          'buyer-name': shape(name),
          'recipient-name': shape(recipient),
          'ship-city': iCity >= 0 ? shape(c[iCity]) : 'missing_column',
          'ship-state': iState >= 0 ? shape(c[iState]) : 'missing_column',
          'ship-postal-code': iPostal >= 0 ? shape(c[iPostal]) : 'missing_column',
        });
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      reportType,
      reportId,
      window_days: days,
      row_count: lines.length - 1,
      columns: header,
      columns_present: {
        'buyer-email': iEmail >= 0,
        'buyer-name': iName >= 0,
        'recipient-name': iRecipient >= 0,
        'ship-city': iCity >= 0,
        'ship-state': iState >= 0,
        'ship-postal-code': iPostal >= 0,
        'amazon-order-id': iOrderId >= 0,
        'fulfillment-channel': iChannel >= 0,
      },
      fba: {
        total: fbaTotal,
        buyer_email_populated: fbaEmailPop,
        buyer_email_alias_or_real: fbaAliasPop,
        recipient_name_populated: fbaRecipientPop,
      },
      fbm: {
        total: fbmTotal,
        buyer_email_populated: fbmEmailPop,
        buyer_email_alias_or_real: fbmAliasPop,
        recipient_name_populated: fbmRecipientPop,
      },
      samples,
      verdict: fbaAliasPop > 0
        ? 'FBA buyer-email is populated in Reports API — safe to wire into sales_orders.buyer_email/customer_key.'
        : 'FBA buyer-email is EMPTY in Reports API — Reports path unavailable for FBA repeat-customer detection.',
    }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
