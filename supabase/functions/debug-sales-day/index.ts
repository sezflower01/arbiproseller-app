import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Convert PT date to UTC boundaries for Amazon API calls
function getPacificDayBoundsUTC(dateYYYYMMDD: string): { startUTC: string; endUTC: string; error?: string } {
  // dateYYYYMMDD like "2025-12-02"
  // PT is UTC-8 (or UTC-7 in DST, but December is standard time = UTC-8)
  // Start of day in PT: 00:00:00 PT = 08:00:00 UTC
  // End of day in PT: 23:59:59 PT = 07:59:59 UTC next day
  
  const [year, month, day] = dateYYYYMMDD.split('-').map(Number);
  
  // Start: midnight PT = 08:00 UTC same day
  const startUTC = new Date(Date.UTC(year, month - 1, day, 8, 0, 0, 0));
  
  // End: 23:59:59 PT = 07:59:59 UTC next day
  let endUTC = new Date(Date.UTC(year, month - 1, day + 1, 7, 59, 59, 999));
  
  // IMPORTANT: Amazon requires dates at least 2 minutes before current time
  // Cap the end date if it's too close to now
  const now = new Date();
  const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
  
  if (endUTC > twoMinutesAgo) {
    console.log(`⏰ Capping endUTC from ${endUTC.toISOString()} to ${twoMinutesAgo.toISOString()} (2 min before now)`);
    endUTC = twoMinutesAgo;
  }
  
  // Check if start is after the capped end (e.g., querying current day that hasn't started much)
  if (startUTC >= endUTC) {
    return {
      startUTC: startUTC.toISOString(),
      endUTC: endUTC.toISOString(),
      error: `Cannot query this date yet - the day hasn't progressed enough. Start (${startUTC.toISOString()}) >= End (${endUTC.toISOString()})`
    };
  }
  
  return {
    startUTC: startUTC.toISOString(),
    endUTC: endUTC.toISOString()
  };
}

async function getLWAAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');

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
    const errorText = await response.text();
    throw new Error(`LWA token refresh failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function signRequest(method: string, url: string, body: string, accessToken: string): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  
  const urlObj = new URL(url);
  const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = datetime.substring(0, 8);
  
  const headers: Record<string, string> = {
    'host': urlObj.host,
    'x-amz-access-token': accessToken,
    'x-amz-date': datetime,
    'content-type': 'application/json',
  };

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  
  const payloadHash = await sha256(body || '');
  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.substring(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = `${date}/${region}/execute-api/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    credentialScope,
    await sha256(canonicalRequest)
  ].join('\n');

  const signingKey = await getSignatureKey(awsSecretAccessKey, date, region, 'execute-api');
  const signature = await hmacHex(signingKey, stringToSign);

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  return headers;
}

