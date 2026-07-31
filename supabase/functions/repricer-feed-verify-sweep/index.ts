// Sample-SKU price verification for repricer-batch-update's feed submissions,
// moved out of the inline poll chain (pollAfterDelay) into its own
// independently-scheduled sweep.
//
// Why: pollAfterDelay's own poll wait already uses ~2 minutes (a 120s sleep
// plus at least one 60s-spaced status check) before a feed reaches
// 'completed'. The old code then ran verifySampleSkus() directly inline --
// a further hardcoded 3-minute wait (Amazon propagation delay), and a
// possible SECOND 3-minute wait if the first check found a mismatch -- all
// within that SAME continuous execution. Live evidence: only 1 of 30
// sampled real "completed" submissions ever had a verification result
// recorded; the runtime was silently killing the execution before
// verification could run in the other 29, with zero visibility (the
// submission still showed status='completed').
//
// This sweep gets its own fresh execution/budget per tick instead of
// stacking more multi-minute waits onto an already-long poll chain. It
// naturally implements "wait for Amazon to propagate, then retry on
// mismatch" by re-checking anything not yet finalized on a LATER tick,
// rather than sleeping inside one execution.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';
import { waitForApiToken } from '../_shared/rate-limiter.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// How long to wait after a feed completes before the first verification
// check, so Amazon has time to propagate the price change.
const VERIFY_DELAY_MS = 3 * 60_000;
const MAX_VERIFY_ATTEMPTS = 3;
const MAX_SUBMISSIONS_PER_TICK = 20;

const MARKETPLACE_ID_MAP: Record<string, string> = {
  US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2', MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC',
};

// --- AWS SigV4 + LWA helpers (duplicated from repricer-batch-update; each
// edge function in this codebase is self-contained rather than sharing SP-API
// signing code across a _shared module) ---
const hmacSha256 = async (key: ArrayBuffer | Uint8Array, data: Uint8Array): Promise<ArrayBuffer> => {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, data as any);
};
const sha256Hex = async (data: string): Promise<string> => {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
};
const getSignatureKey = async (key: string, dateStamp: string, region: string, service: string) => {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256(encoder.encode('AWS4' + key), encoder.encode(dateStamp));
  const kRegion = await hmacSha256(kDate, encoder.encode(region));
  const kService = await hmacSha256(kRegion, encoder.encode(service));
  return await hmacSha256(kService, encoder.encode('aws4_request'));
};
async function signedRequest(method: string, url: string, body: string, accessToken: string): Promise<Response> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const encoder = new TextEncoder();

  const urlObj = new URL(url);
  const host = urlObj.host;
  const path = urlObj.pathname;
  const queryString = urlObj.search.replace('?', '');
  const service = 'execute-api';

  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);

  const payloadHashHex = await sha256Hex(body);
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;

  const canonicalRequestHashHex = await sha256Hex(canonicalRequest);
  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHashHex}`;

  const signingKey = await getSignatureKey(awsSecretAccessKey, date, awsRegion, service);
  const signature = await hmacSha256(signingKey, encoder.encode(stringToSign));
  const signatureHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;

  return fetch(url, {
    method,
    headers: {
      'host': host,
      'x-amz-access-token': accessToken,
      'x-amz-date': timestamp,
      'Authorization': authorizationHeader,
      'Content-Type': 'application/json',
    },
    body: method === 'GET' ? undefined : body,
  });
}
async function getAccessToken(refreshToken: string): Promise<string> {
  const lwaClientId = Deno.env.get('LWA_CLIENT_ID');
  const lwaClientSecret = Deno.env.get('LWA_CLIENT_SECRET');
  if (!lwaClientId || !lwaClientSecret) throw new Error('LWA credentials not configured');

  const resp = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: lwaClientId,
      client_secret: lwaClientSecret,
    }),
  });
  if (!resp.ok) throw new Error('Failed to get access token');
  const data = await resp.json();
  return data.access_token;
}

interface SkuRef { sku: string; asin: string; newPrice?: number }

async function checkSkuPrices(
  supabase: any, samples: SkuRef[], sellerId: string, marketplaceId: string, accessToken: string
): Promise<any[]> {
  const results: any[] = [];
  for (const sample of samples) {
    try {
      await waitForApiToken(supabase, 'listings_api');
      const listingsUrl = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sample.sku)}?marketplaceIds=${marketplaceId}&includedData=offers`;
      const resp = await signedRequest('GET', listingsUrl, '', accessToken);

      if (!resp.ok) {
        const errText = await resp.text();
        results.push({ sku: sample.sku, asin: sample.asin, expectedPrice: sample.newPrice, verified: false, error: `API ${resp.status}: ${errText.slice(0, 200)}` });
        continue;
      }

      const listingData = await resp.json();
      let actualPrice: number | null = null;
      if (listingData?.offers) {
        for (const offer of listingData.offers) {
          if (offer.marketplaceId === marketplaceId || !offer.marketplaceId) {
            actualPrice = offer.price?.amount
              || offer.listingPrice?.amount
              || offer.ourPrice?.[0]?.schedule?.[0]?.valueWithTax
              || null;
            break;
          }
        }
      }

      const priceMatch = actualPrice !== null && sample.newPrice !== undefined
        ? Math.abs(actualPrice - sample.newPrice) < 0.01
        : null;

      results.push({
        sku: sample.sku, asin: sample.asin, expectedPrice: sample.newPrice,
        actualPrice, verified: priceMatch === true, match: priceMatch,
      });
    } catch (e) {
      results.push({ sku: sample.sku, asin: sample.asin, expectedPrice: sample.newPrice, verified: false, error: String((e as Error)?.message || e) });
    }
  }
  return results;
}

