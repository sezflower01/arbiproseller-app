import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { markReconciliation, trackBbLossAfterRaise } from '../_shared/repricer-hardening.ts';
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";
import { requireInternalOrUser } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Repricer Reconciliation Loop v2 — with delayed recheck sequence
 * 
 * NEW: 3-stage verification: +2min → +5min → +10min before finalizing mismatch.
 * Stores recon_retry_count, recon_severity, recon_root_cause, recon_converged_at.
 */

// AWS SigV4 helpers
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
      'Authorization': authorizationHeader,
      'x-amz-access-token': accessToken,
      'x-amz-date': timestamp,
      'host': host,
      'content-type': 'application/json',
    },
    body: method !== 'GET' ? body : undefined,
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

// ─── MISMATCH CLASSIFICATION ────────────────────────────────────────────────

interface MismatchClassification {
  rootCause: string;
  severity: 'minor' | 'moderate' | 'severe';
  type: string;
}

function classifyMismatch(
  intended: number,
  live: number,
  action: any,
  amazonBounds?: { min: number | null; max: number | null }
): MismatchClassification {
  const d = Math.abs(live - intended);
  const pctDiff = intended > 0 ? (d / intended) * 100 : 0;
  const ageMs = Date.now() - new Date(action.created_at).getTime();
  const ageMins = ageMs / 60000;
  const direction = live > intended ? 'UP' : 'DOWN';
  const marketplace = action.marketplace || 'US';

  // ── PRIORITY: Amazon-side Automate Pricing min/max constraint detection ──
  // If the intended price violates Amazon's own min/max rule and the live price
  // is essentially clamped at Amazon's bound, that's not a system bug — it's
  // Seller Central rejecting the submission.
  const amzMin = amazonBounds?.min ?? null;
  const amzMax = amazonBounds?.max ?? null;
  if (amzMin != null && intended < amzMin - 0.001 && Math.abs(live - amzMin) <= 0.05) {
    return { rootCause: 'AMAZON_MIN_PRICE_BLOCK', severity: 'severe', type: 'amazon_rule_block' };
  }
  if (amzMax != null && intended > amzMax + 0.001 && Math.abs(live - amzMax) <= 0.05) {
    return { rootCause: 'AMAZON_MAX_PRICE_BLOCK', severity: 'severe', type: 'amazon_rule_block' };
  }

  // International marketplaces use local currency with larger absolute values
  // Apply percentage-based tolerance instead of fixed dollar amounts
  const isInternational = marketplace !== 'US';
  const intlTolerancePct = 3.0; // 3% tolerance for MX/BR currency differences

  // Severity buckets — wider for international
  let severity: 'minor' | 'moderate' | 'severe' = 'severe';
  if (d <= 0.05) {
    severity = 'minor';
  } else if (isInternational && pctDiff <= intlTolerancePct) {
    severity = 'moderate'; // International rounding/FX within 3%
  } else if (d <= 1.0 && pctDiff <= 1.5) {
    severity = 'moderate';
  }

  // Root cause classification
  let rootCause = 'UNKNOWN';

  if (d < 0.15) {
    rootCause = 'AMAZON_ROUNDING';
  } else if (isInternational && pctDiff <= intlTolerancePct) {
    rootCause = 'FX_ROUNDING';
  } else if (action.update_method === 'FEED' && ageMins < 8) {
    rootCause = 'FEED_DELAY';
  } else if (direction === 'UP' && pctDiff < 3) {
    rootCause = 'AMAZON_PRICE_FLOOR';
  } else if (direction === 'UP' && pctDiff >= 3) {
    rootCause = 'EXTERNAL_PRICE_CHANGE';
  } else if (direction === 'DOWN' && pctDiff >= 5) {
    rootCause = 'COMPETITOR_REACTION';
  } else if (direction === 'DOWN' && pctDiff < 5 && pctDiff >= 1) {
    rootCause = 'AMAZON_STEP_ENFORCEMENT';
  } else {
    const liveCents = Math.round(live * 100);
    if (liveCents % 25 === 0 || liveCents % 50 === 0 || liveCents % 100 === 0) {
      rootCause = 'AMAZON_STEP_ENFORCEMENT';
    } else {
      rootCause = 'STALE_READBACK';
    }
  }

  const type = severity === 'minor' ? 'rounding' : severity === 'moderate' ? 'minor_drift' : 'real_mismatch';

  return { rootCause, severity, type };
}

