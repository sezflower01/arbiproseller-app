import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";
import { isInternalCaller } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AWS SigV4 signing functions
function getAwsSignature(stringToSign: string, kSigning: Uint8Array): string {
  const hmac = createHmac('sha256', kSigning as any);
  hmac.update(stringToSign);
  return hmac.digest('hex');
}

function hmacSha256(key: string | Uint8Array, data: string): Uint8Array {
  const hmac = createHmac('sha256', key as any);
  hmac.update(data);
  return new Uint8Array(hmac.digest());
}

function getSigningKey(key: string, dateStamp: string, region: string, service: string): Uint8Array {
  const kDate = hmacSha256(`AWS4${key}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return kSigning;
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('SPAPI_LWA_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('Missing LWA credentials');
  }

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
  path: string,
  accessToken: string,
  queryParams: Record<string, string> = {}
): Promise<any> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error('Missing AWS credentials');
  }

  const host = 'sellingpartnerapi-na.amazon.com';
  const service = 'execute-api';
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const queryString = new URLSearchParams(queryParams).toString();
  const canonicalUri = path;
  const canonicalQueryString = queryString;
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const canonicalRequest = `GET\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  
  const encoder = new TextEncoder();
  const data = encoder.encode(canonicalRequest);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as any);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const requestHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${requestHash}`;
  const signingKey = getSigningKey(awsSecretAccessKey, dateStamp, region, service);
  const signature = getAwsSignature(stringToSign, signingKey);

  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}${queryString ? '?' + queryString : ''}`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'host': host,
      'x-amz-date': amzDate,
      'x-amz-access-token': accessToken,
      'Authorization': authorizationHeader,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Handle rate limiting
    if (response.status === 429) {
      throw new Error('RATE_LIMITED');
    }
    throw new Error(`SP-API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

async function fetchCatalogTitle(asin: string, accessToken: string, marketplaceId: string): Promise<{ title: string | null; imageUrl: string | null }> {
  try {
    const result = await callSpApi(
      `/catalog/2022-04-01/items/${asin}`,
      accessToken,
      {
        marketplaceIds: marketplaceId,
        includedData: 'summaries,images'
      }
    );
    
    const summaries = result?.summaries || [];
    const summary = summaries.find((s: any) => s.marketplaceId === marketplaceId) || summaries[0];
    
    // Get image from images array
    const images = result?.images || [];
    const imageData = images.find((img: any) => img.marketplaceId === marketplaceId) || images[0];
    let imageUrl: string | null = null;
    
    if (imageData?.images?.length > 0) {
      // Find MAIN image variant, fallback to first image
      const mainImage = imageData.images.find((i: any) => i.variant === 'MAIN') || imageData.images[0];
      imageUrl = mainImage?.link || null;
    }
    
    return {
      title: summary?.itemName || null,
      imageUrl
    };
  } catch (error: any) {
    if ((error as Error).message === 'RATE_LIMITED') {
      throw error;
    }
    console.error(`Failed to fetch catalog for ${asin}:`, (error as Error).message);
    return { title: null, imageUrl: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Support internal service-to-service calls
    let userId: string;
    let body: any = {};
    
    try {
      body = await req.json();
    } catch {
      // No body
    }

    if (body.internal === true && body.user_id && isInternalCaller(req)) {
      userId = body.user_id;
      console.log(`[ENRICH_TITLES] Internal call for user ${userId}`);
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) {
        throw new Error('No authorization header');
      }

      const { data: { user }, error: authError } = await supabase.auth.getUser(
        authHeader.replace('Bearer ', '')
      );

      if (authError || !user) {
        throw new Error('Unauthorized');
      }
      userId = user.id;
    }

    const limit = body.limit || 50;
    // Optional: target a specific, caller-supplied ASIN list (e.g. exactly the
    // rows showing on a page right now) instead of an account-wide scan for
    // bad titles. Any state (title/image already fine or not) is eligible --
    // the caller already knows these specific rows need enrichment.
    const rawAsins: unknown[] = Array.isArray(body.asins) ? body.asins : [];
    const cleanedAsins = rawAsins.filter((a): a is string => typeof a === 'string' && a.length > 0);
    const targetAsins: string[] | null = cleanedAsins.length > 0 ? [...new Set(cleanedAsins)] : null;
    console.log(`[ENRICH_TITLES] Starting for user ${userId}, limit ${limit}, targetAsins=${targetAsins?.length ?? 'none'}`);

    // Get global refresh token
    const refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN');
    const marketplaceId = Deno.env.get('SPAPI_MARKETPLACE_ID') || 'ATVPDKIKX0DER';

    if (!refreshToken) {
      throw new Error('SPAPI_REFRESH_TOKEN not configured');
    }

    // Find inventory items to enrich: either the caller's specific ASIN list,
    // or (default, backward-compatible) items with missing/placeholder titles.
    let itemsQuery = supabase
      .from('inventory')
      .select('id, asin, sku, title, image_url')
      .eq('user_id', userId);
    itemsQuery = targetAsins
      ? itemsQuery.in('asin', targetAsins)
      // Also catches rows with a perfectly fine title but no image -- these
      // were previously invisible to this scan entirely (title-only filter),
      // which is exactly why real, cataloged ASINs could sit with a null
      // image_url indefinitely with nothing ever picking them up.
      : itemsQuery.or('title.is.null,title.eq.,title.ilike.%unknown%,title.ilike.%untitled%,image_url.is.null').limit(limit);
    const { data: missingTitleItems, error: fetchError } = await itemsQuery;

    if (fetchError) {
      throw new Error(`Failed to fetch items: ${fetchError.message}`);
    }

    if (!missingTitleItems || missingTitleItems.length === 0) {
      console.log('[ENRICH_TITLES] No items found to enrich');
      return new Response(
        JSON.stringify({ success: true, enriched: 0, message: 'No items to enrich' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[ENRICH_TITLES] Found ${missingTitleItems.length} items to enrich`);

    // Get access token
    const accessToken = await getLwaAccessToken(refreshToken);

    // Process items with rate limiting awareness
    let enrichedCount = 0;
    let skippedCount = 0;
    const rateLimitDelayMs = 200; // Delay between API calls to avoid rate limiting

    for (const item of missingTitleItems) {
      if (!item.asin || item.asin.length !== 10) {
        console.log(`[ENRICH_TITLES] Skipping invalid ASIN: ${item.asin}`);
        skippedCount++;
        continue;
      }

      try {
        const { title, imageUrl } = await fetchCatalogTitle(item.asin, accessToken, marketplaceId);

        // Title and image are independent -- a catalog lookup can return an
        // image even when title fetch/parsing comes back empty (or the item
        // already has a fine title and only the image was missing).
        const updateData: any = {};
        const needsTitle = !item.title || /unknown|untitled/i.test(item.title);
        if (title && needsTitle) updateData.title = title;
        if (imageUrl && (!item.image_url || item.image_url === '')) {
          updateData.image_url = imageUrl;
        }

        if (Object.keys(updateData).length > 0) {
          const { error: updateError } = await supabase
            .from('inventory')
            .update(updateData)
            .eq('id', item.id);

          if (updateError) {
            console.error(`[ENRICH_TITLES] Failed to update ${item.asin}:`, updateError);
          } else {
            enrichedCount++;
            console.log(`[ENRICH_TITLES] Updated ${item.asin}:`, Object.keys(updateData).join(', '));
          }
        } else {
          console.log(`[ENRICH_TITLES] No new data found for ${item.asin}`);
          skippedCount++;
        }

        // Rate limiting delay
        await new Promise(resolve => setTimeout(resolve, rateLimitDelayMs));
      } catch (error: any) {
        if ((error as Error).message === 'RATE_LIMITED') {
          console.warn('[ENRICH_TITLES] Rate limited, stopping early');
          break;
        }
        console.error(`[ENRICH_TITLES] Error for ${item.asin}:`, (error as Error).message);
        skippedCount++;
      }
    }

    console.log(`[ENRICH_TITLES] Complete: enriched ${enrichedCount}, skipped ${skippedCount}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        enriched: enrichedCount, 
        skipped: skippedCount,
        total: missingTitleItems.length 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[ENRICH_TITLES] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
