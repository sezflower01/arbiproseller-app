import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";
import { listingToInventoryCost } from "../_shared/cost-contract.ts";
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";

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
  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Missing LWA credentials');

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LWA token error: ${response.status} - ${errorText}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function callSpApi(
  method: string,
  path: string,
  accessToken: string,
  queryParams: Record<string, string> = {},
): Promise<any> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const host = 'sellingpartnerapi-na.amazon.com';
  const service = 'execute-api';

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const queryString = new URLSearchParams(queryParams).toString();
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const headers: Record<string, string> = {
    'host': host,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
  };

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');
  const canonicalRequest = `${method}\n${path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const requestHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${requestHash}`;
  const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, service);
  const signature = getAwsSignature(stringToSign, signingKey);
  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${path}${queryString ? '?' + queryString : ''}`;
  const response = await fetch(url, {
    method,
    headers: { ...headers, 'Authorization': authorizationHeader },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SP-API ${response.status}: ${errorText}`);
  }
  return await response.json();
}

const ZERO_CONFIRMATION_WINDOW_MINUTES = 45;

const MARKETPLACE_ID_BY_CODE = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
} as const;

const MARKETPLACE_CODE_BY_ID = Object.fromEntries(
  Object.entries(MARKETPLACE_ID_BY_CODE).map(([code, id]) => [id, code]),
) as Record<string, MarketplaceCode>;

type MarketplaceCode = keyof typeof MARKETPLACE_ID_BY_CODE;

type VerificationStatus =
  | 'corrected'
  | 'verified_unchanged'
  | 'unresolved_no_summary'
  | 'unresolved_wrong_marketplace'
  | 'suspicious_zero_blocked';

type SellerAuthorization = {
  refresh_token: string;
  marketplace_id: string;
  is_active: boolean | null;
};

type LiveStock = {
  available: number;
  reserved: number;
  inbound: number;
  inbound_working?: number;
  inbound_receiving?: number;
  inbound_shipped?: number;
};

type MarketplaceAttempt = {
  marketplace: MarketplaceCode;
  marketplace_id: string;
  authorization_marketplace_id: string | null;
  raw_summaries_count: number;
  matched_summaries_count: number;
  exact_seller_sku_match: boolean;
  matched_summary_identity: {
    seller_sku: string | null;
    asin: string | null;
    fnsku: string | null;
    product_name: string | null;
    condition: string | null;
  } | null;
  raw_quantities: {
    available: number;
    reserved: number;
    inbound: number;
    unfulfillable: number;
  } | null;
  inbound_components: {
    receiving: number;
    shipped: number;
    working: number;
    total: number;
  } | null;
  raw_summary_excerpt: Record<string, unknown> | null;
  live_stock: LiveStock;
  error: string | null;
};

function normalizeMarketplaceCode(value: unknown): MarketplaceCode | null {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized in MARKETPLACE_ID_BY_CODE ? (normalized as MarketplaceCode) : null;
}

function marketplaceCodeFromId(value: unknown): MarketplaceCode | null {
  return MARKETPLACE_CODE_BY_ID[String(value || '').trim()] || null;
}

function getTotalStock(stock: { available?: number; reserved?: number; inbound?: number } | null | undefined): number {
  return (stock?.available || 0) + (stock?.reserved || 0) + (stock?.inbound || 0);
}

function uniqueMarketplaces(values: Array<MarketplaceCode | null | undefined>): MarketplaceCode[] {
  return Array.from(new Set(values.filter(Boolean))) as MarketplaceCode[];
}

async function hasRecentZeroConfirmation(supabase: any, userId: string, sku: string): Promise<boolean> {
  // HARDENED GUARD (Apr 2026): Do NOT trust live_api zero history as confirmation
  // because Amazon SP-API Summaries returns intermittent false-zeros that
  // corrupt the history table itself, creating a self-poisoning guard.
  //
  // A zero is only "confirmed" if EITHER:
  //   (a) An FBA Inventory Report (source='amazon_sync') recorded zero in the
  //       last 7 days — Reports API is far more reliable than Summaries; OR
  //   (b) Listing has been tombstoned (NOT_IN_CATALOG / DELETED) — handled
  //       upstream, not here.
  //
  // Live API zeros NEVER confirm other live API zeros. This means a single
  // SP-API Summaries zero can never overwrite previous positive stock.
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('inventory_history')
    .select('available, reserved, inbound, captured_at, source')
    .eq('user_id', userId)
    .eq('sku', sku)
    .gte('captured_at', cutoff)
    .eq('source', 'amazon_sync')  // Reports API only, NOT live_api
    .order('captured_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error('[RESCUE] Failed to check zero confirmation history:', error);
    return false;
  }

  return (data || []).some((row: any) => getTotalStock(row) === 0);
}

