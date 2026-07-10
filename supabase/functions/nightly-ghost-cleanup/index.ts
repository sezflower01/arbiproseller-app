// Nightly Ghost Cleanup
// Runs once per night. For every user × marketplace, scans inventory for ghost
// candidates (amzn.gr.* SKUs, tombstoned, or zero-stock+non-ACTIVE). For each
// candidate, calls SP-API /fba/inventory/v1/summaries to verify whether Amazon
// still considers the SKU live ACTIVE with stock. If NOT confirmed, the row is:
//   - archived to ghost_sku_quarantine
//   - removed from fnsku_map
//   - flipped to listing_status='NOT_IN_CATALOG' (when summaries explicitly disowns it)
//   - eligibility cache for the ASIN is busted
// Live ACTIVE+stock rows are left untouched (skipped_active).
// Per-run stats are written to ghost_cleanup_runs.
//
// Mirrors the helper public.is_ghost_inventory_row().

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

function isGhostCandidate(row: any): boolean {
  const ls = (row.listing_status || '').toUpperCase();
  if (ls === 'NOT_IN_CATALOG' || ls === 'DELETED') return true;
  if ((row.sku || '').toLowerCase().startsWith('amzn.gr.')) return true;
  const total = (Number(row.available)||0)+(Number(row.reserved)||0)+(Number(row.inbound)||0);
  if (total <= 0 && ls !== 'ACTIVE') return true;
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const startedAt = new Date();
  const t0 = Date.now();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let checked = 0, archived = 0, skippedActive = 0, errors = 0;
  const perMarketplace: Record<string, { checked: number; archived: number; skipped: number; errors: number }> = {};

  try {
    const body = await req.json().catch(() => ({} as any));
    const dryRun = !!body.dry_run;
    const userIdFilter: string | null = body.user_id || null;

    // Get all active SP-API auths
    let authQ = supabase
      .from('seller_authorizations')
      .select('user_id, seller_id, marketplace_id, refresh_token')
      .eq('is_active', true)
      .not('refresh_token', 'is', null);
    if (userIdFilter) authQ = authQ.eq('user_id', userIdFilter);
    const { data: auths, error: authErr } = await authQ;
    if (authErr) throw authErr;

    const idToCode = Object.fromEntries(Object.entries(MARKETPLACE_TO_ID).map(([k, v]) => [v, k]));

    for (const auth of (auths || [])) {
      const marketplace = idToCode[auth.marketplace_id] || 'US';
      const bucket = perMarketplace[marketplace] ||= { checked: 0, archived: 0, skipped: 0, errors: 0 };

      try {
        // Pull ghost candidates for this user+marketplace
        const { data: rows, error: rowsErr } = await supabase
          .from('inventory')
          .select('id, asin, sku, listing_status, available, reserved, inbound, marketplace, fnsku')
          .eq('user_id', auth.user_id)
          .or(
            `sku.ilike.amzn.gr.%,listing_status.eq.NOT_IN_CATALOG,listing_status.eq.DELETED`,
          )
          .limit(1000);
        if (rowsErr) throw rowsErr;

        const candidates = (rows || []).filter(isGhostCandidate);
        if (candidates.length === 0) continue;

        // Live verify in one paged scan of summaries; build set of currently-ACTIVE+stock SKUs
        const liveActive = new Set<string>();
        try {
          const accessToken = await getAccessToken(auth.refresh_token);
          const host = hostFor(marketplace);
          const path = `/fba/inventory/v1/summaries`;
          let nextToken: string | undefined;
          for (let page = 0; page < 10; page++) {
            const qsObj: Record<string, string> = {
              details: 'true',
              granularityType: 'Marketplace',
              granularityId: auth.marketplace_id,
              marketplaceIds: auth.marketplace_id,
            };
            if (nextToken) qsObj.nextToken = nextToken;
            const qs = Object.keys(qsObj).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(qsObj[k])}`).join('&');
            const url = `https://${host}${path}?${qs}`;
            const res = await spApiSignedFetch({ method: 'GET', url, path, queryParams: qs, accessToken, host });
            if (!res.ok) { await res.text(); throw new Error(`summaries ${res.status}`); }
            const data = await res.json();
            for (const it of (data?.payload?.inventorySummaries || [])) {
              const sku = String(it?.sellerSku || '');
              const stock = Number(it?.inventoryDetails?.fulfillableQuantity || 0)
                + Number(it?.inventoryDetails?.inboundWorkingQuantity || 0)
                + Number(it?.inventoryDetails?.inboundShippedQuantity || 0)
                + Number(it?.inventoryDetails?.inboundReceivingQuantity || 0)
                + Number(it?.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0);
              const cond = String(it?.condition || '').toUpperCase();
              // ACTIVE if Amazon returns the SKU AND it has positive stock OR isn't marked NOT_IN_CATALOG
              if (sku && stock > 0 && cond !== 'NOT_IN_CATALOG') liveActive.add(sku);
            }
            nextToken = data?.payload?.nextToken;
            if (!nextToken) break;
            await new Promise((r) => setTimeout(r, 800)); // throttle
          }
        } catch (e) {
          // Live verify failed — be safe, skip this user/mp this run (don't quarantine on uncertainty).
          bucket.errors += 1;
          errors += 1;
          continue;
        }

        for (const row of candidates) {
          checked += 1;
          bucket.checked += 1;
          if (liveActive.has(row.sku || '')) {
            skippedActive += 1;
            bucket.skipped += 1;
            continue;
          }

          if (dryRun) {
            archived += 1;
            bucket.archived += 1;
            continue;
          }

          try {
            // 1) Archive evidence
            await supabase.from('ghost_sku_quarantine').insert({
              user_id: auth.user_id,
              seller_id: auth.seller_id,
              marketplace_id: auth.marketplace_id,
              asin: row.asin,
              sku: row.sku,
              fnsku: row.fnsku,
              reason: (row.sku || '').toLowerCase().startsWith('amzn.gr.')
                ? 'AMZN_GR_NO_LIVE_CONFIRM'
                : 'NIGHTLY_GHOST_DRIFT',
              source_function: 'nightly_ghost_cleanup',
              evidence: {
                listing_status: row.listing_status,
                available: row.available,
                reserved: row.reserved,
                inbound: row.inbound,
                live_active_count: liveActive.size,
              },
            });

            // 2) Remove from fnsku_map (cache table — safe to delete)
            if (row.fnsku) {
              await supabase
                .from('fnsku_map')
                .delete()
                .eq('seller_id', auth.seller_id)
                .eq('marketplace_id', auth.marketplace_id)
                .eq('asin', row.asin)
                .eq('fnsku', row.fnsku);
            }

            // 3) Flip inventory row to NOT_IN_CATALOG (downstream UIs already filter this)
            //    Keep stock untouched — suspicious-zero guard owns stock writes.
            await supabase
              .from('inventory')
              .update({ listing_status: 'NOT_IN_CATALOG' })
              .eq('id', row.id);

            // 4) Bust eligibility cache
            await supabase
              .from('fba_eligibility_cache')
              .delete()
              .eq('user_id', auth.user_id)
              .eq('seller_id', auth.seller_id)
              .eq('marketplace_id', auth.marketplace_id)
              .eq('asin', row.asin);

            archived += 1;
            bucket.archived += 1;
          } catch (e) {
            errors += 1;
            bucket.errors += 1;
          }
        }
      } catch (e) {
        errors += 1;
        bucket.errors += 1;
      }
    }
  } catch (e) {
    errors += 1;
  }

  const finishedAt = new Date();
  await supabase.from('ghost_cleanup_runs').insert({
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: Date.now() - t0,
    checked, archived, skipped_active: skippedActive, errors,
    notes: { per_marketplace: perMarketplace },
  });

  return new Response(JSON.stringify({
    ok: true, checked, archived, skipped_active: skippedActive, errors,
    duration_ms: Date.now() - t0, per_marketplace: perMarketplace,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

// ── SP-API helpers (mirror of check-fba-listing-eligibility) ──────────

async function getAccessToken(refreshToken: string): Promise<string> {
  const id = Deno.env.get('LWA_CLIENT_ID') ?? Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const secret = Deno.env.get('LWA_CLIENT_SECRET') ?? Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  if (!id || !secret) throw new Error('LWA credentials missing');
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: id,
      client_secret: secret,
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
      'x-amz-date': ts,
      host: p.host,
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
