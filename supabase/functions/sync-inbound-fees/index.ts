import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

// Constant-time string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// AWS SigV4 signing utilities
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest('SHA-256', data as any);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function getSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

async function signRequest(method: string, url: string, body: string, accessToken: string): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = 'us-east-1';
  const service = 'execute-api';

  const urlObj = new URL(url);
  const host = urlObj.host;
  const path = urlObj.pathname + urlObj.search;
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const hashedPayload = toHex(await sha256(body || ''));
  
  const headers: Record<string, string> = {
    'host': host,
    'x-amz-access-token': accessToken,
    'x-amz-date': amzDate,
  };

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map(k => `${k}:${headers[k]}\n`).join('');

  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    toHex(await sha256(canonicalRequest)),
  ].join('\n');

  const signingKey = await getSigningKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  return {
    'host': host,
    'x-amz-access-token': accessToken,
    'x-amz-date': amzDate,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
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

// Get SP-API endpoint based on region
function getSpApiEndpoint(): string {
  const region = (Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1').toLowerCase();
  if (region.startsWith('eu')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (region.startsWith('us') || region.startsWith('ca')) return 'https://sellingpartnerapi-na.amazon.com';
  // default to NA
  return 'https://sellingpartnerapi-na.amazon.com';
}

// Fetch financial events for a date range with page limits to avoid quota exhaustion
async function fetchFinancialEventsWithServiceFees(
  accessToken: string,
  startDate: string,
  endDate: string,
  maxPages: number = 20 // Limit pages to avoid quota exhaustion
): Promise<{ events: any[]; reachedLimit: boolean; pagesProcessed: number }> {
  const endpoint = getSpApiEndpoint();
  const path = '/finances/v0/financialEvents';
  
  let allEvents: any[] = [];
  let nextToken: string | null = null;
  let pageCount = 0;
  const maxRetries = 5; // Increased from 3
  let reachedLimit = false;

  do {
    pageCount++;
    
    // Check page limit before fetching
    if (pageCount > maxPages) {
      console.log(`Reached max page limit (${maxPages}), stopping pagination to avoid quota issues`);
      reachedLimit = true;
      break;
    }
    
    const params = new URLSearchParams({
      PostedAfter: startDate,
      PostedBefore: endDate,
    });
    if (nextToken) params.append('NextToken', nextToken);

    const url = `${endpoint}${path}?${params}`;
    const headers = await signRequest('GET', url, '', accessToken);

    let attempt = 0;
    let waitMs = 3000; // Start with longer wait

    while (true) {
      attempt++;
      const response = await fetch(url, { headers });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');

        if (response.status === 429) {
          if (attempt < maxRetries) {
            console.warn(`Rate limited (attempt ${attempt}/${maxRetries}), waiting ${waitMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
            waitMs = Math.min(waitMs * 2, 30000); // Cap at 30 seconds
            continue;
          }
          // Return what we have instead of throwing
          console.warn(`Quota exceeded after ${maxRetries} retries on page ${pageCount}, returning partial results`);
          return { events: allEvents, reachedLimit: true, pagesProcessed: pageCount - 1 };
        }
        if (response.status === 400) {
          console.error('Financial Events 400 error:', bodyText.slice(0, 800));
          throw new Error(`FINANCIAL_EVENTS_BAD_REQUEST: ${bodyText.slice(0, 300)}`);
        }

        console.error(`Financial Events API failed: ${response.status}`, bodyText.slice(0, 800));
        throw new Error(`Financial Events API failed: ${response.status}`);
      }

      const data = await response.json();
      const payload = data.payload?.FinancialEvents || data.payload || {};

      // Log all event types we receive for debugging
      const eventTypes = Object.keys(payload).filter(k => Array.isArray(payload[k]) && payload[k].length > 0);
      if (eventTypes.length > 0) {
        console.log(`Page ${pageCount} event types present:`, eventTypes.join(', '));
      }

      // Extract relevant event lists
      const addEvents = (list: any[] | undefined, source: string) => {
        if (!list || list.length === 0) return;
        for (const ev of list) allEvents.push({ source, ev });
      };

      addEvents(payload?.ServiceFeeEventList, 'ServiceFeeEventList');
      addEvents(payload?.ShipmentEventList, 'ShipmentEventList');

      if (payload?.ServiceFeeEventList?.length) {
        console.log(`Found ${payload.ServiceFeeEventList.length} service fee events on page ${pageCount}`);
        const firstEvent = payload.ServiceFeeEventList[0];
        if (firstEvent?.FeeList) {
          const feeTypes = firstEvent.FeeList.map((f: any) => f.FeeType).join(', ');
          console.log(`Sample fee types: ${feeTypes}`);
        }
      }

      nextToken = data.payload?.NextToken || null;
      break;
    }

    if (nextToken) {
      // Longer delay between pages to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } while (nextToken);

  console.log(`Fetched ${allEvents.length} total events across ${pageCount} pages (reachedLimit: ${reachedLimit})`);
  return { events: allEvents, reachedLimit, pagesProcessed: pageCount };
}

// Convert timestamp to Central Time date string (YYYY-MM-DD) - matches Sellerboard behavior
function getCentralDateString(isoTimestamp: string): string {
  const utc = new Date(isoTimestamp);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  
  const parts = formatter.formatToParts(utc);
  const year = parts.find(p => p.type === 'year')?.value || '2025';
  const month = parts.find(p => p.type === 'month')?.value || '01';
  const day = parts.find(p => p.type === 'day')?.value || '01';
  
  return `${year}-${month}-${day}`;
}

// Process and store inbound-related fees from financial events
async function processServiceFeeEvents(
  supabase: any,
  userId: string,
  events: { source: string; ev: any }[],
  defaultPostedDate: string,
  shipmentDatesMap: Map<string, string> // shipment_id -> created_at date
): Promise<{ inserted: number; skipped: number; errors: number; feeTypesFound: string[] }> {
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const feeTypesFound = new Set<string>();

  console.log(`Processing ${events.length} total events...`);

  for (const wrapped of events) {
    const event = wrapped.ev;
    const source = wrapped.source;
    
    try {
      // Log all fee types for debugging
      const feeList = event.FeeList || event.FeeComponentList || event.ChargeComponentList || [];
      for (const fee of feeList) {
        const feeType = fee.FeeType || fee.ChargeType || fee.Type || 'Unknown';
        feeTypesFound.add(feeType);
      }
      
      const postedDateRaw =
        event.PostedDate ??
        event.PostedDateTime ??
        event.EventDate ??
        event.PostedAfter ??
        event.PostedBefore ??
        null;

      // Use Central Time for date attribution (matches Sellerboard)
      const postedDate = postedDateRaw
        ? getCentralDateString(postedDateRaw)
        : defaultPostedDate;
      // Store the raw UTC timestamp for accurate filtering
      const postedDateUtc = postedDateRaw ? postedDateRaw : null;
      const asin = event.ASIN || null;
      const sellerSKU = event.SellerSKU || null;
      const fnSKU = event.FnSKU || null;
      const feeReason = event.FeeReason || event.FeeDescription || event.TransactionType || null;

      for (const fee of feeList) {
        const feeType = fee.FeeType || fee.ChargeType || fee.Type || 'Unknown';
        const amountObj = fee.FeeAmount || fee.ChargeAmount || fee.Amount || {};
        const currency = amountObj.CurrencyCode || 'USD';
        const rawAmount = parseFloat(amountObj.CurrencyAmount || '0');
        const amountUSD = convertToUSD(Math.abs(rawAmount), currency);

        // Only process inbound/shipping-related fees - expanded matching
        const feeTypeLower = feeType.toLowerCase();
        const isInboundFee = feeType.includes('FBAInboundTransportation') ||
                             feeType.includes('FBAInbound') ||
                             feeTypeLower.includes('inbound') ||
                             feeTypeLower.includes('fbapartneredcarrier') ||
                             feeTypeLower.includes('partnered') ||
                             feeTypeLower.includes('transportation') ||
                             feeTypeLower.includes('shipping') ||
                             feeTypeLower.includes('freight');

        if (!isInboundFee) {
          continue; // Skip non-inbound fees
        }

        // Try to extract shipment ID from the event
        // AmazonOrderId is the primary identifier for inbound fee events (e.g., "FBA195Y2GYV6")
        let shipmentId = null;
        if (event.AmazonOrderId) {
          shipmentId = event.AmazonOrderId;
        } else if (event.ShipmentId) {
          shipmentId = event.ShipmentId;
        } else if (event.TransactionDescription) {
          // Try to extract from description (e.g., "FBA Inbound Transportation Fee for shipment FBA17ABCD1234")
          const match = event.TransactionDescription.match(/shipment\s+(\w+)/i);
          if (match) {
            shipmentId = match[1];
          }
        } else if (event.FeeReason) {
          // Try to extract from FeeReason
          const match = event.FeeReason.match(/(FBA\w+)/i);
          if (match) {
            shipmentId = match[1];
          }
        }

        // Determine shipment_day: look up from fba_shipments created_at, else fall back to posted_date
        let shipmentDay = postedDate; // default fallback
        if (shipmentId && shipmentDatesMap.has(shipmentId)) {
          shipmentDay = shipmentDatesMap.get(shipmentId)!;
        }

        const feeData = {
          user_id: userId,
          shipment_id: shipmentId,
          fee_type: feeType,
          fee_reason: feeReason,
          fee_amount: amountUSD,
          currency: 'USD',
          posted_date: postedDate,
          posted_date_utc: postedDateUtc, // Store raw UTC timestamp
          shipment_day: shipmentDay,
          asin: asin,
          sku: sellerSKU,
          fnsku: fnSKU,
          event_description: event.TransactionDescription || event.FeeReason || null,
          raw_event: event,
          updated_at: new Date().toISOString(),
        };

        // Use upsert with ignoreDuplicates to skip existing records
        // Unique constraint: (user_id, fee_type, fee_amount, posted_date, COALESCE(shipment_day, posted_date))
        const { data: insertResult, error } = await supabase
          .from('fba_inbound_fees')
          .upsert(feeData, { 
            onConflict: 'user_id,fee_type,fee_amount,posted_date',
            ignoreDuplicates: true 
          })
          .select('id');

        if (error) {
          // If duplicate key error, skip it silently
          if (error.code === '23505') {
            skipped++;
          } else {
            console.error(`Error inserting inbound fee:`, (error as Error).message, error.code);
            errors++;
          }
        } else if (insertResult && insertResult.length > 0) {
          inserted++;
          console.log(`✅ Inbound fee: ${feeType} | $${amountUSD.toFixed(2)} | ${postedDate} | Shipment: ${shipmentId || 'N/A'}`);
        } else {
          skipped++;
        }
      }
    } catch (err: any) {
      console.error('Error processing service fee event:', err?.message || err);
      errors++;
    }
  }

  return { inserted, skipped, errors, feeTypesFound: Array.from(feeTypesFound) };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const internalSyncSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

    // Admin Supabase client (server-side)
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Secure dual-mode auth:
    // (A) Internal cron/background job: x-internal-secret header
    // (B) Normal user JWT: Authorization header
    const internalHeader = req.headers.get('x-internal-secret') || '';
    const authHeader = req.headers.get('Authorization') || '';

    // Parse request body early (needed for internal-mode user_id)
    let requestBody: any = {};
    try {
      requestBody = await req.json();
    } catch {}

    // Constant-time comparison to prevent timing attacks
    const isInternal = internalSyncSecret.length > 0 &&
      internalHeader.length === internalSyncSecret.length &&
      timingSafeEqual(internalHeader, internalSyncSecret);

    let userId: string | null = null;

    if (isInternal) {
      // Internal background job (auto-sync-all-users)
      userId = requestBody?.user_id || null;
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Missing user_id for internal call' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      console.log(`🔐 Internal sync call for user: ${userId}`);
    } else {
      // Normal web app call (user JWT)
      const token = authHeader.startsWith('Bearer ') ? authHeader.replace('Bearer ', '') : '';
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const userSupabase = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });

      const { data, error } = await userSupabase.auth.getClaims(token);
      if (error || !data?.claims?.sub) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      userId = data.claims.sub;
    }

    const { startDate, endDate, sync_history } = requestBody;

    // Get seller authorization (prefer US marketplace, fallback to any)
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', userId);

    if (authError || !authRows || authRows.length === 0) {
      return new Response(JSON.stringify({ error: 'No Amazon seller authorization found' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Prefer US marketplace for inbound fees, fallback to first available
    const authData = authRows.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows[0];

    const accessToken = await getLwaAccessToken(authData.refresh_token);

    // Determine date range
    let syncStartDate: string;
    let syncEndDate: string;
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

    if (sync_history) {
      // Requested history sync (we will chunk to satisfy SP-API 180-day max)
      const twoYearsAgo = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);
      syncStartDate = twoYearsAgo.toISOString();
      syncEndDate = twoMinutesAgo.toISOString();
      console.log(`📦 Syncing inbound fees (history): ${syncStartDate} to ${syncEndDate}`);
    } else if (startDate && endDate) {
      // Use provided dates - start at beginning of day and end at end of day
      const startD = new Date(startDate);
      startD.setUTCHours(0, 0, 0, 0);
      syncStartDate = startD.toISOString();

      const endD = new Date(endDate);
      endD.setUTCHours(23, 59, 59, 999);
      // SP-API requires PostedBefore <= (now - 2 minutes)
      syncEndDate = (endD.getTime() > twoMinutesAgo.getTime() ? twoMinutesAgo : endD).toISOString();
      console.log(`📦 Syncing inbound fees for date range: ${syncStartDate} to ${syncEndDate}`);
    } else {
      // Default: last 7 days (quick sync to avoid timeout)
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      syncStartDate = sevenDaysAgo.toISOString();
      syncEndDate = twoMinutesAgo.toISOString();
      console.log(`📦 Syncing last 7 days of inbound fees: ${syncStartDate} to ${syncEndDate}`);
    }

    // SP-API constraint: date range cannot span more than 180 days
    const MAX_RANGE_DAYS = 179;
    const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

    let start = new Date(syncStartDate);
    const end = new Date(syncEndDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error(`Invalid date range: ${syncStartDate} to ${syncEndDate}`);
    }

    if (end.getTime() <= start.getTime()) {
      console.log('No range to sync (end <= start)');
      return new Response(JSON.stringify({
        success: true,
        message: 'No date range to sync',
        inserted: 0,
        skipped: 0,
        errors: 0,
        totalEvents: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch in chunks
    let serviceFeeEvents: any[] = [];
    let chunk = 0;
    let hitQuotaLimit = false;
    let totalPagesProcessed = 0;

    while (start.getTime() < end.getTime() && !hitQuotaLimit) {
      chunk++;
      const chunkEnd = new Date(Math.min(end.getTime(), start.getTime() + MAX_RANGE_MS));
      console.log(`📦 Chunk ${chunk}: ${start.toISOString()} -> ${chunkEnd.toISOString()}`);

      const result = await fetchFinancialEventsWithServiceFees(
        accessToken,
        start.toISOString(),
        chunkEnd.toISOString(),
        15 // Max 15 pages per chunk to avoid quota issues
      );

      serviceFeeEvents = serviceFeeEvents.concat(result.events);
      totalPagesProcessed += result.pagesProcessed;
      
      if (result.reachedLimit) {
        hitQuotaLimit = true;
        console.log(`⚠️ Hit quota limit during chunk ${chunk}, processing partial results`);
      }

      // move forward 1 second to avoid overlapping boundaries
      start = new Date(chunkEnd.getTime() + 1000);
    }

    // Fetch shipment creation dates from fba_shipments for shipment_day lookup
    const { data: shipmentsData } = await supabase
      .from('fba_shipments')
      .select('shipment_id, created_at')
      .eq('user_id', userId);
    
    const shipmentDatesMap = new Map<string, string>();
    if (shipmentsData && shipmentsData.length > 0) {
      for (const s of shipmentsData) {
        if (s.shipment_id && s.created_at) {
          // Convert to Central Time date string (matches Sellerboard)
          shipmentDatesMap.set(s.shipment_id, getCentralDateString(s.created_at));
        }
      }
      console.log(`📦 Loaded ${shipmentDatesMap.size} shipment creation dates for shipment_day lookup`);
    }

    const defaultPostedDate = getCentralDateString(syncStartDate);
    const results = await processServiceFeeEvents(supabase, userId, serviceFeeEvents, defaultPostedDate, shipmentDatesMap);

    console.log(`✅ Inbound fees sync complete: ${results.inserted} inserted, ${results.skipped} skipped, ${results.errors} errors`);
    console.log(`📋 All fee types found in events: ${results.feeTypesFound.join(', ') || 'none'}`);

    return new Response(JSON.stringify({
      success: true,
      message: hitQuotaLimit 
        ? `Synced ${results.inserted} inbound fees (partial - API quota reached after ${totalPagesProcessed} pages)`
        : `Synced ${results.inserted} inbound transportation fees`,
      inserted: results.inserted,
      skipped: results.skipped,
      errors: results.errors,
      feeTypesFound: results.feeTypesFound,
      totalEvents: serviceFeeEvents.length,
      pagesProcessed: totalPagesProcessed,
      quotaLimitReached: hitQuotaLimit,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('sync-inbound-fees error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
