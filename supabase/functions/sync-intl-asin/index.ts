import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";
import { getListingUnitCost, getInventoryUnitCost } from '../_shared/cost-contract.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function hmacSha256(key: string | Uint8Array, data: string): Uint8Array {
  const hmac = createHmac('sha256', key as any);
  hmac.update(data);
  return new Uint8Array(hmac.digest());
}

function getSigningKey(key: string, dateStamp: string, region: string, service: string): Uint8Array {
  const kDate = hmacSha256(`AWS4${key}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function getAwsSignature(stringToSign: string, kSigning: Uint8Array): string {
  const hmac = createHmac('sha256', kSigning as any);
  hmac.update(stringToSign);
  return hmac.digest('hex');
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Missing LWA credentials');
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw new Error(`LWA token error: ${response.status}`);
  return (await response.json()).access_token;
}

async function callSpApi(method: string, path: string, accessToken: string, queryParams: Record<string, string> = {}): Promise<any> {
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const awsAccessKey = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const host = 'sellingpartnerapi-na.amazon.com';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.substring(0, 8);
  const qs = Object.entries(queryParams).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonicalRequest = `${method}\n${path}\n${qs}\nhost:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n\nhost;x-amz-access-token;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const canonicalHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  const scope = `${dateStamp}/${awsRegion}/execute-api/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${canonicalHash}`;
  const signingKey = getSigningKey(awsSecretKey, dateStamp, awsRegion, 'execute-api');
  const signature = getAwsSignature(stringToSign, signingKey);
  const authHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKey}/${scope}, SignedHeaders=host;x-amz-access-token;x-amz-date, Signature=${signature}`;
  const url = `https://${host}${path}${qs ? '?' + qs : ''}`;
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, { method, headers: { 'host': host, 'x-amz-access-token': accessToken, 'x-amz-date': amzDate, 'Authorization': authHeader, 'Content-Type': 'application/json' } });
    if (response.ok) return response.json();
    const errorText = await response.text();
    if (response.status === 429 && attempt < maxRetries) { await new Promise(r => setTimeout(r, 5000 * Math.pow(2, attempt - 1))); continue; }
    if (response.status === 503 && attempt < maxRetries) { await new Promise(r => setTimeout(r, 10000 * attempt)); continue; }
    throw new Error(`SP-API ${response.status}: ${errorText}`);
  }
  throw new Error('SP-API request failed after max retries');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth: support both JWT (manual) and internal secret (automated trigger)
    const authHeader = req.headers.get('Authorization');
    const internalSecret = req.headers.get('x-internal-secret');
    const configuredSecret = Deno.env.get('INTERNAL_SYNC_SECRET');

    let userId: string;

    if (internalSecret && configuredSecret && internalSecret === configuredSecret) {
      // Internal automated call - user_id comes from body
      const body = await req.json();
      if (!body.user_id || !body.asin || !body.sku) {
        return new Response(JSON.stringify({ error: 'user_id, asin and sku required' }), { status: 400, headers: corsHeaders });
      }
      userId = body.user_id;
      const { asin, sku } = body;
      console.log(`[sync-intl-asin] Auto-trigger for ${asin} (${sku}) user=${userId}`);
      // Re-assign for downstream use - store in request-scoped vars
      (req as any)._parsed = { asin, sku };
    } else if (authHeader) {
      const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
      if (authErr || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      userId = user.id;
      const body = await req.json();
      if (!body.asin || !body.sku) return new Response(JSON.stringify({ error: 'asin and sku required' }), { status: 400, headers: corsHeaders });
      (req as any)._parsed = { asin: body.asin, sku: body.sku };
      console.log(`[sync-intl-asin] Manual sync for ${body.asin} (${body.sku}) user=${userId}`);
    } else {
      return new Response(JSON.stringify({ error: 'No auth' }), { status: 401, headers: corsHeaders });
    }

    const { asin, sku } = (req as any)._parsed;

    // Get user's refresh token
    const { data: authData } = await supabase.from('seller_authorizations').select('refresh_token, marketplace_id').eq('user_id', userId);
    if (!authData?.length) return new Response(JSON.stringify({ error: 'No seller authorization' }), { status: 400, headers: corsHeaders });

    const naAuth = authData.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authData[0];
    const accessToken = await getLwaAccessToken(naAuth.refresh_token);
    const globalSellerId = Deno.env.get('SPAPI_SELLER_ID');
    if (!globalSellerId) return new Response(JSON.stringify({ error: 'SPAPI_SELLER_ID missing' }), { status: 500, headers: corsHeaders });

    const intlMarketplaces: Record<string, string> = {
      'A2EUQ1WTGCTBG2': 'CA', 'A1AM78C64UM0Y8': 'MX', 'A2Q3Y263D00KWC': 'BR',
    };
    const mktCurrency: Record<string, string> = { 'A2EUQ1WTGCTBG2': 'CAD', 'A1AM78C64UM0Y8': 'MXN', 'A2Q3Y263D00KWC': 'BRL' };
    const activeStatuses = new Set(['ACTIVE', 'BUYABLE', 'DISCOVERABLE']);

    // Get authorized intl marketplaces
    const authorizedIntl = authData.map((a: any) => a.marketplace_id).filter((mid: string) => mid in intlMarketplaces);
    if (authorizedIntl.length === 0) return new Response(JSON.stringify({ error: 'No international authorizations', results: {} }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Get auto-onboarding settings
    let autoSettings: any = null;
    const { data: autoData } = await supabase.from('user_settings')
      .select('auto_assign_enabled, auto_assign_rule_id, auto_minmax_enabled, auto_min_strategy, auto_max_strategy, auto_min_buffer_pct, auto_max_buffer_pct, auto_require_cost, auto_raise_roi_floor_us, auto_raise_roi_floor_ca, auto_raise_roi_floor_mx, auto_raise_roi_floor_br')
      .eq('user_id', userId).maybeSingle();
    autoSettings = autoData;
    if (!autoSettings?.auto_assign_enabled) {
      const { data: firstRule } = await supabase.from('repricer_rules').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (firstRule) {
        autoSettings = { auto_assign_enabled: true, auto_assign_rule_id: firstRule.id, auto_minmax_enabled: true, auto_min_strategy: 'price_buffer', auto_max_strategy: 'price_buffer', auto_min_buffer_pct: 15, auto_max_buffer_pct: 30, auto_require_cost: true, auto_raise_roi_floor_us: false, auto_raise_roi_floor_ca: false, auto_raise_roi_floor_mx: false, auto_raise_roi_floor_br: false };
      }
    }

    // Get rule's Min ROI settings
    let ruleMinRoi: number | null = null;
    let ruleMinRoiEnabled = false;
    let ruleMinRoiOverrides: Record<string, number> = {};
    if (autoSettings?.auto_assign_rule_id) {
      const { data: ruleData } = await supabase.from('repricer_rules')
        .select('min_roi_enabled, min_roi, min_roi_percent, min_roi_marketplace_overrides')
        .eq('id', autoSettings.auto_assign_rule_id).maybeSingle();
      if (ruleData) {
        ruleMinRoiEnabled = ruleData.min_roi_enabled || false;
        ruleMinRoi = ruleData.min_roi_percent || ruleData.min_roi || null;
        if (ruleData.min_roi_marketplace_overrides && typeof ruleData.min_roi_marketplace_overrides === 'object') {
          ruleMinRoiOverrides = ruleData.min_roi_marketplace_overrides as Record<string, number>;
        }
      }
    }

    // Get cost (USD) — Contract A: created_listings.amount = UNIT, .cost = TOTAL.
    let unitCostUsd: number | null = null;
    const { data: costData } = await supabase.from('created_listings').select('cost, units, amount').eq('user_id', userId).eq('asin', asin).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (costData) {
      unitCostUsd = getListingUnitCost(costData);
    }
    // Also check inventory (Contract A: inventory.cost = UNIT, .amount = TOTAL).
    if (!unitCostUsd || unitCostUsd <= 0) {
      const { data: invCost } = await supabase.from('inventory').select('cost, units, amount').eq('user_id', userId).eq('asin', asin).maybeSingle();
      if (invCost) unitCostUsd = getInventoryUnitCost(invCost);
    }

    // Fetch FX rates for currency conversion (USD → local)
    const { data: fxRows } = await supabase.from('fx_rates').select('quote, rate').in('quote', ['CAD', 'MXN', 'BRL']);
    const fxMap: Record<string, number> = {};
    for (const fx of (fxRows || [])) { fxMap[fx.quote] = fx.rate; }
    console.log(`[sync-intl-asin] FX rates: CAD=${fxMap['CAD']}, MXN=${fxMap['MXN']}, BRL=${fxMap['BRL']}, unitCostUsd=$${unitCostUsd}`);

    const results: Record<string, { status: string; listing_status?: string; price?: number; assignment_created?: boolean; error?: string }> = {};

    for (const mktId of authorizedIntl) {
      const mktLabel = intlMarketplaces[mktId];
      try {
        // Check listing status via SP-API
        const listingResult = await callSpApi('GET', `/listings/2021-08-01/items/${globalSellerId}/${encodeURIComponent(sku)}`, accessToken, { marketplaceIds: mktId, includedData: 'offers,summaries' });
        const summaries = listingResult?.summaries || [];
        const summary = summaries.find((s: any) => s.marketplaceId === mktId) || summaries[0];
        const listingStatus = summary?.status || 'UNKNOWN';

        // Get listing price
        let listingPrice: number | null = null;
        let listingCurrency: string | null = null;
        if (listingResult?.offers && Array.isArray(listingResult.offers)) {
          for (const offer of listingResult.offers) {
            const val = parseFloat(offer.price?.amount || offer.price?.listingPrice?.amount || offer.listingPrice?.amount || offer.ourPrice?.amount || '0');
            if (val > 0) { listingPrice = val; listingCurrency = offer.price?.currency || null; break; }
          }
        }
        if (!listingPrice && summary?.price?.listingPrice?.amount) {
          listingPrice = summary.price.listingPrice.amount;
          listingCurrency = summary.price.listingPrice.currency || null;
        }

        // Cache price
        if (listingPrice && listingPrice > 0) {
          await supabase.from('asin_my_price_cache').upsert({
            user_id: userId, asin, marketplace_id: mktId, seller_sku: sku,
            my_price: listingPrice, currency: listingCurrency || mktCurrency[mktId] || 'USD',
            fetched_at: new Date().toISOString(), source: 'manual_intl_sync',
            attempt_count: 0, last_error: null, next_retry_at: null,
          }, { onConflict: 'user_id,asin,marketplace_id,seller_sku' });
        }

        if (!activeStatuses.has(listingStatus)) {
          // Update status on existing assignment — explicitly disable ineligible
          await supabase.from('repricer_assignments').upsert({
            user_id: userId, asin, sku, marketplace: mktLabel, intl_listing_status: listingStatus,
            is_enabled: false,
          }, { onConflict: 'user_id,sku,marketplace' });
          results[mktLabel] = { status: 'not_active', listing_status: listingStatus };
          continue;
        }

        // Build assignment
        const assignmentObj: any = {
          user_id: userId, asin, sku, marketplace: mktLabel,
          is_enabled: false, intl_listing_status: listingStatus,
        };

        if (autoSettings?.auto_assign_enabled && autoSettings.auto_assign_rule_id) {
          assignmentObj.rule_id = autoSettings.auto_assign_rule_id;
          assignmentObj.is_enabled = true;

          // Convert USD cost to local currency for this marketplace
          const localCurrency = mktCurrency[mktId] || 'USD';
          const fxRate = fxMap[localCurrency] || 1;
          const unitCostLocal = unitCostUsd && unitCostUsd > 0 ? unitCostUsd * fxRate : null;
          console.log(`[sync-intl-asin] ${asin}/${mktLabel}: costUSD=$${unitCostUsd} × FX ${fxRate} = ${localCurrency} ${unitCostLocal?.toFixed(2)}, listingPrice=${listingPrice}`);

          if (autoSettings.auto_minmax_enabled && listingPrice && listingPrice > 0) {
            let bufferMin: number | null = null;
            // Min price — listingPrice is already in local currency from SP-API
            if (autoSettings.auto_min_strategy === 'cost_buffer' && unitCostLocal && unitCostLocal > 0) {
              bufferMin = Math.round(unitCostLocal * (1 + (autoSettings.auto_min_buffer_pct || 15) / 100) * 100) / 100;
            } else if (autoSettings.auto_min_strategy === 'price_buffer') {
              bufferMin = Math.round(listingPrice * (1 - (autoSettings.auto_min_buffer_pct || 15) / 100) * 100) / 100;
            }

            // ROI-safe min for intl — must use LOCAL currency cost
            let roiSafeMin: number | null = null;
            if (ruleMinRoiEnabled && unitCostLocal && unitCostLocal > 0) {
              const effectiveRoi = ruleMinRoiOverrides[mktLabel] ?? ruleMinRoi;
              if (effectiveRoi && effectiveRoi > 0) {
                const referralRate = 0.15;
                const fbaFeeLocal = 3.50 * fxRate; // Convert FBA fee to local currency too
                const cushionedRoi = effectiveRoi + 10;
                const roiFloorPrice = (unitCostLocal * (1 + cushionedRoi / 100) + fbaFeeLocal) / (1 - referralRate);
                roiSafeMin = Math.ceil(roiFloorPrice * 100) / 100;
                console.log(`[sync-intl-asin] ROI floor for ${asin}/${mktLabel}: target=${effectiveRoi}% +10pt → ${localCurrency} ${roiSafeMin} (costLocal=${unitCostLocal.toFixed(2)}, fbaLocal=${fbaFeeLocal.toFixed(2)})`);
              }
            }

            // Use higher of buffer and ROI floor
            assignmentObj.min_price_override = bufferMin;
            if (roiSafeMin && (bufferMin === null || roiSafeMin > bufferMin)) {
              assignmentObj.min_price_override = roiSafeMin;
              console.log(`[sync-intl-asin] 🛡️ ROI floor raised min for ${asin}/${mktLabel}: ${localCurrency} ${bufferMin} → ${roiSafeMin}`);
            }

            // Max price — already in local currency (from listingPrice)
            if (autoSettings.auto_max_strategy === 'price_buffer') {
              assignmentObj.max_price_override = Math.round(listingPrice * (1 + (autoSettings.auto_max_buffer_pct || 30) / 100) * 100) / 100;
            } else if (autoSettings.auto_max_strategy === 'buybox_buffer') {
              assignmentObj.max_price_override = Math.round(listingPrice * (1 + (autoSettings.auto_max_buffer_pct || 30) / 100) * 100) / 100;
            }

            // Ensure max is above min when ROI raised min
            if (assignmentObj.min_price_override && assignmentObj.max_price_override && assignmentObj.min_price_override > assignmentObj.max_price_override) {
              assignmentObj.max_price_override = Math.round(assignmentObj.min_price_override * 1.35 * 100) / 100;
            }

            if (autoSettings.auto_require_cost && (!unitCostLocal || unitCostLocal <= 0)) {
              delete assignmentObj.min_price_override;
            }
          }
        }

        const { error: upsertErr } = await supabase.from('repricer_assignments').upsert(assignmentObj, { onConflict: 'user_id,sku,marketplace' });
        if (upsertErr) {
          results[mktLabel] = { status: 'error', error: upsertErr.message };
        } else {
          // ── IMMEDIATE AUTO-RAISE: submit live price update when toggle is ON ──
          let autoRaised = false;
          const roiSafeMinVal = assignmentObj.min_price_override;
          const raiseToggleKey = `auto_raise_roi_floor_${mktLabel.toLowerCase()}`;
          const raiseEnabled = autoSettings?.[raiseToggleKey] === true;
          
          if (raiseEnabled && roiSafeMinVal && listingPrice && listingPrice < roiSafeMinVal) {
            const gap = roiSafeMinVal - listingPrice;
            if (gap > 0.25 || (gap / listingPrice) > 0.02) {
              try {
                console.log(`[sync-intl-asin] 🚀 Auto-raise ${asin}/${mktLabel}: current=$${listingPrice} → $${roiSafeMinVal}`);
                const submitResp = await fetch(`${supabaseUrl}/functions/v1/update-amazon-price`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
                  body: JSON.stringify({
                    user_id: userId, asin, sku, marketplace: mktLabel,
                    newPrice: roiSafeMinVal, updateMinMaxOnly: false, internal: true, fromScheduler: true,
                  }),
                });
                const submitResult = await submitResp.json().catch(() => null);
                if (submitResp.ok && submitResult?.success) {
                  autoRaised = true;
                  console.log(`[sync-intl-asin] ✅ Auto-raise succeeded: ${asin}/${mktLabel} → $${roiSafeMinVal}`);
                } else {
                  console.log(`[sync-intl-asin] ⚠️ Auto-raise failed for ${asin}/${mktLabel}: ${submitResult?.error || submitResp.status} — HOT lane fallback`);
                }
              } catch (raiseErr: any) {
                console.log(`[sync-intl-asin] ⚠️ Auto-raise exception for ${asin}/${mktLabel}: ${raiseErr.message} — HOT lane fallback`);
              }
            }
          }
          
          results[mktLabel] = {
            status: 'synced',
            listing_status: listingStatus,
            price: listingPrice || undefined,
            assignment_created: true,
            auto_raised: autoRaised,
          };
        }

        await new Promise(r => setTimeout(r, 300));
      } catch (mktErr: any) {
        console.error(`[sync-intl-asin] ${mktLabel} error for ${asin}:`, mktErr.message);
        // If 404, mark as NOT_FOUND
        if (mktErr.message?.includes('404')) {
          await supabase.from('repricer_assignments').upsert({
            user_id: userId, asin, sku, marketplace: mktLabel, intl_listing_status: 'NOT_FOUND',
            is_enabled: false,
          }, { onConflict: 'user_id,sku,marketplace' });
          results[mktLabel] = { status: 'not_found' };
        } else {
          results[mktLabel] = { status: 'error', error: mktErr.message };
        }
      }
    }

    console.log(`[sync-intl-asin] Results for ${asin}:`, JSON.stringify(results));
    return new Response(JSON.stringify({ asin, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('[sync-intl-asin] Error:', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
