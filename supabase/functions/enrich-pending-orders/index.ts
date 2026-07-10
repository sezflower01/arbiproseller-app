import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";

/**
 * enrich-pending-orders: Scheduled cron job for self-healing enrichment
 * 
 * This function runs on a schedule (every 15 minutes) to:
 * 1. Find orders with needs_price_enrich=true OR needs_fee_enrich=true
 * 2. Find stuck PENDING orders (asin='PENDING' older than 15 minutes)
 * 3. Process them in batches with rate limiting
 * 4. Use exponential backoff for repeated failures
 * 5. Log all attempts to enrichment_logs for observability
 * 
 * This ensures orders are eventually enriched even when:
 * - The app was closed during initial sync
 * - Rate limits prevented initial enrichment
 * - Network errors occurred
 * - Order items API returned partial data
 */

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
    throw new Error(`LWA token refresh failed: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Fetch order items from Amazon Orders API with retry-on-429.
// getOrderItems quota: 0.5 req/sec steady, burst 30.
// Honors Retry-After and x-amzn-RateLimit-Limit response headers.
async function fetchOrderItems(
  orderId: string,
  accessToken: string,
  _marketplaceId: string = 'ATVPDKIKX0DER',
  maxRetries: number = 3
): Promise<{ asin: string; title: string; quantity: number; sku: string; itemPrice: number | null; imageUrl?: string }[]> {
  const url = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${orderId}/orderItems`;
  let attempt = 0;
  let lastErr: Error | null = null;

  while (attempt <= maxRetries) {
    const headers = await signRequest('GET', url, '', accessToken);
    const response = await fetch(url, {
      method: 'GET',
      headers: { ...headers, 'Content-Type': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json();
      const items = data.payload?.OrderItems || [];
      return items.map((item: any) => ({
        asin: item.ASIN,
        title: item.Title || 'Unknown Product',
        quantity: item.QuantityOrdered || 1,
        sku: item.SellerSKU || '',
        itemPrice: item.ItemPrice?.Amount ? parseFloat(item.ItemPrice.Amount) : null,
        imageUrl: null,
      }));
    }

    const errorText = await response.text().catch(() => '');
    lastErr = new Error(`Order items API failed: ${response.status} - ${errorText}`);

    // Only retry on 429 / 503
    if (response.status !== 429 && response.status !== 503) {
      throw lastErr;
    }
    if (attempt === maxRetries) break;

    const retryAfter = response.headers.get('retry-after');
    const rateLimit = response.headers.get('x-amzn-ratelimit-limit');
    let waitMs: number;
    if (retryAfter) {
      const secs = parseFloat(retryAfter);
      waitMs = Number.isFinite(secs) ? Math.max(1000, secs * 1000) : 4000;
    } else if (rateLimit) {
      const rps = parseFloat(rateLimit);
      waitMs = Number.isFinite(rps) && rps > 0 ? Math.ceil(1000 / rps) + 500 : 4000;
    } else {
      waitMs = [2500, 5000, 10000][attempt] + Math.floor(Math.random() * 500);
    }
    console.log(`[ENRICH_PENDING] 429/503 for ${orderId}, retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
    attempt++;
  }
  throw lastErr || new Error(`Order items API failed after ${maxRetries} retries`);
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
  
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Parse body first to check for scheduled flag
    const body = await req.json().catch(() => ({}));
    const isScheduledCall = body.scheduled === true;
    
    // Validate internal call (from cron) or authenticated user
    const authHeader = req.headers.get('Authorization');
    const internalHeader = req.headers.get('x-internal-secret');
    
    let userId: string | null = null;
    let isInternalCall = false;
    
    // Allow scheduled cron calls (with body.scheduled=true) OR internal secret header
    if (internalHeader === internalSecret || isScheduledCall) {
      isInternalCall = true;
      console.log('[ENRICH_PENDING] Internal/scheduled cron call - processing all users');
    } else if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      userId = user.id;
      console.log(`[ENRICH_PENDING] User call for ${userId}`);
    } else {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const limit = body.limit || body.batch_size || 50;
    const force = body.force === true; // Skip age filter for manual calls
    const targetDate = typeof body.target_date === 'string' && body.target_date.trim() ? body.target_date.trim() : null;
    const targetOrderIds = Array.isArray(body.order_ids) && body.order_ids.length > 0
      ? body.order_ids.filter((v: unknown) => typeof v === 'string' && v.trim().length > 0)
      : null;
    const now = new Date().toISOString();
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    // ======================================================================
    // PART 1: Find orders needing fee/price enrichment.
    //
    // CRITICAL: do a "FRESH" pass first (orders created in the last 48h,
    // newest-first) so a sale that happens right now isn't buried behind
    // thousands of stale backlog rows. Then a "BACKLOG" pass fills any
    // remaining capacity with oldest pending rows.
    // ======================================================================
    const freshLimit = force || targetOrderIds ? limit : Math.max(10, Math.floor(limit * 0.6));
    const backlogLimit = force || targetOrderIds ? 0 : Math.max(5, limit - freshLimit);
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const buildBaseQuery = () =>
      supabase
        .from('sales_orders')
        .select('id, user_id, order_id, asin, sku, title, quantity, sold_price, total_sale_amount, total_fees, needs_price_enrich, needs_fee_enrich, enrich_attempts')
        .or('needs_price_enrich.eq.true,needs_fee_enrich.eq.true')
        .neq('asin', 'PENDING');

    // ---- FRESH pass: newest first, last 48h ----
    let freshQuery = buildBaseQuery()
      .gte('created_at', fortyEightHoursAgo)
      .order('created_at', { ascending: false })
      .order('enrich_attempts', { ascending: true })
      .limit(freshLimit);
    if (!force && !targetOrderIds) {
      freshQuery = freshQuery.or(`next_enrich_after.is.null,next_enrich_after.lte.${now}`);
    }
    if (userId) freshQuery = freshQuery.eq('user_id', userId);
    if (targetOrderIds && targetOrderIds.length > 0) freshQuery = freshQuery.in('order_id', targetOrderIds);

    const { data: freshRows, error: freshErr } = await freshQuery;
    if (freshErr) console.error('[ENRICH_PENDING] Fresh query error:', freshErr);

    // ---- BACKLOG pass: oldest first (only when not force/target) ----
    let backlogRows: any[] = [];
    let enrichQueryError: any = null;
    if (backlogLimit > 0) {
      const excludeIds = (freshRows || []).map((r: any) => r.id);
      let backlogQuery = buildBaseQuery()
        .lt('created_at', fortyEightHoursAgo)
        .or(`next_enrich_after.is.null,next_enrich_after.lte.${now}`)
        .order('next_enrich_after', { ascending: true, nullsFirst: true })
        .order('enrich_attempts', { ascending: true })
        .limit(backlogLimit);
      if (userId) backlogQuery = backlogQuery.eq('user_id', userId);
      if (excludeIds.length > 0) backlogQuery = backlogQuery.not('id', 'in', `(${excludeIds.join(',')})`);
      const { data, error } = await backlogQuery;
      if (error) {
        console.error('[ENRICH_PENDING] Backlog query error:', error);
        enrichQueryError = error;
      }
      backlogRows = data || [];
    }

    const pendingEnrichOrders = [...(freshRows || []), ...backlogRows];
    console.log(`[ENRICH_PENDING] Fresh=${(freshRows || []).length} Backlog=${backlogRows.length} Total=${pendingEnrichOrders.length}`);

    // ======================================================================
    // PART 2: Find stuck PENDING orders (asin='PENDING', older than 15 min)
    // ======================================================================
    let pendingAsinQuery = supabase
      .from('sales_orders')
      .select('id, user_id, order_id, order_date, asin, sku, title, sold_price, total_sale_amount, created_at, pending_enrich_attempts')
      .or("asin.eq.PENDING,title.eq.Order Processing...")
      .neq('order_status', 'Canceled')
      .neq('order_status', 'Cancelled')
      .order('pending_enrich_attempts', { ascending: true, nullsFirst: true })
      .order('order_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(force ? limit : Math.floor(limit / 2));

    if (targetDate) {
      pendingAsinQuery = pendingAsinQuery.eq('order_date', targetDate);
    }

    if (targetOrderIds && targetOrderIds.length > 0) {
      pendingAsinQuery = pendingAsinQuery.in('order_id', targetOrderIds);
    }
    
    // Only apply the 15-minute age filter for scheduled/automatic calls, not manual/force calls
    if (!force) {
      pendingAsinQuery = pendingAsinQuery.lt('created_at', fifteenMinutesAgo);
    }
    
    if (userId) {
      pendingAsinQuery = pendingAsinQuery.eq('user_id', userId);
    }

    const { data: stuckPendingOrders, error: pendingQueryError } = await pendingAsinQuery;

    if (enrichQueryError) {
      console.error('[ENRICH_PENDING] Enrich query error:', enrichQueryError);
    }
    if (pendingQueryError) {
      console.error('[ENRICH_PENDING] Pending ASIN query error:', pendingQueryError);
    }

    const pendingOrders = pendingEnrichOrders || [];
    const stuckOrders = stuckPendingOrders || [];

    if (pendingOrders.length === 0 && stuckOrders.length === 0) {
      console.log('[ENRICH_PENDING] No orders pending enrichment');
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No orders pending enrichment',
        processed: 0,
        stuckPendingProcessed: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[ENRICH_PENDING] Found ${pendingOrders.length} orders needing fee/price enrichment, ${stuckOrders.length} stuck PENDING orders`);

    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    let stuckProcessed = 0;
    let stuckSuccess = 0;

    // ======================================================================
    // Process fee/price enrichment orders (existing logic)
    // ======================================================================
    const ordersByUser = new Map<string, typeof pendingOrders>();
    for (const order of pendingOrders) {
      const orders = ordersByUser.get(order.user_id) || [];
      orders.push(order);
      ordersByUser.set(order.user_id, orders);
    }

    for (const [userIdToProcess, userOrders] of ordersByUser) {
      // Get all seller authorizations for this user (multi-marketplace)
      const { data: authRows } = await supabase
        .from('seller_authorizations')
        .select('refresh_token, marketplace_id')
        .eq('user_id', userIdToProcess);

      // Prefer US marketplace, fallback to first available
      const auth = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
      if (!auth?.refresh_token) {
        console.log(`[ENRICH_PENDING] No authorization for user ${userIdToProcess}, skipping`);
        continue;
      }

      let accessToken: string;
      try {
        accessToken = await getLWAAccessToken(auth.refresh_token);
      } catch (err) {
        console.error(`[ENRICH_PENDING] Failed to get access token for user ${userIdToProcess}:`, err);
        HealthSignals.spApiAuthError(userIdToProcess, 'enrich-pending-orders', (err as Error)?.message?.slice(0, 500));
        continue;
      }

      for (const order of userOrders) {
        totalProcessed++;
        const cooldownKey = order.sku || order.asin;

        try {
          // Log attempt started
          await supabase.from('enrichment_logs').insert({
            user_id: userIdToProcess,
            order_id: order.order_id,
            asin: order.asin,
            seller_sku: order.sku,
            enrichment_type: 'repair',
            source: 'enrich-pending-orders',
            status: 'started',
            attempts: (order.enrich_attempts || 0) + 1,
          });

          let awaitingConfirmedPrice = false;
          if (order.needs_price_enrich) {
            const orderItems = await fetchOrderItems(order.order_id, accessToken);
            const matchedItem = orderItems.find((item) =>
              item.asin === order.asin || (item.sku && item.sku === order.sku)
            ) || orderItems[0];

            if (matchedItem?.itemPrice && matchedItem.itemPrice > 0) {
              const qty = Math.max(1, Number(matchedItem.quantity || order.quantity || 1));
              const unitPrice = Math.round((Number(matchedItem.itemPrice) / qty) * 100) / 100;
              const totalSaleAmount = Math.round(Number(matchedItem.itemPrice) * 100) / 100;
              await supabase
                .from('sales_orders')
                .update({
                  asin: matchedItem.asin || order.asin,
                  sku: matchedItem.sku || order.sku,
                  title: matchedItem.title || order.title,
                  quantity: qty,
                  sold_price: unitPrice,
                  item_price: unitPrice,
                  total_sale_amount: totalSaleAmount,
                  price_source: 'orders_itemprice',
                  price_confidence: 'CONFIRMED',
                  price_enrich_status: 'enriched',
                  needs_price_enrich: false,
                  last_enrich_error: null,
                  next_enrich_after: null,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', order.id);
              console.log(`[ENRICH_PENDING] ✓ Direct ItemPrice for ${order.order_id}/${order.asin}: unit=$${unitPrice}, total=$${totalSaleAmount}`);
            } else {
              awaitingConfirmedPrice = true;
              // IMPORTANT: do NOT null estimated_price / fees / cost here.
              // The UI uses estimated_price (BB/snapshot fallback) so the row
              // shows a meaningful price while waiting for the real ItemPrice.
              // We only flag it pending and schedule the next retry.
              await supabase
                .from('sales_orders')
                .update({
                  needs_price_enrich: true,
                  needs_fee_enrich: false,
                  price_enrich_status: 'pending',
                  last_enrich_error: 'NO_CONFIRMED_ITEM_PRICE',
                  next_enrich_after: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .eq('id', order.id);
              console.log(`[ENRICH_PENDING] No confirmed ItemPrice yet for ${order.order_id}/${order.asin}; keeping pending (estimate preserved)`);
            }
          }

          if (awaitingConfirmedPrice) {
            await supabase.from('enrichment_logs').insert({
              user_id: userIdToProcess,
              order_id: order.order_id,
              asin: order.asin,
              seller_sku: order.sku,
              enrichment_type: 'repair',
              source: 'enrich-pending-orders',
              status: 'pending',
              error_message: 'NO_CONFIRMED_ITEM_PRICE',
              attempts: (order.enrich_attempts || 0) + 1,
            });
            totalSuccess++;
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }

          // Call sync-sales-orders for fee enrichment
          const { data: enrichResult, error: enrichError } = await supabase.functions.invoke('sync-sales-orders', {
            body: {
              enrich_by_asin: true,
              asin: order.asin,
              seller_sku: order.sku,
              user_id: userIdToProcess,
            },
          });

          if (enrichError) {
            const isRateLimit = enrichError.message?.includes('429');
            console.warn(`[ENRICH_PENDING] Enrichment failed for ${cooldownKey}:`, enrichError);
            HealthSignals.enrichmentRequeued(
              userIdToProcess,
              'enrich-pending-orders',
              isRateLimit ? 'rate_limited' : 'no_price',
              order.order_id,
            );
            
            // Update order with backoff
            const backoffMinutes = Math.min(5 * Math.pow(2, order.enrich_attempts || 0), 60);
            await supabase
              .from('sales_orders')
              .update({
                enrich_attempts: (order.enrich_attempts || 0) + 1,
                last_enrich_attempt_at: new Date().toISOString(),
                last_enrich_error: enrichError.message?.slice(0, 500),
                next_enrich_after: new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString(),
              })
              .eq('id', order.id);

            // Log failure
            await supabase.from('enrichment_logs').insert({
              user_id: userIdToProcess,
              order_id: order.order_id,
              asin: order.asin,
              seller_sku: order.sku,
              enrichment_type: 'repair',
              source: 'enrich-pending-orders',
              status: isRateLimit ? 'rate_limited' : 'failed',
              error_message: enrichError.message,
              attempts: (order.enrich_attempts || 0) + 1,
            });

            totalFailed++;

            if (isRateLimit) {
              console.log('[ENRICH_PENDING] Rate limited, stopping processing');
              break;
            }
          } else {
            const { data: refreshedOrder } = await supabase
              .from('sales_orders')
              .select('sold_price, total_sale_amount, needs_price_enrich, next_enrich_after')
              .eq('id', order.id)
              .maybeSingle();
            const hasConfirmedPrice =
              (Number(refreshedOrder?.sold_price) || 0) > 0 ||
              (Number(refreshedOrder?.total_sale_amount) || 0) > 0;

            console.log(`[ENRICH_PENDING] ✓ Enrichment attempt completed for ${cooldownKey} (confirmedPrice=${hasConfirmedPrice})`);
            
            // Only clear needs_price_enrich after a real Orders API/FEC price exists.
            // sync-sales-orders may return success while re-queueing the row because
            // Amazon was rate-limited or ItemPrice was still unavailable.
            const retryUpdate: Record<string, unknown> = {
              needs_fee_enrich: false,
            };
            if (hasConfirmedPrice) {
              retryUpdate.needs_price_enrich = false;
              retryUpdate.last_enrich_error = null;
              retryUpdate.next_enrich_after = null;
            } else {
              retryUpdate.needs_price_enrich = true;
              retryUpdate.last_enrich_error = 'NO_CONFIRMED_ITEM_PRICE';
              if (!refreshedOrder?.next_enrich_after) {
                retryUpdate.next_enrich_after = new Date(Date.now() + 15 * 60 * 1000).toISOString();
              }
            }

            await supabase
              .from('sales_orders')
              .update(retryUpdate)
              .eq('id', order.id);

            // Log success
            await supabase.from('enrichment_logs').insert({
              user_id: userIdToProcess,
              order_id: order.order_id,
              asin: order.asin,
              seller_sku: order.sku,
              enrichment_type: 'repair',
              source: 'enrich-pending-orders',
              status: 'success',
              attempts: (order.enrich_attempts || 0) + 1,
            });

            totalSuccess++;
          }

          // 2.2s delay between Orders API calls (Amazon quota: 0.5 req/sec)
          await new Promise(resolve => setTimeout(resolve, 2200));

        } catch (err: any) {
          console.error(`[ENRICH_PENDING] Exception for ${cooldownKey}:`, err);
          const message = (err as Error)?.message || 'ENRICHMENT_EXCEPTION';
          const isRateLimit = message.includes('429') || message.includes('QuotaExceeded');
          const backoffMinutes = isRateLimit ? 15 : Math.min(5 * Math.pow(2, order.enrich_attempts || 0), 60);
          // IMPORTANT: do NOT wipe estimated_price / fees / cost on transient
          // errors. Keep the existing BB/snapshot estimate so the UI shows
          // a meaningful price while we retry. Only flag pending + backoff.
          await supabase
            .from('sales_orders')
            .update({
              needs_price_enrich: true,
              needs_fee_enrich: false,
              price_enrich_status: 'pending',
              last_enrich_attempt_at: new Date().toISOString(),
              last_enrich_error: isRateLimit ? 'ORDER_ITEMS_RATE_LIMITED' : message.slice(0, 500),
              next_enrich_after: new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', order.id);
          totalFailed++;
        }
      }
    }

    // ======================================================================
    // Process stuck PENDING orders (NEW: fetch order items from Amazon)
    // ======================================================================
    const stuckByUser = new Map<string, typeof stuckOrders>();
    for (const order of stuckOrders) {
      const orders = stuckByUser.get(order.user_id) || [];
      orders.push(order);
      stuckByUser.set(order.user_id, orders);
    }

    for (const [userIdToProcess, userStuckOrders] of stuckByUser) {
      // Get all seller authorizations for this user (multi-marketplace)
      const { data: authRows } = await supabase
        .from('seller_authorizations')
        .select('refresh_token, marketplace_id')
        .eq('user_id', userIdToProcess);

      // Prefer US marketplace, fallback to first available
      const auth = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
      if (!auth?.refresh_token) {
        console.log(`[ENRICH_PENDING] No authorization for stuck orders user ${userIdToProcess}, skipping`);
        continue;
      }

      let accessToken: string;
      try {
        accessToken = await getLWAAccessToken(auth.refresh_token);
      } catch (err) {
        console.error(`[ENRICH_PENDING] Failed to get access token for stuck orders user ${userIdToProcess}:`, err);
        continue;
      }

      // Group stuck orders by order_id (one API call per order)
      const orderIdMap = new Map<string, typeof userStuckOrders>();
      for (const order of userStuckOrders) {
        const existing = orderIdMap.get(order.order_id) || [];
        existing.push(order);
        orderIdMap.set(order.order_id, existing);
      }

      for (const [orderId, stuckRows] of orderIdMap) {
        stuckProcessed++;
        const attempts = (stuckRows[0] as any).pending_enrich_attempts || 0;

        try {
          console.log(`[ENRICH_PENDING] Fetching order items for stuck order ${orderId} (attempt ${attempts + 1})`);
          
          // Log attempt
          await supabase.from('enrichment_logs').insert({
            user_id: userIdToProcess,
            order_id: orderId,
            asin: 'PENDING',
            enrichment_type: 'pending_asin_backfill',
            source: 'enrich-pending-orders',
            status: 'started',
            attempts: attempts + 1,
          });

          // Fetch order items from Amazon
          const orderItems = await fetchOrderItems(orderId, accessToken, auth.marketplace_id || 'ATVPDKIKX0DER');

          if (orderItems.length === 0) {
            console.warn(`[ENRICH_PENDING] No items returned for order ${orderId}`);
            
            // Update retry count with backoff
            const backoffMinutes = Math.min(15 * Math.pow(2, attempts), 120);
            for (const row of stuckRows) {
              await supabase
                .from('sales_orders')
                .update({
                  pending_enrich_attempts: attempts + 1,
                  pending_enrich_last_error: 'No items returned from API',
                  pending_enrich_last_attempt_at: new Date().toISOString(),
                })
                .eq('id', row.id);
            }
            
            await supabase.from('enrichment_logs').insert({
              user_id: userIdToProcess,
              order_id: orderId,
              asin: 'PENDING',
              enrichment_type: 'pending_asin_backfill',
              source: 'enrich-pending-orders',
              status: 'failed',
              error_message: 'No items returned from API',
              attempts: attempts + 1,
            });
            
            continue;
          }

          // Update the PENDING row(s) with real ASIN data
          // If multiple items, we may need to insert additional rows
          const resolvedAsins = new Set<string>();
          
          for (let i = 0; i < orderItems.length; i++) {
            const item = orderItems[i];
            resolvedAsins.add(item.asin);
            const hasOrderItemPrice = typeof item.itemPrice === 'number' && Number.isFinite(item.itemPrice) && item.itemPrice > 0;
            const itemUnitPrice = hasOrderItemPrice ? Number(item.itemPrice) : null;
            const itemTotalAmount = itemUnitPrice !== null ? itemUnitPrice * Math.max(item.quantity || 1, 1) : null;
            
            if (i < stuckRows.length) {
              // Update existing PENDING row
              const updatePayload: Record<string, any> = {
                asin: item.asin,
                title: item.title,
                sku: item.sku || null,
                quantity: item.quantity,
                pending_enrich_attempts: null,
                pending_enrich_last_error: null,
                pending_enrich_last_attempt_at: null,
              };

              if (itemUnitPrice !== null) {
                updatePayload.sold_price = itemUnitPrice;
                updatePayload.total_sale_amount = itemTotalAmount;
                updatePayload.price_source = 'order_items_api';
                updatePayload.needs_price_enrich = false;
              }

              await supabase
                .from('sales_orders')
                .update(updatePayload)
                .eq('id', stuckRows[i].id);
              
              console.log(`[ENRICH_PENDING] ✓ Updated PENDING row to ASIN ${item.asin} for order ${orderId}${itemUnitPrice !== null ? ` (price ${itemUnitPrice})` : ''}`);
            } else {
              // Need to insert a new row for additional items
              const { data: originalRow } = await supabase
                .from('sales_orders')
                .select('*')
                .eq('id', stuckRows[0].id)
                .single();
              
              if (originalRow) {
                const { id, created_at, updated_at, ...rowData } = originalRow;
                const insertPayload: Record<string, any> = {
                  ...rowData,
                  asin: item.asin,
                  title: item.title,
                  sku: item.sku || null,
                  quantity: item.quantity,
                  pending_enrich_attempts: null,
                  pending_enrich_last_error: null,
                  pending_enrich_last_attempt_at: null,
                };

                if (itemUnitPrice !== null) {
                  insertPayload.sold_price = itemUnitPrice;
                  insertPayload.total_sale_amount = itemTotalAmount;
                  insertPayload.price_source = 'order_items_api';
                  insertPayload.needs_price_enrich = false;
                }

                await supabase
                  .from('sales_orders')
                  .insert(insertPayload);
                
                console.log(`[ENRICH_PENDING] ✓ Inserted new row for ASIN ${item.asin} order ${orderId}${itemUnitPrice !== null ? ` (price ${itemUnitPrice})` : ''}`);
              }
            }
          }

          // If we had more PENDING rows than items, delete the extras
          if (stuckRows.length > orderItems.length) {
            for (let i = orderItems.length; i < stuckRows.length; i++) {
              await supabase
                .from('sales_orders')
                .delete()
                .eq('id', stuckRows[i].id);
              
              console.log(`[ENRICH_PENDING] Deleted extra PENDING row for order ${orderId}`);
            }
          }

          // ============================================================
          // IMMEDIATE ENRICHMENT: Fetch price, fees, and COGS right now
          // instead of deferring to a future cycle via needs_fee_enrich flag.
          // Calls sync-sales-orders enrich_by_asin for each resolved ASIN.
          // ============================================================
          for (const resolvedAsin of resolvedAsins) {
            try {
              console.log(`[ENRICH_PENDING] 💰 Immediately enriching ASIN ${resolvedAsin} (price + fees + COGS)`);
              const { error: enrichErr } = await supabase.functions.invoke('sync-sales-orders', {
                body: {
                  enrich_by_asin: true,
                  target_asin: resolvedAsin,
                  user_id: userIdToProcess,
                  force_price_update: true,
                },
              });
              if (enrichErr) {
                console.warn(`[ENRICH_PENDING] Fee enrichment failed for ${resolvedAsin}: ${enrichErr.message}`);
              } else {
                console.log(`[ENRICH_PENDING] ✓ Fully enriched ASIN ${resolvedAsin} (price + fees + COGS)`);
              }
            } catch (enrichEx: any) {
              console.warn(`[ENRICH_PENDING] Fee enrichment exception for ${resolvedAsin}: ${enrichEx?.message}`);
            }
            // Small delay between enrichment calls
            await new Promise(resolve => setTimeout(resolve, 300));
          }

          // Log success
          await supabase.from('enrichment_logs').insert({
            user_id: userIdToProcess,
            order_id: orderId,
            asin: orderItems.map(i => i.asin).join(','),
            enrichment_type: 'pending_asin_backfill',
            source: 'enrich-pending-orders',
            status: 'success',
            attempts: attempts + 1,
          });

          stuckSuccess++;

          // 2.2s delay between stuck-order fetches (Amazon Orders API quota)
          await new Promise(resolve => setTimeout(resolve, 2200));

        } catch (err: any) {
          console.error(`[ENRICH_PENDING] Exception processing stuck order ${orderId}:`, err);
          
          const isRateLimit = (err as Error).message?.includes('429') || (err as Error).message?.includes('QuotaExceeded');
          const backoffMinutes = Math.min(15 * Math.pow(2, attempts), 120);
          
          // Update retry count with backoff
          for (const row of stuckRows) {
            await supabase
              .from('sales_orders')
              .update({
                pending_enrich_attempts: attempts + 1,
                pending_enrich_last_error: (err as Error).message?.slice(0, 500),
                pending_enrich_last_attempt_at: new Date().toISOString(),
              })
              .eq('id', row.id);
          }

          await supabase.from('enrichment_logs').insert({
            user_id: userIdToProcess,
            order_id: orderId,
            asin: 'PENDING',
            enrichment_type: 'pending_asin_backfill',
            source: 'enrich-pending-orders',
            status: isRateLimit ? 'rate_limited' : 'failed',
            error_message: (err as Error).message,
            attempts: attempts + 1,
          });

          if (isRateLimit) {
            console.log('[ENRICH_PENDING] Rate limited on stuck orders, stopping');
            break;
          }
        }
      }
    }

    // ======================================================================
    // PART 3: SWEEP — Enrich resolved orders still missing price/fees/COGS
    // These are orders that have a real ASIN but were resolved before the
    // inline enrichment was added. One enrich_by_asin call per unique ASIN.
    // ======================================================================
    let sweepEnriched = 0;
    if (force && userId) {
      // Find distinct ASINs that still have missing data for this user
      const { data: incompleteRows } = await supabase
        .from('sales_orders')
        .select('asin')
        .eq('user_id', userId)
        .neq('asin', 'PENDING')
        .neq('asin', 'UNKNOWN')
        .not('asin', 'is', null)
        .or('sold_price.eq.0,sold_price.is.null,total_fees.is.null,fees_source.eq.unavailable')
        .order('created_at', { ascending: false })
        .limit(200);

      if (incompleteRows && incompleteRows.length > 0) {
        const uniqueAsins = [...new Set(incompleteRows.map((r: any) => r.asin))];
        console.log(`[ENRICH_PENDING] SWEEP: Found ${incompleteRows.length} orders (${uniqueAsins.length} unique ASINs) with missing price/fees`);

        // Get user's seller authorization for the LWA token
        const { data: sweepAuth } = await supabase
          .from('seller_authorizations')
          .select('refresh_token, marketplace_id')
          .eq('user_id', userId);
        const auth = sweepAuth?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || sweepAuth?.[0];

        if (auth?.refresh_token) {
          for (const asin of uniqueAsins) {
            try {
              console.log(`[ENRICH_PENDING] SWEEP: Enriching ${asin} (price + fees + COGS)`);
              const { error: enrichErr } = await supabase.functions.invoke('sync-sales-orders', {
                body: {
                  enrich_by_asin: true,
                  target_asin: asin,
                  user_id: userId,
                  force_price_update: true,
                },
              });
              if (enrichErr) {
                console.warn(`[ENRICH_PENDING] SWEEP: Failed ${asin}: ${enrichErr.message}`);
              } else {
                sweepEnriched++;
                console.log(`[ENRICH_PENDING] SWEEP: ✓ Enriched ${asin}`);
              }
              await new Promise(resolve => setTimeout(resolve, 300));
            } catch (ex: any) {
              console.warn(`[ENRICH_PENDING] SWEEP: Exception ${asin}: ${ex?.message}`);
            }
          }
        }
      }
    }

    console.log(`[ENRICH_PENDING] Complete: fee/price ${totalProcessed} processed (${totalSuccess} success, ${totalFailed} failed), stuck PENDING ${stuckProcessed} processed (${stuckSuccess} success), sweep ${sweepEnriched} ASINs enriched`);

    const has_more = (pendingOrders.length + stuckOrders.length) >= limit;
    return new Response(JSON.stringify({
      success: true,
      processed: totalProcessed,
      successCount: totalSuccess,
      failed: totalFailed,
      stuckPendingProcessed: stuckProcessed,
      stuckPendingSuccess: stuckSuccess,
      sweepEnriched,
      has_more,
      totalCandidates: pendingOrders.length + stuckOrders.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[ENRICH_PENDING] Error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