async function getSellerAuth(supabase: any, userId: string, marketplace: string) {
  const marketplaceId = MARKETPLACE_ID_MAP[marketplace] || 'ATVPDKIKX0DER';
  const { data: authRows } = await supabase
    .from('seller_authorizations')
    .select('seller_id, refresh_token, marketplace_id')
    .eq('user_id', userId);
  return (
    authRows?.find((a: any) => a.marketplace_id === marketplaceId) ||
    authRows?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') ||
    authRows?.[0] ||
    null
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const cutoff = new Date(Date.now() - VERIFY_DELAY_MS).toISOString();
    const { data: candidates, error: selErr } = await supabase
      .from('repricer_feed_submissions')
      .select('id, feed_id, user_id, marketplace, feed_payload, feed_result, status, completed_at')
      .in('status', ['completed', 'DONE_NO_REPORT'])
      .lt('completed_at', cutoff)
      .order('completed_at', { ascending: true })
      .limit(200);

    if (selErr) {
      return new Response(JSON.stringify({ ok: false, error: selErr }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const eligible = (candidates || []).filter((c: any) => {
      const v = c.feed_result?._verification;
      if (!v) return true;
      if (v.final) return false;
      return (v.attempts || 0) < MAX_VERIFY_ATTEMPTS;
    }).slice(0, MAX_SUBMISSIONS_PER_TICK);

    let processed = 0;
    for (const sub of eligible) {
      try {
        const skus: SkuRef[] = sub.feed_payload?.skus || [];
        if (skus.length === 0) continue;

        const auth = await getSellerAuth(supabase, sub.user_id, sub.marketplace);
        if (!auth?.refresh_token || !auth?.seller_id) continue;

        const marketplaceId = MARKETPLACE_ID_MAP[sub.marketplace] || 'ATVPDKIKX0DER';
        const accessToken = await getAccessToken(auth.refresh_token);

        const sampleIndices = [0, Math.floor(skus.length / 2), skus.length - 1];
        const uniqueIndices = [...new Set(sampleIndices)];
        const samples = uniqueIndices.map(i => skus[i]).filter(Boolean);

        const results = await checkSkuPrices(supabase, samples, auth.seller_id, marketplaceId, accessToken);
        const verifiedCount = results.filter(r => r.verified).length;
        const priorAttempts = sub.feed_result?._verification?.attempts || 0;
        const attempts = priorAttempts + 1;

        const verification = {
          checked_at: new Date().toISOString(),
          verified: verifiedCount,
          total: results.length,
          results,
          attempts,
          final: verifiedCount === results.length || attempts >= MAX_VERIFY_ATTEMPTS,
        };

        const mergedResult = { ...(sub.feed_result || {}), _verification: verification };

        // Mirror the original behavior: DONE_NO_REPORT + all-matched verification upgrades to completed.
        const newStatus = sub.status === 'DONE_NO_REPORT' && verifiedCount === results.length && results.length > 0
          ? 'completed'
          : sub.status;

        await supabase
          .from('repricer_feed_submissions')
          .update({
            feed_result: mergedResult,
            status: newStatus,
            skus_succeeded: newStatus === 'completed' && sub.status === 'DONE_NO_REPORT' ? skus.length : undefined,
            updated_at: new Date().toISOString(),
          })
          .eq('id', sub.id);

        for (const vr of results) {
          if (vr.verified !== null) {
            await supabase
              .from('repricer_price_actions')
              .update({
                intelligence_factors: {
                  verification: {
                    checked_at: verification.checked_at,
                    expected: vr.expectedPrice,
                    actual: vr.actualPrice,
                    confirmed: vr.verified,
                  },
                },
              })
              .eq('feed_id', sub.feed_id)
              .eq('sku', vr.sku)
              .eq('user_id', sub.user_id);
          }
        }

        processed++;
      } catch (e) {
        console.error(`[repricer-feed-verify-sweep] failed for submission ${sub.id}:`, e);
      }
    }

    return new Response(JSON.stringify({ ok: true, eligible: eligible.length, processed }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
