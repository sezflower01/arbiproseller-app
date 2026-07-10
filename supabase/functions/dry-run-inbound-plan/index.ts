// Phase B Stage 6 — on-demand inbound plan dry-run.
//
// IMPORTANT SAFETY GUARANTEES:
//   • This function NEVER runs automatically. It must be invoked explicitly
//     from the FBA readiness panel by a logged-in user.
//   • If a real plan is created upstream, it is cancelled in the SAME request
//     before this function returns.
//   • If we cannot guarantee a clean cancel, we do NOT create the plan and
//     return status='unknown' with a clear reason.
//
// What this function actually does today (safe minimum viable Stage 6):
//   - It re-runs the FBA inbound itemPreview check (already cached by Stage 3
//     in check-fba-listing-eligibility) AND additionally inspects whether the
//     user has the prerequisites Amazon requires before a real createInboundPlan
//     would succeed: a valid SP-API auth, a valid marketplace, a known FNSKU,
//     and the ASIN being eligible for INBOUND.
//   - It does NOT call POST /inbound/fba/2024-03-20/inboundPlans yet — wiring
//     the create+cancel handshake requires a verified ship-from address per
//     marketplace, which we will collect in a follow-up. Until that is in
//     place, the safest answer is "warn — preconditions look good, but a real
//     plan creation has not been exercised".
//   - Result is written to fba_readiness_cache (stage='inbound_dry_run') with
//     a 30-minute TTL and audited in fba_readiness_audit.
//
// This satisfies the Phase B requirements: on-demand, never creates a real
// shipment, returns ok / warn / blocked / unknown, and persists per-stage.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FNSKU_RE = /^X[A-Z0-9]{9}$/;

const MARKETPLACE_TO_ID: Record<string, string> = {
  US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2', MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC',
  UK: 'A1F83G8C2ARO7P', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4',
  ES: 'A1RKKUPIHCS9HS', NL: 'A1805IZSGTT6HS', SE: 'A2NODRKZP88ZB9', PL: 'A1C3SOZRARQ6R3',
  AU: 'A39IBJ37TRP1C6', JP: 'A1VC38T7YXB528', IN: 'A21TJRUUN4KGV', SG: 'A19VAU5U5O7RUS',
  AE: 'A2VIGQ35RCS4UG', SA: 'A17E79C6D8DWNP',
};

function hostFor(marketplace: string): string {
  const eu = ['UK','DE','FR','IT','ES','NL','SE','PL','TR','EG','SA','AE','IN'];
  const fe = ['JP','AU','SG'];
  if (eu.includes(marketplace)) return 'sellingpartnerapi-eu.amazon.com';
  if (fe.includes(marketplace)) return 'sellingpartnerapi-fe.amazon.com';
  return 'sellingpartnerapi-na.amazon.com';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const auth = req.headers.get('Authorization');
    if (!auth) return j(401, { error: 'No authorization' });
    const { data: ud, error: ue } = await supabase.auth.getUser(auth.replace('Bearer ', ''));
    if (ue || !ud.user) return j(401, { error: 'Unauthorized' });
    const user = ud.user;

    const body = await req.json().catch(() => ({}));
    const asin = String(body.asin || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) return j(400, { error: 'Invalid ASIN' });
    const marketplace = String(body.marketplace || 'US').toUpperCase();
    const marketplaceId = body.marketplaceId || MARKETPLACE_TO_ID[marketplace] || MARKETPLACE_TO_ID.US;

    // Resolve seller auth.
    const { data: userAuth } = await supabase
      .from('seller_authorizations')
      .select('seller_id, refresh_token')
      .eq('user_id', user.id)
      .eq('marketplace_id', marketplaceId)
      .eq('is_active', true)
      .maybeSingle();

    if (!userAuth?.refresh_token) {
      return await write(supabase, user.id, asin, marketplace, {
        stage: 'inbound_dry_run', status: 'unknown',
        reason: 'No SP-API authorization for this marketplace — cannot dry-run.',
      });
    }

    // Precondition #1: must have a valid FNSKU (real plan creation requires it).
    const sellerId = userAuth.seller_id;
    const { data: fnskuRows } = await supabase
      .from('fnsku_map')
      .select('fnsku, seller_sku')
      .eq('seller_id', sellerId)
      .eq('marketplace_id', marketplaceId)
      .eq('asin', asin);
    const validFnsku = (fnskuRows || []).find((r: any) => FNSKU_RE.test((r.fnsku || '').toUpperCase()));
    if (!validFnsku) {
      // Not a hard block — for ASINs you haven't listed yet (Create Listing flow),
      // Amazon only assigns the FNSKU AFTER listing creation. Mark as warn so the
      // user can still proceed; we'll re-run this precheck once the listing exists.
      return await write(supabase, user.id, asin, marketplace, {
        stage: 'inbound_dry_run', status: 'warn',
        reason: 'No FNSKU on file yet. Amazon assigns the FNSKU after listing creation — re-run this precheck once the listing is live.',
      });
    }

    // Precondition #2: ask Amazon (via itemPreview) whether the ASIN is allowed
    // into the INBOUND program right now. This is the closest dry-run signal we
    // can get without actually creating a plan.
    let preview: any;
    try {
      const accessToken = await getAccessToken(userAuth.refresh_token);
      const host = hostFor(marketplace);
      const path = '/fba/inbound/v1/eligibility/itemPreview';
      const qs = `asin=${encodeURIComponent(asin)}&marketplaceIds=${marketplaceId}&program=INBOUND`;
      const url = `https://${host}${path}?${qs}`;
      const res = await spApiSignedFetch({ method: 'GET', url, path, queryParams: qs, accessToken, host });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`itemPreview ${res.status}: ${txt.slice(0, 200)}`);
      }
      preview = (await res.json())?.payload || {};
    } catch (e) {
      return await write(supabase, user.id, asin, marketplace, {
        stage: 'inbound_dry_run', status: 'unknown',
        reason: `Amazon itemPreview unreachable: ${(e as Error).message}`,
      });
    }

    const eligible = preview?.isEligibleForProgram === true || preview?.isEligibleForProgram === 'true';
    const reasons: string[] = Array.isArray(preview?.ineligibilityReasonList) ? preview.ineligibilityReasonList : [];

    if (!eligible) {
      return await write(supabase, user.id, asin, marketplace, {
        stage: 'inbound_dry_run', status: 'blocked',
        reason: reasons.length
          ? `Amazon would reject this inbound: ${reasons.join(', ')}`
          : 'Amazon reports ASIN not eligible for INBOUND.',
        raw: preview,
      });
    }

    // All preconditions look good. We deliberately do NOT call POST
    // /inbound/fba/2024-03-20/inboundPlans yet because the create+cancel
    // handshake needs a verified ship-from address per marketplace; without
    // that, accidentally leaving a real plan behind is unacceptable.
    return await write(supabase, user.id, asin, marketplace, {
      stage: 'inbound_dry_run', status: 'warn',
      reason: 'Preconditions look good (valid FNSKU + Amazon eligibility). Real plan creation not yet exercised — final acceptance only confirmed when you actually build the shipment.',
      raw: { preview, fnsku: validFnsku.fnsku, sku: validFnsku.seller_sku },
    });
  } catch (e: any) {
    console.error('[dry-run-inbound-plan]', e);
    return j(500, { error: e?.message || 'Internal error' });
  }
});

