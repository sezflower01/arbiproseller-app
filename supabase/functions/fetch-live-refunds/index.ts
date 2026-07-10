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
    console.error('LWA token error:', error);
    throw new Error('Failed to get LWA access token');
  }

  const data = await response.json();
  return data.access_token;
}


// Amazon business day = midnight-to-midnight in Pacific Time
const AMAZON_BUSINESS_TZ = 'America/Los_Angeles';

// Convert ISO timestamp to Pacific Time date string (YYYY-MM-DD)
// This is the CORRECT approach: format directly in PT, no hour shifting
function getPacificDateString(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString('en-CA', { timeZone: AMAZON_BUSINESS_TZ });
  } catch {
    return new Date(isoDate).toLocaleDateString('en-CA', { timeZone: 'UTC' });
  }
}

// Legacy alias for compatibility - now just uses PT directly
function getCutoffDateStringInTimeZone(isoDate: string, _timeZone: string): string {
  return getPacificDateString(isoDate);
}

// Currency conversion rates to USD
function convertToUSD(amount: number, currency: string): number {
  const rates: Record<string, number> = {
    'USD': 1,
    'CAD': 0.73,
    'MXN': 0.05,
    'BRL': 0.17,
    'GBP': 1.27,
    'EUR': 1.08,
  };
  return amount * (rates[currency] || 1);
}

// Convert a business-day date-range (YYYY-MM-DD) into UTC timestamps for SP-API.
// Source of truth: Amazon business day = midnight-to-midnight in Pacific Time.
// We therefore build the date window in PT and convert it to UTC.
function getBusinessDayRangeUTC(
  startYYYYMMDD: string,
  endYYYYMMDD: string,
  _userTz: string,
): { startUTC: string; endUTC: string } {
  // Build a Date at noon UTC for stable parsing then derive the offset for that date.
  const toUtcForTzLocal = (dateYYYYMMDD: string, h: number, m: number, s: number, ms: number, tz: string) => {
    const [y, mo, d] = dateYYYYMMDD.split('-').map(Number);

    // Start with an approximate UTC date near the target to compute offset.
    const approx = new Date(Date.UTC(y, mo - 1, d, h + 8, m, s, ms));

    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const parts = fmt.formatToParts(approx);
    const get = (t: string) => parts.find(p => p.type === t)?.value;
    const tzY = Number(get('year'));
    const tzM = Number(get('month'));
    const tzD = Number(get('day'));
    const tzH = Number(get('hour'));
    const tzMin = Number(get('minute'));
    const tzS = Number(get('second'));

    const desiredLocal = Date.UTC(y, mo - 1, d, h, m, s, ms);
    const currentLocal = Date.UTC(tzY, tzM - 1, tzD, tzH, tzMin, tzS, 0);

    const deltaMs = desiredLocal - currentLocal;
    return new Date(approx.getTime() + deltaMs);
  };

  // Start at 00:00:00.000 PT on the start date
  const start = toUtcForTzLocal(startYYYYMMDD, 0, 0, 0, 0, AMAZON_BUSINESS_TZ);

  // End at 23:59:59.999 PT on the end date
  const endPlusOne = new Date(endYYYYMMDD + 'T12:00:00');
  endPlusOne.setDate(endPlusOne.getDate() + 1);
  const endPlusOneISO = `${endPlusOne.getFullYear()}-${String(endPlusOne.getMonth() + 1).padStart(2, '0')}-${String(endPlusOne.getDate()).padStart(2, '0')}`;
  const endExclusive = toUtcForTzLocal(endPlusOneISO, 0, 0, 0, 0, AMAZON_BUSINESS_TZ);
  const end = new Date(endExclusive.getTime() - 1);

  // Amazon requires end date to be no later than ~2 minutes from now
  const maxEndDate = new Date(Date.now() - 3 * 60 * 1000);
  const effectiveEnd = end > maxEndDate ? maxEndDate : end;

  return { startUTC: start.toISOString(), endUTC: effectiveEnd.toISOString() };
}

async function fetchFinancialEventGroups(accessToken: string, startUTC: string, endUTC: string): Promise<any[]> {
  const allGroups: any[] = [];
  let nextToken: string | undefined;

  do {
    const url = new URL('https://sellingpartnerapi-na.amazon.com/finances/v0/financialEventGroups');
    url.searchParams.set('FinancialEventGroupStartedAfter', startUTC);
    url.searchParams.set('FinancialEventGroupStartedBefore', endUTC);
    url.searchParams.set('MaxResultsPerPage', '100');
    if (nextToken) url.searchParams.set('NextToken', nextToken);

    const headers = await signRequest('GET', url.toString(), '', accessToken);
    const res = await fetch(url.toString(), { method: 'GET', headers });

    if (res.status === 429) {
      console.log('[LIVE_REFUNDS] EventGroups rate limited, waiting 2s...');
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      console.error('[LIVE_REFUNDS] EventGroups API error:', res.status, text);
      break;
    }

    const json = await res.json();
    const groups = json?.payload?.FinancialEventGroupList || [];
    allGroups.push(...groups);
    nextToken = json?.payload?.NextToken;

    if (nextToken) await new Promise(r => setTimeout(r, 500));
  } while (nextToken);

  return allGroups;
}