async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as any);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function hmacHex(key: ArrayBuffer, message: string): Promise<string> {
  const result = await hmac(key, message);
  return Array.from(new Uint8Array(result)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

// Fetch ALL orders from Orders API for a date range (with pagination and retry)
async function fetchAllOrdersForDay(
  accessToken: string,
  marketplaceId: string,
  startUTC: string,
  endUTC: string
): Promise<{ orders: any[]; orderIds: string[]; quotaExceeded?: boolean }> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const allOrders: any[] = [];
  let nextToken: string | null = null;
  let pageCount = 0;
  const maxRetries = 3;

  do {
    pageCount++;
    let url: string;
    
    if (nextToken) {
      const params = new URLSearchParams({ NextToken: nextToken });
      url = `${endpoint}/orders/v0/orders?${params}`;
    } else {
      const params = new URLSearchParams({
        MarketplaceIds: marketplaceId,
        CreatedAfter: startUTC,
        CreatedBefore: endUTC,
      });
      url = `${endpoint}/orders/v0/orders?${params}`;
    }

    console.log(`📦 Orders API page ${pageCount}: ${url}`);
    
    let response: Response | null = null;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      attempt++;
      const headers = await signRequest('GET', url, '', accessToken);
      response = await fetch(url, { headers });
      
      if (response.ok) break;
      
      if (response.status === 429) {
        // Quota exceeded - wait and retry with exponential backoff
        const waitMs = Math.pow(2, attempt) * 2000; // 4s, 8s, 16s
        console.warn(`⏳ Orders API quota exceeded (attempt ${attempt}/${maxRetries}), waiting ${waitMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      
      // Other error - don't retry
      break;
    }

    if (!response || !response.ok) {
      if (response?.status === 429) {
        console.warn(`📦 Orders API quota exceeded after ${maxRetries} retries. Returning partial results.`);
        return { orders: allOrders, orderIds: allOrders.map(o => o.AmazonOrderId), quotaExceeded: true };
      }
      const errorText = response ? await response.text() : 'No response';
      console.error(`Orders API error: ${response?.status}`, errorText);
      // Return partial results instead of throwing
      console.warn(`Orders API failed. Returning ${allOrders.length} orders collected so far.`);
      return { orders: allOrders, orderIds: allOrders.map(o => o.AmazonOrderId), quotaExceeded: response?.status === 429 };
    }

    const data = await response.json();
    const orders = data.payload?.Orders || [];
    allOrders.push(...orders);
    
    nextToken = data.payload?.NextToken || null;
    console.log(`📦 Page ${pageCount}: ${orders.length} orders, hasNext: ${!!nextToken}`);
    
    if (nextToken) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Slower rate limit
    }
  } while (nextToken);

  const orderIds = allOrders.map(o => o.AmazonOrderId);
  return { orders: allOrders, orderIds };
}

// Fetch ALL financial events for a date range (with pagination)
async function fetchAllFinancialEventsForDay(
  accessToken: string,
  marketplaceId: string,
  startUTC: string,
  endUTC: string
): Promise<{ events: any[]; shipmentOrderIds: string[]; refundOrderIds: string[] }> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = '/finances/v0/financialEvents';
  
  const allEvents: any[] = [];
  const shipmentOrderIds = new Set<string>();
  const refundOrderIds = new Set<string>();
  let nextToken: string | null = null;
  let pageCount = 0;

  do {
    pageCount++;
    const params = new URLSearchParams({
      PostedAfter: startUTC,
      PostedBefore: endUTC,
    });
    if (nextToken) params.append('NextToken', nextToken);

    const url = `${endpoint}${path}?${params}`;
    console.log(`💰 Financial Events page ${pageCount}: PostedAfter=${startUTC}, PostedBefore=${endUTC}`);
    
    const headers = await signRequest('GET', url, '', accessToken);
    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Financial Events API error: ${response.status}`, errorText);
      // Don't throw, just return what we have
      console.warn(`Financial Events API failed with ${response.status}. Returning partial data.`);
      break;
    }

    const data = await response.json();
    const payload = data.payload?.FinancialEvents || data.payload || {};

    // Shipment events
    if (payload?.ShipmentEventList) {
      for (const event of payload.ShipmentEventList) {
        allEvents.push({ ...event, _eventType: 'shipment' });
        if (event.AmazonOrderId) shipmentOrderIds.add(event.AmazonOrderId);
      }
    }
    
    // Refund events
    if (payload?.RefundEventList) {
      for (const event of payload.RefundEventList) {
        allEvents.push({ ...event, _eventType: 'refund' });
        if (event.AmazonOrderId) refundOrderIds.add(event.AmazonOrderId);
      }
    }

    nextToken = data.payload?.NextToken || null;
    console.log(`💰 Page ${pageCount}: shipments=${shipmentOrderIds.size}, refunds=${refundOrderIds.size}, hasNext: ${!!nextToken}`);
    
    if (nextToken) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } while (nextToken);

  return { 
    events: allEvents, 
    shipmentOrderIds: Array.from(shipmentOrderIds),
    refundOrderIds: Array.from(refundOrderIds)
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse request body
    const body = await req.json();
    const { date } = body; // Expected: "2025-12-02" (Pacific Time date)

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ error: 'Invalid date format. Use YYYY-MM-DD' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`\n========== DEBUG SALES DAY: ${date} (Pacific Time) ==========\n`);

    // Get all seller authorizations for this user (multi-marketplace)
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id')
      .eq('user_id', user.id);

    // Prefer US marketplace, fallback to first available
    const authData = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (authError || !authData) {
      return new Response(JSON.stringify({ error: 'No Amazon seller authorization found' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await getLWAAccessToken(authData.refresh_token);
    const dateBounds = getPacificDayBoundsUTC(date);
    
    // Check if the date range is valid (not too close to current time)
    if (dateBounds.error) {
      return new Response(JSON.stringify({ 
        error: dateBounds.error,
        startUTC: dateBounds.startUTC,
        endUTC: dateBounds.endUTC
      }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    const { startUTC, endUTC } = dateBounds;

    console.log(`📅 PT Date: ${date}`);
    console.log(`📅 UTC Boundaries: ${startUTC} to ${endUTC}`);

    // A. Fetch all orders from Amazon Orders API
    console.log('\n--- A. AMAZON ORDERS API ---');
    const ordersResult = await fetchAllOrdersForDay(accessToken, authData.marketplace_id, startUTC, endUTC);
    console.log(`DEBUG_ORDERS_API_DAY`, {
      date,
      totalAmazonOrders: ordersResult.orders.length,
      orderIds: ordersResult.orderIds
    });

    // B. Fetch all financial events from Amazon
    console.log('\n--- B. AMAZON FINANCIAL EVENTS ---');
    const finResult = await fetchAllFinancialEventsForDay(accessToken, authData.marketplace_id, startUTC, endUTC);
    console.log(`DEBUG_FIN_EVENTS_DAY`, {
      date,
      totalEvents: finResult.events.length,
      shipmentOrderIds: finResult.shipmentOrderIds,
      refundOrderIds: finResult.refundOrderIds
    });

    // C. Query Database
    console.log('\n--- C. DATABASE ---');
    
    // Get counts by status
    const { data: dbStats } = await supabase
      .from('sales_orders')
      .select('status')
      .eq('user_id', user.id)
      .eq('order_date', date);
    
    const statusCounts: Record<string, number> = {};
    const dbOrderIds = new Set<string>();
    
    // Get all order IDs from DB for this date
    const { data: dbOrders } = await supabase
      .from('sales_orders')
      .select('order_id, status, refund_amount, refund_quantity')
      .eq('user_id', user.id)
      .eq('order_date', date);

    if (dbOrders) {
      for (const row of dbOrders) {
        dbOrderIds.add(row.order_id);
        statusCounts[row.status || 'unknown'] = (statusCounts[row.status || 'unknown'] || 0) + 1;
      }
    }

    const dbOrderIdArray = Array.from(dbOrderIds);
    
    console.log(`DEBUG_DB_DAY`, {
      date,
      totalRows: dbOrders?.length || 0,
      distinctOrders: dbOrderIdArray.length,
      byStatus: statusCounts,
      orderIds: dbOrderIdArray
    });

    // D. Calculate differences
    console.log('\n--- D. DIFFERENCES ---');
    
    const amazonOrderIdSet = new Set(ordersResult.orderIds);
    const missingInDb = ordersResult.orderIds.filter(id => !dbOrderIds.has(id));
    const missingInAmazon = dbOrderIdArray.filter(id => !amazonOrderIdSet.has(id));
    
    // Check refunds in DB
    const dbRefundOrders = dbOrders?.filter(o => (o.refund_amount || 0) > 0 || (o.refund_quantity || 0) > 0) || [];
    const dbRefundOrderIds = dbRefundOrders.map(o => o.order_id);
    
    const refundsMissingInDb = finResult.refundOrderIds.filter(id => !dbRefundOrderIds.includes(id));

    console.log(`DEBUG_DIFF_DAY`, {
      date,
      amazonOrderCount: ordersResult.orders.length,
      dbOrderCount: dbOrderIdArray.length,
      missingInDb: missingInDb,
      missingInDbCount: missingInDb.length,
      missingInAmazon: missingInAmazon,
      missingInAmazonCount: missingInAmazon.length,
      amazonRefundOrders: finResult.refundOrderIds,
      amazonRefundCount: finResult.refundOrderIds.length,
      dbRefundOrders: dbRefundOrderIds,
      dbRefundCount: dbRefundOrderIds.length,
      refundsMissingInDb: refundsMissingInDb,
      refundsMissingInDbCount: refundsMissingInDb.length,
    });

    const result = {
      date,
      utcBoundaries: { startUTC, endUTC },
      amazonOrders: {
        count: ordersResult.orders.length,
        orderIds: ordersResult.orderIds,
      },
      amazonFinancialEvents: {
        totalEvents: finResult.events.length,
        shipmentOrderIds: finResult.shipmentOrderIds,
        refundOrderIds: finResult.refundOrderIds,
      },
      database: {
        totalRows: dbOrders?.length || 0,
        distinctOrders: dbOrderIdArray.length,
        byStatus: statusCounts,
        orderIds: dbOrderIdArray,
        refundOrders: dbRefundOrderIds,
      },
      differences: {
        missingInDb,
        missingInDbCount: missingInDb.length,
        missingInAmazon,
        missingInAmazonCount: missingInAmazon.length,
        refundsMissingInDb,
        refundsMissingInDbCount: refundsMissingInDb.length,
      },
      summary: {
        amazonVsDb: `Amazon has ${ordersResult.orders.length} orders, DB has ${dbOrderIdArray.length} orders. Missing ${missingInDb.length} orders in DB.`,
        refunds: `Amazon has ${finResult.refundOrderIds.length} refund orders, DB has ${dbRefundOrderIds.length} refund orders. Missing ${refundsMissingInDb.length} refunds in DB.`,
      }
    };

    console.log('\n========== DEBUG COMPLETE ==========\n');
    console.log('SUMMARY:', result.summary);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Debug function error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
