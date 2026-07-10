import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";
import { gunzip } from "https://deno.land/x/compress@v0.4.5/gzip/mod.ts";
import { getListingUnitCost } from "../_shared/cost-contract.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function normalizeReportHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/^"+|"+$/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function findHeaderIndex(headers: string[], aliases: string[]): number {
  const normalizedAliases = aliases.map(normalizeReportHeader);
  return headers.findIndex((header) => normalizedAliases.includes(normalizeReportHeader(header)));
}

function parseReportLines(reportText: string): { lines: string[]; headers: string[] } {
  const normalizedText = reportText
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = normalizedText
    .split('\n')
    .map((line) => line.replace(/\u0000/g, '').trimEnd())
    .filter((line) => line.length > 0);

  const headers = (lines[0] || '').split('\t').map((header) => header.trim());
  return { lines, headers };
}

async function downloadReportText(documentUrl: string, compressionAlgorithm?: string): Promise<string> {
  const reportResponse = await fetch(documentUrl);
  if (!reportResponse.ok) {
    throw new Error(`Failed to download report: ${reportResponse.status}`);
  }

  if ((compressionAlgorithm || '').toUpperCase() === 'GZIP') {
    const compressedData = new Uint8Array(await reportResponse.arrayBuffer());
    const decompressed = gunzip(compressedData);
    return new TextDecoder().decode(decompressed);
  }

  return await reportResponse.text();
}

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
  const clientId = Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('Missing LWA_CLIENT_ID or LWA_CLIENT_SECRET');
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
  method: string,
  path: string,
  accessToken: string,
  queryParams: Record<string, string> = {},
  body?: string,
  maxRetries: number = 3
): Promise<any> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error('Missing AWS credentials');
  }

  const host = 'sellingpartnerapi-na.amazon.com';
  const service = 'execute-api';
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const queryString = new URLSearchParams(queryParams).toString();
    const canonicalUri = path;
    const canonicalQueryString = queryString;
    
    const payloadHash = body 
      ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))).map(b => b.toString(16).padStart(2, '0')).join('')
      : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    const headers: Record<string, string> = {
      'host': host,
      'x-amz-date': amzDate,
      'x-amz-access-token': accessToken,
    };
    
    if (body) {
      headers['content-type'] = 'application/json';
    }

    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    
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
    
    const fetchOptions: RequestInit = {
      method,
      headers: {
        ...headers,
        'Authorization': authorizationHeader,
      },
    };
    
    if (body) {
      fetchOptions.body = body;
    }

    const response = await fetch(url, fetchOptions);

    if (response.ok) {
      return await response.json();
    }

    const errorText = await response.text();
    
    // Handle 429 (rate limit) with exponential backoff
    if (response.status === 429 && attempt < maxRetries) {
      const waitTime = Math.min(30000, 5000 * Math.pow(2, attempt - 1)); // 5s, 10s, 20s, max 30s
      console.warn(`[FULL_SYNC] Rate limited (429), waiting ${waitTime/1000}s before retry ${attempt + 1}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      continue;
    }
    
    // Handle 503 (service unavailable) with retry
    if (response.status === 503 && attempt < maxRetries) {
      const waitTime = 10000 * attempt;
      console.warn(`[FULL_SYNC] Service unavailable (503), waiting ${waitTime/1000}s before retry ${attempt + 1}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      continue;
    }

    console.error('SP-API Error:', errorText);
    throw new Error(`SP-API request failed: ${response.status} - ${errorText}`);
  }

  throw new Error('SP-API request failed after max retries');
}

async function updateProgress(
  supabase: any,
  progressId: string,
  updates: {
    status?: string;
    message?: string;
    current_chunk?: number;
    total_chunks?: number;
    error?: string;
  }
) {
  const { error } = await supabase
    .from('pl_sync_progress')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', progressId);
  
  if (error) {
    console.error('Failed to update progress:', error);
  }
}

async function isSyncCancelled(supabase: any, progressId: string) {
  const { data, error } = await supabase
    .from('pl_sync_progress')
    .select('status')
    .eq('id', progressId)
    .maybeSingle();

  if (error) {
    console.warn('[FULL_SYNC] Failed to read progress status:', (error as Error).message);
    return false;
  }

  return data?.status === 'cancelled';
}

async function throwIfCancelled(supabase: any, progressId: string) {
  if (await isSyncCancelled(supabase, progressId)) {
    throw new Error('sync_cancelled_by_user');
  }
}

type InventoryQuantitySnapshot = {
  available: number;
  reserved: number;
  inbound: number;
};

type PhysicalInventorySnapshot = {
  warehouse: number;
  sellable: number;
  reserved: number;
  inbound: number;
  unfulfillable: number;
};

function getLiveSummaryQuantities(summary: any): InventoryQuantitySnapshot {
  const details = summary?.inventoryDetails || summary || {};

  const available =
    details?.fulfillableQuantity ??
    summary?.totalFulfillableQuantity ??
    summary?.fulfillableQuantity ??
    0;
  const reserved =
    details?.reservedQuantity?.totalReservedQuantity ??
    summary?.reservedQuantity?.totalReservedQuantity ??
    0;
  const inbound =
    (details?.inboundReceivingQuantity ?? summary?.inboundReceivingQuantity ?? 0) +
    (details?.inboundShippedQuantity ?? summary?.inboundShippedQuantity ?? 0);

  return { available, reserved, inbound };
}

function accumulateInventoryQuantity(
  map: Map<string, InventoryQuantitySnapshot>,
  key: string | null | undefined,
  quantity: InventoryQuantitySnapshot,
) {
  if (!key) return;

  const existing = map.get(key);
  if (existing) {
    existing.available += quantity.available;
    existing.reserved += quantity.reserved;
    existing.inbound += quantity.inbound;
    return;
  }

  map.set(key, { ...quantity });
}

function getPhysicalInventorySnapshot(params: {
  warehouseQuantity?: number;
  sellableQuantity?: number;
  reservedQuantity?: number;
  inboundQuantity?: number;
  unfulfillableQuantity?: number;
}): PhysicalInventorySnapshot {
  const warehouse = Math.max(0, params.warehouseQuantity ?? 0);
  const sellable = Math.max(0, params.sellableQuantity ?? 0);
  const reserved = Math.max(0, params.reservedQuantity ?? 0);
  const inbound = Math.max(0, params.inboundQuantity ?? 0);
  const unfulfillable = Math.max(0, params.unfulfillableQuantity ?? 0);

  return {
    warehouse,
    sellable,
    reserved,
    inbound,
    unfulfillable,
  };
}

function resolveStoredAvailableFromPhysical(snapshot: PhysicalInventorySnapshot): number {
  // Use Amazon's direct sellable quantity as the source of truth.
  // Previously this derived available = warehouse - reserved - unfulfillable,
  // which zeroed out items when afn-warehouse-quantity was missing/inconsistent.
  return Math.max(snapshot.sellable, 0);
}