async function fetchFinancialEventsByGroupId(accessToken: string, groupId: string): Promise<any | null> {
  const url = new URL(`https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents/${encodeURIComponent(groupId)}`);
  // Per spec this endpoint supports MaxResultsPerPage + NextToken too, but most groups fit in one call.
  url.searchParams.set('MaxResultsPerPage', '100');

  const headers = await signRequest('GET', url.toString(), '', accessToken);
  const res = await fetch(url.toString(), { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    console.error('[LIVE_REFUNDS] EventsByGroup API error:', res.status, text);
    return null;
  }
  const json = await res.json();
  return json?.payload?.FinancialEvents || null;
}

// ============================================================
// NEW FINANCES API v2024-06-19: listTransactions with transactionStatus filter
// This captures DEFERRED refunds that the old listFinancialEvents API misses
// ============================================================
async function fetchDeferredTransactions(
  accessToken: string, 
  startUTC: string, 
  endUTC: string,
  userTimezone: string,
  maxPages: number = 20
): Promise<{ orderId: string; postedDate: string; amount: number; asin: string; sku: string; referralFee: number; isDeferred: boolean }[]> {
  const deferredRefunds: { orderId: string; postedDate: string; amount: number; asin: string; sku: string; referralFee: number; isDeferred: boolean }[] = [];
  let nextToken: string | undefined;
  let pageCount = 0;
  
  console.log(`[LIVE_REFUNDS] Fetching DEFERRED transactions via Finances API v2024-06-19 (max ${maxPages} pages)`);
  
  do {
    const url = new URL('https://sellingpartnerapi-na.amazon.com/finances/2024-06-19/transactions');
    url.searchParams.set('postedAfter', startUTC);
    url.searchParams.set('postedBefore', endUTC);
    url.searchParams.set('transactionStatus', 'DEFERRED');
    url.searchParams.set('maxResults', '100');
    if (nextToken) url.searchParams.set('nextToken', nextToken);
    
    const headers = await signRequest('GET', url.toString(), '', accessToken);
    const res = await fetch(url.toString(), { method: 'GET', headers });
    
    if (res.status === 429) {
      console.log('[LIVE_REFUNDS] Deferred transactions rate limited, waiting 2s...');
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    
    if (!res.ok) {
      const text = await res.text();
      console.error('[LIVE_REFUNDS] Deferred transactions API error:', res.status, text);
      break;
    }
    
    const json = await res.json();
    const payload = (json && (json.payload ?? json)) as any;
    const transactions = payload?.transactions || [];

    console.log(`[LIVE_REFUNDS] Deferred page ${pageCount + 1}: ${transactions.length} transactions`);

    for (const tx of transactions) {
      const description = String(tx.description || '');
      const isRefundTx = /refund/i.test(description);
      if (!isRefundTx) continue;
      
      const related = Array.isArray(tx.relatedIdentifiers) ? tx.relatedIdentifiers : [];
      let orderId = related.find((ri: any) => ri.relatedIdentifierName === 'ORDER_ID')?.relatedIdentifierValue;
      if (!orderId) {
        const match = JSON.stringify(related).match(/\d{3}-\d{7}-\d{7}/);
        if (match) orderId = match[0];
      }
      orderId = orderId || 'Unknown';
      const postedDate = tx.postedDate || '';
      const postedDateOnly = postedDate ? getCutoffDateStringInTimeZone(postedDate, userTimezone) : '';
      
      // Get the principal refund amount from breakdown
      let refundAmount = 0;
      let referralFee = 0;
      
      // Total amount from the transaction
      const totalAmt = tx.totalAmount;
      if (totalAmt?.currencyCode && totalAmt?.currencyAmount) {
        const rawAmount = parseFloat(totalAmt.currencyAmount);
        if (!isNaN(rawAmount) && rawAmount < 0) {
          // Negative = refund to customer
          refundAmount = Math.abs(convertToUSD(rawAmount, totalAmt.currencyCode));
        }
      }
      
      // Extract ASIN and SKU from items (schema: items[].relatedIdentifiers)
      let asin = 'UNKNOWN';
      let sku = '';
      const txItems = Array.isArray(tx.items) ? tx.items : [];
      const firstItem = txItems[0];
      const itemRelated = Array.isArray(firstItem?.relatedIdentifiers) ? firstItem.relatedIdentifiers : [];
      for (const ri of itemRelated) {
        const name = String(ri?.itemRelatedIdentifierName || ri?.relatedIdentifierName || '').toUpperCase();
        const value = String(ri?.itemRelatedIdentifierValue || ri?.relatedIdentifierValue || '');
        if (!value) continue;
        if (name.includes('ASIN')) asin = value;
        if (name.includes('SKU')) sku = value;
      }
      
      // Get fees from breakdown
      const breakdowns = tx.breakdowns || [];
      for (const bd of breakdowns) {
        if (bd.breakdownType === 'Fees' && bd.breakdownAmount) {
          const feeAmount = parseFloat(bd.breakdownAmount.currencyAmount || 0);
          if (!isNaN(feeAmount) && feeAmount !== 0) {
            referralFee += Math.abs(convertToUSD(feeAmount, bd.breakdownAmount.currencyCode));
          }
        }
      }
      
      if (refundAmount > 0) {
        deferredRefunds.push({
          orderId,
          postedDate: postedDateOnly,
          amount: refundAmount,
          asin,
          sku,
          referralFee,
          isDeferred: true,
        });
        console.log(`[LIVE_REFUNDS] Found DEFERRED refund: ${orderId} | ${asin} | $${refundAmount.toFixed(2)}`);
      }
    }
    
    nextToken = payload?.nextToken;
    pageCount++;
    
    if (nextToken) {
      await new Promise(r => setTimeout(r, 300));
    }
  } while (nextToken && pageCount < maxPages);
  
  console.log(`[LIVE_REFUNDS] Found ${deferredRefunds.length} DEFERRED refunds from new API`);
  return deferredRefunds;
}

// Orders API fallback: resolve ASIN for a refund when Finances payload doesn't include it.
// Uses Orders v0 GetOrderItems; returns first ASIN found.
async function fetchFirstAsinFromOrderItems(accessToken: string, orderId: string): Promise<string | null> {
  const url = new URL(`https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`);
  const headers = await signRequest('GET', url.toString(), '', accessToken);
  const res = await fetch(url.toString(), { method: 'GET', headers });

  if (!res.ok) {
    const text = await res.text();
    console.warn(`[LIVE_REFUNDS] Orders API GetOrderItems failed for ${orderId}: ${res.status} ${text}`);
    return null;
  }

  const json = await res.json();
  const items = json?.payload?.OrderItems || [];
  const asin = items.find((it: any) => typeof it?.ASIN === 'string' && it.ASIN.length > 0)?.ASIN;
  return asin || null;
}

interface RefundRecord {
  orderId: string;
  postedDate: string;
  amount: number;
  asin: string;
  sku?: string;
  referralFee: number;
  title?: string;
  imageUrl?: string;
  isDeferred?: boolean;  // Track if this is a deferred refund
  adjustmentType?: string;  // Track the type of adjustment
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get user from auth header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No auth header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: claims, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claims?.claims?.sub) {
      console.error('[LIVE_REFUNDS] Auth error:', claimsError?.message || 'No claims');
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const user = { id: claims.claims.sub };

    // Parse request body
    const { start_date, end_date, timezone } = await req.json();

    if (!start_date || !end_date) {
      return new Response(JSON.stringify({ error: 'start_date and end_date required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

// User timezone for 2am cutoff date calculation (same as orders)
    const userTimezone = timezone || 'America/Chicago';
    
    // Store the requested date range for client-side filtering
    const requestedStartDate = start_date;
    const requestedEndDate = end_date;

    console.log(`[LIVE_REFUNDS] Fetching refunds for user ${user.id} from ${start_date} to ${end_date} (tz: ${userTimezone})`);

    // Get seller authorization (prefer US marketplace, fallback to any)
    const { data: authRows, error: authFetchError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id')
      .eq('user_id', user.id);

    if (authFetchError || !authRows || authRows.length === 0) {
      return new Response(JSON.stringify({ error: 'Amazon account not connected' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Prefer US marketplace, fallback to first available
    const auth = authRows.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows[0];

    const accessToken = await getLWAAccessToken(auth.refresh_token);

    // Use user's timezone for BUSINESS-day boundaries (2am cutoff) converted to UTC (handles DST correctly)
    const { startUTC, endUTC } = getBusinessDayRangeUTC(start_date, end_date, userTimezone);

    const refundRecords: RefundRecord[] = [];
    let totalRefundAmount = 0;
    let totalReferralFeeRefund = 0;
    let nextToken: string | undefined;
    let pageCount = 0;
    const maxPages = 50; // Hard cap

    // CRITICAL: Edge functions have ~50s max execution time
    // We need strict time budgeting to prevent timeouts
    const startedAtMs = Date.now();
    const maxTotalRuntimeMs = 45_000; // Hard limit for entire function
    const maxMainLoopMs = 15_000; // Time budget for main financial events loop
    const maxDeferredMs = 10_000; // Time budget for deferred transactions
    let isPartial = false;
    
    // Helper to check remaining time
    const getElapsedMs = () => Date.now() - startedAtMs;
    const hasTimeBudget = (budgetMs: number) => getElapsedMs() < budgetMs;

    // ============================================================
    // 1) Primary source: listFinancialEvents (PostedAfter/PostedBefore)
    // ============================================================
    let rateLimitRetries = 0;
    const maxRateLimitRetries = 3;

    do {
      // Time budget guard - use main loop budget
      if (!hasTimeBudget(maxMainLoopMs)) {
        console.warn(`[LIVE_REFUNDS] Main loop time budget exceeded (${maxMainLoopMs}ms). Returning partial results.`);
        isPartial = true;
        break;
      }
      
      // Also check total runtime to prevent edge function timeout
      if (!hasTimeBudget(maxTotalRuntimeMs)) {
        console.error(`[LIVE_REFUNDS] Total runtime exceeded (${maxTotalRuntimeMs}ms). Returning immediately.`);
        isPartial = true;
        break;
      }

      const eventsUrl = new URL('https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents');
      eventsUrl.searchParams.set('PostedAfter', startUTC);
      eventsUrl.searchParams.set('PostedBefore', endUTC);
      eventsUrl.searchParams.set('MaxResultsPerPage', '100');
      if (nextToken) eventsUrl.searchParams.set('NextToken', nextToken);

      console.log(`[LIVE_REFUNDS] Fetching page ${pageCount + 1}`);

      const headers = await signRequest('GET', eventsUrl.toString(), '', accessToken);
      const response = await fetch(eventsUrl.toString(), { method: 'GET', headers });

      // Handle rate limiting with exponential backoff (bounded)
      if (response.status === 429) {
        rateLimitRetries++;
        isPartial = true; // If we get rate-limited, we may not get the full set

        if (rateLimitRetries > maxRateLimitRetries) {
          console.error(`[LIVE_REFUNDS] Max rate limit retries (${maxRateLimitRetries}) exceeded, returning partial results`);
          break;
        }

        const backoffMs = Math.min(750 * Math.pow(2, rateLimitRetries), 4000); // Max 4s to avoid hanging
        console.log(`[LIVE_REFUNDS] Rate limited on page ${pageCount + 1}, waiting ${backoffMs}ms (retry ${rateLimitRetries}/${maxRateLimitRetries})`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue; // Retry the same page
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[LIVE_REFUNDS] API error: ${response.status} - ${errorText}`);
        isPartial = true;
        break;
      }

      // Reset rate limit retries on successful request
      rateLimitRetries = 0;

      const data = await response.json();
      const events = data?.payload?.FinancialEvents;


      // Process refund events - matching P&L logic exactly
      for (const event of events?.RefundEventList || []) {
        const orderId = event.AmazonOrderId || 'Unknown';
        const postedDate = event.PostedDate || '';
        
        // Use 2am cutoff for consistency with orders (same business-day logic)
        const postedDateOnly = postedDate ? getCutoffDateStringInTimeZone(postedDate, userTimezone) : '';
        
        // Process each item in the refund event separately (like P&L does)
        for (const item of event.ShipmentItemAdjustmentList || []) {
          const asin = item.ASIN || 'UNKNOWN';
          const sku = item.SellerSKU || '';
          let itemRefundAmount = 0;
          let itemReferralFee = 0;
          
          // Get refund amount from ItemChargeAdjustmentList - start with Principal (item price)
          for (const charge of item.ItemChargeAdjustmentList || []) {
            const chargeType = charge.ChargeType || '';
            const currency = charge.ChargeAmount?.CurrencyCode || 'USD';
            const rawAmount = parseFloat(charge.ChargeAmount?.CurrencyAmount || 0);
            
            // Debug log all charge types for investigation
            if (asin === 'B005MTYH1M' || rawAmount !== 0) {
              console.log(`[LIVE_REFUNDS] ASIN ${asin} ChargeType: ${chargeType}, Amount: ${rawAmount} ${currency}`);
            }
            
            // Only include Principal charge (the actual item price refund), not Tax, Shipping, etc.
            if (chargeType === 'Principal') {
              if (!isNaN(rawAmount) && rawAmount !== 0) {
                const amount = Math.abs(convertToUSD(rawAmount, currency));
                itemRefundAmount += amount;
              }
            }
          }
          
          // Adjust for promotions: subtract any promotion adjustments from the Principal refund
          for (const promo of item.PromotionAdjustmentList || []) {
            const currency = promo.PromotionAmount?.CurrencyCode || 'USD';
            const rawAmount = parseFloat(promo.PromotionAmount?.CurrencyAmount || 0);
            if (!isNaN(rawAmount) && rawAmount !== 0) {
              const promoAmount = Math.abs(convertToUSD(rawAmount, currency));
              console.log(`[LIVE_REFUNDS] ASIN ${asin} PromotionAdjustment: ${promoAmount} ${currency}`);
              // Promotions reduce the effective refund amount (customer originally paid less)
              itemRefundAmount -= promoAmount;
            }
          }

          // Clamp at zero in case promotions exceed principal
          if (itemRefundAmount < 0) {
            itemRefundAmount = 0;
          }
          
          // Get fees from ItemFeeAdjustmentList (negative = refund back to seller)
          // Commission, RefundCommission, and VariableClosingFee all reduce net refund
          let feesRefundedToSeller = 0;
          for (const fee of item.ItemFeeAdjustmentList || []) {
            const feeType = fee.FeeType || '';
            const currency = fee.FeeAmount?.CurrencyCode || 'USD';
            const rawFeeAmount = parseFloat(fee.FeeAmount?.CurrencyAmount || 0);
            const signedAmount = convertToUSD(rawFeeAmount, currency);
            const amount = Math.abs(signedAmount);
            
            // Debug log fee adjustments
            if (amount > 0) {
              console.log(`[LIVE_REFUNDS] ASIN ${asin} FeeType: ${feeType}, Amount: ${rawFeeAmount} ${currency}`);
            }
            
            // Track all fees for referralFee field
            if (feeType === 'FBAPerUnitFulfillmentFee' || feeType === 'Commission' || feeType === 'RefundCommission' || feeType === 'VariableClosingFee') {
              itemReferralFee += amount;
            }
            
            // Commission, RefundCommission, VariableClosingFee reduce net refund (positive = refunded to seller)
            if (feeType === 'Commission' || feeType === 'RefundCommission' || feeType === 'VariableClosingFee') {
              feesRefundedToSeller += signedAmount;
            }
          }
          
          // Calculate NET refund = Principal - net fees refunded to seller (matches Seller Central)
          const feeDebit = feesRefundedToSeller > 0 ? feesRefundedToSeller : 0;
          const netRefundAmount = Math.max(0, itemRefundAmount - feeDebit);
          
          // Count refund only if there's a real monetary impact (skip $0 replacement/goodwill refunds)
          if (netRefundAmount > 0) {
            refundRecords.push({
              orderId,
              postedDate: postedDateOnly,
              amount: netRefundAmount, // Use NET refund, not gross
              asin,
              sku,
              referralFee: itemReferralFee,
            });
            totalRefundAmount += netRefundAmount;
            totalReferralFeeRefund += itemReferralFee;
          } else {
            console.log(`[LIVE_REFUNDS] Skipping $0 refund for ${orderId} / ${asin} (net=${netRefundAmount}, gross=${itemRefundAmount})`);
          }
        }
      }

      // Also treat Guarantee Claim events as refunds (use adjustment lists for consistency)
      for (const event of events?.GuaranteeClaimEventList || []) {
        const orderId = event.AmazonOrderId || 'Unknown';
        const postedDate = event.PostedDate || '';
        const postedDateOnly = postedDate ? getCutoffDateStringInTimeZone(postedDate, userTimezone) : '';

        for (const item of event.ShipmentItemAdjustmentList || []) {
          const asin = item.ASIN || 'UNKNOWN';
          const sku = item.SellerSKU || '';
          let itemRefundAmount = 0;
          let itemReferralFee = 0;

          // Sum Principal charge as base refund amount (not tax/shipping)
          for (const charge of item.ItemChargeAdjustmentList || []) {
            const chargeType = charge.ChargeType || '';
            if (chargeType === 'Principal') {
              const currency = charge.ChargeAmount?.CurrencyCode || 'USD';
              const rawAmount = parseFloat(charge.ChargeAmount?.CurrencyAmount || 0);
              if (!isNaN(rawAmount) && rawAmount !== 0) {
                const amount = Math.abs(convertToUSD(rawAmount, currency));
                itemRefundAmount += amount;
              }
            }
          }

          // Adjust for promotions: subtract any promotion adjustments from the Principal refund
          for (const promo of item.PromotionAdjustmentList || []) {
            const currency = promo.PromotionAmount?.CurrencyCode || 'USD';
            const rawAmount = parseFloat(promo.PromotionAmount?.CurrencyAmount || 0);
            if (!isNaN(rawAmount) && rawAmount !== 0) {
              const promoAmount = Math.abs(convertToUSD(rawAmount, currency));
              itemRefundAmount -= promoAmount;
            }
          }

          if (itemRefundAmount < 0) {
            itemRefundAmount = 0;
          }

          let feesRefundedToSeller = 0;
          for (const fee of item.ItemFeeAdjustmentList || []) {
            const feeType = fee.FeeType || '';
            if (feeType === 'FBAPerUnitFulfillmentFee' || feeType === 'Commission' || feeType === 'RefundCommission' || feeType === 'VariableClosingFee') {
              const currency = fee.FeeAmount?.CurrencyCode || 'USD';
              const rawAmount = parseFloat(fee.FeeAmount?.CurrencyAmount || 0);
              if (!isNaN(rawAmount) && rawAmount !== 0) {
                const signedAmount = convertToUSD(rawAmount, currency);
                const amount = Math.abs(signedAmount);
                itemReferralFee += amount;
                if (feeType === 'Commission' || feeType === 'RefundCommission' || feeType === 'VariableClosingFee') {
                  feesRefundedToSeller += signedAmount;
                }
              }
            }
          }

          // Calculate NET refund = Principal - net fees refunded to seller
          const feeDebit = feesRefundedToSeller > 0 ? feesRefundedToSeller : 0;
          const netRefundAmount = Math.max(0, itemRefundAmount - feeDebit);

          if (netRefundAmount > 0) {
            refundRecords.push({
              orderId,
              postedDate: postedDateOnly,
              amount: netRefundAmount,
              asin,
              sku,
              referralFee: itemReferralFee,
            });
            totalRefundAmount += netRefundAmount;
            totalReferralFeeRefund += itemReferralFee;
          } else {
            console.log(`[LIVE_REFUNDS] Skipping $0 guarantee claim for ${orderId} / ${asin}`);
          }
        }
      }

      // Also treat Chargeback events as refunds (use adjustment lists for consistency)
      for (const event of events?.ChargebackEventList || []) {
        const orderId = event.AmazonOrderId || 'Unknown';
        const postedDate = event.PostedDate || '';
        const postedDateOnly = postedDate ? getCutoffDateStringInTimeZone(postedDate, userTimezone) : '';

        for (const item of event.ShipmentItemAdjustmentList || []) {
          const asin = item.ASIN || 'UNKNOWN';
          const sku = item.SellerSKU || '';
          let itemRefundAmount = 0;
          let itemReferralFee = 0;

          // Sum Principal charge as base refund amount (not tax/shipping)
          for (const charge of item.ItemChargeAdjustmentList || []) {
            const chargeType = charge.ChargeType || '';
            if (chargeType === 'Principal') {
              const currency = charge.ChargeAmount?.CurrencyCode || 'USD';
              const rawAmount = parseFloat(charge.ChargeAmount?.CurrencyAmount || 0);
              if (!isNaN(rawAmount) && rawAmount !== 0) {
                const amount = Math.abs(convertToUSD(rawAmount, currency));
                itemRefundAmount += amount;
              }
            }
          }

          // Adjust for promotions: subtract any promotion adjustments from the Principal refund
          for (const promo of item.PromotionAdjustmentList || []) {
            const currency = promo.PromotionAmount?.CurrencyCode || 'USD';
            const rawAmount = parseFloat(promo.PromotionAmount?.CurrencyAmount || 0);
            if (!isNaN(rawAmount) && rawAmount !== 0) {
              const promoAmount = Math.abs(convertToUSD(rawAmount, currency));
              itemRefundAmount -= promoAmount;
            }
          }

          if (itemRefundAmount < 0) {
            itemRefundAmount = 0;
          }

          let feesRefundedToSeller = 0;
          for (const fee of item.ItemFeeAdjustmentList || []) {
            const feeType = fee.FeeType || '';
            if (feeType === 'FBAPerUnitFulfillmentFee' || feeType === 'Commission' || feeType === 'RefundCommission' || feeType === 'VariableClosingFee') {
              const currency = fee.FeeAmount?.CurrencyCode || 'USD';
              const rawAmount = parseFloat(fee.FeeAmount?.CurrencyAmount || 0);
              if (!isNaN(rawAmount) && rawAmount !== 0) {
                const signedAmount = convertToUSD(rawAmount, currency);
                const amount = Math.abs(signedAmount);
                itemReferralFee += amount;
                if (feeType === 'Commission' || feeType === 'RefundCommission' || feeType === 'VariableClosingFee') {
                  feesRefundedToSeller += signedAmount;
                }
              }
            }
          }

          // Calculate NET refund = Principal - net fees refunded to seller
          const feeDebit = feesRefundedToSeller > 0 ? feesRefundedToSeller : 0;
          const netRefundAmount = Math.max(0, itemRefundAmount - feeDebit);

          if (netRefundAmount > 0) {
            refundRecords.push({
              orderId,
              postedDate: postedDateOnly,
              amount: netRefundAmount,
              asin,
              sku,
              referralFee: itemReferralFee,
            });
            totalRefundAmount += netRefundAmount;
            totalReferralFeeRefund += itemReferralFee;
          } else {
            console.log(`[LIVE_REFUNDS] Skipping $0 chargeback for ${orderId} / ${asin}`);
          }
        }
      }

      // ============================================================
      // Process AdjustmentEventList (includes deferred refunds and other adjustments)
      // ============================================================
      for (const event of events?.AdjustmentEventList || []) {
        const adjustmentType = event.AdjustmentType || 'Unknown';
        const postedDate = event.PostedDate || '';
        const postedDateOnly = postedDate ? getCutoffDateStringInTimeZone(postedDate, userTimezone) : '';
        
        // SKIP ALL adjustment events entirely.
        // Real customer refunds come from RefundEventList (with proper Order IDs).
        // AdjustmentEventList contains inventory adjustments (FBACustomerReturn, etc.)
        // which are NOT actual monetary refunds - they track inventory movement only.
        // Including them causes false refund entries with SKU IDs instead of Order IDs.
        console.log(`[LIVE_REFUNDS] Skipping adjustment event entirely: ${adjustmentType} (adjustments are not customer refunds)`);
        continue;
        
        console.log(`[LIVE_REFUNDS] Processing refund adjustment: ${adjustmentType}, PostedDate: ${postedDateOnly}`);
        
        for (const item of event.AdjustmentItemList || []) {
          const asin = item.ASIN || 'UNKNOWN';
          const sku = item.SellerSKU || '';
          const orderId = item.FnSku || sku || `ADJ-${postedDateOnly}`;
          
          let itemRefundAmount = 0;
          
          // Get amount from PerUnitAmount (this is the reimbursement/adjustment amount per unit)
          const perUnitCurrency = item.PerUnitAmount?.CurrencyCode || 'USD';
          const perUnitRaw = parseFloat(item.PerUnitAmount?.CurrencyAmount || 0);
          const quantity = parseInt(item.Quantity || '1', 10);
          
          if (!isNaN(perUnitRaw) && perUnitRaw !== 0) {
            // For adjustments, positive = money to seller, negative = deduction
            const converted = convertToUSD(Math.abs(perUnitRaw), perUnitCurrency);
            itemRefundAmount = converted * Math.abs(quantity);
            
            console.log(`[LIVE_REFUNDS] Adjustment: ${adjustmentType} | ASIN: ${asin} | PerUnit: $${perUnitRaw} x ${quantity} = $${itemRefundAmount.toFixed(2)}`);
          }
          
          // Also check TotalAmount if PerUnitAmount is 0
          if (itemRefundAmount === 0 && item.TotalAmount) {
            const totalCurrency = item.TotalAmount?.CurrencyCode || 'USD';
            const totalRaw = parseFloat(item.TotalAmount?.CurrencyAmount || 0);
            if (!isNaN(totalRaw) && totalRaw !== 0) {
              itemRefundAmount = Math.abs(convertToUSD(totalRaw, totalCurrency));
              console.log(`[LIVE_REFUNDS] Adjustment TotalAmount: ${adjustmentType} | ASIN: ${asin} | Total: $${itemRefundAmount.toFixed(2)}`);
            }
          }
          
          if (itemRefundAmount > 0) {
            refundRecords.push({
              orderId,
              postedDate: postedDateOnly,
              amount: itemRefundAmount,
              asin,
              sku,
              referralFee: 0,
              isDeferred: adjustmentType.includes('Reserve') || adjustmentType.includes('Deferred'),
              adjustmentType,
            });
            totalRefundAmount += itemRefundAmount;
            console.log(`[LIVE_REFUNDS] Added adjustment as refund: ${orderId} | ${asin} | $${itemRefundAmount.toFixed(2)} | Type: ${adjustmentType}`);
          }
        }
      }

      nextToken = data?.payload?.NextToken;
      pageCount++;

      if (nextToken) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } while (nextToken && pageCount < maxPages);

    console.log(`[LIVE_REFUNDS] listFinancialEvents complete: Found ${refundRecords.length} refunds totaling $${totalRefundAmount.toFixed(2)}`);
    console.log(`[LIVE_REFUNDS] Total referral fee refunds: $${totalReferralFeeRefund.toFixed(2)}`);

    // ============================================================
    // 2) Secondary source: NEW Finances API v2024-06-19 for DEFERRED refunds
    // This captures refunds that are visible in Seller Central but not yet "Released"
    // ONLY run if we have time budget remaining
    // ============================================================
    if (hasTimeBudget(maxMainLoopMs + maxDeferredMs)) {
      try {
        const remainingMs = maxTotalRuntimeMs - getElapsedMs();
        const deferredMaxPages = remainingMs > 15000 ? 20 : remainingMs > 8000 ? 5 : 2;
        console.log(`[LIVE_REFUNDS] Fetching deferred with ${deferredMaxPages} max pages (${Math.round(remainingMs/1000)}s remaining)`);
        
        const deferredRefunds = await fetchDeferredTransactions(accessToken, startUTC, endUTC, userTimezone, deferredMaxPages);
        
        if (deferredRefunds.length > 0) {
          // Create a set of existing order IDs to avoid duplicates
          const existingOrderIds = new Set(refundRecords.map(r => `${r.orderId}-${r.asin}`));
          
          let addedCount = 0;
          for (const deferred of deferredRefunds) {
            const key = `${deferred.orderId}-${deferred.asin}`;
            if (!existingOrderIds.has(key)) {
              refundRecords.push({
                orderId: deferred.orderId,
                postedDate: deferred.postedDate,
                amount: deferred.amount,
                asin: deferred.asin,
                sku: deferred.sku,
                referralFee: deferred.referralFee,
                isDeferred: true,
              });
              totalRefundAmount += deferred.amount;
              totalReferralFeeRefund += deferred.referralFee;
              addedCount++;
            }
          }
          
          console.log(`[LIVE_REFUNDS] Added ${addedCount} new DEFERRED refunds (${deferredRefunds.length - addedCount} were duplicates)`);
        }
      } catch (deferredError) {
        console.error('[LIVE_REFUNDS] Error fetching deferred transactions (non-fatal):', deferredError);
        // Continue with the refunds we have from listFinancialEvents
      }
    } else {
      console.log(`[LIVE_REFUNDS] Skipping deferred transactions - insufficient time budget (${Math.round(getElapsedMs()/1000)}s elapsed)`);
      isPartial = true;
    }

    console.log(`[LIVE_REFUNDS] Total after deferred: ${refundRecords.length} refunds totaling $${totalRefundAmount.toFixed(2)}`);

    // Enrich refunds with product data from sales_orders by order_id
    // Skip enrichment if we're running low on time
    const uniqueOrderIds = [...new Set(refundRecords.map(r => r.orderId))];
    
    if (!hasTimeBudget(maxTotalRuntimeMs - 5000)) {
      console.log(`[LIVE_REFUNDS] Skipping enrichment - insufficient time (${Math.round(getElapsedMs()/1000)}s elapsed)`);
      // Return basic refunds without enrichment
      const basicRefunds = refundRecords
        .filter(r => r.postedDate >= requestedStartDate && r.postedDate <= requestedEndDate)
        .map(r => ({
          orderId: r.orderId,
          postedDate: r.postedDate,
          amount: r.amount,
          asin: r.asin,
          sku: r.sku || '',
          title: r.title || '',
          imageUrl: r.imageUrl || '',
          referralFee: r.referralFee,
          isDeferred: r.isDeferred || false,
          adjustmentType: r.adjustmentType,
        }));
      
      return new Response(JSON.stringify({
        refunds: basicRefunds,
        totalAmount: basicRefunds.reduce((sum, r) => sum + r.amount, 0),
        totalReferralFeeRefund,
        count: basicRefunds.length,
        isPartial: true,
        requestedRange: { start: requestedStartDate, end: requestedEndDate },
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    console.log(`[LIVE_REFUNDS] Looking up ${uniqueOrderIds.length} unique order IDs in sales_orders`);

    const { data: salesData } = await supabase
      .from('sales_orders')
      .select('order_id, asin, sku, title, image_url')
      .eq('user_id', user.id)
      .in('order_id', uniqueOrderIds);

    // Create lookup map by order_id
    const salesLookup = new Map<string, { asin: string; sku: string; title: string; imageUrl: string }>();
    for (const sale of salesData || []) {
      if (!salesLookup.has(sale.order_id)) {
        salesLookup.set(sale.order_id, {
          asin: sale.asin,
          sku: sale.sku || '',
          title: sale.title || '',
          imageUrl: sale.image_url || '',
        });
      }
    }

    // Helper to check if value looks like a SKU (not a valid ASIN format)
    const looksLikeSku = (val: string) => {
      if (!val || val === 'UNKNOWN') return true;
      // Valid ASIN is exactly 10 chars, starts with B0 or is all digits for older ASINs
      const isValidAsin = /^[A-Z0-9]{10}$/.test(val) && (val.startsWith('B0') || /^\d{10}$/.test(val));
      return !isValidAsin;
    };

    // Collect SKUs and FNSKUs that need ASIN lookup
    const skusToLookup: string[] = [];
    const fnskusToLookup: string[] = [];
    
    for (const refund of refundRecords) {
      const productData = salesLookup.get(refund.orderId);
      // If sales_orders has SKU in asin field (no title/image), we need to lookup by SKU
      if (productData && looksLikeSku(productData.asin) && !productData.title) {
        skusToLookup.push(productData.asin); // The "asin" field actually contains SKU
      }
      if (productData?.sku) {
        skusToLookup.push(productData.sku);
      }
      // NEW: refunds often include SellerSKU even when ASIN is missing
      if (refund.sku) {
        skusToLookup.push(refund.sku);
      }
      
      // For adjustment refunds, the orderId might be an FNSKU - collect for lookup
      if (refund.adjustmentType && refund.asin === 'UNKNOWN') {
        // The orderId for adjustments is often the FNSKU
        fnskusToLookup.push(refund.orderId);
      }
    }

    // Lookup SKU → ASIN mapping from inventory table
    let inventoryLookup = new Map<string, { asin: string; title: string; imageUrl: string }>();
    if (skusToLookup.length > 0) {
      const uniqueSkus = [...new Set(skusToLookup)];
      console.log(`[LIVE_REFUNDS] Looking up ${uniqueSkus.length} SKUs in inventory for ASIN mapping`);
      
      const { data: inventoryData } = await supabase
        .from('inventory')
        .select('sku, asin, title, image_url')
        .eq('user_id', user.id)
        .in('sku', uniqueSkus);

      for (const inv of inventoryData || []) {
        inventoryLookup.set(inv.sku, {
          asin: inv.asin,
          title: inv.title || '',
          imageUrl: inv.image_url || '',
        });
      }
      console.log(`[LIVE_REFUNDS] Found ${inventoryLookup.size} SKU→ASIN mappings in inventory`);
    }
    
    // Lookup FNSKU → ASIN mapping from fnsku_map and inventory tables
    let fnskuLookup = new Map<string, { asin: string; title: string; imageUrl: string }>();
    if (fnskusToLookup.length > 0) {
      const uniqueFnskus = [...new Set(fnskusToLookup)];
      console.log(`[LIVE_REFUNDS] Looking up ${uniqueFnskus.length} FNSKUs for ASIN mapping`);
      
      // Try fnsku_map first
      const { data: fnskuMapData } = await supabase
        .from('fnsku_map')
        .select('fnsku, asin')
        .in('fnsku', uniqueFnskus);
      
      // Create a set of found FNSKUs to avoid duplicate lookups
      const foundFnskus = new Set<string>();
      
      for (const fm of fnskuMapData || []) {
        foundFnskus.add(fm.fnsku);
        // Now get title/image from inventory using the ASIN
        fnskuLookup.set(fm.fnsku, { asin: fm.asin, title: '', imageUrl: '' });
      }
      
      // Also try inventory table directly (has fnsku column)
      const { data: invFnskuData } = await supabase
        .from('inventory')
        .select('fnsku, asin, title, image_url')
        .eq('user_id', user.id)
        .in('fnsku', uniqueFnskus);
      
      for (const inv of invFnskuData || []) {
        if (inv.fnsku) {
          fnskuLookup.set(inv.fnsku, {
            asin: inv.asin,
            title: inv.title || '',
            imageUrl: inv.image_url || '',
          });
        }
      }
      
      // Enrich fnsku_map results with title/image from inventory
      const asinsToEnrich = [...fnskuLookup.entries()]
        .filter(([_, data]) => !data.title)
        .map(([_, data]) => data.asin);
      
      if (asinsToEnrich.length > 0) {
        const { data: invByAsin } = await supabase
          .from('inventory')
          .select('asin, title, image_url')
          .eq('user_id', user.id)
          .in('asin', asinsToEnrich);
        
        const asinDataMap = new Map<string, { title: string; imageUrl: string }>();
        for (const inv of invByAsin || []) {
          asinDataMap.set(inv.asin, { title: inv.title || '', imageUrl: inv.image_url || '' });
        }
        
        // Update fnskuLookup with title/image
        for (const [fnsku, data] of fnskuLookup.entries()) {
          if (!data.title && asinDataMap.has(data.asin)) {
            const enrichment = asinDataMap.get(data.asin)!;
            fnskuLookup.set(fnsku, { ...data, ...enrichment });
          }
        }
      }
      
      console.log(`[LIVE_REFUNDS] Found ${fnskuLookup.size} FNSKU→ASIN mappings`);
    }

    // Helper: check if value looks like an Amazon order ID
    const isAmazonOrderIdFormat = (val: string) => /^\d{3}-\d{7}-\d{7}$/.test(val);

    // NOTE: We do NOT resolve adjustment order IDs to real orders.
    // The old approach matched by ASIN + closest date, causing false positives.

    // Enrich refund records with product data
    for (let i = 0; i < refundRecords.length; i++) {
      const refund = refundRecords[i];
      // 0) If ASIN is UNKNOWN but we have SellerSKU, try inventory immediately
      if (refund.asin === 'UNKNOWN' && refund.sku && inventoryLookup.has(refund.sku)) {
        const inv = inventoryLookup.get(refund.sku)!;
        refund.asin = inv.asin;
        refund.title = inv.title;
        refund.imageUrl = inv.imageUrl;
      }

      // 1) Try to enrich via FNSKU lookup (for adjustments)
      if (refund.adjustmentType && refund.asin === 'UNKNOWN' && fnskuLookup.has(refund.orderId)) {
        const fnskuData = fnskuLookup.get(refund.orderId)!;
        refund.asin = fnskuData.asin;
        refund.title = fnskuData.title;
        refund.imageUrl = fnskuData.imageUrl;
        console.log(`[LIVE_REFUNDS] Enriched adjustment via FNSKU: ${refund.orderId} -> ${fnskuData.asin} "${fnskuData.title}"`);
      }
      
      const productData = salesLookup.get(refund.orderId);
      if (productData) {
        // Check if we need to use inventory lookup (sales_orders has SKU, not ASIN)
        const skuToCheck = looksLikeSku(productData.asin) ? productData.asin : productData.sku;
        const inventoryProduct = skuToCheck ? inventoryLookup.get(skuToCheck) : null;

        if (inventoryProduct) {
          // Use inventory data (has correct ASIN)
          refund.asin = inventoryProduct.asin;
          refund.title = inventoryProduct.title;
          refund.imageUrl = inventoryProduct.imageUrl;
        } else if (!looksLikeSku(productData.asin)) {
          // sales_orders has valid ASIN
          refund.asin = productData.asin;
          refund.title = productData.title;
          refund.imageUrl = productData.imageUrl;
        }
      }

    }

    // Adjustment refunds keep their SKU/FNSKU as orderId - do NOT try to resolve
    // to a real order ID, as this causes false positives (matching unrelated orders
    // that share the same ASIN) and duplicates with actual RefundEventList entries.
    // The UI handles non-order-ID formats by showing "SKU:" label.

    // FINAL PASS: For any remaining UNKNOWN ASINs, try to find the original order by searching order_id patterns
    const stillUnknownRefunds = refundRecords.filter(r => r.asin === 'UNKNOWN' && r.orderId);
    if (stillUnknownRefunds.length > 0) {
      console.log(`[LIVE_REFUNDS] ${stillUnknownRefunds.length} refunds still have UNKNOWN ASIN, attempting broader lookup`);

      // Amazon order id format: 123-1234567-1234567
      const isAmazonOrderId = (val: string) => /^\d{3}-\d{7}-\d{7}$/.test(val);

      for (const refund of stillUnknownRefunds) {
        // 1) Try direct order_id lookup (in case it wasn't in the initial batch due to date range)
        const { data: directMatch } = await supabase
          .from('sales_orders')
          .select('order_id, asin, sku, title, image_url')
          .eq('user_id', user.id)
          .eq('order_id', refund.orderId)
          .limit(1);

        if (directMatch && directMatch.length > 0) {
          const sale = directMatch[0];
          if (!looksLikeSku(sale.asin)) {
            refund.asin = sale.asin;
            refund.title = sale.title || '';
            refund.imageUrl = sale.image_url || '';
            console.log(`[LIVE_REFUNDS] Found direct match for ${refund.orderId}: ${sale.asin}`);
            continue;
          } else if (sale.sku) {
            // Lookup ASIN from inventory using SKU
            const invMatch = inventoryLookup.get(sale.sku);
            if (invMatch) {
              refund.asin = invMatch.asin;
              refund.title = invMatch.title;
              refund.imageUrl = invMatch.imageUrl;
              console.log(`[LIVE_REFUNDS] Found via SKU lookup for ${refund.orderId}: ${invMatch.asin}`);
              continue;
            }
          }
        }

        // 2) Orders API fallback (authoritative for ASIN on a given order)
        if (isAmazonOrderId(refund.orderId)) {
          const asin = await fetchFirstAsinFromOrderItems(accessToken, refund.orderId);
          if (asin) {
            refund.asin = asin;
            console.log(`[LIVE_REFUNDS] Resolved UNKNOWN ASIN via Orders API: ${refund.orderId} -> ${asin}`);
            // title/image will be filled later by inventory/sales_orders/amazon catalog enrichment
            continue;
          }
        }
      }
    }

    // ============================================================
    // COMPREHENSIVE DEDUP: Remove ALL duplicates
    // Pass 1: Dedup by orderId + asin (keeps larger amount)
    // Pass 2: Dedup by orderId alone - if same order appears with real ASIN and UNKNOWN,
    //         keep the one with the real ASIN (handles partial enrichment)
    // ============================================================
    const beforeDedup = refundRecords.length;
    
    // Pass 1: orderId + asin dedup (keeps larger amount)
    const seenMap = new Map<string, number>();
    const dedupedRefunds: RefundRecord[] = [];
    
    for (const r of refundRecords) {
      const key = `${r.orderId}-${r.asin}`;
      if (seenMap.has(key)) {
        const existingIdx = seenMap.get(key)!;
        const existing = dedupedRefunds[existingIdx];
        if (r.amount > existing.amount) {
          console.log(`[LIVE_REFUNDS] Dedup: replacing $${existing.amount.toFixed(2)} with larger $${r.amount.toFixed(2)} for ${r.orderId} | ${r.asin}`);
          dedupedRefunds[existingIdx] = r;
        } else {
          console.log(`[LIVE_REFUNDS] Dedup: skipping smaller duplicate $${r.amount.toFixed(2)} for ${r.orderId} | ${r.asin} (keeping $${existing.amount.toFixed(2)})`);
        }
        continue;
      }
      seenMap.set(key, dedupedRefunds.length);
      dedupedRefunds.push(r);
    }
    
    // Pass 2: orderId-only dedup - remove UNKNOWN entries when a real ASIN entry exists for same orderId
    const orderIdToEntries = new Map<string, number[]>();
    for (let i = 0; i < dedupedRefunds.length; i++) {
      const oid = dedupedRefunds[i].orderId;
      if (!orderIdToEntries.has(oid)) orderIdToEntries.set(oid, []);
      orderIdToEntries.get(oid)!.push(i);
    }
    
    const indicesToRemove = new Set<number>();
    for (const [orderId, indices] of orderIdToEntries) {
      if (indices.length <= 1) continue;
      const hasRealAsin = indices.some(i => dedupedRefunds[i].asin !== 'UNKNOWN');
      if (hasRealAsin) {
        for (const i of indices) {
          if (dedupedRefunds[i].asin === 'UNKNOWN') {
            console.log(`[LIVE_REFUNDS] Dedup pass 2: removing UNKNOWN entry for ${orderId} (real ASIN exists)`);
            indicesToRemove.add(i);
          }
        }
      }
    }
    
    const afterPass2 = dedupedRefunds.filter((_, i) => !indicesToRemove.has(i));
    
    // Also remove adjustment entries when a real refund exists for same ASIN + date
    const realRefunds = afterPass2.filter(r => isAmazonOrderIdFormat(r.orderId) && !r.adjustmentType);
    const realRefundKeys = new Set(realRefunds.map(r => `${r.asin}-${r.postedDate}`));
    
    const finalRefunds = afterPass2.filter(r => {
      if (!r.adjustmentType) return true;
      const key = `${r.asin}-${r.postedDate}`;
      if (realRefundKeys.has(key)) {
        console.log(`[LIVE_REFUNDS] Dedup: removing adjustment for ASIN ${r.asin} on ${r.postedDate} (real refund exists)`);
        return false;
      }
      return true;
    });
    
    if (beforeDedup !== finalRefunds.length) {
      console.log(`[LIVE_REFUNDS] Deduped: ${beforeDedup} -> ${finalRefunds.length} refunds`);
    }
    refundRecords.length = 0;
    refundRecords.push(...finalRefunds);

    console.log(`[LIVE_REFUNDS] Enriched refunds with product data`);

    // Helper to check if title needs enrichment
    const needsTitleEnrichment = (title: string | undefined): boolean => {
      if (!title) return true;
      const placeholder = title.toLowerCase();
      return placeholder === 'untitled product' || 
             placeholder === 'order processing...' || 
             placeholder === 'unknown product' ||
             placeholder === 'n/a';
    };

    // TITLE FALLBACK: For refunds that have ASIN but no/placeholder title, look up in inventory/sales_orders by ASIN
    const untitledRefunds = refundRecords.filter(r => r.asin && r.asin !== 'UNKNOWN' && needsTitleEnrichment(r.title));
    if (untitledRefunds.length > 0) {
      const untitledAsins = [...new Set(untitledRefunds.map(r => r.asin))];
      console.log(`[LIVE_REFUNDS] ${untitledRefunds.length} refunds have ASIN but need title enrichment, looking up ${untitledAsins.length} ASINs`);
      
      // Try inventory first (but only accept real titles, not placeholders)
      const { data: invTitleData } = await supabase
        .from('inventory')
        .select('asin, title, image_url')
        .eq('user_id', user.id)
        .in('asin', untitledAsins);
      
      const titleByAsin = new Map<string, { title: string; imageUrl: string }>();
      for (const inv of invTitleData || []) {
        // Only use inventory title if it's a real title, not a placeholder
        if (inv.title && !needsTitleEnrichment(inv.title)) {
          titleByAsin.set(inv.asin, { title: inv.title, imageUrl: inv.image_url || '' });
        }
      }
      
      // Also try sales_orders for any ASINs not found in inventory
      const stillMissingAsins = untitledAsins.filter(a => !titleByAsin.has(a));
      if (stillMissingAsins.length > 0) {
        const { data: salesTitleData } = await supabase
          .from('sales_orders')
          .select('asin, title, image_url')
          .eq('user_id', user.id)
          .in('asin', stillMissingAsins)
          .not('title', 'is', null);
        
        for (const sale of salesTitleData || []) {
          // Only use sales_orders title if it's a real title, not a placeholder
          if (sale.title && !needsTitleEnrichment(sale.title) && !titleByAsin.has(sale.asin)) {
            titleByAsin.set(sale.asin, { title: sale.title, imageUrl: sale.image_url || '' });
          }
        }
      }
      
      // Apply titles to refunds
      for (const refund of untitledRefunds) {
        const titleData = titleByAsin.get(refund.asin);
        if (titleData) {
          refund.title = titleData.title;
          if (!refund.imageUrl) {
            refund.imageUrl = titleData.imageUrl;
          }
        }
      }
      
      console.log(`[LIVE_REFUNDS] Found titles for ${titleByAsin.size} of ${untitledAsins.length} ASINs`);
      
      // AMAZON CATALOG API FALLBACK: For ASINs still without title, call Amazon Catalog API
      const finalUntitledAsins = untitledAsins.filter(a => !titleByAsin.has(a));
      if (finalUntitledAsins.length > 0) {
        console.log(`[LIVE_REFUNDS] ${finalUntitledAsins.length} ASINs still need title, calling Amazon Catalog API`);
        
        // Process in batches of 5 to avoid rate limiting
        const BATCH_SIZE = 5;
        for (let i = 0; i < finalUntitledAsins.length && i < 15; i += BATCH_SIZE) {
          const batch = finalUntitledAsins.slice(i, i + BATCH_SIZE);
          
          await Promise.all(batch.map(async (asin) => {
            try {
              const catalogUrl = `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${asin}?marketplaceIds=ATVPDKIKX0DER&includedData=summaries,images`;
              const catalogHeaders = await signRequest('GET', catalogUrl, '', accessToken);
              
              const catalogResponse = await fetch(catalogUrl, {
                method: 'GET',
                headers: catalogHeaders,
              });
              
              if (catalogResponse.ok) {
                const catalogData = await catalogResponse.json();
                const summaries = catalogData.summaries || [];
                const images = catalogData.images || [];
                
                let title = '';
                let imageUrl = '';
                
                // Get title from summaries
                if (summaries.length > 0) {
                  title = summaries[0].itemName || '';
                }
                
                // Get image from images
                if (images.length > 0 && images[0].images && images[0].images.length > 0) {
                  imageUrl = images[0].images[0].link || '';
                }
                
                if (title) {
                  titleByAsin.set(asin, { title, imageUrl });
                  console.log(`[LIVE_REFUNDS] Got title from Catalog API for ${asin}: "${title.substring(0, 50)}..."`);
                  
                  // Apply to refunds with this ASIN (including those with placeholder titles)
                  for (const refund of untitledRefunds) {
                    if (refund.asin === asin && needsTitleEnrichment(refund.title)) {
                      refund.title = title;
                      if (!refund.imageUrl && imageUrl) {
                        refund.imageUrl = imageUrl;
                      }
                    }
                  }
                  
                  // Also update the inventory table to fix the "Untitled Product" entries
                  try {
                    await supabase
                      .from('inventory')
                      .update({ title, image_url: imageUrl || undefined })
                      .eq('user_id', user.id)
                      .eq('asin', asin);
                    console.log(`[LIVE_REFUNDS] Updated inventory title for ${asin}`);
                  } catch (updateErr) {
                    console.log(`[LIVE_REFUNDS] Failed to update inventory for ${asin}:`, updateErr);
                  }
                }
              } else {
                console.log(`[LIVE_REFUNDS] Catalog API failed for ${asin}: ${catalogResponse.status}`);
              }
            } catch (err) {
              console.log(`[LIVE_REFUNDS] Error fetching catalog for ${asin}:`, err);
            }
          }));
          
          // Small delay between batches to avoid rate limiting
          if (i + BATCH_SIZE < finalUntitledAsins.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        
        console.log(`[LIVE_REFUNDS] After Catalog API, found titles for ${titleByAsin.size} of ${untitledAsins.length} ASINs`);
      }
    }

    // Filter refund records to only include those within the requested date range
    // This ensures consistency regardless of timezone mismatches in the API response
    const filteredRefunds = refundRecords.filter(r => {
      if (!r.postedDate) return false;
      return r.postedDate >= requestedStartDate && r.postedDate <= requestedEndDate;
    });
    
    // Recalculate totals based on filtered refunds
    const filteredTotalAmount = filteredRefunds.reduce((sum, r) => sum + r.amount, 0);
    const filteredTotalReferralFee = filteredRefunds.reduce((sum, r) => sum + r.referralFee, 0);

    // Count deferred vs regular refunds
    const deferredCount = filteredRefunds.filter(r => r.isDeferred).length;
    const adjustmentCount = filteredRefunds.filter(r => r.adjustmentType).length;
    const stillUnknownCount = filteredRefunds.filter(r => r.asin === 'UNKNOWN').length;
    const stillUntitledCount = filteredRefunds.filter(r => r.asin && r.asin !== 'UNKNOWN' && !r.title).length;
    
    console.log(`[LIVE_REFUNDS] Summary: ${refundRecords.length} fetched, ${filteredRefunds.length} in date range (${requestedStartDate} to ${requestedEndDate}), ${deferredCount} deferred, ${adjustmentCount} adjustments, ${stillUnknownCount} still unknown, ${stillUntitledCount} still untitled`);

    // PERSIST REFUNDS TO DATABASE: Save to sales_orders for historical queries
    // This allows "Last month" and older periods to use DB-only without calling API
    const validRefundsForDb = filteredRefunds.filter(r => r.asin && r.asin !== 'UNKNOWN' && r.orderId);
    if (validRefundsForDb.length > 0) {
      const refundRows = validRefundsForDb.map(r => {
        const eventDate = (r.postedDate || '').split('T')[0] || r.postedDate;
        return ({
          user_id: user.id,
          order_id: `${r.orderId}-REFUND`,
          order_date: r.postedDate,
          asin: r.asin,
          sku: r.sku || null,
          title: r.title ? `[REFUND] ${r.title}` : `[REFUND] ${r.asin}`,
          image_url: r.imageUrl || null,
          sold_price: -Math.abs(r.amount),
          refund_amount: Math.abs(r.amount),
          referral_fee: -Math.abs(r.referralFee),
          total_fees: 0,
          quantity: (r as any).quantity || 1,
          order_status: 'Refunded',
          status: 'settled',
          price_source: 'financial_events',
          marketplace: 'US',
          // PERMANENT PREVENTION: stable idempotency key. DB unique index on
          // (user_id, fec_refund_key) blocks any duplicate insert for the
          // same refund event.
          fec_refund_key: `refund:${r.orderId}|${r.asin}|${eventDate}`,
        });
      });

      // Upsert on fec_refund_key so the same refund event never creates a new row.
      let insertedCount = 0;
      for (const row of refundRows) {
        const { error: upsertErr } = await supabase
          .from('sales_orders')
          .upsert(row, { onConflict: 'user_id,fec_refund_key' });
        if (!upsertErr) insertedCount++;
      }

      
      console.log(`[LIVE_REFUNDS] Persisted ${insertedCount} new refunds to sales_orders (${refundRows.length - insertedCount} already existed)`);
    }

    // Write sync trace for refund fetch
    try {
      await supabase
        .from('sync_traces')
        .insert({
          user_id: user.id,
          sync_type: 'refunds',
          phase: 'fetch_live_refunds',
          status: 'completed',
          started_at: new Date(startedAtMs).toISOString(),
          completed_at: new Date().toISOString(),
          rows_fetched: refundRecords.length,
          rows_inserted: validRefundsForDb.length,
          duplicates_skipped: 0,
          error_count: 0,
          metadata: { deferredCount, adjustmentCount, isPartial, range: { start: start_date, end: end_date } },
        });
    } catch (traceErr: any) {
      console.warn('[LIVE_REFUNDS] Failed to write sync trace:', traceErr?.message);
    }

    return new Response(JSON.stringify({
      success: true,
      refunds: filteredRefunds,
      totalAmount: filteredTotalAmount,
      totalReferralFee: filteredTotalReferralFee,
      count: filteredRefunds.length,
      deferredCount,
      adjustmentCount,
      partial: isPartial,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[LIVE_REFUNDS] Error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message || 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
