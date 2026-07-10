import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RefundRecord {
  id: string;
  order_id: string;
  asin: string;
  title: string | null;
  image_url: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Get user from auth header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`🔄 Starting refund sync for user ${user.id}`);

    // Step 1: Fetch refund records that need enrichment (skip $0 refunds - those are replacements/goodwill)
    const { data: refundsToEnrich, error: fetchError } = await supabase
      .from('sales_orders')
      .select('id, order_id, asin, title, image_url, refund_amount')
      .eq('user_id', user.id)
      .like('order_id', '%-REFUND%')
      .gt('refund_amount', 0)
      .limit(200);

    if (fetchError) {
      console.error('Error fetching refunds to enrich:', fetchError);
      throw fetchError;
    }

    console.log(`📋 Found ${refundsToEnrich?.length || 0} refunds needing enrichment`);

    if (!refundsToEnrich || refundsToEnrich.length === 0) {
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No refunds need enrichment',
        enriched: 0 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 2: Get all seller authorizations for this user (multi-marketplace)
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', user.id);

    // Prefer US marketplace, fallback to first available
    const sellerAuth = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (authError || !sellerAuth) {
      console.error('No seller authorization found');
      return new Response(JSON.stringify({ error: 'Amazon not connected' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 3: Get fresh access token
    const accessToken = await getAccessToken(sellerAuth.refresh_token);
    console.log('🔑 Got fresh access token');

    let enrichedCount = 0;

    // Step 4: For each refund needing enrichment
    for (const refund of refundsToEnrich) {
      const originalOrderId = refund.order_id.replace('-REFUND', '');
      console.log(`🔍 Enriching refund for order ${originalOrderId} (asin=${refund.asin}, hasImage=${!!refund.image_url})`);

      try {
        let asin = refund.asin;
        let title = refund.title;
        let imageUrl = refund.image_url;
        
        // Helper to validate ASIN format (10 chars, starts with B0 or all digits)
        const isValidAsin = (val: string) => {
          if (!val || val === 'UNKNOWN' || val.length !== 10) return false;
          return val.startsWith('B0') || /^\d{10}$/.test(val);
        };
        
        // Check if current asin is actually a SKU (doesn't match ASIN format)
        const needsAsinLookup = !isValidAsin(asin);
        const possibleSku = needsAsinLookup ? asin : null;
        
        console.log(`🔍 Checking ${refund.order_id}: asin=${asin}, isValidAsin=${!needsAsinLookup}, possibleSku=${possibleSku}`);

        // If ASIN is unknown or looks like a SKU, we need to resolve it
        if (needsAsinLookup) {
          // First try to lookup by SKU in inventory table
          if (possibleSku && possibleSku !== 'UNKNOWN') {
            const { data: invBySku } = await supabase
              .from('inventory')
              .select('asin, title, image_url')
              .eq('sku', possibleSku)
              .maybeSingle();
            
            if (invBySku && isValidAsin(invBySku.asin)) {
              asin = invBySku.asin;
              title = invBySku.title || title;
              imageUrl = invBySku.image_url || imageUrl;
              console.log(`✅ Resolved SKU ${possibleSku} → ASIN ${asin} from inventory`);
            } else {
              // Try created_listings by SKU
              const { data: listingBySku } = await supabase
                .from('created_listings')
                .select('asin, title, image_url')
                .eq('sku', possibleSku)
                .maybeSingle();
              
              if (listingBySku && isValidAsin(listingBySku.asin)) {
                asin = listingBySku.asin;
                title = listingBySku.title || title;
                imageUrl = listingBySku.image_url || imageUrl;
                console.log(`✅ Resolved SKU ${possibleSku} → ASIN ${asin} from created_listings`);
              }
            }
          }
          
          // Still need ASIN? Check original order or call API
          if (!isValidAsin(asin)) {
            const { data: originalOrder } = await supabase
              .from('sales_orders')
              .select('asin, title, image_url')
              .eq('order_id', originalOrderId)
              .eq('user_id', user.id)
              .maybeSingle();

            if (originalOrder && isValidAsin(originalOrder.asin)) {
              asin = originalOrder.asin;
              title = originalOrder.title ? originalOrder.title.replace('[REFUND] ', '') : title;
              imageUrl = originalOrder.image_url || imageUrl;
              console.log(`✅ Found original order data: ${asin}`);
            } else {
              // Call Amazon Orders API to get order items
              console.log(`📞 Calling Orders API for ${originalOrderId}`);
              const orderItems = await fetchOrderItems(accessToken, originalOrderId);
              
              if (orderItems && orderItems.length > 0) {
                const firstItem = orderItems[0];
                if (firstItem.ASIN && isValidAsin(firstItem.ASIN)) {
                  asin = firstItem.ASIN;
                }
                title = firstItem.Title || title;
                console.log(`✅ Got from API: ${asin} - ${title?.substring(0, 30)}...`);
              } else {
                console.log(`⚠️ No order items found for ${originalOrderId}`);
              }
              
              // Rate limit delay
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
        }

        // Now try to get image from local tables if still missing
        if (asin !== 'UNKNOWN' && !imageUrl) {
          // Try created_listings first
          const { data: listing } = await supabase
            .from('created_listings')
            .select('image_url, title')
            .eq('asin', asin)
            .maybeSingle();
          
          if (listing?.image_url) {
            imageUrl = listing.image_url;
            console.log(`✅ Found image in created_listings for ${asin}`);
            if (!title || title === '[REFUND]') {
              title = listing.title ? `[REFUND] ${listing.title}` : title;
            }
          } else {
            // Try inventory table
            const { data: invItem } = await supabase
              .from('inventory')
              .select('image_url, title')
              .eq('asin', asin)
              .maybeSingle();
            
            if (invItem?.image_url) {
              imageUrl = invItem.image_url;
              console.log(`✅ Found image in inventory for ${asin}`);
              if (!title || title === '[REFUND]') {
                title = invItem.title ? `[REFUND] ${invItem.title}` : title;
              }
            }
          }
        }

        // Still no image? Call Catalog API
        if (asin !== 'UNKNOWN' && !imageUrl) {
          console.log(`📸 Calling Catalog API for image: ${asin}`);
          const catalogData = await fetchCatalogItem(accessToken, asin);
          
          if (catalogData?.image) {
            imageUrl = catalogData.image;
            console.log(`✅ Got image from Catalog API for ${asin}`);
          }
          if (catalogData?.title && (!title || title === '[REFUND]')) {
            title = `[REFUND] ${catalogData.title}`;
          }
          
          // Rate limit delay
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Update the refund record if we found data
        if (asin !== 'UNKNOWN' || (title && title !== '[REFUND]') || imageUrl) {
          const updateData: any = { updated_at: new Date().toISOString() };
          if (asin !== 'UNKNOWN') updateData.asin = asin;
          if (title && title !== '[REFUND]') updateData.title = title;
          if (imageUrl) updateData.image_url = imageUrl;

          const { error: updateError } = await supabase
            .from('sales_orders')
            .update(updateData)
            .eq('id', refund.id);

          if (updateError) {
            console.error(`Failed to update ${refund.order_id}:`, updateError);
          } else {
            enrichedCount++;
            console.log(`✅ Updated ${refund.order_id}: asin=${asin}, hasImage=${!!imageUrl}`);
          }
        } else {
          console.log(`⚠️ Could not find data for ${refund.order_id}`);
        }
      } catch (err) {
        console.error(`Error enriching ${refund.order_id}:`, err);
        // HEALTH SIGNAL: per-refund enrichment failure
        await HealthSignals.settlementSyncError(user.id, 'sync-refunds', `order=${refund.order_id} ${(err as Error).message}`);
      }
    }

    console.log(`🎉 Enriched ${enrichedCount}/${refundsToEnrich.length} refunds`);

    return new Response(JSON.stringify({ 
      success: true, 
      message: `Enriched ${enrichedCount} of ${refundsToEnrich.length} refunds`,
      enriched: enrichedCount,
      total: refundsToEnrich.length
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Error in sync-refunds:', error);
    // HEALTH SIGNAL: top-level fatal
    try {
      const authHeader = req.headers.get('Authorization');
      if (authHeader) {
        const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
        const { data: { user: fatalUser } } = await sb.auth.getUser(authHeader.replace('Bearer ', ''));
        if (fatalUser?.id) {
          await HealthSignals.settlementSyncError(fatalUser.id, 'sync-refunds', `Fatal: ${(error as Error).message}`);
        }
      }
    } catch { /* never throw */ }
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function getAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET');

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId!,
      client_secret: clientSecret!,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get access token: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function fetchOrderItems(accessToken: string, orderId: string): Promise<any[] | null> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = 'us-east-1';
  const service = 'execute-api';
  const host = 'sellingpartnerapi-na.amazon.com';
  const endpoint = `/orders/v0/orders/${orderId}/orderItems`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalQuerystring = '';
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const payloadHash = await sha256('');
  const canonicalRequest = `GET\n${endpoint}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha256(canonicalRequest)}`;

  const signingKey = await getSignatureKey(awsSecretAccessKey!, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  try {
    const response = await fetch(`https://${host}${endpoint}`, {
      method: 'GET',
      headers: {
        'host': host,
        'x-amz-access-token': accessToken,
        'x-amz-date': amzDate,
        'Authorization': authorizationHeader,
      },
    });

    if (!response.ok) {
      console.error(`Orders API error: ${response.status} ${await response.text()}`);
      return null;
    }

    const data = await response.json();
    return data.payload?.OrderItems || null;
  } catch (error) {
    console.error('Error fetching order items:', error);
    return null;
  }
}

async function fetchCatalogItem(accessToken: string, asin: string): Promise<{ image?: string; title?: string } | null> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = 'us-east-1';
  const service = 'execute-api';
  const host = 'sellingpartnerapi-na.amazon.com';
  const marketplaceId = 'ATVPDKIKX0DER'; // US marketplace
  const endpoint = `/catalog/2022-04-01/items/${asin}`;
  const queryParams = `includedData=images,summaries&marketplaceIds=${marketplaceId}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalQuerystring = queryParams;
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const payloadHash = await sha256('');
  const canonicalRequest = `GET\n${endpoint}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha256(canonicalRequest)}`;

  const signingKey = await getSignatureKey(awsSecretAccessKey!, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  try {
    const response = await fetch(`https://${host}${endpoint}?${queryParams}`, {
      method: 'GET',
      headers: {
        'host': host,
        'x-amz-access-token': accessToken,
        'x-amz-date': amzDate,
        'Authorization': authorizationHeader,
      },
    });

    if (!response.ok) {
      console.error(`Catalog API error: ${response.status} ${await response.text()}`);
      return null;
    }

    const data = await response.json();
    
    // Extract image URL
    let image: string | undefined;
    if (data.images && data.images.length > 0) {
      const usImages = data.images.find((img: any) => img.marketplaceId === marketplaceId);
      if (usImages?.images?.[0]?.link) {
        image = usImages.images[0].link;
      }
    }
    
    // Extract title
    let title: string | undefined;
    if (data.summaries && data.summaries.length > 0) {
      const usSummary = data.summaries.find((s: any) => s.marketplaceId === marketplaceId);
      title = usSummary?.itemName;
    }

    return { image, title };
  } catch (error) {
    console.error('Error fetching catalog item:', error);
    return null;
  }
}

async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as any);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function hmacHex(key: ArrayBuffer, message: string): Promise<string> {
  const result = await hmac(key, message);
  return Array.from(new Uint8Array(result))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getSignatureKey(
  key: string,
  dateStamp: string,
  regionName: string,
  serviceName: string
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode('AWS4' + key), dateStamp);
  const kRegion = await hmac(kDate, regionName);
  const kService = await hmac(kRegion, serviceName);
  return await hmac(kService, 'aws4_request');
}