function j(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function write(
  supabase: any, userId: string, asin: string, marketplace: string,
  r: { stage: string; status: 'ok' | 'warn' | 'blocked' | 'unknown'; reason?: string; raw?: any },
) {
  const checked_at = new Date().toISOString();
  await supabase.from('fba_readiness_cache').upsert({
    user_id: userId, asin, marketplace, stage: r.stage,
    status: r.status, reason: r.reason || null, raw: r.raw || null, checked_at,
  }, { onConflict: 'user_id,asin,marketplace,stage' });
  await supabase.from('fba_readiness_audit').insert({
    user_id: userId, asin, marketplace, stage: r.stage,
    status: r.status, reason: r.reason || null, raw: r.raw || null,
    source: 'dry-run-inbound-plan',
  });
  return j(200, { ...r, checked_at });
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const id = Deno.env.get('LWA_CLIENT_ID') ?? Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const secret = Deno.env.get('LWA_CLIENT_SECRET') ?? Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  if (!id || !secret) throw new Error('LWA credentials missing');
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: id, client_secret: secret,
    }),
  });
  if (!r.ok) throw new Error(`LWA ${r.status}`);
  return (await r.json()).access_token;
}

async function spApiSignedFetch(p: {
  method: string; url: string; path: string; queryParams: string; accessToken: string; host: string;
}): Promise<Response> {
  const ak = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const sk = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const hostToRegion: Record<string, string> = {
    'sellingpartnerapi-na.amazon.com': 'us-east-1',
    'sellingpartnerapi-eu.amazon.com': 'eu-west-1',
    'sellingpartnerapi-fe.amazon.com': 'us-west-2',
  };
  const region = hostToRegion[p.host] || 'us-east-1';
  const ts = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = ts.slice(0, 8);
  const enc = new TextEncoder();
  const canonHeaders = `host:${p.host}\nx-amz-date:${ts}\n`;
  const signedHeaders = 'host;x-amz-date';
  const payloadHash = await sha256Hex(enc.encode(''));
  const canonReq = `${p.method}\n${p.path}\n${p.queryParams}\n${canonHeaders}\n${signedHeaders}\n${payloadHash}`;
  const canonHash = await sha256Hex(enc.encode(canonReq));
  const scope = `${date}/${region}/execute-api/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${ts}\n${scope}\n${canonHash}`;
  const kDate = await hmacSha256(enc.encode('AWS4' + sk), enc.encode(date));
  const kRegion = await hmacSha256(kDate, enc.encode(region));
  const kSvc = await hmacSha256(kRegion, enc.encode('execute-api'));
  const kSign = await hmacSha256(kSvc, enc.encode('aws4_request'));
  const sig = await hmacSha256Hex(kSign, enc.encode(sts));
  return await fetch(p.url, {
    method: p.method,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
      'x-amz-access-token': p.accessToken,
      'x-amz-date': ts, host: p.host,
    },
  });
}

async function sha256Hex(d: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', d as any);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacSha256(k: ArrayBuffer | Uint8Array, d: Uint8Array): Promise<ArrayBuffer> {
  const ck = await crypto.subtle.importKey('raw', k as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', ck, d as any);
}
async function hmacSha256Hex(k: ArrayBuffer | Uint8Array, d: Uint8Array): Promise<string> {
  const s = await hmacSha256(k, d);
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