// ─── DELAYED RECHECK SCHEDULE (accelerated) ────────────────────────────────
// Retry 0: first check (at method-aware delay: 90s PATCH, 3min FEED)
// Retry 1: +1.5 min after first check (was +2min)
// Retry 2: +3 min after first check (was +5min)
// Retry 3: +6 min after first check (was +10min) → finalize

const RECHECK_DELAYS_MS = [0, 90 * 1000, 3 * 60 * 1000, 6 * 60 * 1000];
const MAX_RETRIES = 3;
const MAX_RECHECK_LIFETIME_MS = 4 * 60 * 60 * 1000; // 4 hours max lifetime

function isReadyForRecheck(action: any): boolean {
  const retryCount = action.recon_retry_count || 0;
  
  // Force finalize if stuck too long (max lifetime)
  const createdAt = new Date(action.created_at).getTime();
  if (Date.now() - createdAt > MAX_RECHECK_LIFETIME_MS) return true;
  
  if (retryCount >= MAX_RETRIES) return true; // Final check
  if (retryCount === 0) return true; // First check, already filtered by age

  const lastCheckAt = action.recon_last_check_at || action.created_at;
  const lastCheckTime = new Date(lastCheckAt).getTime();
  const delayNeeded = RECHECK_DELAYS_MS[retryCount] || RECHECK_DELAYS_MS[MAX_RETRIES];
  
  return Date.now() >= lastCheckTime + delayNeeded;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;


  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json().catch(() => ({}));
    const userId = body.user_id;
    
    if (!userId) {
      throw new Error('user_id required');
    }

    // Method-aware reconciliation delays
    const patchMinAge = new Date(Date.now() - 90 * 1000).toISOString();
    const feedMinAge = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const backfillWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const actionSelect = 'id, asin, sku, marketplace, new_price, old_price, action_type, update_method, assignment_id, intended_price, created_at, intelligence_factors, recon_retry_count, recon_first_check_at, recon_last_check_at, recon_price_submitted';

    // Backfill legacy mismatches from the last 24h into the delayed recheck pipeline.
    // These rows were finalized by older code before the 3-stage recheck sequence existed.
    const { data: legacyReset } = await supabase
      .from('repricer_price_actions')
      .update({
        reconciliation_status: 'recheck',
        recon_retry_count: 0,
        recon_root_cause: null,
        recon_severity: null,
        recon_first_check_at: null,
        recon_last_check_at: null,
        verified_live_price: null,
        verified_at: null,
      })
      .eq('user_id', userId)
      .eq('success', true)
      .in('action_type', ['price_change', 'price_and_minmax_change'])
      .eq('reconciliation_status', 'mismatch')
      .is('recon_root_cause', null)
      .gte('created_at', backfillWindowStart)
      .select(actionSelect);

    const legacyResetCount = legacyReset?.length || 0;
    if (legacyResetCount > 0) {
      console.log(`[repricer-reconcile] BACKFILL: Re-queued ${legacyResetCount} legacy mismatches from the last 24h`);
    }
    
    // Timeout old pending actions (>2h)
    const { data: timedOut } = await supabase
      .from('repricer_price_actions')
      .update({
        reconciliation_status: 'pending_timeout',
        reconciliation_reason: 'Not verified within 2 hours',
        verified_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('reconciliation_status', 'pending')
      .eq('success', true)
      .in('action_type', ['price_change', 'price_and_minmax_change'])
      .lt('created_at', twoHoursAgo)
      .select('id');
    
    const timedOutCount = timedOut?.length || 0;
    if (timedOutCount > 0) {
      console.log(`[repricer-reconcile] Timed out ${timedOutCount} old pending actions (>2h)`);
    }
    
    // Fetch pending actions (first check) AND recheck actions (retry_count 1-3)
    const { data: patchActions } = await supabase
      .from('repricer_price_actions')
      .select(actionSelect)
      .eq('user_id', userId)
      .eq('reconciliation_status', 'pending')
      .eq('success', true)
      .eq('update_method', 'PATCH')
      .in('action_type', ['price_change', 'price_and_minmax_change'])
      .gte('created_at', twoHoursAgo)
      .lte('created_at', patchMinAge)
      .order('created_at', { ascending: true })
      .limit(40);
    
    const { data: feedActions } = await supabase
      .from('repricer_price_actions')
      .select(actionSelect)
      .eq('user_id', userId)
      .eq('reconciliation_status', 'pending')
      .eq('success', true)
      .in('action_type', ['price_change', 'price_and_minmax_change'])
      .gte('created_at', twoHoursAgo)
      .lte('created_at', feedMinAge)
      .neq('update_method', 'PATCH')
      .order('created_at', { ascending: true })
      .limit(40);

    // Fetch recheck actions with priority ordering: retry 0 first, then 1, then 2+
    const { data: recheckActions } = await supabase
      .from('repricer_price_actions')
      .select(actionSelect)
      .eq('user_id', userId)
      .eq('reconciliation_status', 'recheck')
      .eq('success', true)
      .in('action_type', ['price_change', 'price_and_minmax_change'])
      .gte('created_at', backfillWindowStart)
      .order('recon_retry_count', { ascending: true })
      .limit(60);

    const allActions = [
      ...(legacyReset || []).slice(0, 20),
      ...(patchActions || []),
      ...(feedActions || []),
      ...(recheckActions || []),
    ]
      .filter((action, index, arr) => action && arr.findIndex((candidate) => candidate.id === action.id) === index)
      .filter((action) => isReadyForRecheck(action));

    if (allActions.length === 0) {
      console.log(`[repricer-reconcile] No pending reconciliation items for ${userId} (legacy_backfill=${legacyResetCount})`);
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No pending reconciliation items',
        verified: 0 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[repricer-reconcile] Processing ${allActions.length} actions (pending+recheck) for ${userId} (legacy_backfill=${legacyResetCount})`);

    // Get seller auth
    const { data: authRows } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', userId);

    if (!authRows || authRows.length === 0) {
      for (const action of allActions) {
        await markReconciliation(supabase, action.id, 'failed', null, 'No seller authorization found');
      }
      return new Response(JSON.stringify({ success: false, error: 'No seller authorization' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Group by marketplace
    const marketplaceGroups = new Map<string, typeof allActions>();
    for (const action of allActions) {
      const m = action.marketplace || 'US';
      if (!marketplaceGroups.has(m)) marketplaceGroups.set(m, []);
      marketplaceGroups.get(m)!.push(action);
    }

    const marketplaceIdMap: Record<string, string> = {
      US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2',
      MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC',
    };

    let totalVerified = 0;
    let totalMatched = 0;
    let totalMismatched = 0;
    let totalFailed = 0;
    let totalRequeued = 0;

    for (const [marketplace, actions] of marketplaceGroups.entries()) {
      const marketplaceId = marketplaceIdMap[marketplace] || 'ATVPDKIKX0DER';
      const sellerAuth = authRows.find(a => a.marketplace_id === marketplaceId) ||
                         authRows.find(a => a.marketplace_id === 'ATVPDKIKX0DER') ||
                         authRows[0];

      let accessToken: string;
      try {
        accessToken = await getAccessToken(sellerAuth.refresh_token);
      } catch (e) {
        console.error(`[repricer-reconcile] Token refresh failed for ${marketplace}:`, e);
        // HEALTH SIGNAL: SP-API auth failure (critical)
        await HealthSignals.spApiAuthError(userId, 'repricer-reconcile', `Token refresh failed for ${marketplace}: ${(e as Error).message}`);
        for (const action of actions) {
          await markReconciliation(supabase, action.id, 'failed', null, 'Token refresh failed');
        }
        totalFailed += actions.length;
        continue;
      }

      const reconcileStartMs = Date.now();
      const TIME_GUARD_MS = 100_000;
      
      for (const action of actions) {
        if (Date.now() - reconcileStartMs > TIME_GUARD_MS) {
          console.log(`[repricer-reconcile] TIME GUARD: stopping after ${Math.round((Date.now() - reconcileStartMs) / 1000)}s`);
          break;
        }
        
        const retryCount = action.recon_retry_count || 0;
        const nowIso = new Date().toISOString();
        
        try {
          // Adaptive pacing: slower for MX (highest failure rate), faster for US
          const pacingMs = marketplace === 'MX' ? 700 : marketplace === 'BR' ? 600 : 500;
          await new Promise(r => setTimeout(r, pacingMs));

          // ─── MULTI-LAYER PRICE EXTRACTION ────────────────────
          let livePrice: number | null = null;
          let extractionSource = 'none';

          // Layer 1: Listings API (offers)
          const listingsUrl = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${sellerAuth.seller_id}/${encodeURIComponent(action.sku)}?marketplaceIds=${marketplaceId}&includedData=offers,attributes,summaries`;
          const resp = await signedRequest('GET', listingsUrl, '', accessToken);

          if (!resp.ok) {
            const errText = await resp.text();
            const status = resp.status;
            console.warn(`[repricer-reconcile] API error for ${action.sku} (${status}): ${errText.slice(0, 200)}`);
            
            // On 429, apply marketplace-specific cooldown and skip
            if (status === 429) {
              const cooldownMs = 2000 + Math.random() * 1000;
              await new Promise(r => setTimeout(r, cooldownMs));
              if (retryCount < MAX_RETRIES) {
                await supabase.from('repricer_price_actions').update({
                  reconciliation_status: 'recheck',
                  recon_retry_count: retryCount + 1,
                  recon_first_check_at: action.recon_first_check_at || nowIso,
                  recon_last_check_at: nowIso,
                }).eq('id', action.id);
                totalRequeued++;
                continue;
              }
            }
            
            // On API error during recheck, don't finalize — just skip this cycle
            if (retryCount > 0 && retryCount < MAX_RETRIES) {
              continue; // Will be picked up next cycle
            }
            await markReconciliation(supabase, action.id, 'failed', null, `API error ${status}`);
            await supabase.from('repricer_price_actions').update({
              recon_root_cause: 'API_ERROR',
              recon_severity: 'unknown',
              recon_last_check_at: nowIso,
            }).eq('id', action.id);
            totalFailed++;
            continue;
          }

          const listingData = await resp.json();

          // Extract Amazon-side min/max from purchasable_offer attributes (Automate Pricing rules)
          let amazonMinFromListing: number | null = null;
          let amazonMaxFromListing: number | null = null;
          try {
            const po = listingData?.attributes?.purchasable_offer?.[0];
            if (po) {
              const minRaw = po?.minimum_seller_allowed_price?.[0]?.schedule?.[0];
              const maxRaw = po?.maximum_seller_allowed_price?.[0]?.schedule?.[0];
              const minV = minRaw?.value_with_tax ?? minRaw?.value;
              const maxV = maxRaw?.value_with_tax ?? maxRaw?.value;
              if (minV != null && Number.isFinite(Number(minV))) amazonMinFromListing = Number(minV);
              if (maxV != null && Number.isFinite(Number(maxV))) amazonMaxFromListing = Number(maxV);
            }
          } catch (_) { /* ignore */ }

          // Persist freshest Amazon bounds onto the assignment for UI surfacing & future evaluations
          if (action.assignment_id && (amazonMinFromListing != null || amazonMaxFromListing != null)) {
            const upd: Record<string, unknown> = { amazon_bounds_synced_at: nowIso };
            if (amazonMinFromListing != null) {
              upd.amazon_min_price = amazonMinFromListing;
              upd.last_min_price_on_amazon = amazonMinFromListing;
            }
            if (amazonMaxFromListing != null) {
              upd.amazon_max_price = amazonMaxFromListing;
              upd.last_max_price_on_amazon = amazonMaxFromListing;
            }
            await supabase.from('repricer_assignments').update(upd).eq('id', action.assignment_id);
          }

          // Layer 1a: Extract from offers array (primary)
          if (listingData?.offers) {
            for (const offer of listingData.offers) {
              if (offer.marketplaceId === marketplaceId || !offer.marketplaceId) {
                const rawPrice = offer.price?.amount 
                  || offer.listingPrice?.amount 
                  || offer.ourPrice?.[0]?.schedule?.[0]?.valueWithTax
                  || offer.ourPrice?.[0]?.schedule?.[0]?.value
                  || null;
                if (rawPrice !== null) {
                  livePrice = Number(rawPrice);
                  extractionSource = 'offers';
                }
                break;
              }
            }
          }
          
          // Layer 1b: Extract from attributes (purchasable_offer)
          if (livePrice === null) {
            const purchasableOffer = listingData?.attributes?.purchasable_offer;
            if (purchasableOffer && purchasableOffer.length > 0) {
              const offer = purchasableOffer[0];
              const attrPrice = offer?.our_price?.[0]?.schedule?.[0]?.value_with_tax
                ?? offer?.our_price?.[0]?.schedule?.[0]?.value
                ?? null;
              if (attrPrice !== null) {
                livePrice = Number(attrPrice);
                extractionSource = 'attributes_purchasable';
              }
            }
          }

          // Layer 1c: Extract from attributes (list_price)
          if (livePrice === null) {
            const listPrice = listingData?.attributes?.list_price?.[0]?.value
              ?? listingData?.attributes?.list_price?.[0]?.value_with_tax
              ?? null;
            if (listPrice !== null) {
              livePrice = Number(listPrice);
              extractionSource = 'attributes_list_price';
            }
          }

          // Layer 1d: Extract from summaries
          if (livePrice === null) {
            const summary = listingData?.summaries?.[0];
            if (summary?.mainImage?.link) {
              // Listing exists but no price — may be suppressed
              const purchPrice = summary?.price?.amount ?? null;
              if (purchPrice !== null) {
                livePrice = Number(purchPrice);
                extractionSource = 'summaries';
              }
            }
          }

          const intendedPrice = Number(action.intended_price || action.new_price);
          
          if (livePrice === null || isNaN(livePrice)) {
            // Log extraction failure details for debugging
            const availableKeys = Object.keys(listingData || {}).join(',');
            const offerCount = listingData?.offers?.length || 0;
            const hasAttrs = !!listingData?.attributes;
            console.warn(`[repricer-reconcile] EXTRACTION_FAILED: ${action.asin}/${action.sku} (${marketplace}) — keys=[${availableKeys}], offers=${offerCount}, hasAttrs=${hasAttrs}`);

            const isGiftReceipt = action.sku?.startsWith('amzn.gr.');
            if (isGiftReceipt) {
              await markReconciliation(supabase, action.id, 'matched', null, 'Gift receipt variant — price inherited from parent SKU');
              await supabase.from('repricer_price_actions').update({
                recon_root_cause: 'GIFT_RECEIPT',
                recon_severity: 'minor',
                recon_converged_at: nowIso,
              }).eq('id', action.id);
              totalMatched++;
            } else {
              if (retryCount < MAX_RETRIES) {
                // Requeue — may be listing propagation delay
                await supabase.from('repricer_price_actions').update({
                  reconciliation_status: 'recheck',
                  recon_retry_count: retryCount + 1,
                  recon_first_check_at: action.recon_first_check_at || nowIso,
                  recon_last_check_at: nowIso,
                }).eq('id', action.id);
                totalRequeued++;
              } else {
                await markReconciliation(supabase, action.id, 'failed', null, `Could not extract live price from listing`);
                await supabase.from('repricer_price_actions').update({
                  recon_root_cause: 'NO_PRICE_READABLE',
                  recon_severity: 'unknown',
                }).eq('id', action.id);
                totalFailed++;
              }
            }
            continue;
          }

          if (extractionSource !== 'offers') {
            console.log(`[repricer-reconcile] FALLBACK_EXTRACTION: ${action.asin}/${action.sku} (${marketplace}) — source=${extractionSource}, price=${livePrice}`);
          }

          const delta = Math.abs(livePrice - intendedPrice);
          const marketplaceLocal = action.marketplace || 'US';
          const isInternational = marketplaceLocal !== 'US';
          const pctDiff = intendedPrice > 0 ? (delta / intendedPrice) * 100 : 0;
          
          // Wider tolerance for international marketplaces (FX rounding)
          const tolerance = isInternational ? Math.max(0.15, intendedPrice * 0.03) : 0.15;
          const priceMatch = delta < tolerance;
          const isGiftReceipt = action.sku?.startsWith('amzn.gr.');
          
          if (priceMatch || isGiftReceipt) {
            // ─── MATCHED ────────────────────────────────────────
            let matchRootCause = 'EXACT_MATCH';
            let reason: string | null = null;
            
            if (isGiftReceipt) {
              matchRootCause = 'GIFT_RECEIPT';
              reason = `Gift receipt — price inherited (intended $${intendedPrice.toFixed(2)}, live $${livePrice.toFixed(2)})`;
            } else if (isInternational && delta >= 0.15) {
              matchRootCause = 'FX_ROUNDING';
              reason = `FX rounding match: intended $${intendedPrice.toFixed(2)}, live $${livePrice.toFixed(2)} (${pctDiff.toFixed(1)}%)`;
            } else if (delta >= 0.05) {
              matchRootCause = 'AMAZON_ROUNDING';
              reason = `Rounding match: intended $${intendedPrice.toFixed(2)}, live $${livePrice.toFixed(2)}`;
            } else if (delta >= 0.01) {
              matchRootCause = 'AMAZON_ROUNDING';
            }
            
            await markReconciliation(supabase, action.id, 'matched', livePrice, reason);
            await supabase.from('repricer_price_actions').update({
              recon_severity: 'minor',
              recon_root_cause: matchRootCause,
              recon_first_check_at: action.recon_first_check_at || nowIso,
              recon_last_check_at: nowIso,
              recon_converged_at: nowIso,
              recon_price_submitted: action.recon_price_submitted || intendedPrice,
            }).eq('id', action.id);
            
            totalMatched++;
            if (retryCount > 0) {
              console.log(`[repricer-reconcile] DELAYED_MATCH (retry ${retryCount}): ${action.asin}/${action.sku} — converged after recheck`);
            }
          } else {
            // ─── MISMATCH — check fast-path and retry ────────────
            const classification = classifyMismatch(intendedPrice, livePrice, action, {
              min: amazonMinFromListing,
              max: amazonMaxFromListing,
            });
            const isAmazonRuleBlock = classification.rootCause === 'AMAZON_MIN_PRICE_BLOCK'
              || classification.rootCause === 'AMAZON_MAX_PRICE_BLOCK';
            const blockBoundLabel = classification.rootCause === 'AMAZON_MIN_PRICE_BLOCK'
              ? `Amazon minimum $${(amazonMinFromListing ?? livePrice).toFixed(2)}`
              : classification.rootCause === 'AMAZON_MAX_PRICE_BLOCK'
                ? `Amazon maximum $${(amazonMaxFromListing ?? livePrice).toFixed(2)}`
                : null;
            const baseReason = isAmazonRuleBlock && blockBoundLabel
              ? `⚠️ Amazon pricing rule blocked submission — intended $${intendedPrice.toFixed(2)} violates ${blockBoundLabel} (live clamped at $${livePrice.toFixed(2)})`
              : `Intended $${intendedPrice.toFixed(2)}, live $${livePrice.toFixed(2)} (delta $${(livePrice - intendedPrice).toFixed(2)})`;

            // FAST-PATH CONFIDENCE MATCH: if delta < 3% and retried at least once,
            // classify as matched with appropriate root cause (avoids infinite recheck loops)
            if (retryCount >= 1 && pctDiff < 3.0 && classification.severity !== 'severe') {
              const fastRootCause = isInternational ? 'FX_ROUNDING' : 'AMAZON_ROUNDING';
              const fastReason = `Confidence match (${pctDiff.toFixed(1)}% delta after ${retryCount} rechecks) [${fastRootCause}]`;
              await markReconciliation(supabase, action.id, 'matched', livePrice, fastReason);
              await supabase.from('repricer_price_actions').update({
                recon_severity: 'minor',
                recon_root_cause: fastRootCause,
                recon_first_check_at: action.recon_first_check_at || nowIso,
                recon_last_check_at: nowIso,
                recon_converged_at: nowIso,
                recon_price_submitted: action.recon_price_submitted || intendedPrice,
              }).eq('id', action.id);
              totalMatched++;
              console.log(`[repricer-reconcile] FAST_PATH_MATCH (${pctDiff.toFixed(1)}%): ${action.asin}/${action.sku} — ${fastReason}`);
              continue;
            }

            // Force-finalize if past max lifetime (4h)
            const actionAge = Date.now() - new Date(action.created_at).getTime();
            // Amazon rule blocks (Automate Pricing min/max) are deterministic — finalize immediately, don't waste rechecks
            const forceFinalize = actionAge > MAX_RECHECK_LIFETIME_MS || isAmazonRuleBlock;

            if (retryCount < MAX_RETRIES && !forceFinalize) {
              // Not yet exhausted retries — requeue for delayed recheck
              await supabase.from('repricer_price_actions').update({
                reconciliation_status: 'recheck',
                recon_retry_count: retryCount + 1,
                recon_first_check_at: action.recon_first_check_at || nowIso,
                recon_last_check_at: nowIso,
                verified_live_price: livePrice,
                recon_severity: classification.severity,
                recon_root_cause: classification.rootCause,
                recon_price_submitted: action.recon_price_submitted || intendedPrice,
                reconciliation_reason: `${baseReason}, ${classification.type} [${classification.rootCause}] — recheck ${retryCount + 1}/${MAX_RETRIES}`,
              }).eq('id', action.id);
              
              totalRequeued++;
              console.log(`[repricer-reconcile] RECHECK_QUEUED (${retryCount + 1}/${MAX_RETRIES}) [${classification.rootCause}]: ${action.asin}/${action.sku} — ${baseReason}`);
              continue;
            }
            
            // ─── FINAL MISMATCH — all retries exhausted ─────────
            
            // Check if non_reconcilable (repeated mismatches on inactive listing)
            const { data: recentMismatches } = await supabase
              .from('repricer_price_actions')
              .select('id')
              .eq('user_id', userId)
              .eq('sku', action.sku)
              .in('reconciliation_status', ['mismatch', 'recheck'])
              .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
              .limit(3);
            
            const repeatedMismatch = (recentMismatches?.length || 0) >= 2;
            
            if (repeatedMismatch) {
              const { data: invCheck } = await supabase
                .from('inventory')
                .select('listing_status')
                .eq('user_id', userId)
                .eq('sku', action.sku)
                .maybeSingle();
              
              const isInactiveOrRestricted = invCheck?.listing_status && 
                (invCheck.listing_status.includes('INACTIVE') || invCheck.listing_status === 'NOT_FOUND' || invCheck.listing_status === 'CLOSED');
            
              if (isInactiveOrRestricted) {
                await markReconciliation(supabase, action.id, 'non_reconcilable' as any, livePrice, 
                  `Repeated mismatch on ${invCheck.listing_status} listing — excluded [${classification.rootCause}]`);
                await supabase.from('repricer_price_actions').update({
                  recon_severity: classification.severity,
                  recon_root_cause: classification.rootCause,
                  recon_last_check_at: nowIso,
                }).eq('id', action.id);
                console.log(`[repricer-reconcile] NON_RECONCILABLE: ${action.asin}/${action.sku}`);
                totalVerified++;
                continue;
              }
            }
            
            // Final mismatch
            const reason = `${baseReason}, ${classification.type} [${classification.rootCause}] — final after ${retryCount} rechecks`;
            await markReconciliation(supabase, action.id, 'mismatch', livePrice, reason);
            await supabase.from('repricer_price_actions').update({
              recon_severity: classification.severity,
              recon_root_cause: classification.rootCause,
              recon_last_check_at: nowIso,
              recon_price_submitted: action.recon_price_submitted || intendedPrice,
            }).eq('id', action.id);
            
            // Force re-evaluation for severe mismatches
            if (classification.severity === 'severe' && action.assignment_id) {
              await supabase.from('repricer_assignments').update({
                last_sp_api_check_at: null,
              }).eq('id', action.assignment_id);
              console.log(`[repricer-reconcile] AUTO_RETRY: ${action.asin} — severe mismatch, forcing re-evaluation`);
            }
            
            totalMismatched++;
            console.log(`[repricer-reconcile] FINAL_MISMATCH [${classification.severity}/${classification.rootCause}]: ${action.asin}/${action.sku} — ${reason}`);
          }

          totalVerified++;

          // BB loss tracking on final mismatch only
          if (!priceMatch && retryCount >= MAX_RETRIES && action.assignment_id && action.old_price && action.new_price > action.old_price) {
            try {
              const spApiResponse = await fetch(`${supabaseUrl}/functions/v1/repricer-sp-api-pricing`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
                body: JSON.stringify({
                  asin: action.asin,
                  sku: action.sku,
                  marketplace: action.marketplace || 'US',
                  user_id: userId,
                  internal: true,
                }),
              });
              const spData = await spApiResponse.json();
              
              if (spData.success && spData.data) {
                const lostBb = !spData.data.isBuyboxOwner;
                if (lostBb) {
                  console.log(`[repricer-reconcile] BB_LOSS_AFTER_RAISE: ${action.asin}`);
                }
                await trackBbLossAfterRaise(supabase, action.assignment_id, true, lostBb);
              }
            } catch (bbErr) {
              console.warn(`[repricer-reconcile] BB check failed for ${action.asin}:`, bbErr);
            }
          }

        } catch (e: any) {
          console.error(`[repricer-reconcile] Error verifying ${action.asin}/${action.sku}:`, e);
          // HEALTH SIGNAL: Amazon price update failed (verification side)
          await logHealthSignal({
            user_id: userId, module: 'amazon_api', severity: 'warning', confidence: 'high',
            pattern: 'amazon_price_update_failed',
            title: 'Amazon price verification failed',
            impact: `Reconciliation could not confirm price for ${action.asin}${action.sku ? '/' + action.sku : ''}.`,
            recommended_fix: 'Re-run repricer-reconcile or inspect listing in Repricer > Diagnostics.',
            auto_fix_action: 'repricer-reconcile',
            entity: { asin: action.asin, sku: action.sku, marketplace, assignment_id: action.assignment_id },
            function_name: 'repricer-reconcile', source: 'edge_runtime',
            raw_message: (e as Error).message,
          });
          await markReconciliation(supabase, action.id, 'failed', null, (e as Error).message || 'Unknown error');
          totalFailed++;
        }
      }
    }

    console.log(`[repricer-reconcile] Complete: verified=${totalVerified}, matched=${totalMatched}, mismatched=${totalMismatched}, failed=${totalFailed}, requeued=${totalRequeued}, timed_out=${timedOutCount}`);

    return new Response(JSON.stringify({
      success: true,
      verified: totalVerified,
      matched: totalMatched,
      mismatched: totalMismatched,
      failed: totalFailed,
      requeued: totalRequeued,
      timed_out: timedOutCount,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[repricer-reconcile] Error:', error);
    // HEALTH SIGNAL: top-level fatal
    try {
      const body = await req.clone().json().catch(() => ({} as any));
      const fatalUserId = body?.user_id;
      if (fatalUserId) {
        await logHealthSignal({
          user_id: fatalUserId, module: 'repricer', severity: 'critical', confidence: 'high',
          pattern: 'repricer_reconcile_fatal',
          title: 'Repricer reconciliation crashed',
          impact: 'Submitted Amazon prices were not verified this cycle; status may show stuck.',
          recommended_fix: 'Re-run repricer-reconcile or contact support.',
          auto_fix_action: 'repricer-reconcile',
          function_name: 'repricer-reconcile', source: 'edge_runtime',
          raw_message: (error as Error).message,
        });
      }
    } catch { /* never throw */ }
    return new Response(JSON.stringify({ 
      success: false, 
      error: (error as Error).message || 'Reconciliation failed' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
