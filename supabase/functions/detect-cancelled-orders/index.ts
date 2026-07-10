import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const error = await response.text();
    console.error('[DETECT_CANCELLED] LWA token error:', error);
    throw new Error('Failed to get LWA access token');
  }

  const data = await response.json();
  return data.access_token;
}

// Fetch single order status from Amazon Orders API
async function getOrderStatus(accessToken: string, orderId: string): Promise<{ status: string } | null> {
  const url = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${orderId}`;
  const headers = await signRequest('GET', url, '', accessToken);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 429) {
    console.warn(`[DETECT_CANCELLED] Rate limited for ${orderId}`);
    return null; // Skip on rate limit, will retry next run
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.warn(`[DETECT_CANCELLED] Failed to get order ${orderId}: ${response.status}`);
    return null;
  }

  const data = await response.json();
  return { status: data.payload?.OrderStatus };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const MAX_RUNTIME_MS = 55000; // 55 seconds max to leave buffer before timeout

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Helper function to clean up orders that already have Cancelled status but haven't been zeroed
    async function cleanupAlreadyCancelledOrders(userId: string): Promise<{ cleaned: number }> {
      const now = new Date().toISOString();
      
      // Find orders with Canceled/Cancelled status but not properly zeroed
      const { data: cancelledNotZeroed, error: fetchErr } = await supabase
        .from('sales_orders')
        .select('id, order_id, order_status, sold_price, quantity')
        .eq('user_id', userId)
        .in('order_status', ['Canceled', 'Cancelled'])
        .or('is_cancelled.is.null,is_cancelled.eq.false,sold_price.gt.0,quantity.gt.0')
        .limit(100);

      if (fetchErr || !cancelledNotZeroed || cancelledNotZeroed.length === 0) {
        return { cleaned: 0 };
      }

      console.log(`[DETECT_CANCELLED] Found ${cancelledNotZeroed.length} cancelled orders needing cleanup`);

      // Update them all to zero out financial fields
      const orderIds = [...new Set(cancelledNotZeroed.map(o => o.order_id))];
      let cleaned = 0;

      for (const orderId of orderIds) {
        const { error: updateErr } = await supabase
          .from('sales_orders')
          .update({
            is_cancelled: true,
            cancelled_at: now,
            quantity: 0,
            sold_price: 0,
            total_sale_amount: 0,
            referral_fee: 0,
            fba_fee: 0,
            closing_fee: 0,
            total_fees: 0,
            refund_amount: 0,
            status_source: 'detect_cancelled_cleanup',
            updated_at: now,
          })
          .eq('user_id', userId)
          .like('order_id', `${orderId}%`);

        if (!updateErr) {
          cleaned++;
          console.log(`[DETECT_CANCELLED] 🧹 Cleaned up cancelled order: ${orderId}`);
        }
      }

      return { cleaned };
    }

    const body = await req.json().catch(() => ({}));
    const { user_id, batch_size = 50, lookback_months = 24 } = body;

    // Validate internal call or get user from JWT
    let targetUserId = user_id;
    
    const authHeader = req.headers.get('authorization');
    if (!user_id && authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      targetUserId = user.id;
    }

    if (!targetUserId) {
      return new Response(JSON.stringify({ error: 'user_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[DETECT_CANCELLED] Starting for user ${targetUserId}, batch_size=${batch_size}, lookback_months=${lookback_months}`);

    // FIRST: Clean up orders that already have Cancelled status but weren't properly zeroed
    const { cleaned: cleanedUp } = await cleanupAlreadyCancelledOrders(targetUserId);
    if (cleanedUp > 0) {
      console.log(`[DETECT_CANCELLED] 🧹 Pre-cleaned ${cleanedUp} already-cancelled orders`);
    }

    // Get seller authorization
    const { data: authRows, error: authFetchError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, seller_id, marketplace_id')
      .eq('user_id', targetUserId);

    const authRow = authRows?.[0];
    if (authFetchError || !authRow?.refresh_token) {
      console.error('[DETECT_CANCELLED] No seller authorization found');
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Amazon account not connected',
        checked: 0,
        cancelled: 0 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get access token once for all batches
    let accessToken: string;
    try {
      accessToken = await getLWAAccessToken(authRow.refresh_token);
    } catch (tokenError: any) {
      console.error('[DETECT_CANCELLED] Token error:', tokenError);
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Failed to authenticate with Amazon',
        checked: 0,
        cancelled: 0 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let totalChecked = 0;
    let totalCancelled = 0;
    let totalRateLimited = 0;
    let monthsProcessed = 0;
    let allComplete = true;
    const monthResults: { month: string; checked: number; cancelled: number; remaining: number }[] = [];

    // Process month by month, starting from current month going backwards
    for (let monthOffset = 0; monthOffset < lookback_months; monthOffset++) {
      // Check if we're running out of time
      if (Date.now() - startTime > MAX_RUNTIME_MS) {
        console.log(`[DETECT_CANCELLED] Time limit reached after ${monthsProcessed} months`);
        allComplete = false;
        break;
      }

      // Calculate month boundaries
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth() - monthOffset, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - monthOffset + 1, 0, 23, 59, 59);
      
      const monthStartStr = monthStart.toISOString().split('T')[0];
      const monthEndStr = monthEnd.toISOString().split('T')[0];
      const monthLabel = monthStart.toISOString().slice(0, 7); // YYYY-MM

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      // Find orders needing verification for this month
      const { data: ordersToCheck, error: ordersError } = await supabase
        .from('sales_orders')
        .select('order_id, order_status, order_date, last_status_sync_at')
        .eq('user_id', targetUserId)
        .or('is_cancelled.is.null,is_cancelled.eq.false')
        .in('order_status', ['Pending', 'Unshipped', 'PendingAvailability', 'PartiallyShipped'])
        .gte('order_date', monthStartStr)
        .lte('order_date', monthEndStr)
        .or(`last_status_sync_at.is.null,last_status_sync_at.lt.${oneHourAgo}`)
        .not('order_id', 'like', '%-REFUND%')
        .order('order_date', { ascending: false })
        .limit(batch_size);

      if (ordersError) {
        console.error(`[DETECT_CANCELLED] Error fetching orders for ${monthLabel}:`, ordersError);
        continue;
      }

      if (!ordersToCheck || ordersToCheck.length === 0) {
        console.log(`[DETECT_CANCELLED] ✓ ${monthLabel}: No orders to verify`);
        monthResults.push({ month: monthLabel, checked: 0, cancelled: 0, remaining: 0 });
        monthsProcessed++;
        continue;
      }

      console.log(`[DETECT_CANCELLED] 📅 ${monthLabel}: Processing ${ordersToCheck.length} orders`);

      // Get unique order IDs
      const uniqueOrderIds = [...new Set(ordersToCheck.map(o => o.order_id))];
      let monthChecked = 0;
      let monthCancelled = 0;

      // Process orders with rate limiting (250ms between calls)
      for (const orderId of uniqueOrderIds) {
        // Check time limit
        if (Date.now() - startTime > MAX_RUNTIME_MS) {
          console.log(`[DETECT_CANCELLED] Time limit reached mid-month ${monthLabel}`);
          allComplete = false;
          break;
        }

        try {
          const orderResult = await getOrderStatus(accessToken, orderId);
          
          const now = new Date().toISOString();

          if (!orderResult) {
            totalRateLimited++;
            // Still update last_status_sync_at to prevent immediate retry
            await supabase
              .from('sales_orders')
              .update({ last_status_sync_at: now })
              .eq('user_id', targetUserId)
              .like('order_id', `${orderId}%`);
            continue;
          }

          totalChecked++;
          monthChecked++;

          const amazonStatus = orderResult.status;
          const isCancelled = amazonStatus === 'Canceled' || amazonStatus === 'Cancelled';

          const updates: Record<string, any> = {
            order_status: amazonStatus,
            is_cancelled: isCancelled,
            last_status_sync_at: now,
            status_source: 'detect_cancelled_job',
            updated_at: now,
          };

          // If cancelled, zero out all financial fields
          if (isCancelled) {
            totalCancelled++;
            monthCancelled++;
            updates.cancelled_at = now;
            updates.quantity = 0;
            updates.sold_price = 0;
            updates.total_sale_amount = 0;
            updates.referral_fee = 0;
            updates.fba_fee = 0;
            updates.closing_fee = 0;
            updates.total_fees = 0;
            updates.refund_amount = 0;
            console.log(`[DETECT_CANCELLED] ❌ ${monthLabel} ${orderId} -> CANCELLED (zeroed)`);
          }

          // Update all rows with this order_id (including -REFUND variants)
          const { error: updateError } = await supabase
            .from('sales_orders')
            .update(updates)
            .eq('user_id', targetUserId)
            .like('order_id', `${orderId}%`);

          if (updateError) {
            console.error(`[DETECT_CANCELLED] Update failed for ${orderId}:`, updateError.message);
          }

          // Rate limiting: 150ms between API calls (faster than before, still safe)
          await new Promise(r => setTimeout(r, 150));

        } catch (err: any) {
          console.error(`[DETECT_CANCELLED] Error for ${orderId}:`, (err as Error).message);
        }
      }

      // Count remaining orders for this month
      const { count: remainingCount } = await supabase
        .from('sales_orders')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', targetUserId)
        .or('is_cancelled.is.null,is_cancelled.eq.false')
        .in('order_status', ['Pending', 'Unshipped', 'PendingAvailability', 'PartiallyShipped'])
        .gte('order_date', monthStartStr)
        .lte('order_date', monthEndStr)
        .or(`last_status_sync_at.is.null,last_status_sync_at.lt.${oneHourAgo}`)
        .not('order_id', 'like', '%-REFUND%');

      monthResults.push({ 
        month: monthLabel, 
        checked: monthChecked, 
        cancelled: monthCancelled, 
        remaining: remainingCount || 0 
      });
      
      console.log(`[DETECT_CANCELLED] ✓ ${monthLabel}: checked=${monthChecked}, cancelled=${monthCancelled}, remaining=${remainingCount || 0}`);
      monthsProcessed++;

      // If this month still has orders to check, don't move to older months yet
      if ((remainingCount || 0) > 0) {
        allComplete = false;
        console.log(`[DETECT_CANCELLED] ${monthLabel} still has ${remainingCount} orders - will continue next run`);
        break;
      }

      // Small delay between months (reduced from 200ms)
      await new Promise(r => setTimeout(r, 100));
    }

    const elapsedMs = Date.now() - startTime;
    
    console.log(`[DETECT_CANCELLED] ${allComplete ? '✅ ALL COMPLETE' : '⏳ PARTIAL'}: months=${monthsProcessed}, checked=${totalChecked}, cancelled=${totalCancelled}, cleaned_up=${cleanedUp}, rate_limited=${totalRateLimited}, elapsed=${elapsedMs}ms`);

    return new Response(JSON.stringify({
      success: true,
      complete: allComplete,
      months_processed: monthsProcessed,
      month_results: monthResults,
      checked: totalChecked,
      cancelled: totalCancelled,
      cleaned_up: cleanedUp,
      rate_limited: totalRateLimited,
      elapsed_ms: elapsedMs,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[DETECT_CANCELLED] Error:', error);
    return new Response(JSON.stringify({ 
      error: (error as Error).message,
      checked: 0,
      cancelled: 0 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
