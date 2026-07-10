import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface UpdatePriceRequest {
  inventoryId?: string;
  asin?: string;
  sku?: string;
  newPrice?: number;
  newMinPrice?: number;  // If provided, also update min_price on Amazon
  newMaxPrice?: number;  // If provided, also update max_price on Amazon
  marketplace?: string;
  updateMinMaxOnly?: boolean;  // If true, only update min/max, not the listing price
  // Internal service call fields
  internal?: boolean;
  user_id?: string;
  fromScheduler?: boolean;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: UpdatePriceRequest = await req.json();
    console.log('Update Amazon price request:', body);

    // Support both JWT auth and internal service calls
    let userId: string;
    const authHeader = req.headers.get('Authorization');
    
    if (body.internal && body.user_id) {
      // Internal service call from scheduler
      console.log('[update-amazon-price] Internal service call for user', body.user_id);
      userId = body.user_id;
    } else if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: userError } = await supabase.auth.getUser(token);
      if (userError || !user) {
        throw new Error('Unauthorized');
      }
      userId = user.id;
    } else {
      throw new Error('Unauthorized');
    }

    // Load inventory item - support both inventoryId and asin/sku lookup.
    // For FBM-only listings there is no inventory row — fall back to
    // created_listings + repricer_assignments so the SP-API call can still proceed.
    let item: any = null;
    let inventoryId: string | null = null;
    const requestedMarketplaceForLookup = (body.marketplace || 'US').toUpperCase();

    async function fbmFallback(asin: string, sku?: string) {
      // Prefer the assignment row (authoritative SKU after reconciliation)
      let asgnQuery = supabase
        .from('repricer_assignments')
        .select('*')
        .eq('user_id', userId)
        .eq('asin', asin)
        .eq('marketplace', requestedMarketplaceForLookup);
      if (sku) asgnQuery = asgnQuery.eq('sku', sku);
      const { data: asgn } = await asgnQuery.maybeSingle();
      const resolvedSku = asgn?.sku || sku;
      if (!resolvedSku) return null;

      const { data: cl } = await supabase
        // Phase 2: shared source-of-truth view (validation gate + ghost filter) —
        // never push prices for PENDING / FAILED / ARCHIVED listings.
        .from('active_created_listings')
        .select('*')
        .eq('user_id', userId)
        .eq('asin', asin)
        .eq('sku', resolvedSku)
        .maybeSingle();

      return {
        id: null,
        user_id: userId,
        asin,
        sku: resolvedSku,
        my_price: cl?.price ?? asgn?.last_applied_price ?? null,
        price: cl?.price ?? null,
        min_price: asgn?.min_price_override ?? null,
        max_price: asgn?.max_price_override ?? null,
        _fbm_fallback: true,
      };
    }

    if (body.inventoryId) {
      const { data, error } = await supabase
        .from('inventory')
        .select('*')
        .eq('id', body.inventoryId)
        .eq('user_id', userId)
        .single();
      
      if (error || !data) {
        throw new Error('Inventory item not found or you do not have permission');
      }
      item = data;
      inventoryId = body.inventoryId;
    } else if (body.asin && body.sku) {
      const { data } = await supabase
        .from('inventory')
        .select('*')
        .eq('asin', body.asin)
        .eq('sku', body.sku)
        .eq('user_id', userId)
        .maybeSingle();
      if (data) {
        item = data;
        inventoryId = data.id;
      } else {
        item = await fbmFallback(body.asin, body.sku);
        if (!item) throw new Error(`No inventory or FBM listing found for ASIN ${body.asin} / SKU ${body.sku}`);
        console.log('[update-amazon-price] Using FBM fallback for', body.asin, item.sku);
      }
    } else if (body.asin) {
      const { data } = await supabase
        .from('inventory')
        .select('*')
        .eq('asin', body.asin)
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();
      if (data) {
        item = data;
        inventoryId = data.id;
      } else {
        item = await fbmFallback(body.asin);
        if (!item) throw new Error(`No inventory or FBM listing found for ASIN ${body.asin}`);
        console.log('[update-amazon-price] Using FBM fallback for', body.asin, item.sku);
      }
    } else {
      throw new Error('Either inventoryId or asin+sku must be provided');
    }

    // Determine what we're updating
    const updateMinMaxOnly = body.updateMinMaxOnly === true;
    const hasMinMaxUpdate = body.newMinPrice !== undefined || body.newMaxPrice !== undefined;
    
    // Use newPrice from request if provided, otherwise use item.my_price
    const priceToSet = body.newPrice ?? item.my_price;

    // Determine marketplace early for min/max logic
    const requestedMarketplaceEarly = body.marketplace || 'US';
    const isUSEarly = requestedMarketplaceEarly === 'US';

    // If only updating min/max, we don't need a price
    if (!updateMinMaxOnly) {
      // Validate price is set
      if (priceToSet === null || priceToSet === undefined) {
        throw new Error('Set My Price first before updating on Amazon');
      }

      // Get effective min/max prices
      // CRITICAL: Only use inventory min/max for US marketplace
      // For non-US, inventory min/max are US-specific values and must NOT be used as defaults
      let effectiveMinPrice = body.newMinPrice ?? (isUSEarly ? item.min_price : null);
      let effectiveMaxPrice = body.newMaxPrice ?? (isUSEarly ? item.max_price : null);
      
      // If the new price is below current min_price and we have newMinPrice, use that
      if (body.newMinPrice !== undefined) {
        effectiveMinPrice = body.newMinPrice;
      }

      // Validate priceToSet is within min/max if they're set (after any auto-adjustments)
      if (
        effectiveMinPrice !== null && effectiveMinPrice !== undefined &&
        effectiveMaxPrice !== null && effectiveMaxPrice !== undefined
      ) {
        if (priceToSet < effectiveMinPrice || priceToSet > effectiveMaxPrice) {
          throw new Error(`Price ($${priceToSet}) must be between Min ($${effectiveMinPrice}) and Max ($${effectiveMaxPrice})`);
        }
      }
    }

    // Get all seller authorizations for this user (multi-marketplace)
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', userId);

    // Strict marketplace matching — with seller_id cross-account fallback
    const marketplaceIdMap: Record<string, string> = {
      'US': 'ATVPDKIKX0DER',
      'CA': 'A2EUQ1WTGCTBG2',
      'MX': 'A1AM78C64UM0Y8',
      'BR': 'A2Q3Y263D00KWC',
    };
    const requestedMarketplace = body.marketplace || 'US';
    const requestedMarketplaceId = marketplaceIdMap[requestedMarketplace] || 'ATVPDKIKX0DER';
    
    if (authError) {
      throw new Error('Amazon seller account not connected. Please connect your account first.');
    }
    
    let sellerAuth = authRows?.find(a => a.marketplace_id === requestedMarketplaceId);
    
    // Cross-account fallback: if user has authorizations for the same seller_id
    // but not for this specific marketplace, look for any auth with the same seller_id
    if (!sellerAuth && authRows && authRows.length > 0) {
      const sellerId = authRows[0].seller_id;
      console.log(`[update-amazon-price] No direct ${requestedMarketplace} auth for user ${userId}, trying seller_id fallback (${sellerId})`);
      
      const { data: fallbackAuth } = await supabase
        .from('seller_authorizations')
        .select('*')
        .eq('seller_id', sellerId)
        .eq('marketplace_id', requestedMarketplaceId)
        .limit(1)
        .maybeSingle();
      
      if (fallbackAuth) {
        console.log(`[update-amazon-price] Found ${requestedMarketplace} auth via seller_id fallback from user ${fallbackAuth.user_id}`);
        sellerAuth = fallbackAuth;
      }
    }
    
    if (!sellerAuth) {
      throw new Error(`No Amazon authorization found for marketplace ${requestedMarketplace} (${requestedMarketplaceId}). Cannot fall back to another marketplace for safety.`);
    }
    
    // Safety check: verify the auth we found actually matches what we requested
    if (sellerAuth.marketplace_id !== requestedMarketplaceId) {
      throw new Error(`Auth marketplace mismatch: expected ${requestedMarketplaceId} but got ${sellerAuth.marketplace_id}. Refusing to send price update.`);
    }

    // Update status to pending (skip when no inventory row exists — FBM fallback)
    if (inventoryId) {
      await supabase
        .from('inventory')
        .update({
          last_price_update_status: 'pending',
          last_price_update_at: new Date().toISOString(),
        })
        .eq('id', inventoryId);
    }

    // Get fresh access token
    const accessToken = await getAccessToken(sellerAuth.refresh_token, supabase, userId);
    console.log('Got access token for price update');

    // SKU mismatch guard — verify the SKU we're about to submit actually exists
    // on Amazon for this seller. Prevents wasted PATCH calls + 404 spam from
    // synthetic SKUs minted by the listing tool that were never published.
    try {
      const exists = await verifySkuOnAmazon({
        accessToken,
        sellerId: sellerAuth.seller_id,
        marketplaceId: sellerAuth.marketplace_id,
        sku: item.sku,
      });
      if (!exists) {
        const msg = `SKU "${item.sku}" not found on Amazon for ASIN ${item.asin} in marketplace ${requestedMarketplace}. Run "Reconcile SKU" to map to the live Amazon SKU.`;
        // Mark assignment so UI can surface the issue
        await supabase
          .from('repricer_assignments')
          .update({
            sku_validation_status: 'sku_mismatch',
            sku_validation_checked_at: new Date().toISOString(),
            sku_validation_message: msg,
            apply_error: msg,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('asin', item.asin)
          .eq('sku', item.sku)
          .eq('marketplace', requestedMarketplace);
        if (inventoryId) {
          await supabase
            .from('inventory')
            .update({ last_price_update_status: 'failed' })
            .eq('id', inventoryId);
        }
        throw new Error(msg);
      }
    } catch (vErr: any) {
      // If verification itself failed (network, 5xx), log and proceed — don't block legit updates
      if (String(vErr?.message || '').startsWith('SKU "')) throw vErr;
      console.warn('[update-amazon-price] SKU verify skipped (verifier error):', vErr?.message || vErr);
    }

    // Prepare update parameters
    const updateParams = {
      sku: item.sku,
      price: updateMinMaxOnly ? null : priceToSet,
      minPrice: body.newMinPrice,
      maxPrice: body.newMaxPrice,
      accessToken,
      marketplaceId: sellerAuth.marketplace_id,
      sellerId: sellerAuth.seller_id,
    };

    // Update price and/or min/max via SP-API Listings Items API
    const priceUpdateResult = await updatePriceViaSPAPI(updateParams);

    console.log('Price update response:', priceUpdateResult);

    // Build inventory update object — only write price fields for US marketplace
    // to prevent non-US price updates from contaminating the US inventory record
    const isUS = requestedMarketplace === 'US';
    
    const inventoryUpdate: Record<string, any> = {
      last_price_update_status: 'success',
    };
    
    if (isUS) {
      if (!updateMinMaxOnly && priceToSet !== null) {
        inventoryUpdate.amazon_price = priceToSet;
        inventoryUpdate.my_price = priceToSet;
      }
      
      if (body.newMinPrice !== undefined) {
        inventoryUpdate.min_price = body.newMinPrice;
      }
      
      if (body.newMaxPrice !== undefined) {
        inventoryUpdate.max_price = body.newMaxPrice;
      }
    }

    // On success, update status in our database (only if inventory row exists)
    if (inventoryId) {
      await supabase
        .from('inventory')
        .update(inventoryUpdate)
        .eq('id', inventoryId);
    }

    // For non-US marketplaces, update the marketplace-specific price cache instead
    if (!isUS && !updateMinMaxOnly && priceToSet !== null) {
      await supabase
        .from('asin_my_price_cache')
        .upsert({
          user_id: userId,
          asin: item.asin,
          seller_sku: item.sku,
          marketplace_id: requestedMarketplaceId,
          my_price: priceToSet,
          fetched_at: new Date().toISOString(),
          source: 'manual_update',
        }, { onConflict: 'user_id,asin,marketplace_id,seller_sku' });
    }

    // Keep the repricer assignment row aligned to the exact SKU that was updated.
    // SKU identity is authoritative for split New/Used sibling listings.
    if (item.asin && item.sku) {
      const skuValue = String(item.sku || '');
      const assignmentPatch: Record<string, any> = {
        item_condition: skuValue.startsWith('amzn.gr.') || skuValue.toLowerCase().startsWith('used_') ? 'Used' : 'New',
        updated_at: new Date().toISOString(),
      };
      if (body.newMinPrice !== undefined) assignmentPatch.min_price_override = body.newMinPrice;
      if (body.newMaxPrice !== undefined) assignmentPatch.max_price_override = body.newMaxPrice;
      if (!updateMinMaxOnly && priceToSet !== null) {
        assignmentPatch.last_applied_price = priceToSet;
        assignmentPatch.last_applied_at = new Date().toISOString();
      }

      const { error: assignmentUpdateError } = await supabase
        .from('repricer_assignments')
        .update(assignmentPatch)
        .eq('user_id', userId)
        .eq('asin', item.asin)
        .eq('sku', item.sku)
        .eq('marketplace', requestedMarketplace);

      if (assignmentUpdateError) {
        console.warn('[update-amazon-price] Assignment sync failed:', assignmentUpdateError.message);
      }
    }

    // Log to audit trail (repricer_price_actions) if this was a direct manual call
    // Scheduler already logs its own actions, but manual UI updates should be logged too
    if (!body.fromScheduler) {
      // For non-US marketplaces, don't log US min/max or US price as old values
      const oldMinPrice = isUS ? item.min_price : null;
      const oldMaxPrice = isUS ? item.max_price : null;
      
      // For non-US, fetch old price from marketplace-specific cache instead of US inventory
      let oldPrice = item.my_price || item.price;
      if (!isUS) {
        const { data: cachedPrice } = await supabase
          .from('asin_my_price_cache')
          .select('my_price')
          .eq('user_id', userId)
          .eq('asin', item.asin)
          .eq('marketplace_id', requestedMarketplaceId)
          .maybeSingle();
        oldPrice = cachedPrice?.my_price ?? null;
      }
      
      await supabase.from('repricer_price_actions').insert({
        user_id: userId,
        asin: item.asin,
        sku: item.sku,
        marketplace: body.marketplace || 'US',
        old_price: oldPrice,
        new_price: updateMinMaxOnly ? null : priceToSet,
        old_min_price: oldMinPrice,
        new_min_price: body.newMinPrice,
        old_max_price: oldMaxPrice,
        new_max_price: body.newMaxPrice,
        action_type: updateMinMaxOnly ? 'minmax_change' : (hasMinMaxUpdate ? 'price_and_minmax_change' : 'price_change'),
        trigger_source: updateMinMaxOnly ? 'rule_change' : 'manual',
        reason: updateMinMaxOnly ? 'MIN/MAX bounds updated from UI' : 'Manual price update from UI',
        success: true,
        amazon_response: priceUpdateResult
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: updateMinMaxOnly ? 'Min/Max prices updated on Amazon successfully' : 'Price updated on Amazon successfully',
        newPrice: updateMinMaxOnly ? null : priceToSet,
        newMinPrice: body.newMinPrice,
        newMaxPrice: body.newMaxPrice,
        amazonStatus: priceUpdateResult?.status ?? null,
        submissionId: priceUpdateResult?.submissionId ?? null,
        amazonIssues: Array.isArray(priceUpdateResult?.issues) ? priceUpdateResult.issues : [],
        amazonResponse: priceUpdateResult,
        lastUpdateAt: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Update Amazon price error:', error);

    // Classify the error for better UI feedback
    const errorInfo = classifyAmazonError((error as Error).message || '');
    try {
      if (typeof userId !== 'undefined' && userId) {
        HealthSignals.amazonPriceUpdateFailed(userId, 'update-amazon-price', (body as any)?.asin, (error as Error)?.message?.slice(0, 500) || 'unknown');
      }
    } catch (_) {}

    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message || 'Failed to update price on Amazon',
        errorType: errorInfo.type,
        errorCode: errorInfo.code,
        amazonMinFromApi: errorInfo.amazonMin,
        amazonMaxFromApi: errorInfo.amazonMax,
        isRecoverable: errorInfo.isRecoverable,
        suggestedAction: errorInfo.suggestedAction,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});

import { exchangeLwaToken } from '../_shared/lwa-token.ts';
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";
async function getAccessToken(refreshToken: string, supabase?: any, userId?: string | null): Promise<string> {
  return await exchangeLwaToken(refreshToken, supabase, userId);
}

async function updatePriceViaSPAPI(params: {
  sku: string;
  price: number | null;
  minPrice?: number;
  maxPrice?: number;
  accessToken: string;
  marketplaceId: string;
  sellerId: string;
}): Promise<any> {
  const { sku, price, minPrice, maxPrice, accessToken, marketplaceId, sellerId } = params;

  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error('AWS credentials not configured');
  }

  // Build patches array based on what needs to be updated
  const patches: any[] = [];
  
  // Determine correct currency based on marketplace
  const currencyMap: Record<string, string> = {
    'ATVPDKIKX0DER': 'USD',  // US
    'A2EUQ1WTGCTBG2': 'CAD', // CA
    'A1AM78C64UM0Y8': 'MXN', // MX
    'A2Q3Y263D00KWC': 'BRL', // BR
  };
  const currency = currencyMap[marketplaceId] || 'USD';
  
  // Build the purchasable_offer value with all pricing info
  const purchasableOfferValue: any = {
    marketplace_id: marketplaceId,
    currency: currency,
  };

  // Add our_price (listing price) if provided
  if (price !== null && price !== undefined) {
    purchasableOfferValue.our_price = [{
      schedule: [{
        value_with_tax: price
      }]
    }];
  }
  
  // Add minimum_seller_allowed_price if provided
  if (minPrice !== undefined) {
    purchasableOfferValue.minimum_seller_allowed_price = [{
      schedule: [{
        value_with_tax: minPrice
      }]
    }];
  }
  
  // Add maximum_seller_allowed_price if provided
  if (maxPrice !== undefined) {
    purchasableOfferValue.maximum_seller_allowed_price = [{
      schedule: [{
        value_with_tax: maxPrice
      }]
    }];
  }
  
  patches.push({
    op: 'replace',
    path: '/attributes/purchasable_offer',
    value: [purchasableOfferValue]
  });

  const requestBody = {
    productType: 'PRODUCT',
    patches
  };

  const endpoint = `https://sellingpartnerapi-na.amazon.com`;
  const path = `/listings/2021-08-01/items/${sellerId}/${sku}`;
  const queryParams = `marketplaceIds=${marketplaceId}&issueLocale=en_US`;
  const url = `${endpoint}${path}?${queryParams}`;
  const host = 'sellingpartnerapi-na.amazon.com';
  const method = 'PATCH';
  const service = 'execute-api';
  const bodyString = JSON.stringify(requestBody);

  // Create canonical request
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  // Hash the payload
  const encoder = new TextEncoder();
  const payloadHash = await crypto.subtle.digest('SHA-256', encoder.encode(bodyString));
  const payloadHashHex = Array.from(new Uint8Array(payloadHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;

  // Create string to sign
  const canonicalRequestHash = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHashHex}`;

  // Calculate signature
  const getSignatureKey = async (key: string, dateStamp: string, regionName: string, serviceName: string) => {
    const kDate = await hmacSha256(encoder.encode('AWS4' + key), encoder.encode(dateStamp));
    const kRegion = await hmacSha256(kDate, encoder.encode(regionName));
    const kService = await hmacSha256(kRegion, encoder.encode(serviceName));
    const kSigning = await hmacSha256(kService, encoder.encode('aws4_request'));
    return kSigning;
  };

  const hmacSha256 = async (key: ArrayBuffer | Uint8Array, data: Uint8Array): Promise<ArrayBuffer> => {
    const cryptoKey = await crypto.subtle.importKey('raw', key as any,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return await crypto.subtle.sign('HMAC', cryptoKey, data as any);
  };

  const signingKey = await getSignatureKey(awsSecretAccessKey, date, awsRegion, service);
  const signature = await hmacSha256(signingKey, encoder.encode(stringToSign));
  const signatureHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;

  console.log('Updating price with PATCH request to:', url);
  console.log('Request body:', JSON.stringify(requestBody, null, 2));

  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': authorizationHeader,
        'x-amz-access-token': accessToken,
        'x-amz-date': timestamp,
        'host': host,
        'content-type': 'application/json',
      },
      body: bodyString,
    });

    const responseText = await response.text();
    lastStatus = response.status;
    lastBody = responseText;
    console.log(`SP-API response status (attempt ${attempt}/3):`, response.status);
    console.log('SP-API response body:', responseText);

    if (response.ok) {
      return JSON.parse(responseText);
    }

    // Retry on transient Amazon errors (500, 502, 503, 504)
    const isTransient = response.status >= 500 && response.status <= 504;
    if (isTransient && attempt < 3) {
      const delayMs = 1500 * attempt;
      console.log(`Amazon ${response.status} error, retrying in ${delayMs}ms (attempt ${attempt}/3)...`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    break;
  }

  const err = new Error(`SP-API error (${lastStatus}): ${lastBody}`);
  (err as any).statusCode = lastStatus;
  (err as any).responseBody = lastBody;
  throw err;
}

/**
 * Classify Amazon API errors for better UI feedback
 */
function classifyAmazonError(errorMessage: string): {
  type: string;
  code: string | null;
  amazonMin: number | null;
  amazonMax: number | null;
  isRecoverable: boolean;
  suggestedAction: string;
} {
  const lowerMsg = errorMessage.toLowerCase();
  
  // Rate limit (429)
  if (lowerMsg.includes('429') || lowerMsg.includes('too many requests') || lowerMsg.includes('rate limit') || lowerMsg.includes('throttl')) {
    return {
      type: 'rate_limit',
      code: '429',
      amazonMin: null,
      amazonMax: null,
      isRecoverable: true,
      suggestedAction: 'Wait a few minutes and try again. The scheduler will auto-resume.',
    };
  }
  
  // Auth expired (401/403)
  if (lowerMsg.includes('401') || lowerMsg.includes('403') || lowerMsg.includes('unauthorized') || lowerMsg.includes('forbidden') || lowerMsg.includes('access denied')) {
    return {
      type: 'auth_expired',
      code: '401',
      amazonMin: null,
      amazonMax: null,
      isRecoverable: false,
      suggestedAction: 'Your Amazon authorization has expired. Please reconnect your account.',
    };
  }
  
  // Min/Max mismatch - extract bounds if possible
  // Example: "Price ($13.06) must be between Min ($29.00) and Max ($50.00)"
  const minMaxMatch = errorMessage.match(/between\s+(?:Min\s+)?\(\$?([\d.]+)\)\s+and\s+(?:Max\s+)?\(\$?([\d.]+)\)/i);
  if (minMaxMatch || lowerMsg.includes('minimum_seller_allowed_price') || lowerMsg.includes('maximum_seller_allowed_price') || lowerMsg.includes('must be between')) {
    return {
      type: 'min_max_mismatch',
      code: '400',
      amazonMin: minMaxMatch ? parseFloat(minMaxMatch[1]) : null,
      amazonMax: minMaxMatch ? parseFloat(minMaxMatch[2]) : null,
      isRecoverable: true,
      suggestedAction: 'Amazon\'s min/max bounds differ from local settings. Click "Sync from Amazon" to fix.',
    };
  }
  
  // Fair Pricing Policy violation
  if (lowerMsg.includes('fair pricing') || lowerMsg.includes('pricing policy') || lowerMsg.includes('potential_pricing_error')) {
    return {
      type: 'fair_pricing_violation',
      code: '400',
      amazonMin: null,
      amazonMax: null,
      isRecoverable: true,
      suggestedAction: 'Price may trigger Amazon\'s Fair Pricing Policy. Lower Max Price or use Reset to Safe Target.',
    };
  }
  
  // Listing suppressed/inactive
  if (lowerMsg.includes('listing_inactive') || lowerMsg.includes('suppressed') || lowerMsg.includes('product_not_found')) {
    return {
      type: 'listing_suppressed',
      code: '400',
      amazonMin: null,
      amazonMax: null,
      isRecoverable: false,
      suggestedAction: 'This listing is inactive or suppressed on Amazon. Check Seller Central for issues.',
    };
  }
  
  // Generic price rejected
  if (lowerMsg.includes('400') || lowerMsg.includes('invalid') || lowerMsg.includes('rejected')) {
    return {
      type: 'price_rejected',
      code: '400',
      amazonMin: null,
      amazonMax: null,
      isRecoverable: true,
      suggestedAction: 'Amazon rejected the price update. Check the listing in Seller Central.',
    };
  }
  
  // Unknown error
  return {
    type: 'unknown',
    code: null,
    amazonMin: null,
    amazonMax: null,
    isRecoverable: false,
    suggestedAction: 'An unexpected error occurred. Check the Activity Log for details.',
  };
}

/**
 * Verify the SKU exists on Amazon for this seller before submitting a PATCH.
 * Returns true when found, false when 404. Throws on transport/5xx errors so
 * the caller can decide whether to skip verification.
 */
async function verifySkuOnAmazon(params: {
  accessToken: string;
  sellerId: string;
  marketplaceId: string;
  sku: string;
}): Promise<boolean> {
  const { accessToken, sellerId, marketplaceId, sku } = params;
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  if (!awsAccessKeyId || !awsSecretAccessKey) throw new Error('AWS creds missing');

  const host = 'sellingpartnerapi-na.amazon.com';
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
  const queryParams = `marketplaceIds=${marketplaceId}&includedData=summaries`;
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const payloadHashHex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const canonicalRequest = `GET\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;
  const enc = new TextEncoder();
  const crHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(canonicalRequest))))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const credentialScope = `${date}/${awsRegion}/execute-api/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${crHash}`;
  const hmac = async (key: ArrayBuffer | Uint8Array, data: Uint8Array) => {
    const k = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return await crypto.subtle.sign('HMAC', k, data as any);
  };
  const kDate = await hmac(enc.encode('AWS4' + awsSecretAccessKey), enc.encode(date));
  const kRegion = await hmac(kDate, enc.encode(awsRegion));
  const kService = await hmac(kRegion, enc.encode('execute-api'));
  const kSigning = await hmac(kService, enc.encode('aws4_request'));
  const sig = Array.from(new Uint8Array(await hmac(kSigning, enc.encode(stringToSign))))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const auth = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  const res = await fetch(`https://${host}${path}?${queryParams}`, {
    method: 'GET',
    headers: { Authorization: auth, 'x-amz-access-token': accessToken, 'x-amz-date': timestamp, host },
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  // Some sellers see 403 on items they don't own — treat as "not theirs" → false
  if (res.status === 403) return false;
  // 4xx other → unknown, don't block
  if (res.status >= 400 && res.status < 500) {
    console.warn('[verifySkuOnAmazon] unexpected status', res.status, (await res.text()).slice(0, 200));
    throw new Error(`verify status ${res.status}`);
  }
  throw new Error(`verify status ${res.status}`);
}
