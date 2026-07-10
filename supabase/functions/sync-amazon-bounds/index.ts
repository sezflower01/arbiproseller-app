import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkModuleAccess } from '../_shared/module-access-guard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Sync Amazon Min/Max Bounds
 * 
 * Fetches the current minimum_seller_allowed_price and maximum_seller_allowed_price
 * from Amazon's Listings Items API and updates the local repricer_assignments table.
 * 
 * This is critical for production because:
 * 1. Amazon can change bounds outside our system (manually in Seller Central)
 * 2. Stale local bounds cause repeated pricing failures
 * 3. Users need a one-click fix when "min/max mismatch" errors occur
 */

interface SyncBoundsRequest {
  asin?: string;
  sku?: string;
  marketplace?: string;
  assignmentId?: string;
  // Internal service call fields
  internal?: boolean;
  user_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: SyncBoundsRequest = await req.json();
    console.log('[sync-amazon-bounds] Request:', body);

    // Auth
    let userId: string;
    const authHeader = req.headers.get('Authorization');
    
    let isInternalCall = false;
    if (body.internal && body.user_id) {
      userId = body.user_id;
      isInternalCall = true;
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

    // MODULE ACCESS GUARD: writes assignment min/max bounds = repricer:edit (skip on internal cron path)
    if (!isInternalCall) {
      const access = await checkModuleAccess(supabase, userId, 'repricer', 'edit');
      if (!access.allowed) {
        console.warn(`[sync-amazon-bounds] MODULE BLOCKED user=${userId} reason=${access.reason}`);
        return new Response(
          JSON.stringify({ success: false, error: access.reason }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    // Get assignment to sync
    let assignment: any = null;
    
    if (body.assignmentId) {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('*')
        .eq('id', body.assignmentId)
        .eq('user_id', userId)
        .single();
      
      if (error || !data) {
        throw new Error('Assignment not found');
      }
      assignment = data;
    } else if (body.sku && body.marketplace) {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('*')
        .eq('user_id', userId)
        .eq('sku', body.sku)
        .eq('marketplace', body.marketplace || 'US')
        .single();
      
      if (error || !data) {
        throw new Error(`Assignment not found for SKU ${body.sku}`);
      }
      assignment = data;
    } else {
      throw new Error('Either assignmentId or sku+marketplace must be provided');
    }

    // Get seller authorization for this marketplace
    const marketplaceIdMap: Record<string, string> = {
      'US': 'ATVPDKIKX0DER',
      'CA': 'A2EUQ1WTGCTBG2',
      'MX': 'A1AM78C64UM0Y8',
      'BR': 'A2Q3Y263D00KWC',
    };
    
    const requestedMarketplaceId = marketplaceIdMap[assignment.marketplace] || 'ATVPDKIKX0DER';
    
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', userId);

    const sellerAuth = authRows?.find(a => a.marketplace_id === requestedMarketplaceId) ||
                       authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || 
                       authRows?.[0];
                       
    if (authError || !sellerAuth) {
      throw new Error('Amazon seller account not connected');
    }

    // Get fresh access token
    const accessToken = await getAccessToken(sellerAuth.refresh_token);
    console.log('[sync-amazon-bounds] Got access token');

    // Fetch listing details from Amazon Listings Items API
    const listingData = await fetchListingFromAmazon({
      sku: assignment.sku,
      accessToken,
      marketplaceId: sellerAuth.marketplace_id,
      sellerId: sellerAuth.seller_id,
    });

    console.log('[sync-amazon-bounds] Listing data:', JSON.stringify(listingData, null, 2));

    // Extract min/max prices from listing
    const purchasableOffer = listingData?.attributes?.purchasable_offer?.[0];
    
    let amazonMinPrice: number | null = null;
    let amazonMaxPrice: number | null = null;
    let currentPrice: number | null = null;

    if (purchasableOffer) {
      // Extract minimum_seller_allowed_price
      const minPriceData = purchasableOffer.minimum_seller_allowed_price?.[0]?.schedule?.[0];
      if (minPriceData?.value_with_tax !== undefined) {
        amazonMinPrice = minPriceData.value_with_tax;
      }

      // Extract maximum_seller_allowed_price
      const maxPriceData = purchasableOffer.maximum_seller_allowed_price?.[0]?.schedule?.[0];
      if (maxPriceData?.value_with_tax !== undefined) {
        amazonMaxPrice = maxPriceData.value_with_tax;
      }

      // Extract current listing price
      const priceData = purchasableOffer.our_price?.[0]?.schedule?.[0];
      if (priceData?.value_with_tax !== undefined) {
        currentPrice = priceData.value_with_tax;
      }
    }

    console.log(`[sync-amazon-bounds] Parsed: price=$${currentPrice}, min=$${amazonMinPrice}, max=$${amazonMaxPrice}`);

    // Update assignment with Amazon's bounds
    const updatePayload: any = {
      amazon_min_price: amazonMinPrice,
      amazon_max_price: amazonMaxPrice,
      amazon_bounds_synced_at: new Date().toISOString(),
      // Clear error state if this was a recovery action
      status: 'active',
      last_error_type: null,
      last_error_message: null,
      consecutive_failures: 0,
    };

    // Refresh Amazon-reported bounds without mutating user-set local overrides.
    // This prevents Amazon sync from silently replacing manual/effective floors.
    if (amazonMinPrice !== null) {
      updatePayload.last_min_price_on_amazon = amazonMinPrice;
    }
    if (amazonMaxPrice !== null) {
      updatePayload.last_max_price_on_amazon = amazonMaxPrice;
    }

    const { error: updateError } = await supabase
      .from('repricer_assignments')
      .update(updatePayload)
      .eq('id', assignment.id);

    if (updateError) {
      console.error('[sync-amazon-bounds] Update error:', updateError);
      throw new Error('Failed to update assignment');
    }

    // Also update inventory table if we have current price
    if (currentPrice !== null) {
      await supabase
        .from('inventory')
        .update({
          my_price: currentPrice,
          amazon_price: currentPrice,
          min_price: amazonMinPrice,
          max_price: amazonMaxPrice,
        })
        .eq('user_id', userId)
        .eq('sku', assignment.sku);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Amazon bounds synced successfully',
        amazonMinPrice,
        amazonMaxPrice,
        currentPrice,
        syncedAt: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[sync-amazon-bounds] Error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message || 'Failed to sync Amazon bounds'
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});

async function getAccessToken(refreshToken: string): Promise<string> {
  const lwaClientId = Deno.env.get('LWA_CLIENT_ID');
  const lwaClientSecret = Deno.env.get('LWA_CLIENT_SECRET');

  if (!lwaClientId || !lwaClientSecret) {
    throw new Error('LWA credentials not configured');
  }

  const tokenResponse = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: lwaClientId,
      client_secret: lwaClientSecret,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error('[sync-amazon-bounds] LWA token error:', errorText);
    throw new Error('Failed to get access token');
  }

  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}

async function fetchListingFromAmazon(params: {
  sku: string;
  accessToken: string;
  marketplaceId: string;
  sellerId: string;
}): Promise<any> {
  const { sku, accessToken, marketplaceId, sellerId } = params;

  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error('AWS credentials not configured');
  }

  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const encodedSku = encodeURIComponent(sku);
  const path = `/listings/2021-08-01/items/${sellerId}/${encodedSku}`;
  const queryParams = `marketplaceIds=${marketplaceId}&issueLocale=en_US&includedData=attributes,summaries`;
  const url = `${endpoint}${path}?${queryParams}`;
  const host = 'sellingpartnerapi-na.amazon.com';
  const method = 'GET';
  const service = 'execute-api';

  // Create canonical request with AWS Signature V4
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const encoder = new TextEncoder();
  const emptyPayloadHash = await crypto.subtle.digest('SHA-256', encoder.encode(''));
  const payloadHashHex = Array.from(new Uint8Array(emptyPayloadHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;

  const canonicalRequestHash = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHashHex}`;

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

  console.log('[sync-amazon-bounds] Fetching listing from:', url);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': authorizationHeader,
      'x-amz-access-token': accessToken,
      'x-amz-date': timestamp,
      'host': host,
    },
  });

  const responseText = await response.text();
  console.log('[sync-amazon-bounds] SP-API response status:', response.status);

  if (!response.ok) {
    throw new Error(`SP-API error (${response.status}): ${responseText}`);
  }

  return JSON.parse(responseText);
}