async function fetchLiveFbaQuantities(accessToken: string, marketplaceId: string): Promise<{
  bySku: Map<string, InventoryQuantitySnapshot>;
}> {
  const bySku = new Map<string, InventoryQuantitySnapshot>();
  let nextToken: string | undefined;
  let pageCount = 0;

  while (true) {
    const queryParams: Record<string, string> = {
      marketplaceIds: marketplaceId,
      details: 'true',
      granularityType: 'Marketplace',
      granularityId: marketplaceId,
    };

    if (nextToken) queryParams.nextToken = nextToken;

    const response = await callSpApi('GET', '/fba/inventory/v1/summaries', accessToken, queryParams);
    const summaries = response?.payload?.inventorySummaries || [];

    for (const summary of summaries) {
      const quantity = getLiveSummaryQuantities(summary);
      const sku = summary?.sellerSku || summary?.sku || summary?.inventoryDetails?.sellerSku;
      accumulateInventoryQuantity(bySku, sku, quantity);
    }

    pageCount += 1;
    nextToken = response?.payload?.pagination?.nextToken || response?.payload?.nextToken;
    if (!nextToken) break;

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log(`[FULL_SYNC] Live quantity verification loaded ${bySku.size} SKU rows across ${pageCount} pages`);
  return { bySku };
}

async function runFullInventorySync(
  supabase: any,
  userId: string,
  progressId: string,
  refreshToken: string,
  marketplaceId: string,
  nonDestructiveSync = false
) {
  try {
    console.log(`[FULL_SYNC] Starting full inventory sync for user ${userId} non_destructive=${nonDestructiveSync}`);
    await throwIfCancelled(supabase, progressId);
    
    await updateProgress(supabase, progressId, {
      status: 'running',
      message: 'Getting Amazon access token...',
      current_chunk: 1,
      total_chunks: 10,
    });

    const accessToken = await getLwaAccessToken(refreshToken);
    console.log('[FULL_SYNC] Got access token');

    // Step 1: Check for existing recent reports first to avoid quota exhaustion
    await updateProgress(supabase, progressId, {
      message: 'Checking for existing reports...',
      current_chunk: 2,
    });

    const reportType = 'GET_FBA_MYI_ALL_INVENTORY_DATA';
    let reportDocumentId: string | null = null;
    let lastReportError: string | null = null;

    // Try to find a recent DONE report from the last 30 minutes to reuse
    try {
      const recentReportsResponse = await callSpApi(
        'GET',
        '/reports/2021-06-30/reports',
        accessToken,
        {
          reportTypes: reportType,
          marketplaceIds: marketplaceId,
          pageSize: '10',
          processingStatuses: 'DONE',
        }
      );

      const recentReports = recentReportsResponse.reports || [];
      console.log(`[FULL_SYNC] Found ${recentReports.length} recent DONE reports`);
      
      // Check if any report was created in the last 30 minutes
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      for (const report of recentReports) {
        const createdTime = new Date(report.createdTime);
        if (createdTime > thirtyMinutesAgo && report.reportDocumentId) {
          console.log(`[FULL_SYNC] Reusing recent report from ${report.createdTime}, ID: ${report.reportDocumentId}`);
          reportDocumentId = report.reportDocumentId;
          
          await updateProgress(supabase, progressId, {
            message: 'Found recent report, skipping generation...',
            current_chunk: 3,
          });
          break;
        }
      }
    } catch (e) {
      console.warn('[FULL_SYNC] Could not check for existing reports:', e);
      // Continue to create new report
    }

    // Only create new report if we didn't find a recent one
    if (!reportDocumentId) {
      await updateProgress(supabase, progressId, {
        message: 'Requesting FBA inventory report from Amazon...',
        current_chunk: 2,
      });

      // Use ALL_INVENTORY report to include all items (active, suppressed, zero-qty)
      const reportRequest = {
        reportType,
        marketplaceIds: [marketplaceId],
      };

      // Only 1 attempt now - no retry loop that creates multiple reports
      console.log(`[FULL_SYNC] Creating new report request`);
      
      const createReportResponse = await callSpApi(
        'POST',
        '/reports/2021-06-30/reports',
        accessToken,
        {},
        JSON.stringify(reportRequest)
      );

      const reportId = createReportResponse.reportId;
      console.log(`[FULL_SYNC] Report requested, ID: ${reportId}`);

      // Poll for report completion
      await updateProgress(supabase, progressId, {
        message: 'Waiting for Amazon to generate report...',
        current_chunk: 3,
      });

      let reportStatus = 'IN_QUEUE';
      let pollCount = 0;
      const maxPolls = 60; // Max 5 minutes (5 sec intervals)

      while (reportStatus !== 'DONE' && reportStatus !== 'FATAL' && reportStatus !== 'CANCELLED' && pollCount < maxPolls) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        await throwIfCancelled(supabase, progressId);
        
        const statusResponse = await callSpApi(
          'GET',
          `/reports/2021-06-30/reports/${reportId}`,
          accessToken
        );

        reportStatus = statusResponse.processingStatus;
        reportDocumentId = statusResponse.reportDocumentId || null;
        pollCount++;

        console.log(`[FULL_SYNC] Poll ${pollCount}: Status = ${reportStatus}`);
        
        await updateProgress(supabase, progressId, {
          message: `Waiting for report... (${reportStatus}, poll ${pollCount}/${maxPolls})`,
        });
      }

      if (reportStatus === 'DONE' && reportDocumentId) {
        console.log(`[FULL_SYNC] Report completed successfully`);
      } else if (reportStatus === 'FATAL') {
        lastReportError = 'Amazon report generation failed (FATAL). This is usually a temporary Amazon issue.';
        console.warn(`[FULL_SYNC] Report FATAL`);
      } else if (reportStatus === 'CANCELLED') {
        lastReportError = 'Amazon report was cancelled.';
        console.warn(`[FULL_SYNC] Report CANCELLED`);
      } else {
        lastReportError = `Report timed out with status: ${reportStatus}`;
        console.warn(`[FULL_SYNC] Report timed out`);
      }
    }

    // Check if we got a successful report
    if (lastReportError || !reportDocumentId) {
      throw new Error(`${lastReportError || 'Report failed'}. Try again in a few minutes - Amazon limits report requests per hour.`);
    }

    // Step 3: Get report document URL
    await updateProgress(supabase, progressId, {
      message: 'Downloading report from Amazon...',
      current_chunk: 4,
    });

    console.log(`[FULL_SYNC] Getting document: ${reportDocumentId}`);
    
    const documentResponse = await callSpApi(
      'GET',
      `/reports/2021-06-30/documents/${reportDocumentId}`,
      accessToken
    );

    const documentUrl = documentResponse.url;
    const compressionAlgorithm = documentResponse.compressionAlgorithm;

    console.log(`[FULL_SYNC] Document URL obtained, compression: ${compressionAlgorithm || 'none'}`);

    // Step 4: Download and parse report
    await updateProgress(supabase, progressId, {
      message: 'Parsing inventory report...',
      current_chunk: 5,
    });

    const reportText = await downloadReportText(documentUrl, compressionAlgorithm);
    await throwIfCancelled(supabase, progressId);

    console.log(`[FULL_SYNC] Report downloaded, size: ${reportText.length} chars`);

    // Parse TSV report
    const { lines, headers } = parseReportLines(reportText);
    
    // Log all headers for debugging
    console.log(`[FULL_SYNC] Report headers (${headers.length}):`, headers.join(', '));
    
    // Find column indices with EXACT matching for critical columns
    const skuIdx = findHeaderIndex(headers, ['sku', 'seller-sku', 'seller sku']);
    const asinIdx = findHeaderIndex(headers, ['asin', 'asin1']);
    const fnskuIdx = findHeaderIndex(headers, ['fnsku']);
    const titleIdx = findHeaderIndex(headers, ['product-name', 'product name', 'title', 'item-name', 'item name']);
    
    // Use exact column names from Amazon's FBA inventory reports
    const availableIdx = headers.findIndex(h => h === 'afn-fulfillable-quantity');
    const reservedIdx = headers.findIndex(h => h === 'afn-reserved-quantity');
    const inboundShippedIdx = headers.findIndex(h => h === 'afn-inbound-shipped-quantity');
    const inboundReceivingIdx = headers.findIndex(h => h === 'afn-inbound-receiving-quantity');
    const inboundWorkingIdx = headers.findIndex(h => h === 'afn-inbound-working-quantity');
    const unfulfillableIdx = headers.findIndex(h => h === 'afn-unsellable-quantity');
    const warehouseQtyIdx = headers.findIndex(h => h === 'afn-warehouse-quantity');
    const totalQtyIdx = headers.findIndex(h => h === 'afn-total-quantity');
    const afnListingExistsIdx = headers.findIndex(h => h === 'afn-listing-exists');
    const mfnListingExistsIdx = headers.findIndex(h => h === 'mfn-listing-exists');


    if (skuIdx === -1 || asinIdx === -1) {
      throw new Error(`Could not find required columns (SKU, ASIN) in report. Headers: ${headers.join(', ')}`);
    }
    
    // CRITICAL: Warn if quantity columns are missing - this WILL cause inaccurate data
    if (availableIdx === -1) {
      console.error('[FULL_SYNC] CRITICAL: afn-fulfillable-quantity column not found! Available will be 0.');
    }
    if (reservedIdx === -1) {
      console.error('[FULL_SYNC] CRITICAL: afn-reserved-quantity column not found! Reserved will be 0.');
    }
    if (inboundShippedIdx === -1 && inboundReceivingIdx === -1 && inboundWorkingIdx === -1) {
      console.error('[FULL_SYNC] CRITICAL: No inbound quantity columns found! Inbound will be 0.');
    }

    // Parse data rows
    let inventoryItems: any[] = [];

    for (let i = 1; i < lines.length; i++) {
      if (i % 200 === 0) {
        await throwIfCancelled(supabase, progressId);
      }
      const cols = lines[i].split('\t');
      if (cols.length < 2) continue;

      const sku = cols[skuIdx]?.trim() || '';
      const asin = cols[asinIdx]?.trim() || '';
      
      if (!sku || !asin) continue;

    // Calculate visible inbound only; exclude working pipeline quantity
      const inboundShippedQ = inboundShippedIdx !== -1 ? (parseInt(cols[inboundShippedIdx]) || 0) : 0;
      const inboundReceivingQ = inboundReceivingIdx !== -1 ? (parseInt(cols[inboundReceivingIdx]) || 0) : 0;
      const inboundWorkingQ = inboundWorkingIdx !== -1 ? (parseInt(cols[inboundWorkingIdx]) || 0) : 0;
      const inboundTotal = inboundShippedQ + inboundReceivingQ;

      // Safely extract reserved and unfulfilled - guard against missing columns
      const reservedQty = reservedIdx !== -1 ? (parseInt(cols[reservedIdx]) || 0) : 0;
      const unfulfillableQty = unfulfillableIdx !== -1 ? (parseInt(cols[unfulfillableIdx]) || 0) : 0;
       const sellableQty = availableIdx !== -1 ? (parseInt(cols[availableIdx]) || 0) : 0;
       const warehouseQty = warehouseQtyIdx !== -1
         ? (parseInt(cols[warehouseQtyIdx]) || 0)
         : (totalQtyIdx !== -1 ? (parseInt(cols[totalQtyIdx]) || 0) : sellableQty + reservedQty + unfulfillableQty);
       const physicalSnapshot = getPhysicalInventorySnapshot({
         warehouseQuantity: warehouseQty,
         sellableQuantity: sellableQty,
         reservedQuantity: reservedQty,
         inboundQuantity: inboundTotal,
         unfulfillableQuantity: unfulfillableQty,
       });
       const availableQty = resolveStoredAvailableFromPhysical(physicalSnapshot);
      
      const afnListingExists = afnListingExistsIdx !== -1 
        ? (cols[afnListingExistsIdx]?.trim()?.toLowerCase() === 'yes')
        : true; // default to true if column missing

      const parsedItem = {
        sku,
        asin,
        fnsku: fnskuIdx !== -1 ? (cols[fnskuIdx]?.trim() || null) : null,
        title: titleIdx !== -1 ? (cols[titleIdx]?.trim() || 'Unknown Product') : 'Unknown Product',
        available: availableQty,
        reserved: reservedQty,
        inbound: inboundTotal,
        inbound_shipped: inboundShippedQ,
        inbound_receiving: inboundReceivingQ,
        inbound_working: inboundWorkingQ,
        unfulfilled: unfulfillableQty,
        afnListingExists,
        warehouse: physicalSnapshot.warehouse,
        sellable: physicalSnapshot.sellable,
      };

      // Debug trace for target ASIN

      inventoryItems.push(parsedItem);

      // Log first few items with stock for debugging accuracy
      if (inventoryItems.length <= 5 && (availableQty > 0 || reservedQty > 0 || inboundTotal > 0)) {
      }
    }

    console.log(`[FULL_SYNC] Parsed ${inventoryItems.length} inventory items from report`);

    // Declare outside try so stale reconciliation can use it later
    let liveQuantities: { bySku: Map<string, InventoryQuantitySnapshot> } | null = null;
    const liveReconciledSkus = new Set<string>(); // Track SKUs verified via live SP-API

    try {
      console.log('[FULL_SYNC] Fetching live FBA inventory summaries to verify report quantities...');
      liveQuantities = await fetchLiveFbaQuantities(accessToken, marketplaceId);
      const verifiedLiveQuantities = liveQuantities;

      let reconciledCount = 0;
      let mismatchCount = 0;
      let missingLiveCount = 0;
      const missingLiveItems: Array<{ asin: string; sku: string }> = [];

      inventoryItems = inventoryItems.map((item) => {
        const liveQty = verifiedLiveQuantities.bySku.get(item.sku);

        if (!liveQty) {
          if ((item.available + item.reserved + item.inbound) > 0) {
            missingLiveCount += 1;
            missingLiveItems.push({ asin: item.asin, sku: item.sku });
            console.log(`[FULL_SYNC] Live summary missing for ${item.asin}/${item.sku}; queueing targeted verification for report qty available=${item.available}, reserved=${item.reserved}, inbound=${item.inbound}`);
          }
          return item;
        }

        reconciledCount += 1;
        liveReconciledSkus.add(item.sku); // Mark as live-verified

        const reconciledAvailable = liveQty.available;
        const reconciledReserved = liveQty.reserved;
        const reconciledInbound = liveQty.inbound;

        if (
          item.sellable !== liveQty.available ||
          item.reserved !== liveQty.reserved ||
          item.inbound !== liveQty.inbound
        ) {
          mismatchCount += 1;
          console.log(`[FULL_SYNC] Reconciled ${item.asin}/${item.sku}: report a=${item.available} r=${item.reserved} i=${item.inbound} → live a=${liveQty.available} r=${liveQty.reserved} i=${liveQty.inbound}`);
        }

        return {
          ...item,
          available: reconciledAvailable,
          reserved: reconciledReserved,
          inbound: reconciledInbound,
          sellable: reconciledAvailable,
          warehouse: Math.max(item.warehouse, reconciledAvailable + reconciledReserved + item.unfulfilled),
        };
      });

      let targetedRecoveredCount = 0;
      let targetedZeroedCount = 0;

      if (missingLiveItems.length > 0) {
        const uniqueMissingItems = Array.from(new Map(missingLiveItems.map((item) => [item.sku, item])).values());
        const unresolvedSkus = new Set(uniqueMissingItems.map((item) => item.sku));

        console.log(`[FULL_SYNC] TARGETED VERIFICATION: checking ${uniqueMissingItems.length} report-stock items missing from bulk live summaries`);

        for (let i = 0; i < uniqueMissingItems.length; i += 10) {
          await throwIfCancelled(supabase, progressId);
          const batch = uniqueMissingItems.slice(i, i + 10);
          const skuList = batch.map((item) => item.sku).join(',');

          try {
            const response = await callSpApi('GET', '/fba/inventory/v1/summaries', accessToken, {
              marketplaceIds: marketplaceId,
              details: 'true',
              granularityType: 'Marketplace',
              granularityId: marketplaceId,
              sellerSkus: skuList,
            });

            const summaries = response?.payload?.inventorySummaries || [];
            for (const summary of summaries) {
              const sku = summary?.sellerSku || summary?.sku || summary?.inventoryDetails?.sellerSku;
              if (!sku) continue;

              const qty = getLiveSummaryQuantities(summary);
              const idx = inventoryItems.findIndex((item) => item.sku === sku);
              if (idx === -1) continue;

              inventoryItems[idx] = {
                ...inventoryItems[idx],
                available: qty.available,
                reserved: qty.reserved,
                inbound: qty.inbound,
                sellable: qty.available,
                warehouse: Math.max(inventoryItems[idx].warehouse, qty.available + qty.reserved + inventoryItems[idx].unfulfilled),
              };

              unresolvedSkus.delete(sku);
              liveReconciledSkus.add(sku); // Mark as live-verified
              targetedRecoveredCount += 1;
              console.log(`[FULL_SYNC] TARGETED LIVE CONFIRMED ${inventoryItems[idx].asin}/${sku}: a=${qty.available} r=${qty.reserved} i=${qty.inbound}`);
            }
          } catch (batchErr: any) {
            console.warn(`[FULL_SYNC] Targeted verification failed for SKUs ${skuList}: ${batchErr?.message}`);
          }

          if (i + 10 < uniqueMissingItems.length) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }

        if (unresolvedSkus.size > 0) {
          targetedZeroedCount = unresolvedSkus.size;
          console.warn(`[FULL_SYNC] TARGETED LIVE MISS for ${unresolvedSkus.size} report-stock SKUs; preserving report quantities for review-only safety`);
        }

        console.log(`[FULL_SYNC] TARGETED VERIFICATION COMPLETE: recovered=${targetedRecoveredCount}, zeroed_report_only=${targetedZeroedCount}`);
      }

      console.log(`[FULL_SYNC] Live quantity reconciliation complete: reconciled=${reconciledCount}, mismatches=${mismatchCount}, missing_live_bulk=${missingLiveCount}`);
    } catch (liveQtyError: any) {
      console.warn(`[FULL_SYNC] Live quantity verification failed, keeping report quantities: ${liveQtyError?.message || liveQtyError}`);
    }
    
    // Log summary of items with stock (before rescue check)
    const itemsWithStock = inventoryItems.filter(i => i.available > 0 || i.reserved > 0 || i.inbound > 0);
    console.log(`[FULL_SYNC] Items with stock (pre-rescue): ${itemsWithStock.length} of ${inventoryItems.length} total`);

    // Step 5: Update database
    await updateProgress(supabase, progressId, {
      message: `Updating ${inventoryItems.length} inventory records...`,
      current_chunk: 6,
    });

    const now = new Date().toISOString();
    let updatedCount = 0;
    let insertedCount = 0;
    const batchSize = 200; // Larger batches for faster processing

    // First, get ALL existing records for this user to avoid per-batch queries
    console.log(`[FULL_SYNC] Fetching all existing inventory records for user...`);
    const allExistingSkus = new Set<string>();
    const existingRecordsMap = new Map<string, { id: string; asin: string; sku: string; available: number; reserved: number; inbound: number; source: string; listing_status: string | null; last_inventory_sync_at: string | null }>();
    const enabledUsAssignmentSkus = new Set<string>();
    const enabledUsAssignmentAsins = new Set<string>();
    const allUsAssignmentSkus = new Set<string>();
    const allUsAssignmentAsins = new Set<string>();
    
    let existingFrom = 0;
    const existingBatchSize = 1000;
    let hasMoreExisting = true;
    
    while (hasMoreExisting) {
      await throwIfCancelled(supabase, progressId);
      const { data: existingBatch, error: existingError } = await supabase
        .from('inventory')
        .select('id, asin, sku, available, reserved, inbound, source, listing_status, last_inventory_sync_at')
        .eq('user_id', userId)
        .order('id', { ascending: true })
        .range(existingFrom, existingFrom + existingBatchSize - 1);
      
      if (existingError) {
        console.error('[FULL_SYNC] Error fetching existing records:', existingError);
        break;
      }
      
      if (!existingBatch || existingBatch.length === 0) {
        hasMoreExisting = false;
      } else {
        existingBatch.forEach((r: any) => {
          allExistingSkus.add(r.sku);
          existingRecordsMap.set(r.sku, r);
        });
        
        if (existingBatch.length < existingBatchSize) {
          hasMoreExisting = false;
        } else {
          existingFrom += existingBatchSize;
        }
      }
    }
    
    console.log(`[FULL_SYNC] Found ${existingRecordsMap.size} existing inventory records`);

    // FIX 2: Validate record count matches DB
    try {
      const { count: dbCount, error: countErr } = await supabase
        .from('inventory')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);
      if (!countErr && dbCount !== null && dbCount !== existingRecordsMap.size) {
        console.warn(`[FULL_SYNC] ⚠️ RECORD COUNT MISMATCH: DB has ${dbCount} records but loaded ${existingRecordsMap.size} into memory. Some records may be missed!`);
      } else if (!countErr) {
        console.log(`[FULL_SYNC] ✅ Record count validated: ${existingRecordsMap.size} loaded == ${dbCount} in DB`);
      }
    } catch (e) {
      console.warn('[FULL_SYNC] Could not validate record count:', e);
    }

    let assignmentFrom = 0;
    const assignmentBatchSize = 1000;
    let hasMoreAssignments = true;

    while (hasMoreAssignments) {
      await throwIfCancelled(supabase, progressId);
      const { data: assignmentBatch, error: assignmentError } = await supabase
        .from('repricer_assignments')
        .select('sku, asin, is_enabled')
        .eq('user_id', userId)
        .eq('marketplace', 'US')
        .order('id', { ascending: true })
        .range(assignmentFrom, assignmentFrom + assignmentBatchSize - 1);

      if (assignmentError) {
        console.warn('[FULL_SYNC] Failed to load US assignments for rescue prioritization:', assignmentError.message);
        break;
      }

      if (!assignmentBatch || assignmentBatch.length === 0) {
        hasMoreAssignments = false;
      } else {
        assignmentBatch.forEach((row: any) => {
          // Track ALL assignments for MISMATCH protection
          if (row.sku) allUsAssignmentSkus.add(row.sku);
          if (row.asin) allUsAssignmentAsins.add(row.asin);
          // Track enabled-only for rescue prioritization
          if (row.is_enabled) {
            if (row.sku) enabledUsAssignmentSkus.add(row.sku);
            if (row.asin) enabledUsAssignmentAsins.add(row.asin);
          }
        });

        if (assignmentBatch.length < assignmentBatchSize) {
          hasMoreAssignments = false;
        } else {
          assignmentFrom += assignmentBatchSize;
        }
      }
    }

    console.log(`[FULL_SYNC] Loaded ${allUsAssignmentSkus.size} total US assignments (${enabledUsAssignmentSkus.size} enabled) for rescue/mismatch`);

    // RESCUE CHECK: Items that went from stocked → zero might be report lag.
    try {
      const rescueCandidates = inventoryItems.filter(item => {
        if (item.available > 0 || item.reserved > 0 || item.inbound > 0) return false; // still has stock
        const dbRecord = existingRecordsMap.get(item.sku);
        const dbAvailable = Number(dbRecord?.available ?? 0);
        const dbReserved = Number(dbRecord?.reserved ?? 0);
        const dbInbound = Number(dbRecord?.inbound ?? 0);
        const dbStock = dbAvailable + dbReserved + dbInbound;
        const wasPreviouslyStocked = dbStock > 0;
        const isActivelyTracked = enabledUsAssignmentSkus.has(item.sku) || enabledUsAssignmentAsins.has(item.asin);

        // Debug trace for target ASIN

        return wasPreviouslyStocked || isActivelyTracked;
      });

      const zeroedItems = rescueCandidates
        .sort((a, b) => {
          const aPriority = (enabledUsAssignmentSkus.has(a.sku) || enabledUsAssignmentAsins.has(a.asin)) ? 1 : 0;
          const bPriority = (enabledUsAssignmentSkus.has(b.sku) || enabledUsAssignmentAsins.has(b.asin)) ? 1 : 0;
          return bPriority - aPriority;
        })
        .slice(0, 250);

      if (rescueCandidates.length > zeroedItems.length) {
        console.log(`[FULL_SYNC] RESCUE CHECK: capped ${rescueCandidates.length} rescue candidates to ${zeroedItems.length} prioritized targeted lookups`);
      }

      if (zeroedItems.length > 0) {
        const activelyTrackedCount = zeroedItems.filter(item => enabledUsAssignmentSkus.has(item.sku) || enabledUsAssignmentAsins.has(item.asin)).length;
        console.log(`[FULL_SYNC] RESCUE CHECK: ${zeroedItems.length} zero-stock items queued for targeted live API verification (${activelyTrackedCount} actively repriced)`);
        let rescuedCount = 0;

        // Process in batches of 10 SKUs
        for (let i = 0; i < zeroedItems.length; i += 10) {
          await throwIfCancelled(supabase, progressId);
          const batch = zeroedItems.slice(i, i + 10);
          const skuList = batch.map(b => b.sku).join(',');

          try {
            const response = await callSpApi('GET', '/fba/inventory/v1/summaries', accessToken, {
              marketplaceIds: marketplaceId,
              details: 'true',
              granularityType: 'Marketplace',
              granularityId: marketplaceId,
              sellerSkus: skuList,
            });

            const summaries = response?.payload?.inventorySummaries || [];
            for (const summary of summaries) {
              const sku = summary?.sellerSku || summary?.sku;
              const qty = getLiveSummaryQuantities(summary);
              const totalLive = qty.available + qty.reserved + qty.inbound;

              // Debug trace for target ASIN rescue result

              if (totalLive > 0 && sku) {
                // Found live stock — rescue this item
                const idx = inventoryItems.findIndex(it => it.sku === sku);
                if (idx !== -1) {
                  console.log(`[FULL_SYNC] RESCUED ${inventoryItems[idx].asin}/${sku}: report=0 → live a=${qty.available} r=${qty.reserved} i=${qty.inbound}`);
                  inventoryItems[idx].available = qty.available;
                  inventoryItems[idx].reserved = qty.reserved;
                  inventoryItems[idx].inbound = qty.inbound;
                  inventoryItems[idx].sellable = qty.available;
                  inventoryItems[idx].warehouse = Math.max(
                    inventoryItems[idx].warehouse,
                    qty.available + qty.reserved + inventoryItems[idx].unfulfilled,
                  );
                  rescuedCount++;
                }
              }
            }
          } catch (batchErr: any) {
            console.warn(`[FULL_SYNC] Rescue batch failed for SKUs ${skuList}: ${batchErr?.message}`);
          }

          // Small delay to avoid throttling
          if (i + 10 < zeroedItems.length) {
            await new Promise(r => setTimeout(r, 300));
          }
        }

        console.log(`[FULL_SYNC] RESCUE COMPLETE: ${rescuedCount}/${zeroedItems.length} items recovered from report lag`);
      } else {
        console.log('[FULL_SYNC] RESCUE CHECK: no zero-stock candidates qualified for targeted live verification');
      }
    } catch (rescueErr: any) {
      console.error('[FULL_SYNC] RESCUE PHASE ERROR', {
        error: rescueErr instanceof Error ? rescueErr.message : String(rescueErr),
        stack: rescueErr instanceof Error ? rescueErr.stack : null,
      });
    }

    // Re-count items with stock after rescue
    const itemsWithStockAfterRescue = inventoryItems.filter(i => i.available > 0 || i.reserved > 0 || i.inbound > 0);
    console.log(`[FULL_SYNC] Items with stock after rescue: ${itemsWithStockAfterRescue.length} of ${inventoryItems.length} total`);

    // Separate all items into updates vs inserts upfront
    const allUpdates: any[] = [];
    const allInserts: any[] = [];
    const authoritativeFbaStateBySku = new Map<string, { listingStatus: string; source: string }>();
    
    const mismatchStrandedAsins: string[] = [];
    let restrictedCount = 0;
    let mismatchCount = 0;
    let strandedCount = 0;
    for (const item of inventoryItems) {
      const existing = existingRecordsMap.get(item.sku);
      const existingListingStatus = String(existing?.listing_status || '').toUpperCase();
      const isTombstonedGhost = existingListingStatus === 'NOT_IN_CATALOG' || existingListingStatus === 'DELETED';
      const hasStock = (item.available + item.reserved + item.inbound) > 0;
      const isRestricted = hasStock && !item.afnListingExists;
      const hasAnyAssignment = allUsAssignmentSkus.has(item.sku) || allUsAssignmentAsins.has(item.asin);
      const isActivelyTracked = enabledUsAssignmentSkus.has(item.sku) || enabledUsAssignmentAsins.has(item.asin);
      const isMismatch = !hasStock && item.afnListingExists && hasAnyAssignment;
      // STRANDED: afnListingExists=false AND zero stock BUT item has an assignment.
      // The unit may be physically in FBA but Amazon report hides it
      // (restricted, researching, return processing, stranded).
      // We preserve existing DB stock to avoid auto-disable cascade.
      const isStranded = !hasStock && !item.afnListingExists && hasAnyAssignment;
      let listingStatus: string;
      if (isRestricted) {
        listingStatus = 'RESTRICTED';
        restrictedCount++;
      } else if (hasStock) {
        listingStatus = 'ACTIVE';
      } else if (isMismatch) {
        listingStatus = 'MISMATCH';
        mismatchCount++;
        mismatchStrandedAsins.push(item.asin);
      } else if (isStranded) {
        listingStatus = 'STRANDED';
        strandedCount++;
        mismatchStrandedAsins.push(item.asin);
      } else {
        listingStatus = 'INACTIVE';
      }

      // Debug trace for target ASIN before DB write
      
      if (existing) {
        if (isTombstonedGhost) {
          authoritativeFbaStateBySku.set(item.sku, {
            listingStatus: existingListingStatus,
            source: existing.source || 'amazon_sync',
          });
          console.log(`[FULL_SYNC] Preserving tombstoned ghost ${item.asin}/${item.sku} (status=${existingListingStatus}) — skipping report overwrite`);
          continue;
        }

        // === SOURCE-AWARE WRITE PROTECTION ===
        // Reports can lag hours behind real-time; live API is always fresher.
        // Two tiers of protection:
        //   1. TIME-BASED: If live_api verified within 6 hours → full skip (keep all live data)
        //   2. ZERO-GUARD: If live_api ever verified this item (any age) and the report
        //      wants to zero it out while live_api had stock → keep live data.
        //      Only live_api should be trusted to zero out stock.
        const existingSource = existing.source || '';
        const existingSyncAt = existing.last_inventory_sync_at ? new Date(existing.last_inventory_sync_at).getTime() : 0;
        const nowMs = new Date(now).getTime();
        const hoursSinceLiveVerify = existingSyncAt > 0 ? (nowMs - existingSyncAt) / (60 * 60 * 1000) : Infinity;
        const isLiveApiSource = existingSource === 'live_api';
        const liveVerifiedRecently = isLiveApiSource && hoursSinceLiveVerify < 6; // Extended from 2h to 6h

        // Check if report is trying to zero out an item that live_api confirmed had stock
        const existingStock = (existing.available ?? 0) + (existing.reserved ?? 0) + (existing.inbound ?? 0);
        const reportStock = (item.available ?? 0) + (item.reserved ?? 0) + (item.inbound ?? 0);
        const reportWantsToZero = reportStock === 0 && existingStock > 0 && isLiveApiSource;

        let writeAvailable: number;
        let writeReserved: number;
        let writeInbound: number;
        let writeSource: string;
        let writeSyncAt: string;

        if (liveVerifiedRecently) {
          // TIER 1: Live API data is fresher than this report — full skip
          writeAvailable = existing.available ?? 0;
          writeReserved = existing.reserved ?? 0;
          writeInbound = existing.inbound ?? 0;
          writeSource = existingSource; // Keep 'live_api'
          writeSyncAt = existing.last_inventory_sync_at ?? new Date().toISOString();
          console.log(`[FULL_SYNC] PROTECTED ${item.asin}/${item.sku}: live_api verified ${Math.round(hoursSinceLiveVerify * 60)}m ago — skipping report overwrite (report: ${item.available}/${item.reserved}/${item.inbound}, kept: ${writeAvailable}/${writeReserved}/${writeInbound})`);
        } else if (reportWantsToZero) {
          // TIER 2: Report says 0 but live_api confirmed stock — don't trust report's zero
          // The report is likely stale. Keep live_api data and let the next live verify
          // be the authoritative source for zeroing out stock.
          writeAvailable = existing.available ?? 0;
          writeReserved = existing.reserved ?? 0;
          writeInbound = existing.inbound ?? 0;
          writeSource = existingSource; // Keep 'live_api'
          writeSyncAt = existing.last_inventory_sync_at ?? new Date().toISOString();
          console.log(`[FULL_SYNC] ZERO-GUARD ${item.asin}/${item.sku}: report wants to zero but live_api had ${existingStock} units (verified ${Math.round(hoursSinceLiveVerify * 60)}m ago) — keeping live data until next live verify`);
        } else if (nonDestructiveSync && existingStock > 0 && reportStock < existingStock) {
          writeAvailable = existing.available ?? 0;
          writeReserved = existing.reserved ?? 0;
          writeInbound = existing.inbound ?? 0;
          writeSource = existingSource || 'amazon_sync';
          writeSyncAt = existing.last_inventory_sync_at ?? now;
          console.warn(`[FULL_SYNC] NON-DESTRUCTIVE GUARD ${item.asin}/${item.sku}: report/live would lower stock ${existingStock} → ${reportStock}; kept DB ${writeAvailable}/${writeReserved}/${writeInbound}`);
        } else {
          // Normal: report data or live-reconciled data
          writeAvailable = item.available;
          writeReserved = item.reserved;
          writeInbound = item.inbound;
          // If this SKU was verified via live SP-API, tag as 'live_api' to activate protection window
          writeSource = liveReconciledSkus.has(item.sku) ? 'live_api' : 'amazon_sync';
          writeSyncAt = now;
        }

        const writeListingStatus = listingStatus;
        const writePreservedSince = null;

        authoritativeFbaStateBySku.set(item.sku, {
          listingStatus: writeListingStatus,
          source: writeSource,
        });

        // FRESHNESS CONTRACT:
        // - When this row was reconciled via the LIVE Summaries API (liveReconciledSkus),
        //   write available/reserved AND advance last_summaries_at — this is fresh.
        // - When this row only comes from the slow Manage Inventory Report,
        //   DO NOT overwrite available/reserved (they may already be fresher from
        //   the Summaries pipeline). We still update inbound, unfulfilled, status,
        //   and metadata, but leave the freshness watermark untouched so the DB
        //   trigger keeps the newer Summaries data.
        const isLiveReconciled = liveReconciledSkus.has(item.sku);
        const updatePayload: any = {
          id: existing.id,
          user_id: userId,
          asin: item.asin,
          sku: item.sku,
          title: item.title,
          fnsku: item.fnsku,
          inbound: writeInbound,
          inbound_shipped: (item as any).inbound_shipped ?? 0,
          inbound_receiving: (item as any).inbound_receiving ?? 0,
          inbound_working: (item as any).inbound_working ?? 0,
          unfulfilled: item.unfulfilled,
          source: writeSource,
          listing_status: writeListingStatus,
          preserved_since: writePreservedSince,
          last_inventory_sync_at: writeSyncAt,
        };

        if (isLiveReconciled) {
          updatePayload.available = writeAvailable;
          updatePayload.reserved = writeReserved;
          updatePayload.last_summaries_at = writeSyncAt;
        }

        allUpdates.push(updatePayload);
      } else {
        const insertSource = liveReconciledSkus.has(item.sku) ? 'live_api' : 'amazon_sync';
        authoritativeFbaStateBySku.set(item.sku, {
          listingStatus,
          source: insertSource,
        });

        // For NEW rows there is no prior data to protect, so insert the report
        // numbers. If they're live-reconciled, also seed last_summaries_at so the
        // freshness guard works on subsequent writes.
        const insertPayload: any = {
          user_id: userId,
          asin: item.asin,
          sku: item.sku,
          fnsku: item.fnsku,
          title: item.title,
          available: item.available,
          reserved: item.reserved,
          inbound: item.inbound,
          inbound_shipped: (item as any).inbound_shipped ?? 0,
          inbound_receiving: (item as any).inbound_receiving ?? 0,
          inbound_working: (item as any).inbound_working ?? 0,
          unfulfilled: item.unfulfilled,
          source: insertSource,
          listing_status: listingStatus,
          last_inventory_sync_at: now,
        };
        if (insertSource === 'live_api') {
          insertPayload.last_summaries_at = now;
        }
        allInserts.push(insertPayload);
      }
    }

    if (restrictedCount > 0) {
      console.log(`[FULL_SYNC] ⚠️ Detected ${restrictedCount} restricted/stranded listings with remaining stock (marked RESTRICTED)`);
    }
    if (mismatchCount > 0) {
      console.log(`[FULL_SYNC] ⚠️ Detected ${mismatchCount} items with API zero stock but AFN listing exists & active assignment (marked MISMATCH)`);
    }
    if (strandedCount > 0) {
      console.log(`[FULL_SYNC] ⚠️ Detected ${strandedCount} items with AFN listing gone, zero API stock, but previously had stock & has assignment (marked STRANDED — unit may be physically in FBA)`);
    }
    console.log(`[FULL_SYNC] Will update ${allUpdates.length} and insert ${allInserts.length} records`);

    // ─────────────────────────────────────────────────────────────────────
    // GLOBAL DROP GUARD
    // Compares pre-sync totals (from existingRecordsMap) against post-sync
    // projected totals (from allUpdates). If any dimension would drop more
    // than its safe threshold, the entire write batch is aborted, current
    // DB values are kept, and a review alert is logged. This prevents
    // bulk-sync inconsistency (mid-flight Amazon API drift) from wiping
    // valid inventory like the $51k → $35k incident.
    //
    // Active by default for cron / non-destructive syncs. User-initiated
    // foreground syncs bypass ONLY this bulk batch-level guard so manual
    // reconciliation still works.
    //
    // ⚠️ IMPORTANT: Manual syncs DO NOT bypass per-SKU protections. The
    // following per-SKU guards remain active on every code path (manual + cron):
    //   1. SUSPICIOUS-ZERO GUARD (lines ~1474-1510): Summaries returning 0
    //      for previously-positive stock requires a 2nd back-to-back confirm
    //      fetch. If confirm shows positive OR fails, the zero is rejected
    //      and DB stock is preserved.
    //   2. POSITIVE→ZERO REVIEW QUEUE (lines ~1518-1538): Even after double-
    //      confirmed live=0, positive→0 transitions are NEVER auto-zeroed —
    //      they are queued to inventory_missing_review for human approval.
    //   3. ZERO-GUARD vs LIVE_API (lines ~1078-1087): Report rows trying to
    //      zero a recently live_api-verified positive SKU are ignored.
    //   4. LIVE-VERIFIED RECENTLY (lines ~1070-1077): live_api data <6h old
    //      always wins over Report data.
    //
    // Manual sync may reconcile, but it can NEVER blindly write 0/0/0 from a
    // suspicious Amazon zero. Only explicit user action in /tools/inventory-
    // review can zero a previously-positive SKU.
    // ─────────────────────────────────────────────────────────────────────
    const DROP_GUARD_ENABLED = nonDestructiveSync;
    const DROP_THRESHOLDS = {
      available: 0.10, // 10%
      reserved: 0.20,  // 20%
      inbound: 0.20,   // 20%
      total_units: 0.10, // 10% across all units (proxy for valuation when costs unavailable)
    };
    const MIN_BASELINE_UNITS = 50; // Skip guard for very small accounts to avoid noise

    if (DROP_GUARD_ENABLED && allUpdates.length > 0) {
      // Build pre-sync totals from existing DB snapshot, restricted to SKUs
      // that this sync would actually modify (so unrelated SKUs don't dilute %).
      const updatedSkus = new Set(allUpdates.map((u: any) => u.sku).filter(Boolean));
      let preAvail = 0, preRes = 0, preIn = 0;
      for (const [sku, rec] of existingRecordsMap.entries()) {
        if (!updatedSkus.has(sku)) continue;
        preAvail += rec.available || 0;
        preRes += rec.reserved || 0;
        preIn += rec.inbound || 0;
      }
      let postAvail = 0, postRes = 0, postIn = 0;
      for (const u of allUpdates as any[]) {
        postAvail += u.available || 0;
        postRes += u.reserved || 0;
        postIn += u.inbound || 0;
      }
      const preTotal = preAvail + preRes + preIn;
      const postTotal = postAvail + postRes + postIn;

      const dropPct = (pre: number, post: number) =>
        pre <= 0 ? 0 : Math.max(0, (pre - post) / pre);

      const drops = {
        available: dropPct(preAvail, postAvail),
        reserved: dropPct(preRes, postRes),
        inbound: dropPct(preIn, postIn),
        total_units: dropPct(preTotal, postTotal),
      };

      const violations: string[] = [];
      if (preAvail >= MIN_BASELINE_UNITS && drops.available > DROP_THRESHOLDS.available) {
        violations.push(`available -${(drops.available * 100).toFixed(1)}% (${preAvail}→${postAvail})`);
      }
      if (preRes >= MIN_BASELINE_UNITS && drops.reserved > DROP_THRESHOLDS.reserved) {
        violations.push(`reserved -${(drops.reserved * 100).toFixed(1)}% (${preRes}→${postRes})`);
      }
      if (preIn >= MIN_BASELINE_UNITS && drops.inbound > DROP_THRESHOLDS.inbound) {
        violations.push(`inbound -${(drops.inbound * 100).toFixed(1)}% (${preIn}→${postIn})`);
      }
      if (preTotal >= MIN_BASELINE_UNITS && drops.total_units > DROP_THRESHOLDS.total_units) {
        violations.push(`total_units -${(drops.total_units * 100).toFixed(1)}% (${preTotal}→${postTotal})`);
      }

      if (violations.length > 0) {
        console.error(`[FULL_SYNC] 🛑 GLOBAL DROP GUARD TRIGGERED for user ${userId}: ${violations.join('; ')}. Aborting write batch (${allUpdates.length} updates skipped) — DB values preserved.`);

        // Log a review alert per affected SKU (cap to avoid flooding)
        try {
          const sample = (allUpdates as any[]).slice(0, 200);
          const reviewRows = sample
            .map((u: any) => {
              const prev = existingRecordsMap.get(u.sku);
              if (!prev) return null;
              return {
                user_id: userId,
                asin: u.asin || prev.asin,
                sku: u.sku,
                marketplace: u.marketplace || 'US',
                reason: 'global_drop_guard_triggered',
                prior_available: prev.available || 0,
                prior_reserved: prev.reserved || 0,
                prior_inbound: prev.inbound || 0,
                current_available: u.available || 0,
                current_reserved: u.reserved || 0,
                current_inbound: u.inbound || 0,
                status: 'needs_review',
                notes: `Bulk sync blocked: ${violations.join('; ')}`,
              };
            })
            .filter(Boolean);

          if (reviewRows.length > 0) {
            const { error: reviewErr } = await supabase
              .from('inventory_missing_review')
              .upsert(reviewRows, { onConflict: 'user_id,sku' });
            if (reviewErr) {
              console.warn('[FULL_SYNC] Failed to log drop-guard review rows:', reviewErr.message);
            }
          }
        } catch (e) {
          console.warn('[FULL_SYNC] Drop-guard review logging error:', (e as Error)?.message);
        }

        await updateProgress(supabase, progressId, {
          status: 'completed',
          message: `Sync aborted by drop guard: ${violations.join('; ')}. DB values preserved.`,
        });

        return new Response(JSON.stringify({
          success: true,
          aborted_by_drop_guard: true,
          violations,
          pre: { available: preAvail, reserved: preRes, inbound: preIn, total: preTotal },
          post: { available: postAvail, reserved: postRes, inbound: postIn, total: postTotal },
          updates_skipped: allUpdates.length,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } else {
        console.log(`[FULL_SYNC] ✅ Drop guard passed: avail ${preAvail}→${postAvail} (-${(drops.available*100).toFixed(1)}%), res ${preRes}→${postRes} (-${(drops.reserved*100).toFixed(1)}%), in ${preIn}→${postIn} (-${(drops.inbound*100).toFixed(1)}%)`);
      }
    }

    for (let i = 0; i < allUpdates.length; i += batchSize) {
      await throwIfCancelled(supabase, progressId);
      const batch = allUpdates.slice(i, i + batchSize);

      const { error } = await supabase
        .from('inventory')
        .upsert(batch, { onConflict: 'id' });

      if (error) {
        console.error(`[FULL_SYNC] Bulk update batch failed:`, error);
      } else {
        updatedCount += batch.length;
      }

      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(allUpdates.length / batchSize);
      console.log(`[FULL_SYNC] Update batch ${batchNum}/${totalBatches}: ${updatedCount} updated so far`);
      
      await updateProgress(supabase, progressId, {
        message: `Updated ${updatedCount} of ${allUpdates.length} items...`,
      });
    }

    // Process inserts in batches
    for (let i = 0; i < allInserts.length; i += batchSize) {
      await throwIfCancelled(supabase, progressId);
      const batch = allInserts.slice(i, i + batchSize);
      
      const { error } = await supabase
        .from('inventory')
        .insert(batch);

      if (!error) {
        insertedCount += batch.length;
      } else {
        console.error(`[FULL_SYNC] Insert error:`, error);
      }

      console.log(`[FULL_SYNC] Insert batch ${Math.floor(i / batchSize) + 1}: ${insertedCount} inserted so far`);
    }

    // Step 5a-fix: Re-enable repricer assignments for MISMATCH/STRANDED items
    if (mismatchStrandedAsins.length > 0) {
      try {
        const { data: reEnabled, error: reEnableErr } = await supabase
          .from('repricer_assignments')
          .update({ is_enabled: true })
          .eq('user_id', userId)
          .in('asin', mismatchStrandedAsins)
          .eq('is_enabled', false)
          .select('asin, sku');

        if (reEnableErr) {
          console.error(`[FULL_SYNC] Failed to re-enable MISMATCH/STRANDED assignments:`, reEnableErr.message);
        } else if (reEnabled && reEnabled.length > 0) {
          console.log(`[FULL_SYNC] RE-ENABLED ${reEnabled.length} repricer assignments for MISMATCH/STRANDED items: ${reEnabled.map((r: any) => r.asin).join(', ')}`);
        }
      } catch (reEnableErr: any) {
        console.error(`[FULL_SYNC] Error re-enabling MISMATCH/STRANDED assignments:`, reEnableErr?.message);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Step 5a-stale: STALE RECORD RECONCILIATION
    // Items in DB but NOT in the report keep old values. Reconcile them
    // against the live FBA Inventory API to prevent stale drift.
    // ══════════════════════════════════════════════════════════════════════
    await updateProgress(supabase, progressId, {
      message: 'Reconciling stale records not in report...',
    });

    const reportSkuSet = new Set(inventoryItems.map(item => item.sku));
    let staleReconciledFromLive = 0;
    let staleKeptPending = 0;
    let staleZeroedConfirmed = 0;
    let staleUntouched = 0;

    try {
      // Find DB records not touched by this report
      const staleRecords: Array<{ id: string; sku: string; asin: string; available: number; reserved: number; inbound: number; source: string; listing_status: string | null }> = [];
      for (const [sku, record] of existingRecordsMap.entries()) {
        if (!reportSkuSet.has(sku)) {
          staleRecords.push(record);
        }
      }

      const staleWithStock = staleRecords.filter(r => 
        (Number(r.available) || 0) + (Number(r.reserved) || 0) + (Number(r.inbound) || 0) > 0
      );
      const staleAlreadyZero = staleRecords.length - staleWithStock.length;

      console.log(`[FULL_SYNC] STALE RECONCILIATION: ${staleRecords.length} DB records not in report (${staleWithStock.length} with stock, ${staleAlreadyZero} already zero)`);

      if (staleRecords.length > 0 && liveQuantities) {
        const staleUpdates: any[] = [];
        const targetedStaleLiveBySku = new Map<string, InventoryQuantitySnapshot>();
        const staleMissingCandidates = staleRecords.filter((record) => {
          const existingListingStatus = String(record.listing_status || '').toUpperCase();
          if (existingListingStatus === 'NOT_IN_CATALOG' || existingListingStatus === 'DELETED') return false;

          const oldStock = (Number(record.available) || 0) + (Number(record.reserved) || 0) + (Number(record.inbound) || 0);
          const hasBulkLiveQty = Boolean(liveQuantities.bySku.get(record.sku));
          return oldStock > 0 && !hasBulkLiveQty;
        });

        if (staleMissingCandidates.length > 0) {
          console.log(`[FULL_SYNC] STALE TARGETED VERIFICATION: checking ${staleMissingCandidates.length} stocked stale records missing from bulk live summaries`);

          for (let i = 0; i < staleMissingCandidates.length; i += 10) {
            await throwIfCancelled(supabase, progressId);
            const batch = staleMissingCandidates.slice(i, i + 10);
            const skuList = batch.map((record) => record.sku).join(',');

            try {
              const response = await callSpApi('GET', '/fba/inventory/v1/summaries', accessToken, {
                marketplaceIds: marketplaceId,
                details: 'true',
                granularityType: 'Marketplace',
                granularityId: marketplaceId,
                sellerSkus: skuList,
              });

              const summaries = response?.payload?.inventorySummaries || [];
              for (const summary of summaries) {
                const sku = summary?.sellerSku || summary?.sku || summary?.inventoryDetails?.sellerSku;
                if (!sku) continue;
                targetedStaleLiveBySku.set(sku, getLiveSummaryQuantities(summary));
              }
            } catch (batchErr: any) {
              console.warn(`[FULL_SYNC] Stale targeted verification failed for SKUs ${skuList}: ${batchErr?.message}`);
            }

            if (i + 10 < staleMissingCandidates.length) {
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          }
        }

        // Collected review-queue rows for SKUs missing from the FBA Inventory Report.
        // POLICY: missing-from-report NEVER auto-zeros positive stock. We log it for review.
        const missingReviewRows: any[] = [];
        let staleQueuedForReview = 0;

        for (const record of staleRecords) {
          const existingListingStatus = String(record.listing_status || '').toUpperCase();
          const isTombstonedGhost = existingListingStatus === 'NOT_IN_CATALOG' || existingListingStatus === 'DELETED';
          if (isTombstonedGhost) {
            console.log(`[FULL_SYNC] Preserving tombstoned stale ghost ${record.asin}/${record.sku} (status=${existingListingStatus})`);
            continue;
          }

          const recordSource = record.source || '';
          const recordSyncAt = (record as any).last_inventory_sync_at ? new Date((record as any).last_inventory_sync_at).getTime() : 0;
          const hoursSinceLiveVerify = recordSyncAt > 0 ? (new Date(now).getTime() - recordSyncAt) / (60 * 60 * 1000) : Infinity;
          const liveVerifiedRecently = recordSource === 'live_api' && hoursSinceLiveVerify < 6;
          const liveQty = liveQuantities.bySku.get(record.sku) || targetedStaleLiveBySku.get(record.sku);

          if (liveQty) {
            // Live API has data for this item — trust it
            const oldStock = (Number(record.available) || 0) + (Number(record.reserved) || 0) + (Number(record.inbound) || 0);
            const newStock = liveQty.available + liveQty.reserved + liveQty.inbound;
            const changed = liveQty.available !== (Number(record.available) || 0) ||
                           liveQty.reserved !== (Number(record.reserved) || 0) ||
                           liveQty.inbound !== (Number(record.inbound) || 0);

            // ⚠️ SUSPICIOUS-ZERO GUARD (mem://architecture/inventory/suspicious-zero-guard-v1)
            // SP-API Summaries returns intermittent false-zeros. NEVER overwrite previous
            // positive stock with 0/0/0 from a single Summaries response. Require a second
            // back-to-back confirmation fetch before accepting the zero.
            const isPositiveToZero = oldStock > 0 && newStock === 0;
            let acceptedZero = !isPositiveToZero;

            if (isPositiveToZero) {
              try {
                await new Promise((r) => setTimeout(r, 1500));
                const confirmResp = await callSpApi('GET', '/fba/inventory/v1/summaries', accessToken, {
                  marketplaceIds: marketplaceId,
                  details: 'true',
                  granularityType: 'Marketplace',
                  granularityId: marketplaceId,
                  sellerSkus: record.sku,
                });
                const confirmSummaries = confirmResp?.payload?.inventorySummaries || [];
                const confirmSummary = confirmSummaries.find((s: any) => {
                  const sku = s?.sellerSku || s?.sku || s?.inventoryDetails?.sellerSku;
                  return sku === record.sku;
                });
                if (confirmSummary) {
                  const confirmQty = getLiveSummaryQuantities(confirmSummary);
                  const confirmTotal = confirmQty.available + confirmQty.reserved + confirmQty.inbound;
                  if (confirmTotal === 0) {
                    acceptedZero = true;
                  } else {
                    console.warn(`[FULL_SYNC] SUSPICIOUS-ZERO BLOCKED ${record.asin}/${record.sku}: 1st fetch said 0 but confirm said a=${confirmQty.available} r=${confirmQty.reserved} i=${confirmQty.inbound} — keeping DB value a=${record.available} r=${record.reserved} i=${record.inbound}`);
                  }
                } else {
                  console.warn(`[FULL_SYNC] SUSPICIOUS-ZERO BLOCKED ${record.asin}/${record.sku}: confirm fetch returned no summary — refusing to zero positive stock from single response`);
                }
              } catch (confirmErr: any) {
                console.warn(`[FULL_SYNC] SUSPICIOUS-ZERO BLOCKED ${record.asin}/${record.sku}: confirm fetch failed (${confirmErr?.message}) — refusing to zero positive stock`);
              }
            }

            if (changed && acceptedZero) {
              // ⚠️ POLICY (2026-05-01): missing-from-report no longer auto-zeros.
              // Even with double-confirmed live=0, if previous DB stock was POSITIVE,
              // we preserve it and queue for manual review. Amazon's FBA Inventory
              // Report and Summaries API can both intermittently omit/return-0 SKUs.
              // Only restorations (0 → positive) and same-positive updates apply.
              if (oldStock > 0 && newStock === 0) {
                missingReviewRows.push({
                  user_id: userId,
                  asin: record.asin,
                  sku: record.sku,
                  marketplace: marketplace,
                  prior_available: Number(record.available) || 0,
                  prior_reserved: Number(record.reserved) || 0,
                  prior_inbound: Number(record.inbound) || 0,
                  reason: 'positive_to_zero_double_confirmed',
                  detection_source: 'live_summaries_zero',
                  status: 'needs_review',
                });
                staleQueuedForReview++;
                staleKeptPending++;
                staleUpdates.push({
                  id: record.id,
                  last_inventory_sync_at: now,
                  source: record.source || 'amazon_sync',
                });
                console.warn(`[FULL_SYNC] STALE→REVIEW (positive→0 NOT auto-zeroed): ${record.asin}/${record.sku} kept a=${record.available} r=${record.reserved} i=${record.inbound} — queued for manual review`);
              } else {
                const newListingStatus = newStock > 0 ? 'ACTIVE' : 'INACTIVE';
                staleUpdates.push({
                  id: record.id,
                  available: liveQty.available,
                  reserved: liveQty.reserved,
                  inbound: liveQty.inbound,
                  listing_status: newListingStatus,
                  source: 'live_api',
                  last_inventory_sync_at: now,
                  preserved_since: null,
                });
                staleReconciledFromLive++;
                if (oldStock === 0 && newStock > 0) {
                  console.log(`[FULL_SYNC] STALE→RESTORED (live confirmed): ${record.asin}/${record.sku} → a=${liveQty.available} r=${liveQty.reserved} i=${liveQty.inbound}`);
                }
              }
            } else if (changed && !acceptedZero) {
              // Suspicious zero blocked — just stamp sync time, keep existing qty
              staleKeptPending++;
            } else {
              // Live matches DB — keep it protected as live_api because it was explicitly re-verified
              staleUpdates.push({
                id: record.id,
                last_inventory_sync_at: now,
                source: 'live_api',
              });
              staleUntouched++;
            }
          } else {
            // Not in report AND not in live API
            const oldStock = (Number(record.available) || 0) + (Number(record.reserved) || 0) + (Number(record.inbound) || 0);
            const hasAssignment = allUsAssignmentSkus.has(record.sku) || allUsAssignmentAsins.has(record.asin);

            if (liveVerifiedRecently) {
              staleKeptPending++;
              console.log(`[FULL_SYNC] STALE PROTECTED ${record.asin}/${record.sku}: live_api verified ${Math.round(hoursSinceLiveVerify * 60)}m ago and missing from report/bulk live — keeping existing qty a=${record.available} r=${record.reserved} i=${record.inbound}`);
            } else if (oldStock > 0) {
              // ⚠️ SUSPICIOUS-ZERO GUARD + 2026-05-01 REVIEW POLICY
              // Missing from both report AND live API. Never overwrite positive stock.
              // Queue for manual review so the user can confirm in Seller Central.
              staleUpdates.push({
                id: record.id,
                last_inventory_sync_at: now,
                source: record.source || 'amazon_sync',
              });
              staleKeptPending++;
              missingReviewRows.push({
                user_id: userId,
                asin: record.asin,
                sku: record.sku,
                marketplace: marketplace,
                prior_available: Number(record.available) || 0,
                prior_reserved: Number(record.reserved) || 0,
                prior_inbound: Number(record.inbound) || 0,
                reason: 'absent_from_report_and_live',
                detection_source: 'absent_both_sources',
                status: 'needs_review',
              });
              staleQueuedForReview++;
              console.warn(`[FULL_SYNC] STALE→REVIEW (absent from both sources): ${record.asin}/${record.sku} kept a=${record.available} r=${record.reserved} i=${record.inbound}${hasAssignment ? ' [assigned]' : ''}`);
            } else {
              // Already zero, just stamp sync time
              staleUpdates.push({
                id: record.id,
                last_inventory_sync_at: now,
                source: 'amazon_sync',
              });
              staleUntouched++;
            }
          }
        }

        // Write stale updates in batches.
        // IMPORTANT: use UPDATE (not upsert), because these payloads are partial
        // and don't carry user_id. Upsert would treat missing rows as INSERT and
        // fail the NOT NULL constraint on user_id.
        for (let i = 0; i < staleUpdates.length; i += batchSize) {
          await throwIfCancelled(supabase, progressId);
          const batch = staleUpdates.slice(i, i + batchSize);
          // Run updates in parallel within the batch (each keyed by id)
          const results = await Promise.all(
            batch.map((row: any) => {
              const { id, ...patch } = row;
              return supabase.from('inventory').update(patch).eq('id', id);
            })
          );
          for (const r of results) {
            if (r.error) {
              console.error(`[FULL_SYNC] Stale reconciliation row error:`, r.error.message);
            }
          }
        }

        // Persist review queue: increment occurrences if a row already exists for that ASIN/SKU.
        if (missingReviewRows.length > 0) {
          try {
            for (let i = 0; i < missingReviewRows.length; i += 100) {
              const batch = missingReviewRows.slice(i, i + 100);
              const { error: reviewErr } = await supabase
                .from('inventory_missing_review')
                .upsert(
                  batch.map((r) => ({
                    ...r,
                    last_missing_at: now,
                  })),
                  { onConflict: 'user_id,asin,sku', ignoreDuplicates: false }
                );
              if (reviewErr) {
                console.error(`[FULL_SYNC] Review-queue upsert error:`, reviewErr.message);
              }
            }
            // Bump occurrences for any rows that already existed (upsert overwrites occurrences=1).
            const skuList = missingReviewRows.map((r) => r.sku);
            const { error: bumpErr } = await supabase.rpc('bump_inventory_missing_review_occurrences', {
              p_user_id: userId,
              p_skus: skuList,
            }).catch(() => ({ error: null } as any));
            if (bumpErr) {
              // RPC may not exist yet — non-fatal.
              console.log(`[FULL_SYNC] (info) bump RPC unavailable: ${bumpErr.message || bumpErr}`);
            }
          } catch (revErr: any) {
            console.error(`[FULL_SYNC] Review-queue write failed:`, revErr?.message);
          }
        }

        console.log(`[FULL_SYNC] STALE RECONCILIATION COMPLETE: reconciled_from_live=${staleReconciledFromLive}, kept_pending=${staleKeptPending}, queued_for_review=${staleQueuedForReview}, zeroed_confirmed=${staleZeroedConfirmed}, untouched=${staleUntouched}`);
      } else if (staleRecords.length > 0 && !liveQuantities) {
        console.warn(`[FULL_SYNC] STALE RECONCILIATION SKIPPED: live quantities not available, ${staleRecords.length} records left stale`);
      }

    // Do NOT mass-stamp untouched rows here.
    // Row-level last_inventory_sync_at must only move when that specific record
    // was actually verified by the report/live reconciliation path.
    // Otherwise stale rows look fresh and hide sync gaps.
    } catch (staleErr: any) {
      console.error(`[FULL_SYNC] Stale reconciliation error (non-fatal):`, staleErr?.message);
    }

    // Step 5b: Bulk assignment enable/disable (replaces per-row trigger during sync)
    // The trigger skips during sync for performance, so we handle it in bulk here.
    try {
      const { data: disabledAssignments, error: disableErr } = await supabase
        .rpc('run_analytics_query', { query_text: `
          SELECT ra.id, ra.asin, ra.sku
          FROM repricer_assignments ra
          JOIN inventory i ON i.user_id = ra.user_id AND i.asin = ra.asin
          WHERE ra.user_id = '${userId}'
            AND ra.is_enabled = true
            AND COALESCE(i.available, 0) + COALESCE(i.reserved, 0) = 0
            AND COALESCE(i.inbound, 0) = 0
            AND i.listing_status NOT IN ('MISMATCH', 'STRANDED')
        `});

      if (!disableErr && disabledAssignments && disabledAssignments.length > 0) {
        const idsToDisable = disabledAssignments.map((a: any) => a.id);
        for (let i = 0; i < idsToDisable.length; i += 200) {
          const batch = idsToDisable.slice(i, i + 200);
          await supabase
            .from('repricer_assignments')
            .update({
              is_enabled: false,
              manual_paused: false,
              last_disabled_by: 'system',
              last_disabled_reason: 'sync-inventory-report: zero stock',
              last_disabled_at: new Date().toISOString(),
            })
            .in('id', batch);
        }
        console.log(`[FULL_SYNC] Bulk-disabled ${idsToDisable.length} assignments with zero stock`);
      }

      // Re-enable assignments where inventory now has stock > 0
      const { data: enabledAssignments, error: enableErr } = await supabase
        .rpc('run_analytics_query', { query_text: `
          SELECT ra.id, ra.asin, ra.sku
          FROM repricer_assignments ra
          JOIN inventory i ON i.user_id = ra.user_id AND i.asin = ra.asin
          WHERE ra.user_id = '${userId}'
            AND ra.is_enabled = false
            AND COALESCE(i.available, 0) + COALESCE(i.reserved, 0) > 0
            AND i.listing_status NOT IN ('INACTIVE', 'NOT_FOUND', 'INCOMPLETE')
        `});

      if (!enableErr && enabledAssignments && enabledAssignments.length > 0) {
        const idsToEnable = enabledAssignments.map((a: any) => a.id);
        for (let i = 0; i < idsToEnable.length; i += 200) {
          const batch = idsToEnable.slice(i, i + 200);
          await supabase
            .from('repricer_assignments')
            .update({
              is_enabled: true,
              manual_paused: false,
              last_enabled_by: 'system',
              last_enabled_at: new Date().toISOString(),
            })
            .in('id', batch);
        }
        console.log(`[FULL_SYNC] Bulk-enabled ${idsToEnable.length} assignments with restored stock`);
      }
    } catch (bulkAssignErr: any) {
      console.error(`[FULL_SYNC] Bulk assignment sync error:`, bulkAssignErr?.message);
    }

    if (allInserts.length > 0) {
      try {
        let { data: autoSettings } = await supabase
          .from('user_settings')
          .select('auto_assign_enabled, auto_assign_rule_id, auto_assign_require_price, auto_assign_require_inbound, auto_assign_skip_existing, auto_minmax_enabled, auto_min_strategy, auto_max_strategy, auto_min_buffer_pct, auto_max_buffer_pct, auto_require_cost, auto_skip_manual_minmax, auto_raise_roi_floor_us, auto_raise_roi_floor_ca, auto_raise_roi_floor_mx, auto_raise_roi_floor_br')
          .eq('user_id', userId)
          .maybeSingle();

        if (!autoSettings || (!autoSettings.auto_assign_enabled && !autoSettings.auto_assign_rule_id)) {
          const { data: firstRule } = await supabase
            .from('repricer_rules')
            .select('id')
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (firstRule) {
            console.log(`[FULL_SYNC] No auto-onboarding settings found – using defaults with rule=${firstRule.id}`);
            autoSettings = {
              auto_assign_enabled: true,
              auto_assign_rule_id: firstRule.id,
              auto_assign_require_price: true,
              auto_assign_require_inbound: true,
              auto_assign_skip_existing: true,
              auto_minmax_enabled: true,
              auto_min_strategy: 'price_buffer',
              auto_max_strategy: 'price_buffer',
              auto_min_buffer_pct: 15,
              auto_max_buffer_pct: 30,
              auto_require_cost: true,
              auto_skip_manual_minmax: true,
              auto_raise_roi_floor_us: false,
              auto_raise_roi_floor_ca: false,
              auto_raise_roi_floor_mx: false,
              auto_raise_roi_floor_br: false,
            } as any;
          }
        }

        // Get rule's Min ROI settings for ROI-aware min/max
        let ruleMinRoi: number | null = null;
        let ruleMinRoiEnabled = false;
        let ruleMinRoiOverrides: Record<string, number> = {};
        if (autoSettings?.auto_assign_rule_id) {
          const { data: ruleData } = await supabase.from('repricer_rules')
            .select('min_roi_enabled, min_roi, min_roi_percent, min_roi_marketplace_overrides')
            .eq('id', autoSettings.auto_assign_rule_id).maybeSingle();
          if (ruleData) {
            ruleMinRoiEnabled = ruleData.min_roi_enabled || false;
            ruleMinRoi = ruleData.min_roi_percent || ruleData.min_roi || null;
            if (ruleData.min_roi_marketplace_overrides && typeof ruleData.min_roi_marketplace_overrides === 'object') {
              ruleMinRoiOverrides = ruleData.min_roi_marketplace_overrides as Record<string, number>;
            }
          }
        }

        if (autoSettings?.auto_assign_enabled && autoSettings.auto_assign_rule_id) {
          console.log(`[FULL_SYNC] Auto-onboarding: enabled, rule=${autoSettings.auto_assign_rule_id}`);
          
          const newSkus = allInserts.map(i => i.sku);
          
          // Check existing assignments if skip_existing is on
          let existingAssignedSkus = new Set<string>();
          if (autoSettings.auto_assign_skip_existing) {
            const { data: existing } = await supabase
              .from('repricer_assignments')
              .select('sku')
              .eq('user_id', userId)
              .eq('marketplace', 'US')
              .in('sku', newSkus.slice(0, 500));
            existingAssignedSkus = new Set((existing || []).map((r: any) => r.sku));
          }

          // Get unit costs from created_listings for min calculation (Contract A via helper).
          const newAsins = [...new Set(allInserts.map(i => i.asin).filter(Boolean))];
          let costMap = new Map<string, number>();
          if (newAsins.length > 0) {
            const { data: costData } = await supabase
              .from('created_listings')
              .select('asin, cost, units, amount')
              .eq('user_id', userId)
              .in('asin', newAsins.slice(0, 500));
            for (const c of (costData || [])) {
              const uc = getListingUnitCost({ cost: c.cost, amount: c.amount, units: c.units });
              if (uc !== null && uc > 0) costMap.set(c.asin, uc);
            }
          }

          // Get current prices from inventory for price-based strategies
          let priceMap = new Map<string, number>();
          if (autoSettings.auto_minmax_enabled) {
            const { data: priceData } = await supabase
              .from('inventory')
              .select('sku, price, my_price, amazon_price')
              .eq('user_id', userId)
              .in('sku', newSkus.slice(0, 500));
            for (const p of (priceData || [])) {
              const price = p.my_price || p.price || p.amazon_price;
              if (price && price > 0) priceMap.set(p.sku, price);
            }
          }

          const assignmentsToCreate: any[] = [];
          let skippedCount = 0;

          for (const item of allInserts) {
            // Skip if already assigned
            if (existingAssignedSkus.has(item.sku)) { skippedCount++; continue; }

            // Check eligibility: require inbound
            if (autoSettings.auto_assign_require_inbound) {
              const hasStock = (item.available || 0) + (item.reserved || 0) + (item.inbound || 0) > 0;
              if (!hasStock) { skippedCount++; continue; }
            }

            // Check eligibility: require cost — skip entire assignment if no unit cost
            if (autoSettings.auto_require_cost) {
              const unitCost = costMap.get(item.asin);
              if (!unitCost || unitCost <= 0) {
                console.log(`[FULL_SYNC] Auto-onboard skip ${item.sku}: no unit cost`);
                skippedCount++;
                continue;
              }
            }

            // Check eligibility: require price
            const currentPrice = priceMap.get(item.sku);
            if (autoSettings.auto_assign_require_price && (!currentPrice || currentPrice <= 0)) {
              skippedCount++;
              continue;
            }

            // Calculate min/max if enabled
            let minPrice: number | null = null;
            let maxPrice: number | null = null;

            if (autoSettings.auto_minmax_enabled) {
              const unitCost = costMap.get(item.asin);
              const refPrice = currentPrice || 0;

              // Buffer-based min
              if (autoSettings.auto_min_strategy === 'cost_buffer' && unitCost && unitCost > 0) {
                minPrice = Math.round(unitCost * (1 + autoSettings.auto_min_buffer_pct / 100) * 100) / 100;
              } else if (autoSettings.auto_min_strategy === 'price_buffer' && refPrice > 0) {
                minPrice = Math.round(refPrice * (1 - autoSettings.auto_min_buffer_pct / 100) * 100) / 100;
              }

              // Skip min if cost required but missing
              if (autoSettings.auto_require_cost && (!unitCost || unitCost <= 0) && autoSettings.auto_min_strategy === 'cost_buffer') {
                minPrice = null;
              }

              // ── ROI-safe min from rule's Min ROI ──
              if (ruleMinRoiEnabled && unitCost && unitCost > 0) {
                const effectiveRoi = ruleMinRoiOverrides['US'] ?? ruleMinRoi;
                if (effectiveRoi && effectiveRoi > 0) {
                  const cushionedRoi = effectiveRoi + 10;
                  const roiFloorPrice = (unitCost * (1 + cushionedRoi / 100) + 3.50) / (1 - 0.15);
                  const roiSafeMin = Math.ceil(roiFloorPrice * 100) / 100;
                  if (minPrice === null || roiSafeMin > minPrice) {
                    console.log(`[FULL_SYNC] ROI floor for ${item.asin}: target=${effectiveRoi}%+10pt → $${roiSafeMin} (buffer=$${minPrice})`);
                    minPrice = roiSafeMin;
                  }
                }
              }

              // Max calculation
              if (autoSettings.auto_max_strategy === 'price_buffer' && refPrice > 0) {
                maxPrice = Math.round(refPrice * (1 + autoSettings.auto_max_buffer_pct / 100) * 100) / 100;
              } else if (autoSettings.auto_max_strategy === 'buybox_buffer' && refPrice > 0) {
                maxPrice = Math.round(refPrice * (1 + autoSettings.auto_max_buffer_pct / 100) * 100) / 100;
              }

              // Ensure max is above min when ROI raised it
              if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
                maxPrice = Math.round(minPrice * 1.35 * 100) / 100;
              }
            }

            const assignment: any = {
              user_id: userId,
              asin: item.asin,
              sku: item.sku,
              marketplace: 'US',
              rule_id: autoSettings.auto_assign_rule_id,
              is_enabled: true,
            };
            if (minPrice !== null) assignment.min_price = minPrice;
            if (maxPrice !== null) assignment.max_price = maxPrice;

            assignmentsToCreate.push(assignment);
          }

          if (assignmentsToCreate.length > 0) {
            for (let b = 0; b < assignmentsToCreate.length; b += 100) {
              const chunk = assignmentsToCreate.slice(b, b + 100);
              const { error: assignErr } = await supabase
                .from('repricer_assignments')
                .upsert(chunk, { onConflict: 'user_id,sku,marketplace', ignoreDuplicates: true });
              if (assignErr) {
                console.error('[FULL_SYNC] Auto-assign upsert error:', assignErr);
              }
            }
            console.log(`[FULL_SYNC] ✅ Auto-onboarded ${assignmentsToCreate.length} new listings (skipped ${skippedCount})`);

            // ROI calculation delegated to auto-assign-bulk (called later in Step 10)
          } else {
            console.log(`[FULL_SYNC] Auto-onboarding: no eligible new listings (skipped ${skippedCount})`);
          }
        }
      } catch (autoErr: any) {
        console.error('[FULL_SYNC] Auto-onboarding error (non-fatal):', autoErr.message);
      }
    }

    // Steps 6-8: FBM Sync, Cleanup, Enrichment — delegated to sync-fbm-cleanup
    await updateProgress(supabase, progressId, {
      message: 'Syncing FBM listings and cleaning up...',
      current_chunk: 6,
      total_chunks: 10,
    });

    let fbmUpdatedCount = 0;
    let fbmInsertedCount = 0;
    let deletedFromInventory = 0;
    let deletedFromRepricer = 0;
    let enrichedCount = 0;

    // FIRE-AND-FORGET: do NOT await sync-fbm-cleanup. The FBM merchant report
    // (GET_MERCHANT_LISTINGS_ALL_DATA) is notoriously slow (60+ polls × 5s)
    // and was causing this parent function to hit the 300s edge-function
    // timeout BEFORE the FBM phase finished — leaving FBM listings missing
    // from inventory and the repricer for weeks at a time. The dedicated
    // `sync-fbm-cleanup-4h` cron (via `sync-fbm-cleanup-all`) now owns FBM
    // sync. We still kick a non-blocking call here so users running a manual
    // full sync still get FBM refreshed in the background.
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const existingRecordsArr = Array.from(existingRecordsMap.values()).map(r => ({ id: r.id, asin: r.asin, sku: r.sku, listing_status: r.listing_status ?? null, source: r.source ?? null }));
      const authFbaStateArr = Array.from(authoritativeFbaStateBySku.entries()).map(([sku, s]) => ({ sku, listingStatus: s.listingStatus, source: s.source }));
      const fbaReportedSkus = inventoryItems.map(i => i.sku);

      // Fire WITHOUT await — let it complete in the background. We deliberately
      // don't `await` and don't track timing here; sync-fbm-cleanup writes its
      // own row in `fbm_sync_runs` for observability.
      fetch(`${supabaseUrl}/functions/v1/sync-fbm-cleanup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'apikey': supabaseServiceKey,
        },
        body: JSON.stringify({
          user_id: userId,
          refresh_token: refreshToken,
          marketplace_id: marketplaceId,
          existing_records_map: existingRecordsArr,
          authoritative_fba_state: authFbaStateArr,
          fba_reported_skus: fbaReportedSkus,
          all_inserts: allInserts,
          non_destructive_sync: nonDestructiveSync,
          triggered_by: 'sync-inventory-report:fire-and-forget',
        }),
      }).catch((err) => console.warn('[FULL_SYNC] FBM fire-and-forget dispatch error:', err?.message));
      console.log('[FULL_SYNC] FBM sync dispatched (fire-and-forget) — see fbm_sync_runs');
    } catch (fbmDelegateErr: any) {
      console.error('[FULL_SYNC] FBM sync dispatch error:', fbmDelegateErr.message);
    }

    // Step 9: Multi-Marketplace Assignment Sync (CA, MX, BR)
    // Delegated to separate edge function for bundle size
    let intlAssignmentsCreated = 0;
    try {
      await updateProgress(supabase, progressId, {
        message: 'Checking international marketplace listings...',
        current_chunk: 9,
        total_chunks: 10,
      });

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const intlResp = await fetch(`${supabaseUrl}/functions/v1/sync-intl-marketplace`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'apikey': supabaseServiceKey,
        },
        body: JSON.stringify({
          user_id: userId,
          refresh_token: refreshToken,
          marketplace_id: marketplaceId,
          inventory_items: inventoryItems.filter(i => (i.available + i.reserved + i.inbound) > 0).map(i => ({ sku: i.sku, asin: i.asin, available: i.available, reserved: i.reserved, inbound: i.inbound })),
        }),
      });

      if (intlResp.ok) {
        const intlData = await intlResp.json();
        intlAssignmentsCreated = intlData.assignmentsCreated || 0;
        console.log(`[FULL_SYNC] International sync: ${intlAssignmentsCreated} assignments created`);
      } else {
        console.warn(`[FULL_SYNC] sync-intl-marketplace returned ${intlResp.status}: ${await intlResp.text()}`);
      }
    } catch (intlErr: any) {
      console.error('[FULL_SYNC] International marketplace sync error:', intlErr.message);
    }

    // Final step: Enrich any remaining placeholder titles using Catalog API
    let titlesEnriched = 0;
    try {
      console.log('[FULL_SYNC] Calling enrich-missing-titles for placeholder titles...');
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      
      const enrichResponse = await fetch(`${supabaseUrl}/functions/v1/enrich-missing-titles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseKey}`
        },
        body: JSON.stringify({ internal: true, user_id: userId, limit: 100 })
      });
      
      if (enrichResponse.ok) {
        const enrichResult = await enrichResponse.json();
        titlesEnriched = enrichResult.enriched || 0;
        console.log(`[FULL_SYNC] Title enrichment complete: ${titlesEnriched} titles updated`);
      } else {
        console.warn('[FULL_SYNC] Title enrichment failed:', await enrichResponse.text());
      }
    } catch (titleErr: any) {
      console.warn('[FULL_SYNC] Title enrichment error:', titleErr.message);
    }

    // Stamp profiles.inventory_synced_at so client caches know to invalidate
    try {
      await supabase
        .from('profiles')
        .update({ inventory_synced_at: new Date().toISOString() })
        .eq('id', userId);
      console.log('[FULL_SYNC] Updated profiles.inventory_synced_at');
    } catch (stampErr: any) {
      console.warn('[FULL_SYNC] Failed to stamp inventory_synced_at:', stampErr.message);
    }

    // Step 10: Call auto-assign-bulk to backfill any missing US assignments
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      console.log('[FULL_SYNC] Calling auto-assign-bulk to backfill missing assignments...');
      const assignResp = await fetch(`${supabaseUrl}/functions/v1/auto-assign-bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'apikey': supabaseServiceKey,
        },
        body: JSON.stringify({ user_id: userId, marketplace: 'US' }),
      });
      if (assignResp.ok) {
        const assignData = await assignResp.json();
        console.log(`[FULL_SYNC] ✅ auto-assign-bulk: created=${assignData.created} skipped=${assignData.skipped}`);
      } else {
        console.warn(`[FULL_SYNC] auto-assign-bulk returned ${assignResp.status}: ${await assignResp.text()}`);
      }
    } catch (assignErr: any) {
      console.warn('[FULL_SYNC] auto-assign-bulk call failed (non-fatal):', assignErr.message);
    }

    // Complete
    await updateProgress(supabase, progressId, {
      status: 'completed',
      current_chunk: 10,
      total_chunks: 10,
      message: `Sync complete! FBA: Updated ${updatedCount}, inserted ${insertedCount}. Stale reconciled: ${staleReconciledFromLive} from live, ${staleKeptPending} pending, ${staleZeroedConfirmed} zeroed. FBM: Updated ${fbmUpdatedCount}, inserted ${fbmInsertedCount}. Deleted: ${deletedFromInventory}. Titles: ${titlesEnriched}. Intl: ${intlAssignmentsCreated}.`,
    });

    console.log(`[FULL_SYNC] Complete: ${updatedCount} updated, ${insertedCount} inserted, stale: live=${staleReconciledFromLive} pending=${staleKeptPending} zeroed=${staleZeroedConfirmed} untouched=${staleUntouched}, deleted=${deletedFromInventory}, titles=${titlesEnriched}`);

  } catch (error: any) {
    if (error?.message === 'sync_cancelled_by_user') {
      await updateProgress(supabase, progressId, {
        status: 'cancelled',
        message: 'Sync stopped by user.',
      });
      console.log(`[FULL_SYNC] Sync cancelled by user for ${userId}`);
      return;
    }
    console.error('[FULL_SYNC] Error:', error);
    await updateProgress(supabase, progressId, {
      status: 'error',
      error: (error as Error).message || 'Unknown error occurred',
      message: `Sync failed: ${(error as Error).message}`,
    });
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

    let userId: string;
    
    // Support both auth header (user-initiated) and body user_id (auto-sync)
    const body = await req.json().catch(() => ({}));
    
    if (body.user_id) {
      // Called from auto-sync with user_id in body
      console.log(`[FULL_SYNC] Called with user_id from body: ${body.user_id}`);
      userId = body.user_id;
    } else {
      // Called from frontend with auth header
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

    // Get all seller authorizations for this user (multi-marketplace)
    const { data: authRows, error: authFetchError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id, user_id')
      .eq('user_id', userId)
      .not('refresh_token', 'is', null);

    const inventoryReportMarketplacePriority = [
      'ATVPDKIKX0DER', // US
      'A2EUQ1WTGCTBG2', // CA
      'A2Q3Y263D00KWC', // BR
    ];
    const unsupportedInventoryReportMarketplaces = new Set([
      'A1AM78C64UM0Y8', // MX - Amazon rejects GET_FBA_MYI_ALL_INVENTORY_DATA here
    ]);

    const pickPreferredInventoryReportAuth = (rows: any[] = []) => {
      return (
        rows.find((row) => inventoryReportMarketplacePriority.includes(row.marketplace_id)) ||
        rows.find((row) => !unsupportedInventoryReportMarketplaces.has(row.marketplace_id)) ||
        rows[0]
      );
    };

    let auth = pickPreferredInventoryReportAuth(authRows || []);

    if ((!auth || unsupportedInventoryReportMarketplaces.has(auth.marketplace_id)) && authRows?.[0]?.seller_id) {
      console.log(`[FULL_SYNC] User has no supported inventory-report marketplace, checking same seller ${authRows[0].seller_id} across accounts...`);
      const { data: sellerAuthRows, error: sellerAuthError } = await supabase
        .from('seller_authorizations')
        .select('refresh_token, marketplace_id, seller_id, user_id')
        .eq('seller_id', authRows[0].seller_id)
        .not('refresh_token', 'is', null);

      if (sellerAuthError) {
        console.warn('[FULL_SYNC] Failed to load same-seller authorizations:', sellerAuthError.message);
      } else {
        const sameSellerAuth = pickPreferredInventoryReportAuth(sellerAuthRows || []);
        if (sameSellerAuth) {
          auth = sameSellerAuth;
          console.log(`[FULL_SYNC] Found supported marketplace ${auth.marketplace_id} on account ${auth.user_id}`);
        }
      }
    }

    if (authFetchError || !auth?.refresh_token) {
      throw new Error('No Amazon seller authorization found. Please connect your Amazon account first.');
    }

    if (unsupportedInventoryReportMarketplaces.has(auth.marketplace_id)) {
      throw new Error(`Full sync is not supported with marketplace ${auth.marketplace_id}. Connect a US, CA, or BR authorization for this seller and try again.`);
    }

    console.log(`[FULL_SYNC] Using marketplace ${auth.marketplace_id} for FBA inventory report`);

    // Create progress record
    const { data: progressRecord, error: progressError } = await supabase
      .from('pl_sync_progress')
      .insert({
        user_id: userId,
        status: 'starting',
        message: 'Initializing full inventory sync...',
        current_chunk: 0,
        total_chunks: 10,
      })
      .select('id')
      .single();

    if (progressError || !progressRecord) {
      throw new Error('Failed to create progress record');
    }

    const progressId = progressRecord.id;
    console.log(`[FULL_SYNC] Created progress record: ${progressId}`);

    const nonDestructiveSync = body?.non_destructive === true || body?.triggered_by === 'cron-fanout' || body?.triggered_by === 'cron';

    // Run sync in background
    (globalThis as any).EdgeRuntime?.waitUntil(
      runFullInventorySync(
        supabase,
        userId,
        progressId,
        auth.refresh_token,
        auth.marketplace_id || 'ATVPDKIKX0DER',
        nonDestructiveSync
      )
    );

    return new Response(
      JSON.stringify({
        success: true,
        progressId,
        message: 'Full inventory sync started. This may take a few minutes.',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[FULL_SYNC] Error:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
