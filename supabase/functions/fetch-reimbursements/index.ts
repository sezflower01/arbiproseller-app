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

// Reimbursement types we track
interface ReimbursementItem {
  id: string;
  type: 'REFUND_NOT_RETURNED' | 'WAREHOUSE_LOST' | 'WAREHOUSE_DAMAGED' | 'CARRIER_LOST' | 'FEE_CORRECTION' | 'OTHER';
  asin: string;
  sku?: string;
  fnsku?: string;
  title?: string;
  imageUrl?: string;
  quantity: number;
  amount: number;
  currency: string;
  amountUSD: number;
  postedDate: string;
  orderId?: string;
  reason?: string;
  status: 'PENDING' | 'ELIGIBLE' | 'REIMBURSED' | 'DENIED';
  daysOpen?: number;
  reimbursementId?: string;
  caseId?: string;
}

// Helper: poll a Reports API report until DONE, then download & parse the TSV
async function fetchReimbursementsReport(
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<Array<Record<string, string>>> {
  const endpoint = 'https://sellingpartnerapi-na.amazon.com';

  // 1. Create the report
  const createBody = JSON.stringify({
    reportType: 'GET_FBA_REIMBURSEMENTS_DATA',
    dataStartTime: new Date(startDate).toISOString(),
    dataEndTime: new Date(endDate).toISOString(),
    marketplaceIds: ['ATVPDKIKX0DER'],
  });
  const createUrl = `${endpoint}/reports/2021-06-30/reports`;
  const createHeaders = await signRequest('POST', createUrl, createBody, accessToken);
  const createResp = await fetch(createUrl, {
    method: 'POST',
    headers: { ...createHeaders, 'Content-Type': 'application/json' },
    body: createBody,
  });
  if (!createResp.ok) {
    console.warn('[REIMBURSEMENTS-REPORT] Create failed:', createResp.status, await createResp.text());
    return [];
  }
  const { reportId } = await createResp.json();
  console.log(`[REIMBURSEMENTS-REPORT] Created reportId=${reportId}, polling...`);

  // 2. Poll for completion (max ~60s)
  let documentId: string | null = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusUrl = `${endpoint}/reports/2021-06-30/reports/${reportId}`;
    const statusHeaders = await signRequest('GET', statusUrl, '', accessToken);
    const statusResp = await fetch(statusUrl, { method: 'GET', headers: statusHeaders });
    if (!statusResp.ok) continue;
    const statusData = await statusResp.json();
    if (statusData.processingStatus === 'DONE') {
      documentId = statusData.reportDocumentId;
      break;
    }
    if (statusData.processingStatus === 'CANCELLED' || statusData.processingStatus === 'FATAL') {
      console.warn('[REIMBURSEMENTS-REPORT] Failed status:', statusData.processingStatus);
      return [];
    }
  }
  if (!documentId) {
    console.warn('[REIMBURSEMENTS-REPORT] Timed out waiting for report');
    return [];
  }

  // 3. Get the document URL & download
  const docUrl = `${endpoint}/reports/2021-06-30/documents/${documentId}`;
  const docHeaders = await signRequest('GET', docUrl, '', accessToken);
  const docResp = await fetch(docUrl, { method: 'GET', headers: docHeaders });
  if (!docResp.ok) return [];
  const { url } = await docResp.json();
  const tsvResp = await fetch(url);
  const tsv = await tsvResp.text();

  // 4. Parse TSV → array of rows
  const lines = tsv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(h => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (cells[idx] || '').trim(); });
    rows.push(row);
  }
  console.log(`[REIMBURSEMENTS-REPORT] Parsed ${rows.length} rows from report`);
  return rows;
}


serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Unauthorized');
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );

    if (authError || !user) {
      throw new Error('Unauthorized');
    }

    const { start_date, end_date, type_filter } = await req.json();
    console.log(`[REIMBURSEMENTS] Fetching for user ${user.id}, dates: ${start_date} to ${end_date}, filter: ${type_filter || 'all'}`);

    // Get seller authorization (a user may have one row per marketplace).
    // Prefer US (ATVPDKIKX0DER); otherwise use the most recently updated active row.
    const { data: sellerAuthRows, error: sellerError } = await supabase
      .from('seller_authorizations')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .order('updated_at', { ascending: false });

    const sellerAuth =
      (sellerAuthRows || []).find((r: any) => r.marketplace_id === 'ATVPDKIKX0DER') ||
      (sellerAuthRows || [])[0];

    if (sellerError || !sellerAuth) {
      console.log('[REIMBURSEMENTS] No seller authorization found', {
        rows: sellerAuthRows?.length || 0,
        error: sellerError?.message,
      });
      return new Response(JSON.stringify({ 
        success: true, 
        reimbursements: [],
        summary: {
          totalPending: 0,
          totalReimbursed: 0,
          refundNotReturned: { count: 0, amount: 0 },
          warehouseLost: { count: 0, amount: 0 },
          warehouseDamaged: { count: 0, amount: 0 },
          other: { count: 0, amount: 0 }
        }
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }


    const accessToken = await getLWAAccessToken(sellerAuth.refresh_token);

    // Calculate date range - default to last 60 days
    const endDate = end_date ? new Date(end_date) : new Date();
    const startDate = start_date ? new Date(start_date) : new Date(endDate.getTime() - 60 * 24 * 60 * 60 * 1000);

    const reimbursements: ReimbursementItem[] = [];
    const refundsToCheck: ReimbursementItem[] = []; // Collect refunds to filter with returns data
    const reimbursedSkus = new Set<string>(); // Track SKUs that have already been reimbursed

    // Amazon API has a 180-day limit per request, so we need to chunk if range is larger
    const MAX_DAYS_PER_CHUNK = 170; // Stay under 180 limit
    const msPerDay = 24 * 60 * 60 * 1000;
    const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / msPerDay);
    
    // Create date chunks
    const dateChunks: { start: Date; end: Date }[] = [];
    let chunkStart = new Date(startDate);
    
    while (chunkStart < endDate) {
      const chunkEnd = new Date(Math.min(
        chunkStart.getTime() + MAX_DAYS_PER_CHUNK * msPerDay,
        endDate.getTime()
      ));
      dateChunks.push({ start: new Date(chunkStart), end: new Date(chunkEnd) });
      chunkStart = new Date(chunkEnd.getTime() + msPerDay); // Start next chunk day after
    }

    console.log(`[REIMBURSEMENTS] Date range spans ${totalDays} days, split into ${dateChunks.length} chunks`);

    // Process each date chunk
    for (let chunkIdx = 0; chunkIdx < dateChunks.length; chunkIdx++) {
      const chunk = dateChunks[chunkIdx];
      const postedAfter = chunk.start.toISOString();
      const postedBefore = chunk.end.toISOString();

      let nextToken: string | undefined;
      let pageCount = 0;
      const maxPages = 50; // Increased from 10 to handle larger date ranges

      console.log(`[REIMBURSEMENTS] Chunk ${chunkIdx + 1}/${dateChunks.length}: ${postedAfter} to ${postedBefore}`);

    do {
      const params = new URLSearchParams({
        PostedAfter: postedAfter,
        PostedBefore: postedBefore,
        MaxResultsPerPage: '100',
      });

      if (nextToken) {
        params.set('NextToken', nextToken);
      }

      // Use direct FinancialEvents endpoint (more reliable than FinancialEventGroups)
      const financesUrl = `https://sellingpartnerapi-na.amazon.com/finances/v0/financialEvents?${params}`;
      const signedHeaders = await signRequest('GET', financesUrl, '', accessToken);

      const response = await fetch(financesUrl, {
        method: 'GET',
        headers: {
          ...signedHeaders,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[REIMBURSEMENTS] Financial events error:', errorText);
        break;
      }

      const data = await response.json();
      const financialEvents = data.payload?.FinancialEvents || {};

      // Process Adjustment Events (reimbursements, fee corrections, reversals)
      const adjustmentEvents = financialEvents.AdjustmentEventList || [];
      console.log(`[REIMBURSEMENTS] Page ${pageCount + 1}: Found ${adjustmentEvents.length} adjustment events`);

      for (const event of adjustmentEvents) {
        const adjustmentType = event.AdjustmentType || '';
        const items = event.AdjustmentItemList || [];
        const postedDate = event.PostedDate || new Date().toISOString();

        for (const item of items) {
          const amount = parseFloat(item.PerUnitAmount?.CurrencyAmount || item.TotalAmount?.CurrencyAmount || '0');
          const currency = item.PerUnitAmount?.CurrencyCode || item.TotalAmount?.CurrencyCode || 'USD';
          const qty = parseInt(item.Quantity || '1');
          const sku = item.SellerSKU;

          // Track SKUs that have been reimbursed for customer return issues
          // These adjustment types indicate Amazon already processed reimbursement for unreturned items
          if (adjustmentType.includes('CUSTOMER_RETURN') || 
              adjustmentType.includes('REFUND') ||
              adjustmentType.includes('CS_ERROR') ||
              adjustmentType.includes('FBACustomerReturn')) {
            if (sku) {
              reimbursedSkus.add(sku);
              console.log(`[REIMBURSEMENTS] Marking SKU ${sku} as already reimbursed (${adjustmentType})`);
            }
          }

          // Categorize the adjustment type
          let type: ReimbursementItem['type'] = 'OTHER';
          let status: ReimbursementItem['status'] = 'REIMBURSED';
          
          if (adjustmentType.includes('WAREHOUSE_LOST') || adjustmentType.includes('LOST')) {
            type = 'WAREHOUSE_LOST';
          } else if (adjustmentType.includes('WAREHOUSE_DAMAGE') || adjustmentType.includes('DAMAGE')) {
            type = 'WAREHOUSE_DAMAGED';
          } else if (adjustmentType.includes('CARRIER') || adjustmentType.includes('TRANSIT')) {
            type = 'CARRIER_LOST';
          } else if (adjustmentType.includes('MISSING_FROM_INBOUND')) {
            type = 'WAREHOUSE_LOST'; // Treat missing inbound as warehouse lost
          } else if (adjustmentType.includes('FEE') && !adjustmentType.includes('REVERSAL')) {
            type = 'FEE_CORRECTION';
          } else if (adjustmentType.includes('REVERSAL_REIMBURSEMENT')) {
            // REVERSAL_REIMBURSEMENT = Amazon clawing back a previous reimbursement
            // This is money OUT of seller account - show as negative
            type = 'FEE_CORRECTION';
            status = 'DENIED'; // Mark as denied since it's money taken back
          } else if (adjustmentType.includes('FBAInventoryReimbursement')) {
            // General FBA inventory reimbursement
            type = 'OTHER';
          }

          // Skip if filter is applied and doesn't match
          if (type_filter && type_filter !== 'all' && type !== type_filter) {
            continue;
          }

          const totalAmount = amount * qty;
          
          // For REVERSAL_REIMBURSEMENT, the amount is negative (money taken from seller)
          // Keep track of direction for display
          const isClawback = adjustmentType.includes('REVERSAL_REIMBURSEMENT');

          const reimbursement: ReimbursementItem = {
            id: `adj-${adjustmentType}-${item.SellerSKU || item.ASIN || 'unknown'}-${new Date(postedDate).getTime()}`,
            type,
            asin: item.ASIN || 'UNKNOWN',
            sku: item.SellerSKU,
            fnsku: item.FNSKU,
            quantity: qty,
            amount: isClawback ? -Math.abs(totalAmount) : Math.abs(totalAmount),
            currency,
            amountUSD: isClawback ? -Math.abs(convertToUSD(totalAmount, currency)) : Math.abs(convertToUSD(totalAmount, currency)),
            postedDate,
            reason: adjustmentType,
            status: isClawback ? 'DENIED' : (totalAmount > 0 ? 'REIMBURSED' : 'PENDING'),
          };

          reimbursements.push(reimbursement);
          console.log(`[REIMBURSEMENTS] Found ${type} (${adjustmentType}): ${reimbursement.asin} | $${reimbursement.amountUSD.toFixed(2)}`);
        }
      }

      // Process Refund Events - look for ones without return
      // We need to cross-reference with returns data to find truly unreturned refunds
      const refundEvents = financialEvents.RefundEventList || [];
      for (const event of refundEvents) {
        const items = event.ShipmentItemAdjustmentList || [];
        const postedDate = event.PostedDate;
        const orderId = event.AmazonOrderId;

        for (const item of items) {
          const asin = item.SellerSKU ? await getAsinFromSku(supabase, user.id, item.SellerSKU) : 'UNKNOWN';
          const qty = parseInt(item.QuantityShipped || '1');
          
          // Calculate total refund amount
          let totalAmount = 0;
          let currency = 'USD';
          for (const charge of item.ItemChargeAdjustmentList || []) {
            if (charge.ChargeType === 'Principal') {
              totalAmount += parseFloat(charge.ChargeAmount?.CurrencyAmount || '0');
              currency = charge.ChargeAmount?.CurrencyCode || 'USD';
            }
          }

          if (totalAmount !== 0 && (!type_filter || type_filter === 'all' || type_filter === 'REFUND_NOT_RETURNED')) {
            const refundDate = new Date(postedDate);
            const daysAgo = Math.floor((Date.now() - refundDate.getTime()) / (1000 * 60 * 60 * 24));

            // Store refund info for later filtering with returns data
            refundsToCheck.push({
              id: `refund-${orderId}-${item.SellerSKU || 'unknown'}`,
              type: 'REFUND_NOT_RETURNED' as const,
              asin,
              sku: item.SellerSKU,
              quantity: qty,
              amount: Math.abs(totalAmount),
              currency,
              amountUSD: Math.abs(convertToUSD(totalAmount, currency)),
              postedDate,
              orderId,
              reason: 'Customer refunded but product may not have been returned',
              status: (daysAgo >= 45 ? 'ELIGIBLE' : 'PENDING') as 'ELIGIBLE' | 'PENDING',
              daysOpen: daysAgo,
            });
          }
        }
      }

      nextToken = data.payload?.NextToken;
      pageCount++;
      
      // Small delay to avoid rate limiting
      if (nextToken) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } while (nextToken && pageCount < maxPages);

      // Delay between chunks to avoid rate limiting
      if (chunkIdx < dateChunks.length - 1) {
        console.log(`[REIMBURSEMENTS] Waiting 1s before next chunk...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } // End of chunk loop

    // Build a set of Order IDs that were returned to sellable inventory
    // by checking FBA Returns data
    const returnedOrderIds = new Set<string>();
    const returnedOrderSkus = new Set<string>(); // Track order+sku combos returned as sellable
    
    // Fetch FBA customer returns to filter out items returned as sellable
    console.log(`[REIMBURSEMENTS] Fetching FBA returns data to filter sellable returns...`);
    
    try {
      // Use FBA Returns Report or Customer Returns API
      // We'll check for returns that were marked as sellable disposition
      const returnsEndDate = new Date();
      const returnsStartDate = new Date(startDate);
      
      // Process returns in chunks of 180 days (API limit)
      let returnsCursor = new Date(returnsStartDate);
      
      while (returnsCursor < returnsEndDate) {
        const returnsChunkEnd = new Date(Math.min(
          returnsCursor.getTime() + 170 * 24 * 60 * 60 * 1000,
          returnsEndDate.getTime()
        ));
        
        const returnsParams = new URLSearchParams({
          createdAfter: returnsCursor.toISOString(),
          createdBefore: returnsChunkEnd.toISOString(),
        });
        
        const returnsUrl = `https://sellingpartnerapi-na.amazon.com/fba/outbound/2020-09-04/returns?${returnsParams}`;
        const returnSignedHeaders = await signRequest('GET', returnsUrl, '', accessToken);
        
        const returnsResponse = await fetch(returnsUrl, {
          method: 'GET',
          headers: {
            ...returnSignedHeaders,
            'Content-Type': 'application/json',
          },
        });
        
        if (returnsResponse.ok) {
          const returnsData = await returnsResponse.json();
          const returns = returnsData.payload?.returnItems || [];
          
          console.log(`[REIMBURSEMENTS] Found ${returns.length} FBA returns in chunk`);
          
          for (const ret of returns) {
            // Check if the return was received in sellable condition
            // Disposition: SELLABLE means it went back to sellable inventory
            const disposition = ret.disposition || '';
            const status = ret.status || '';
            const orderId = ret.amazonRmaId || ret.orderId || '';
            const sku = ret.sellerSku || '';
            
            if (disposition === 'SELLABLE' || 
                disposition.includes('SELLABLE') ||
                status === 'Returned' ||
                status === 'ReturnsReceived') {
              if (orderId) {
                returnedOrderIds.add(orderId);
              }
              if (orderId && sku) {
                returnedOrderSkus.add(`${orderId}-${sku}`);
              }
              console.log(`[REIMBURSEMENTS] Return ${orderId} SKU ${sku} was returned as ${disposition}`);
            }
          }
        } else {
          console.log(`[REIMBURSEMENTS] Returns API returned ${returnsResponse.status}, trying alternative approach...`);
        }
        
        returnsCursor = new Date(returnsChunkEnd.getTime() + 24 * 60 * 60 * 1000);
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch (returnsError) {
      console.error('[REIMBURSEMENTS] Error fetching returns data:', returnsError);
      // Continue with other filtering even if returns API fails
    }
    
    console.log(`[REIMBURSEMENTS] Found ${returnedOrderIds.size} orders with sellable returns, ${returnedOrderSkus.size} order-SKU combos`);
    
    // Filter refunds - exclude:
    // 1. SKUs that have already been reimbursed
    // 2. Orders that were returned to sellable inventory
    console.log(`[REIMBURSEMENTS] Checking ${refundsToCheck.length} refunds, ${reimbursedSkus.size} SKUs already reimbursed...`);
    
    for (const refund of refundsToCheck) {
      // Skip if this SKU was already reimbursed by Amazon
      if (refund.sku && reimbursedSkus.has(refund.sku)) {
        console.log(`[REIMBURSEMENTS] Skipping refund ${refund.orderId} - SKU ${refund.sku} already reimbursed`);
        continue;
      }
      
      // Skip if this order was returned to sellable inventory
      if (refund.orderId && returnedOrderIds.has(refund.orderId)) {
        console.log(`[REIMBURSEMENTS] Skipping refund ${refund.orderId} - returned to sellable inventory`);
        continue;
      }
      
      // Skip if this specific order+SKU combo was returned as sellable
      if (refund.orderId && refund.sku && returnedOrderSkus.has(`${refund.orderId}-${refund.sku}`)) {
        console.log(`[REIMBURSEMENTS] Skipping refund ${refund.orderId} SKU ${refund.sku} - returned as sellable`);
        continue;
      }

      // Only include refunds that are 60+ days old (beyond Amazon's auto-reimbursement window)
      // Amazon typically auto-reimburses within 45-60 days if item wasn't returned
      if (refund.daysOpen && refund.daysOpen >= 60) {
        refund.status = 'ELIGIBLE';
        refund.reason = 'Customer refunded 60+ days ago, item not returned, not yet reimbursed';
        reimbursements.push(refund);
        console.log(`[REIMBURSEMENTS] Including refund ${refund.orderId} (${refund.daysOpen} days old, SKU ${refund.sku})`);
      } else if (refund.daysOpen && refund.daysOpen >= 45) {
        // Between 45-60 days - mark as pending (Amazon may still auto-process)
        refund.status = 'PENDING';
        refund.reason = 'Awaiting Amazon auto-reimbursement (45-60 day window)';
        reimbursements.push(refund);
        console.log(`[REIMBURSEMENTS] Including pending refund ${refund.orderId} (${refund.daysOpen} days old)`);
      }
      // Refunds < 45 days old are not included as Amazon will auto-process if needed
    }

    console.log(`[REIMBURSEMENTS] After filtering: ${reimbursements.filter(r => r.type === 'REFUND_NOT_RETURNED').length} unreturned refunds`);

    // Enrich with product data
    const asins = [...new Set(reimbursements.map(r => r.asin).filter(a => a !== 'UNKNOWN'))];
    if (asins.length > 0) {
      const { data: inventoryData } = await supabase
        .from('inventory')
        .select('asin, title, image_url')
        .eq('user_id', user.id)
        .in('asin', asins);

      const inventoryMap = new Map(inventoryData?.map(i => [i.asin, i]) || []);

      for (const r of reimbursements) {
        const inv = inventoryMap.get(r.asin);
        if (inv) {
          r.title = inv.title;
          r.imageUrl = inv.image_url;
        }
      }
    }

    // === Auto-attach Reimbursement IDs from the FBA Reimbursements Report ===
    // The Finances API does not include reimbursement-id; the dedicated report does.
    try {
      const reportRows = await fetchReimbursementsReport(accessToken, startDate, endDate.toISOString());
      if (reportRows.length > 0) {
        // Index by orderId+sku, fallback by sku+approxDate
        const byOrderSku = new Map<string, { reimbursementId: string; caseId: string }>();
        const bySkuDate = new Map<string, { reimbursementId: string; caseId: string }>();
        for (const row of reportRows) {
          const rid = row['reimbursement-id'] || '';
          const cid = row['case-id'] || '';
          const orderId = row['amazon-order-id'] || '';
          const sku = row['sku'] || '';
          const approvedDate = (row['approval-date'] || '').slice(0, 10);
          if (!rid) continue;
          if (orderId && sku) byOrderSku.set(`${orderId}|${sku}`, { reimbursementId: rid, caseId: cid });
          if (sku && approvedDate) bySkuDate.set(`${sku}|${approvedDate}`, { reimbursementId: rid, caseId: cid });
        }

        let matched = 0;
        for (const r of reimbursements) {
          if (r.reimbursementId) continue;
          // Try orderId+sku first
          if (r.orderId && r.sku) {
            const m = byOrderSku.get(`${r.orderId}|${r.sku}`);
            if (m) { r.reimbursementId = m.reimbursementId; r.caseId = m.caseId; matched++; continue; }
          }
          // Fallback: sku + posted date (±1 day)
          if (r.sku && r.postedDate) {
            const d = new Date(r.postedDate);
            for (const offset of [0, -1, 1, -2, 2]) {
              const test = new Date(d.getTime() + offset * 86400000).toISOString().slice(0, 10);
              const m = bySkuDate.get(`${r.sku}|${test}`);
              if (m) { r.reimbursementId = m.reimbursementId; r.caseId = m.caseId; matched++; break; }
            }
          }
        }
        console.log(`[REIMBURSEMENTS] Auto-attached ${matched} reimbursement IDs from report`);
      }
    } catch (reportErr) {
      console.warn('[REIMBURSEMENTS] Report enrichment failed (non-fatal):', (reportErr as Error).message);
    }


    const summary = {
      totalPending: reimbursements.filter(r => r.status === 'PENDING' || r.status === 'ELIGIBLE').reduce((sum, r) => sum + r.amountUSD, 0),
      totalReimbursed: reimbursements.filter(r => r.status === 'REIMBURSED').reduce((sum, r) => sum + r.amountUSD, 0),
      refundNotReturned: {
        count: reimbursements.filter(r => r.type === 'REFUND_NOT_RETURNED').length,
        amount: reimbursements.filter(r => r.type === 'REFUND_NOT_RETURNED').reduce((sum, r) => sum + r.amountUSD, 0),
      },
      warehouseLost: {
        count: reimbursements.filter(r => r.type === 'WAREHOUSE_LOST').length,
        amount: reimbursements.filter(r => r.type === 'WAREHOUSE_LOST').reduce((sum, r) => sum + r.amountUSD, 0),
      },
      warehouseDamaged: {
        count: reimbursements.filter(r => r.type === 'WAREHOUSE_DAMAGED').length,
        amount: reimbursements.filter(r => r.type === 'WAREHOUSE_DAMAGED').reduce((sum, r) => sum + r.amountUSD, 0),
      },
      other: {
        count: reimbursements.filter(r => !['REFUND_NOT_RETURNED', 'WAREHOUSE_LOST', 'WAREHOUSE_DAMAGED'].includes(r.type)).length,
        amount: reimbursements.filter(r => !['REFUND_NOT_RETURNED', 'WAREHOUSE_LOST', 'WAREHOUSE_DAMAGED'].includes(r.type)).reduce((sum, r) => sum + r.amountUSD, 0),
      },
    };

    console.log(`[REIMBURSEMENTS] Found ${reimbursements.length} items, pending: $${summary.totalPending.toFixed(2)}, reimbursed: $${summary.totalReimbursed.toFixed(2)}`);

    return new Response(JSON.stringify({
      success: true,
      reimbursements: reimbursements.sort((a, b) => new Date(b.postedDate).getTime() - new Date(a.postedDate).getTime()),
      summary,
      lastUpdate: new Date().toISOString(),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[REIMBURSEMENTS] Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: (error as Error).message 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// Helper to get ASIN from SKU
async function getAsinFromSku(supabase: any, userId: string, sku: string): Promise<string> {
  const { data } = await supabase
    .from('inventory')
    .select('asin')
    .eq('user_id', userId)
    .eq('sku', sku)
    .single();
  
  return data?.asin || 'UNKNOWN';
}
