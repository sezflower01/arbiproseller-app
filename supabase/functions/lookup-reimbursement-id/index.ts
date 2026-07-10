// Look up a single Reimbursement ID on-demand by Order ID + SKU
// Calls the FBA Reimbursements Report scoped to a small date window.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── SigV4 (copied minimal version) ──
async function sha256(s: string) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s) as any); }
async function hmac(key: any, msg: string) {
  const ck = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(msg));
}
const toHex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
async function sigKey(sec: string, date: string, region: string, service: string) {
  const enc = new TextEncoder();
  const k1 = await hmac(enc.encode('AWS4' + sec), date);
  const k2 = await hmac(k1, region);
  const k3 = await hmac(k2, service);
  return hmac(k3, 'aws4_request');
}
async function signRequest(method: string, url: string, body: string, accessToken: string) {
  const ak = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const sk = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const u = new URL(url);
  const host = u.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = toHex(await sha256(body));
  const ch = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const sh = 'host;x-amz-access-token;x-amz-date';
  const cr = [method, u.pathname, u.search.slice(1), ch, sh, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/execute-api/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, toHex(await sha256(cr))].join('\n');
  const sig = toHex(await hmac(await sigKey(sk, dateStamp, region, 'execute-api'), sts));
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${sh}, Signature=${sig}`,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': host,
  };
}

async function getLWAToken(refreshToken: string) {
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
  if (!r.ok) throw new Error('LWA token failed');
  return (await r.json()).access_token as string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      console.log('[LOOKUP] No auth header');
      return new Response(JSON.stringify({ error: 'No auth' }), { status: 401, headers: corsHeaders });
    }

    const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!user) {
      console.log('[LOOKUP] Invalid user from auth header');
      return new Response(JSON.stringify({ error: 'Invalid auth' }), { status: 401, headers: corsHeaders });
    }

    const body = await req.json();
    const { orderId, sku, postedDate } = body;
    console.log(`[LOOKUP] user=${user.id} orderId=${orderId} sku=${sku} postedDate=${postedDate}`);

    if (!sku && !orderId) {
      return new Response(JSON.stringify({ error: 'orderId or sku required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Get auth (prefer US)
    const { data: auths, error: authsErr } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true);
    if (authsErr) console.log('[LOOKUP] auths query error:', authsErr.message);
    console.log(`[LOOKUP] Found ${auths?.length || 0} active authorizations`);
    const auth = auths?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || auths?.[0];
    if (!auth) {
      return new Response(JSON.stringify({ error: 'No active SP-API authorization found. Please reconnect Amazon.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    console.log(`[LOOKUP] Using auth marketplace=${auth.marketplace_id}`);

    const accessToken = await getLWAToken(auth.refresh_token);
    console.log(`[LOOKUP] Got LWA access token`);

    // GET_FBA_REIMBURSEMENTS_DATA requires DATE-ONLY format (YYYY-MM-DD) and a window <= 1 year.
    // Full ISO timestamps cause Amazon to mark the report FATAL.
    const center = postedDate ? new Date(postedDate) : new Date();
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const startDate = new Date(Math.min(center.getTime() - 90 * 86400000, yesterday.getTime() - 180 * 86400000));
    const endDate = new Date(Math.min(center.getTime() + 90 * 86400000, yesterday.getTime()));
    const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);
    const start = toDateOnly(startDate);
    const end = toDateOnly(endDate);
    console.log(`[LOOKUP] Report window (date-only): ${start} → ${end}`);

    const endpoint = 'https://sellingpartnerapi-na.amazon.com';
    const createBody = JSON.stringify({
      reportType: 'GET_FBA_REIMBURSEMENTS_DATA',
      dataStartTime: start,
      dataEndTime: end,
      marketplaceIds: ['ATVPDKIKX0DER'],
    });
    const createUrl = `${endpoint}/reports/2021-06-30/reports`;
    const ch = await signRequest('POST', createUrl, createBody, accessToken);
    const cResp = await fetch(createUrl, { method: 'POST', headers: { ...ch, 'Content-Type': 'application/json' }, body: createBody });
    if (!cResp.ok) {
      const t = await cResp.text();
      console.log(`[LOOKUP] Report create failed status=${cResp.status} body=${t}`);
      return new Response(JSON.stringify({ error: `Amazon rejected report request: ${t.slice(0, 200)}` }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const { reportId } = await cResp.json();
    console.log(`[LOOKUP] Report created reportId=${reportId}, polling...`);

    // Poll
    let documentId: string | null = null;
    let lastStatus = '';
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const sUrl = `${endpoint}/reports/2021-06-30/reports/${reportId}`;
      const sH = await signRequest('GET', sUrl, '', accessToken);
      const sR = await fetch(sUrl, { headers: sH });
      if (!sR.ok) {
        console.log(`[LOOKUP] Poll attempt ${i + 1}: HTTP ${sR.status}`);
        continue;
      }
      const sD = await sR.json();
      lastStatus = sD.processingStatus;
      console.log(`[LOOKUP] Poll attempt ${i + 1}: status=${lastStatus}`);
      if (sD.processingStatus === 'DONE') { documentId = sD.reportDocumentId; break; }
      if (['CANCELLED', 'FATAL'].includes(sD.processingStatus)) {
        // Try to fetch the FATAL document for Amazon's actual error message
        let amazonError = '';
        if (sD.reportDocumentId) {
          try {
            const dUrl = `${endpoint}/reports/2021-06-30/documents/${sD.reportDocumentId}`;
            const dH = await signRequest('GET', dUrl, '', accessToken);
            const dR = await fetch(dUrl, { headers: dH });
            const { url } = await dR.json();
            amazonError = (await (await fetch(url)).text()).slice(0, 300);
            console.log(`[LOOKUP] FATAL details: ${amazonError}`);
          } catch (e) { console.log(`[LOOKUP] Could not fetch FATAL doc: ${e}`); }
        }
        return new Response(JSON.stringify({ error: `Amazon report ${sD.processingStatus}${amazonError ? ': ' + amazonError : ''}` }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }
    if (!documentId) {
      console.log(`[LOOKUP] Timed out waiting for report. Last status: ${lastStatus}`);
      return new Response(JSON.stringify({ error: `Amazon report did not finish in time (last status: ${lastStatus || 'unknown'}). Try again in a moment.` }), { status: 504, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const dUrl = `${endpoint}/reports/2021-06-30/documents/${documentId}`;
    const dH = await signRequest('GET', dUrl, '', accessToken);
    const dR = await fetch(dUrl, { headers: dH });
    const { url } = await dR.json();
    const tsv = await (await fetch(url)).text();
    const lines = tsv.split('\n').filter(l => l.trim());
    console.log(`[LOOKUP] Downloaded report: ${lines.length} lines (incl header)`);
    if (lines.length < 2) {
      return new Response(JSON.stringify({
        found: false,
        message: 'Amazon has no reimbursements at all in the ±90 day window. If you believe you are owed money, you must open a case in Seller Central — Amazon only generates a Reimbursement ID after they approve a claim.',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const headers = lines[0].split('\t').map(h => h.trim());
    console.log(`[LOOKUP] Report columns: ${headers.join(', ')}`);
    const matches: Array<Record<string, string>> = [];
    let totalRows = 0;
    let orderMatchOnly = 0;
    let skuMatchOnly = 0;
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split('\t');
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => { row[h] = (cells[idx] || '').trim(); });
      totalRows++;
      const oMatch = orderId ? row['amazon-order-id'] === orderId : true;
      const sMatch = sku ? row['sku'] === sku : true;
      if (orderId && row['amazon-order-id'] === orderId) orderMatchOnly++;
      if (sku && row['sku'] === sku) skuMatchOnly++;
      if (oMatch && sMatch && row['reimbursement-id']) matches.push(row);
    }
    console.log(`[LOOKUP] Scanned ${totalRows} rows, orderMatch=${orderMatchOnly}, skuMatch=${skuMatchOnly}, finalMatches=${matches.length}`);

    if (matches.length === 0) {
      const hint = orderMatchOnly === 0 && skuMatchOnly === 0
        ? 'Amazon has no reimbursement record for this order/SKU. This usually means: (1) you have not opened a Seller Support case yet, OR (2) Amazon has not yet approved a reimbursement. The Reimbursement ID only exists after Amazon approves a claim.'
        : `Found ${orderMatchOnly} rows for this order and ${skuMatchOnly} for this SKU, but none with a Reimbursement ID assigned.`;
      return new Response(JSON.stringify({ found: false, message: hint, totalRowsScanned: totalRows }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const best = matches[0];
    console.log(`[LOOKUP] MATCH found reimbursementId=${best['reimbursement-id']} caseId=${best['case-id']}`);
    return new Response(JSON.stringify({
      found: true,
      reimbursementId: best['reimbursement-id'],
      caseId: best['case-id'] || null,
      approvalDate: best['approval-date'] || null,
      amount: best['amount-total'] || null,
      currency: best['currency-unit'] || null,
      reason: best['reason'] || null,
      allMatches: matches.length,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (e) {
    console.error('[LOOKUP-REIMBURSEMENT-ID]', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