async function resolveInventorySourceMarketplace(
  supabase: any,
  userId: string,
  activeAuthRows: SellerAuthorization[],
): Promise<MarketplaceCode | null> {
  const [{ data: settings }, { data: profile }] = await Promise.all([
    supabase
      .from('repricer_settings')
      .select('primary_marketplace')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('profiles')
      .select('primary_marketplace_id')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  const authCodes = uniqueMarketplaces(activeAuthRows.map((row) => marketplaceCodeFromId(row.marketplace_id)));

  return uniqueMarketplaces([
    normalizeMarketplaceCode(settings?.primary_marketplace),
    marketplaceCodeFromId(profile?.primary_marketplace_id),
    authCodes.includes('US') ? 'US' : null,
    authCodes[0] || null,
  ])[0] || null;
}

async function resolveListingMarketplace(
  supabase: any,
  userId: string,
  asin: string,
  sku: string,
  requestedMarketplace: MarketplaceCode | null,
  inventorySourceMarketplace: MarketplaceCode | null,
): Promise<MarketplaceCode | null> {
  if (requestedMarketplace) return requestedMarketplace;

  const { data: assignmentRows } = await supabase
    .from('repricer_assignments')
    .select('marketplace, is_enabled, sku')
    .eq('user_id', userId)
    .eq('asin', asin)
    .order('is_enabled', { ascending: false })
    .limit(10);

  const exactSkuRows = (assignmentRows || []).filter((row: any) => row.sku === sku && normalizeMarketplaceCode(row.marketplace));
  const marketplacePriority = uniqueMarketplaces([
    inventorySourceMarketplace,
    'US',
    ...exactSkuRows.map((row: any) => normalizeMarketplaceCode(row.marketplace)),
  ]);

  for (const preferredMarketplace of marketplacePriority) {
    const matchedRow = exactSkuRows.find((row: any) => normalizeMarketplaceCode(row.marketplace) === preferredMarketplace);
    if (matchedRow) return preferredMarketplace;
  }

  const firstValidRow = (assignmentRows || []).find((row: any) => normalizeMarketplaceCode(row.marketplace));
  return firstValidRow ? normalizeMarketplaceCode(firstValidRow.marketplace) : null;
}

async function fetchMarketplaceAttempt(
  sku: string,
  marketplace: MarketplaceCode,
  authData: SellerAuthorization,
): Promise<MarketplaceAttempt> {
  const marketplaceId = MARKETPLACE_ID_BY_CODE[marketplace];
  const accessToken = await getLwaAccessToken(authData.refresh_token);
  const response = await callSpApi('GET', '/fba/inventory/v1/summaries', accessToken, {
    marketplaceIds: marketplaceId,
    details: 'true',
    granularityType: 'Marketplace',
    granularityId: marketplaceId,
    sellerSkus: sku,
  });

  const summaries = response?.payload?.inventorySummaries || [];
  const exactMatches = summaries.filter((summary: any) => {
    const summarySku = summary?.sellerSku ?? summary?.seller_sku ?? null;
    return summarySku === sku;
  });
  const summariesToUse = exactMatches;
  const selectedSummary = summariesToUse[0] || null;

  let liveStock: LiveStock = { available: 0, reserved: 0, inbound: 0 };
  let rawQuantities: MarketplaceAttempt['raw_quantities'] = null;
  let inboundComponents: MarketplaceAttempt['inbound_components'] = null;
  let matchedSummaryIdentity: MarketplaceAttempt['matched_summary_identity'] = null;
  let rawSummaryExcerpt: MarketplaceAttempt['raw_summary_excerpt'] = null;

  for (const summary of summariesToUse) {
    const details = summary?.inventoryDetails || summary || {};
    const inboundReceiving = details?.inboundReceivingQuantity ?? summary?.inboundReceivingQuantity ?? 0;
    const inboundShipped = details?.inboundShippedQuantity ?? summary?.inboundShippedQuantity ?? 0;
    const inboundWorking = details?.inboundWorkingQuantity ?? summary?.inboundWorkingQuantity ?? 0;
    const visibleInbound = inboundReceiving + inboundShipped;
    inboundComponents = {
      receiving: inboundReceiving,
      shipped: inboundShipped,
      working: inboundWorking,
      total: visibleInbound,
    };
    rawQuantities = {
      available: details?.fulfillableQuantity ?? summary?.totalFulfillableQuantity ?? summary?.fulfillableQuantity ?? 0,
      reserved: details?.reservedQuantity?.totalReservedQuantity ?? summary?.reservedQuantity?.totalReservedQuantity ?? 0,
      inbound: visibleInbound,
      unfulfillable: details?.unfulfillableQuantity ?? details?.unsellableQuantity ?? summary?.unfulfillableQuantity ?? summary?.unsellableQuantity ?? 0,
    };
    matchedSummaryIdentity = {
      seller_sku: summary?.sellerSku ?? summary?.seller_sku ?? null,
      asin: summary?.asin ?? details?.asin ?? null,
      fnsku: summary?.fnSku ?? summary?.fnsku ?? details?.fnSku ?? details?.fnsku ?? null,
      product_name: summary?.productName ?? details?.productName ?? summary?.title ?? null,
      condition: summary?.condition ?? details?.condition ?? null,
    };
    rawSummaryExcerpt = {
      sellerSku: summary?.sellerSku ?? summary?.seller_sku ?? null,
      asin: summary?.asin ?? details?.asin ?? null,
      fnSku: summary?.fnSku ?? summary?.fnsku ?? details?.fnSku ?? details?.fnsku ?? null,
      totalQuantity: summary?.totalQuantity ?? details?.totalQuantity ?? null,
      inventoryDetails: {
        fulfillableQuantity: details?.fulfillableQuantity ?? summary?.fulfillableQuantity ?? summary?.totalFulfillableQuantity ?? 0,
        inboundReceivingQuantity: inboundReceiving,
        inboundShippedQuantity: inboundShipped,
        inboundWorkingQuantity: inboundWorking,
        reservedQuantity: details?.reservedQuantity ?? summary?.reservedQuantity ?? null,
        unfulfillableQuantity: details?.unfulfillableQuantity ?? summary?.unfulfillableQuantity ?? null,
      },
    };
    liveStock = {
      available: rawQuantities.available,
      reserved: rawQuantities.reserved,
      inbound: rawQuantities.inbound,
      inbound_working: inboundWorking,
      inbound_receiving: inboundReceiving,
      inbound_shipped: inboundShipped,
    };
  }

  return {
    marketplace,
    marketplace_id: marketplaceId,
    authorization_marketplace_id: authData.marketplace_id || null,
    raw_summaries_count: summaries.length,
    matched_summaries_count: exactMatches.length,
    exact_seller_sku_match: exactMatches.length > 0,
    matched_summary_identity: matchedSummaryIdentity,
    raw_quantities: rawQuantities,
    inbound_components: inboundComponents,
    raw_summary_excerpt: rawSummaryExcerpt,
    live_stock: liveStock,
    error: null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json();
    const { asin, sku, marketplace, user_id } = body;

    const authHeader = req.headers.get('Authorization');
    const internalHeader = req.headers.get('x-internal-secret');
    const configuredInternalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

    let userId: string | null = null;

    if (internalHeader && configuredInternalSecret && internalHeader === configuredInternalSecret) {
      if (!user_id) {
        return new Response(JSON.stringify({ error: 'Missing user_id for internal call' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      userId = user_id;
    } else {
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Missing authorization' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: { user }, error: authError } = await supabase.auth.getUser(
        authHeader.replace('Bearer ', ''),
      );
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      userId = user.id;
    }

    const resolvedUserId = userId as string;

    if (!asin || !sku) {
      return new Response(JSON.stringify({ error: 'asin and sku are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const requestedMarketplace = normalizeMarketplaceCode(marketplace);

    console.log(`[RESCUE] Starting rescue for ${asin}/${sku} requested=${requestedMarketplace || 'AUTO'} user=${resolvedUserId}`);

    const [{ data: currentDb }, { data: createdListing }, { data: authRows, error: authError }] = await Promise.all([
      supabase
        .from('inventory')
        .select('id, asin, sku, title, available, reserved, inbound, listing_status, source, updated_at, last_inventory_sync_at')
        .eq('user_id', resolvedUserId)
        .eq('asin', asin)
        .eq('sku', sku)
        .maybeSingle(),
      supabase
        .from('created_listings')
        .select('asin, sku, title, image_url, price, cost, amount, units, supplier_links')
        .eq('user_id', resolvedUserId)
        .eq('asin', asin)
        .eq('sku', sku)
        .maybeSingle(),
      supabase
        .from('seller_authorizations')
        .select('refresh_token, marketplace_id, is_active, seller_id, selling_partner_id')
        .eq('user_id', resolvedUserId),
    ]);

    if (authError) {
      throw new Error(`Failed to resolve seller authorization: ${authError.message}`);
    }

    const previousDb = currentDb ? {
      available: currentDb.available || 0,
      reserved: currentDb.reserved || 0,
      inbound: currentDb.inbound || 0,
      listing_status: currentDb.listing_status || 'UNKNOWN',
    } : null;

    const activeAuthRows = ((authRows || []) as SellerAuthorization[]).filter((row) => row.is_active !== false);
    const inventorySourceMarketplace = await resolveInventorySourceMarketplace(supabase, resolvedUserId, activeAuthRows);
    const listingMarketplace = await resolveListingMarketplace(
      supabase,
      resolvedUserId,
      asin,
      sku,
      requestedMarketplace,
      inventorySourceMarketplace,
    );
    const primaryMarketplace = requestedMarketplace || inventorySourceMarketplace || listingMarketplace || null;
    const candidateMarketplaces = requestedMarketplace
      ? [requestedMarketplace]
      : uniqueMarketplaces([
          primaryMarketplace,
          ...(!primaryMarketplace ? activeAuthRows.map((row) => marketplaceCodeFromId(row.marketplace_id)) : []),
        ]);

    const attemptDetails: MarketplaceAttempt[] = [];

    for (const candidate of candidateMarketplaces) {
      const authData = activeAuthRows.find((row) => row.marketplace_id === MARKETPLACE_ID_BY_CODE[candidate]);

      if (!authData?.refresh_token) {
        attemptDetails.push({
          marketplace: candidate,
          marketplace_id: MARKETPLACE_ID_BY_CODE[candidate],
          authorization_marketplace_id: authData?.marketplace_id || null,
          raw_summaries_count: 0,
          matched_summaries_count: 0,
          exact_seller_sku_match: false,
          matched_summary_identity: null,
          raw_quantities: null,
          inbound_components: null,
          raw_summary_excerpt: null,
          live_stock: { available: 0, reserved: 0, inbound: 0 },
          error: 'missing_marketplace_authorization',
        });
        continue;
      }

      try {
        const attempt = await fetchMarketplaceAttempt(sku, candidate, authData);
        attemptDetails.push(attempt);
        console.log(`[RESCUE] Attempt ${candidate}: summaries=${attempt.raw_summaries_count}, exact_matches=${attempt.matched_summaries_count}`);

        if (attempt.exact_seller_sku_match) {
          break;
        }
      } catch (error: any) {
        attemptDetails.push({
          marketplace: candidate,
          marketplace_id: MARKETPLACE_ID_BY_CODE[candidate],
          authorization_marketplace_id: authData.marketplace_id || null,
          raw_summaries_count: 0,
          matched_summaries_count: 0,
          exact_seller_sku_match: false,
          matched_summary_identity: null,
          raw_quantities: null,
          inbound_components: null,
          raw_summary_excerpt: null,
          live_stock: { available: 0, reserved: 0, inbound: 0 },
          error: error?.message || 'marketplace_attempt_failed',
        });
        console.warn(`[RESCUE] Attempt ${candidate} failed for ${asin}/${sku}: ${error?.message || error}`);
      }
    }

    const successfulAttempt = attemptDetails.find((attempt) => attempt.exact_seller_sku_match) || null;
    const fallbackUsed = !!successfulAttempt && !!primaryMarketplace && successfulAttempt.marketplace !== primaryMarketplace;
    const receivedAnySummaries = attemptDetails.some((attempt) => attempt.raw_summaries_count > 0);
    const rawChosenLiveStock = successfulAttempt?.live_stock || { available: 0, reserved: 0, inbound: 0 };
    const inboundOverrideApplied = false;
    const chosenLiveStock = rawChosenLiveStock;
    const totalLive = getTotalStock(chosenLiveStock);
    const hasStock = totalLive > 0;
    const newListingStatus = hasStock ? 'ACTIVE' : 'INACTIVE';
    const previousTotal = getTotalStock(previousDb);
    const receivedEmptyResponse = !receivedAnySummaries;
    const zeroConfirmed = successfulAttempt && totalLive === 0 && previousTotal > 0
      ? await hasRecentZeroConfirmation(supabase, resolvedUserId, sku)
      : false;
    const suspiciousZero = !!successfulAttempt && totalLive === 0 && previousTotal > 0 && !zeroConfirmed;

    let updatedDb = null;
    let postWriteDb = currentDb;
    let skippedUpdateReason: string | null = null;
    let attemptedWritePayload: Record<string, unknown> | null = null;
    let dbWriteSucceeded = false;
    const isGhostTombstone = currentDb?.listing_status === 'NOT_IN_CATALOG' || currentDb?.listing_status === 'DELETED';

    if (!successfulAttempt) {
      skippedUpdateReason = receivedEmptyResponse ? 'no_summary_any_marketplace' : 'no_exact_seller_sku_match';
    } else if (currentDb && isGhostTombstone) {
      skippedUpdateReason = `tombstoned:${currentDb.listing_status}`;
    } else if (currentDb && suspiciousZero) {
      skippedUpdateReason = 'suspicious_zero_unconfirmed';
      HealthSignals.inventoryStale(resolvedUserId, 'rescue-inventory-asin', asin, sku, successfulAttempt?.marketplace);
    } else if (currentDb) {
      attemptedWritePayload = {
        inventory_row_id: currentDb.id,
        asin,
        sku,
        available: chosenLiveStock.available,
        reserved: chosenLiveStock.reserved,
        inbound: chosenLiveStock.inbound,
        inbound_working: chosenLiveStock.inbound_working ?? 0,
        inbound_receiving: chosenLiveStock.inbound_receiving ?? 0,
        inbound_shipped: chosenLiveStock.inbound_shipped ?? 0,
        listing_status: newListingStatus,
        source: 'live_api',
      };
      const rescueNowIso = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('inventory')
        .update({
          available: chosenLiveStock.available,
          reserved: chosenLiveStock.reserved,
          inbound: chosenLiveStock.inbound,
          inbound_working: chosenLiveStock.inbound_working ?? 0,
          inbound_receiving: chosenLiveStock.inbound_receiving ?? 0,
          inbound_shipped: chosenLiveStock.inbound_shipped ?? 0,
          listing_status: newListingStatus,
          source: 'live_api',
          last_inventory_sync_at: rescueNowIso,
          last_summaries_at: rescueNowIso,
        })
        .eq('id', currentDb.id);

      if (updateError) {
        console.error(`[RESCUE] DB update failed:`, updateError);
        skippedUpdateReason = `update_failed:${updateError.message}`;
      } else {
        dbWriteSucceeded = true;
        updatedDb = {
          available: chosenLiveStock.available,
          reserved: chosenLiveStock.reserved,
          inbound: chosenLiveStock.inbound,
          listing_status: newListingStatus,
        };

        const previousSellable = (previousDb?.available || 0) + (previousDb?.reserved || 0);
        const newSellable = chosenLiveStock.available + chosenLiveStock.reserved;
        if (previousSellable === 0 && newSellable > 0) {
          const { data: reEnabled, error: reEnableErr } = await supabase
            .from('repricer_assignments')
            .update({ is_enabled: true })
            .eq('user_id', resolvedUserId)
            .eq('asin', asin)
            .eq('is_enabled', false)
            .select('asin, marketplace');
          if (reEnableErr) {
            console.error(`[RESCUE] Failed to re-enable assignments:`, reEnableErr);
          } else if (reEnabled?.length) {
            console.log(`[RESCUE] Re-enabled ${reEnabled.length} assignment(s) for ${asin}`);
          }
        }
      }
    } else if (createdListing && successfulAttempt) {
      attemptedWritePayload = {
        inventory_row_id: null,
        asin,
        sku,
        title: createdListing.title || asin,
        available: chosenLiveStock.available,
        reserved: chosenLiveStock.reserved,
        inbound: chosenLiveStock.inbound,
        listing_status: newListingStatus,
        source: 'live_api',
      };
      // Contract A: inventory.cost = UNIT cost, inventory.amount = UNIT * stock qty.
      // We MUST NOT copy createdListing.cost (TOTAL batch cost) raw into
      // inventory.cost. Use the shared helper so the conversion stays in one place.
      const { cost: invUnitCost, amount: invTotalValue } = listingToInventoryCost(
        createdListing,
        chosenLiveStock.available || 0,
      );
      const { data: insertedRow, error: insertError } = await supabase
        .from('inventory')
        .insert({
          user_id: resolvedUserId,
          asin,
          sku,
          title: createdListing.title || asin,
          image_url: createdListing.image_url,
          price: createdListing.price,
          cost: invUnitCost,
          amount: invTotalValue,
          units: chosenLiveStock.available || 0,
          supplier_links: createdListing.supplier_links,
          available: chosenLiveStock.available,
          reserved: chosenLiveStock.reserved,
          inbound: chosenLiveStock.inbound,
          inbound_working: chosenLiveStock.inbound_working ?? 0,
          inbound_receiving: chosenLiveStock.inbound_receiving ?? 0,
          inbound_shipped: chosenLiveStock.inbound_shipped ?? 0,
          listing_status: newListingStatus,
          source: 'live_api',
          last_inventory_sync_at: new Date().toISOString(),
          last_summaries_at: new Date().toISOString(),
        })
        .select('available, reserved, inbound, listing_status')
        .single();

      if (insertError) {
        console.error(`[RESCUE] DB insert failed:`, insertError);
        skippedUpdateReason = `insert_failed:${insertError.message}`;
      } else {
        dbWriteSucceeded = true;
        updatedDb = insertedRow;
      }
    }

    // Persist FNSKU discovered from Summaries API so the UI (Label Printing,
    // Shipment Builder) can find it without re-syncing.
    const discoveredFnsku = successfulAttempt?.matched_summary_identity?.fnsku || null;
    if (discoveredFnsku && /^X[A-Z0-9]{9}$/i.test(discoveredFnsku.trim())) {
      const normalizedFnsku = discoveredFnsku.trim().toUpperCase();
      try {
        await supabase
          .from('inventory')
          .update({ fnsku: normalizedFnsku })
          .eq('user_id', resolvedUserId)
          .eq('asin', asin)
          .eq('sku', sku);

        const successMarketplaceId = successfulAttempt?.marketplace_id
          || successfulAttempt?.authorization_marketplace_id
          || null;
        const sellerIdRow = activeAuthRows.find(
          (row) => row.marketplace_id === successMarketplaceId,
        ) as any;
        const sellerId = sellerIdRow?.seller_id || sellerIdRow?.selling_partner_id || null;

        if (successMarketplaceId) {
          const conflictCols = sellerId
            ? 'seller_id,marketplace_id,seller_sku'
            : 'marketplace_id,seller_sku';
          await supabase
            .from('fnsku_map')
            .upsert(
              {
                seller_id: sellerId || 'unknown',
                marketplace_id: successMarketplaceId,
                asin,
                seller_sku: sku,
                fnsku: normalizedFnsku,
                condition: successfulAttempt?.matched_summary_identity?.condition?.toUpperCase().includes('NEW')
                  ? 'NEW'
                  : (successfulAttempt?.matched_summary_identity?.condition || 'NEW'),
                updated_at: new Date().toISOString(),
              },
              { onConflict: conflictCols },
            );
        }
      } catch (fnskuErr: any) {
        console.warn(`[RESCUE] FNSKU persistence failed for ${asin}/${sku}:`, fnskuErr?.message || fnskuErr);
      }
    }

    if (currentDb || updatedDb) {
      const { data: refreshedDb } = await supabase
        .from('inventory')
        .select('id, asin, sku, title, available, reserved, inbound, listing_status, source, updated_at, last_inventory_sync_at')
        .eq('user_id', resolvedUserId)
        .eq('asin', asin)
        .eq('sku', sku)
        .maybeSingle();
      postWriteDb = refreshedDb || postWriteDb;
    }

    const changed = !!previousDb && !!updatedDb && (
      (updatedDb.available || 0) !== (previousDb.available || 0) ||
      (updatedDb.reserved || 0) !== (previousDb.reserved || 0) ||
      (updatedDb.inbound || 0) !== (previousDb.inbound || 0) ||
      (updatedDb.listing_status || 'UNKNOWN') !== (previousDb.listing_status || 'UNKNOWN')
    );

    let verificationStatus: VerificationStatus = 'verified_unchanged';
    let verificationReason: string | null = null;

    if (!successfulAttempt) {
      verificationStatus = receivedEmptyResponse ? 'unresolved_no_summary' : 'unresolved_wrong_marketplace';
      verificationReason = receivedEmptyResponse ? 'no_summary' : 'wrong_marketplace';
    } else if (suspiciousZero) {
      verificationStatus = 'suspicious_zero_blocked';
      verificationReason = 'suspicious_zero_block';
    } else if (changed || (!previousDb && !!updatedDb)) {
      verificationStatus = 'corrected';
    }

    const verificationTrace = {
      asin,
      sku,
      listing_marketplace: listingMarketplace,
      inventory_source_marketplace: inventorySourceMarketplace,
      first_marketplace_attempted: attemptDetails[0]?.marketplace || null,
      marketplaces_attempted: attemptDetails.map((attempt) => attempt.marketplace),
      fallback_used: fallbackUsed,
      marketplace_succeeded: successfulAttempt?.marketplace || null,
      marketplace_id_used: successfulAttempt?.marketplace_id || null,
      summary_count: successfulAttempt?.raw_summaries_count || 0,
      exact_seller_sku_match: !!successfulAttempt?.exact_seller_sku_match,
      matched_summary_identity: successfulAttempt?.matched_summary_identity || null,
      inbound_components: successfulAttempt?.inbound_components || null,
      raw_summary_excerpt: successfulAttempt?.raw_summary_excerpt || null,
      inbound_override_applied: inboundOverrideApplied,
      final_status: verificationStatus,
      before_db_quantities: previousDb,
      after_db_quantities: updatedDb,
      inventory_row_id: currentDb?.id || postWriteDb?.id || null,
      attempted_write_payload: attemptedWritePayload,
      db_write_succeeded: dbWriteSucceeded,
      post_write_db: postWriteDb,
    };

    const result = {
      asin,
      sku,
      marketplace: successfulAttempt?.marketplace || primaryMarketplace,
      requested_marketplace: requestedMarketplace,
      listing_marketplace: listingMarketplace,
      inventory_source_marketplace: inventorySourceMarketplace,
      marketplaces_attempted: attemptDetails.map((attempt) => attempt.marketplace),
      marketplace_succeeded: successfulAttempt?.marketplace || null,
      fallback_used: fallbackUsed,
      resolved_marketplace_id: successfulAttempt?.marketplace_id || null,
      authorization_marketplace_id: successfulAttempt?.authorization_marketplace_id || null,
      report_stock: 0,
      live_stock: chosenLiveStock,
      suspicious_zero_blocked: suspiciousZero,
      skipped_update_reason: skippedUpdateReason,
      previous_db: previousDb,
      updated_db: updatedDb,
      had_existing_record: !!currentDb,
      raw_summaries_count: successfulAttempt?.raw_summaries_count || 0,
      matched_summaries_count: successfulAttempt?.matched_summaries_count || 0,
      exact_seller_sku_match: !!successfulAttempt?.exact_seller_sku_match,
      matched_summary_identity: successfulAttempt?.matched_summary_identity || null,
      raw_quantities: successfulAttempt?.raw_quantities || null,
      inbound_components: successfulAttempt?.inbound_components || null,
      raw_summary_excerpt: successfulAttempt?.raw_summary_excerpt || null,
      inbound_override_applied: inboundOverrideApplied,
      verification_status: verificationStatus,
      verification_reason: verificationReason,
      first_marketplace_attempted: verificationTrace.first_marketplace_attempted,
      summary_count: verificationTrace.summary_count,
      final_status: verificationTrace.final_status,
      before_db_quantities: verificationTrace.before_db_quantities,
      after_db_quantities: verificationTrace.after_db_quantities,
      inventory_row_id: verificationTrace.inventory_row_id,
      attempted_write_payload: verificationTrace.attempted_write_payload,
      db_write_succeeded: verificationTrace.db_write_succeeded,
      post_write_db: verificationTrace.post_write_db,
      verification_trace: verificationTrace,
      attempt_details: attemptDetails,
    };

    console.log(`[RESCUE_TRACE] ${JSON.stringify(verificationTrace)}`);
    console.log(`[RESCUE] Result:`, JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error(`[RESCUE] Error:`, (err as Error).message, err.stack);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
