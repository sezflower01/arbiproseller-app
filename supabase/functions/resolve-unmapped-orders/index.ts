import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// AWS SigV4 signing utilities
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest('SHA-256', data as any);
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string
): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';

  const urlObj = new URL(url);
  const host = urlObj.host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = toHex(await sha256(body));

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');


  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    toHex(await sha256(canonicalRequest))
  ].join('\n');


  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Authorization': authHeader,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': host,
  };
}

async function getLWAAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID')!;
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET')!;

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`LWA token error: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Check if a value is a valid ASIN (10 chars, starts with B0 or is ISBN)
function isValidAsin(val: string): boolean {
  if (!val || val === 'UNKNOWN' || val === 'PENDING') return false;
  if (val.length !== 10) return false;
  if (/^B0[A-Z0-9]{8}$/.test(val)) return true; // Standard ASIN
  if (/^\d{10}$/.test(val)) return true; // ISBN-style ASIN
  return false;
}

// Check if a value looks like a SKU (not a valid ASIN pattern)
function looksLikeSku(val: string): boolean {
  if (!val) return false;
  // If it's a valid ASIN, it's not a SKU
  if (isValidAsin(val)) return false;
  // Otherwise, it's likely a SKU
  return true;
}

interface OrderItem {
  asin: string;
  sku: string;
  title: string;
  quantity: number;
  price: number;
}

// Fetch order items from Amazon Orders API
async function fetchOrderItems(
  accessToken: string,
  orderId: string
): Promise<OrderItem[]> {
  const url = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${orderId}/orderItems`;
  const headers = await signRequest('GET', url, '', accessToken);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 429) {
    // Rate limited - wait and retry once
    await new Promise(r => setTimeout(r, 2000));
    const retryHeaders = await signRequest('GET', url, '', accessToken);
    const retryResponse = await fetch(url, {
      method: 'GET',
      headers: { ...retryHeaders, 'Content-Type': 'application/json' },
    });
    
    if (retryResponse.ok) {
      const data = await retryResponse.json();
      const items = data.payload?.OrderItems || [];
      return items.map((item: any) => ({
        asin: item.ASIN,
        sku: item.SellerSKU,
        title: item.Title || '',
        quantity: item.QuantityOrdered || 1,
        price: item.ItemPrice ? parseFloat(item.ItemPrice.Amount) : 0,
      }));
    }
    return [];
  }

  if (!response.ok) {
    console.warn(`Failed to get items for order ${orderId}: ${response.status}`);
    return [];
  }

  const data = await response.json();
  const items = data.payload?.OrderItems || [];
  return items.map((item: any) => ({
    asin: item.ASIN,
    sku: item.SellerSKU,
    title: item.Title || '',
    quantity: item.QuantityOrdered || 1,
    price: item.ItemPrice ? parseFloat(item.ItemPrice.Amount) : 0,
  }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify JWT
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { date_from, date_to, marketplace_id, limit = 50 } = await req.json();
    
    console.log(`[RESOLVE] Starting unmapped order resolution for user ${user.id}`);
    console.log(`[RESOLVE] Date range: ${date_from} to ${date_to}, limit: ${limit}`);

    // Get user's SP-API credentials from seller_authorizations
    const targetMarketplace = marketplace_id || 'ATVPDKIKX0DER';
    
    // Get all seller authorizations for this user
    const { data: authRows, error: authRowsError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, seller_id, marketplace_id')
      .eq('user_id', user.id);

    // Find auth for target marketplace, fallback to any available
    const authRow = authRows?.find((a: any) => a.marketplace_id === targetMarketplace) || authRows?.[0];
    if (authRowsError || !authRow?.refresh_token) {
      console.error('[RESOLVE] No seller authorization found for user');
      return new Response(JSON.stringify({ error: 'Amazon account not connected' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await getLWAAccessToken(authRow.refresh_token);

    // Find unmapped orders: asin_source = 'unknown' OR asin looks like SKU
    // Query orders where:
    // 1. asin_source = 'unknown', OR
    // 2. asin doesn't match ASIN pattern (SKU in asin column)
    const { data: unmappedOrders, error: fetchError } = await supabase
      .from('sales_orders')
      .select('id, order_id, asin, sku, title, image_url, asin_source')
      .eq('user_id', user.id)
      .gte('order_date', date_from)
      .lte('order_date', date_to)
      .or('asin_source.eq.unknown,asin_source.is.null')
      .order('order_date', { ascending: false })
      .limit(limit);

    if (fetchError) {
      console.error('[RESOLVE] Fetch error:', fetchError.message);
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Filter to only orders where asin looks like a SKU (not a valid ASIN)
    const ordersToResolve = (unmappedOrders || []).filter(o => 
      !isValidAsin(o.asin) || o.asin_source === 'unknown'
    );

    console.log(`[RESOLVE] Found ${ordersToResolve.length} orders needing resolution`);

    if (ordersToResolve.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        orders_processed: 0,
        rows_updated: 0,
        unresolved_count: 0,
        examples_unresolved: [],
        message: 'No unmapped orders found in the selected period',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Group by order_id (multiple rows may have same order_id)
    const orderIdMap = new Map<string, typeof ordersToResolve>();
    for (const order of ordersToResolve) {
      // Extract base order ID (remove -REFUND suffix if present)
      const baseOrderId = order.order_id.replace(/-REFUND(-\d+)?$/, '');
      if (!orderIdMap.has(baseOrderId)) {
        orderIdMap.set(baseOrderId, []);
      }
      orderIdMap.get(baseOrderId)!.push(order);
    }

    const uniqueOrderIds = Array.from(orderIdMap.keys());
    console.log(`[RESOLVE] Processing ${uniqueOrderIds.length} unique order IDs`);

    let ordersProcessed = 0;
    let rowsUpdated = 0;
    const unresolved: { order_id: string; asin: string; reason: string }[] = [];

    // Process each unique order ID
    for (const orderId of uniqueOrderIds) {
      ordersProcessed++;
      
      try {
        // Call Orders API to get order items
        const orderItems = await fetchOrderItems(accessToken, orderId);
        
        if (orderItems.length === 0) {
          const rows = orderIdMap.get(orderId) || [];
          for (const row of rows) {
            unresolved.push({ order_id: row.order_id, asin: row.asin, reason: 'No items from API' });
          }
          continue;
        }

        // Get the rows for this order
        const rows = orderIdMap.get(orderId) || [];
        
        for (const row of rows) {
          let resolvedAsin: string | null = null;
          let resolvedTitle: string | null = null;
          
          // Strategy 1: Match by seller_sku == row.sku
          if (row.sku) {
            const skuMatch = orderItems.find(item => item.sku === row.sku);
            if (skuMatch && isValidAsin(skuMatch.asin)) {
              resolvedAsin = skuMatch.asin;
              resolvedTitle = skuMatch.title;
              console.log(`[RESOLVE] SKU match: ${row.sku} -> ${resolvedAsin}`);
            }
          }
          
          // Strategy 2: Match by asin in row == sku in API (SKU stored as ASIN)
          if (!resolvedAsin && row.asin) {
            const asinAsSkuMatch = orderItems.find(item => item.sku === row.asin);
            if (asinAsSkuMatch && isValidAsin(asinAsSkuMatch.asin)) {
              resolvedAsin = asinAsSkuMatch.asin;
              resolvedTitle = asinAsSkuMatch.title;
              console.log(`[RESOLVE] ASIN-as-SKU match: ${row.asin} -> ${resolvedAsin}`);
            }
          }
          
          // Strategy 3: If only 1 item in order, use that ASIN
          if (!resolvedAsin && orderItems.length === 1 && isValidAsin(orderItems[0].asin)) {
            resolvedAsin = orderItems[0].asin;
            resolvedTitle = orderItems[0].title;
            console.log(`[RESOLVE] Single-item fallback: ${row.order_id} -> ${resolvedAsin}`);
          }
          
          if (resolvedAsin) {
            // Update the sales_orders row
            const updates: any = {
              asin: resolvedAsin,
              asin_source: 'resolved',
              updated_at: new Date().toISOString(),
            };
            
            // Also update title if we have one and current is missing
            if (resolvedTitle && (!row.title || row.title === '[REFUND]' || row.title === 'Order Processing...')) {
              updates.title = row.title?.startsWith('[REFUND]') ? `[REFUND] ${resolvedTitle}` : resolvedTitle;
            }
            
            // Store the original SKU if we resolved from it
            if (looksLikeSku(row.asin) && !row.sku) {
              updates.sku = row.asin;
            }
            
            const { error: updateError } = await supabase
              .from('sales_orders')
              .update(updates)
              .eq('id', row.id);
            
            if (!updateError) {
              rowsUpdated++;
              console.log(`[RESOLVE] Updated: ${row.order_id} | ${row.asin} -> ${resolvedAsin}`);
              
              // Cache the SKU->ASIN mapping for future use
              if (row.sku || looksLikeSku(row.asin)) {
                const skuToCache = row.sku || row.asin;
                // Try to insert into fnsku_map if not exists
                try {
                  await supabase
                    .from('fnsku_map')
                    .upsert({
                      asin: resolvedAsin,
                      fnsku: skuToCache, // Using fnsku column for SKU mapping
                      seller_id: Deno.env.get('SPAPI_SELLER_ID') || 'GLOBAL',
                      marketplace_id: marketplace_id || 'ATVPDKIKX0DER',
                      seller_sku: skuToCache,
                    }, { onConflict: 'asin,seller_id,marketplace_id' });
                  console.log(`[RESOLVE] Cached SKU mapping: ${skuToCache} -> ${resolvedAsin}`);
                } catch { /* ignore cache errors */ }
              }
            } else {
              console.error(`[RESOLVE] Update failed: ${row.order_id}`, updateError.message);
              unresolved.push({ order_id: row.order_id, asin: row.asin, reason: 'Update failed' });
            }
          } else {
            unresolved.push({ order_id: row.order_id, asin: row.asin, reason: 'No matching ASIN found' });
          }
        }
        
        // Rate limiting: 500ms between order API calls
        if (ordersProcessed < uniqueOrderIds.length) {
          await new Promise(r => setTimeout(r, 500));
        }
        
      } catch (err: any) {
        console.error(`[RESOLVE] Error processing ${orderId}:`, (err as Error).message);
        const rows = orderIdMap.get(orderId) || [];
        for (const row of rows) {
          unresolved.push({ order_id: row.order_id, asin: row.asin, reason: (err as Error).message });
        }
      }
    }

    console.log(`[RESOLVE] Complete: ${ordersProcessed} orders, ${rowsUpdated} rows updated, ${unresolved.length} unresolved`);

    return new Response(JSON.stringify({
      success: true,
      orders_processed: ordersProcessed,
      rows_updated: rowsUpdated,
      unresolved_count: unresolved.length,
      examples_unresolved: unresolved.slice(0, 10),
      message: rowsUpdated > 0 
        ? `Resolved ${rowsUpdated} orders, ${unresolved.length} unresolved`
        : 'No orders could be resolved',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[RESOLVE] Error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
