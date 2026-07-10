import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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

function parseReportText(reportText: string): { lines: string[]; headers: string[] } {
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

// AWS SigV4 signing helpers
async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function getSigningKey(key: string, dateStamp: string, regionName: string, serviceName: string): Promise<Uint8Array> {
  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + key), dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  return await hmacSha256(kService, 'aws4_request');
}

async function getAwsSignature(
  method: string,
  path: string,
  queryParams: string,
  headers: Record<string, string>,
  payload: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<string> {
  const service = 'execute-api';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map(k => `${k.toLowerCase()}:${headers[k].trim()}`)
    .join('\n') + '\n';
  
  const signedHeaders = Object.keys(headers)
    .sort()
    .map(k => k.toLowerCase())
    .join(';');

  const payloadHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  
  const canonicalRequestHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

  const signingKey = await getSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = Array.from(
    new Uint8Array(await hmacSha256(signingKey, stringToSign))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// Normalize Amazon condition strings to consistent display format
function normalizeCondition(raw: string | null | undefined): string | null {
  if (!raw) return null;
  
  const normalized = raw.trim().toLowerCase().replace(/[_\s]+/g, '');
  
  const conditionMap: Record<string, string> = {
    'new': 'NEW',
    'newitem': 'NEW',
    'newoem': 'NEW',
    'usedlikenew': 'USED - LIKE NEW',
    'usedverygood': 'USED - VERY GOOD',
    'usedgood': 'USED - GOOD',
    'usedacceptable': 'USED - ACCEPTABLE',
    'collectiblelikenew': 'COLLECTIBLE - LIKE NEW',
    'collectibleverygood': 'COLLECTIBLE - VERY GOOD',
    'collectiblegood': 'COLLECTIBLE - GOOD',
    'collectibleacceptable': 'COLLECTIBLE - ACCEPTABLE',
    'refurbished': 'RENEWED',
    'renewed': 'RENEWED',
    'club': 'CLUB',
  };
  
  return conditionMap[normalized] || raw.toUpperCase();
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing LWA credentials');
  }

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
    const errorText = await response.text();
    console.error('LWA token error response:', errorText);
    throw new Error(`LWA token error: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function callSpApi(
  path: string,
  accessToken: string,
  queryParams: Record<string, string> = {},
  method = 'GET',
  body = ''
): Promise<any> {
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;

  const host = 'sellingpartnerapi-na.amazon.com';
  const queryString = new URLSearchParams(queryParams).toString();
  const url = `https://${host}${path}${queryString ? '?' + queryString : ''}`;

  const headers: Record<string, string> = {
    'host': host,
    'x-amz-access-token': accessToken,
    'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
    'content-type': 'application/json',
  };

  const authHeader = await getAwsSignature(
    method,
    path,
    queryString,
    headers,
    body,
    awsAccessKeyId,
    awsSecretAccessKey,
    region
  );

  headers['Authorization'] = authHeader;

  const response = await fetch(url, { method, headers, body: body || undefined });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('SP-API error:', response.status, errorText);
    throw new Error(`SP-API error: ${response.status}`);
  }

  return response.json();
}

async function syncFnskusFromReport(
  sellerId: string,
  marketplaceId: string,
  refreshToken: string,
  supabase: any,
  userId: string
): Promise<{ processedRows: number; sampleMappings: any[]; inventoryRecordsProcessed: number; fbmRecordsProcessed: number }> {
  console.log('Starting FNSKU sync from report for seller:', sellerId);

  const ZERO_CONFIRMATION_WINDOW_MINUTES = 45;
  const getTotalStock = (row: { available?: number; reserved?: number; inbound?: number; unfulfilled?: number } | null | undefined) =>
    (row?.available || 0) + (row?.reserved || 0) + (row?.inbound || 0) + (row?.unfulfilled || 0);

  const hasRecentZeroConfirmation = async (sku: string) => {
    const cutoff = new Date(Date.now() - ZERO_CONFIRMATION_WINDOW_MINUTES * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('inventory_history')
      .select('available, reserved, inbound, captured_at, source')
      .eq('user_id', userId)
      .eq('sku', sku)
      .gte('captured_at', cutoff)
      .in('source', ['amazon_sync', 'live_api'])
      .order('captured_at', { ascending: false })
      .limit(5);

    if (error) {
      console.error(`Failed to check zero confirmation history for ${sku}:`, error);
      return false;
    }

    return (data || []).some((row: any) => ((row.available || 0) + (row.reserved || 0) + (row.inbound || 0)) === 0);
  };

  const accessToken = await getLwaAccessToken(refreshToken);

  // Step 1: Create FBA inventory report
  console.log('Creating FBA inventory report...');
  const createReportBody = JSON.stringify({
    reportType: 'GET_FBA_MYI_ALL_INVENTORY_DATA',
    marketplaceIds: [marketplaceId],
  });

  const createResponse = await callSpApi(
    '/reports/2021-06-30/reports',
    accessToken,
    {},
    'POST',
    createReportBody
  );

  const reportId = createResponse.reportId;
  console.log('FBA Report created with ID:', reportId);

  // Step 2: Poll for report completion
  let reportStatus = 'IN_QUEUE';
  let attempts = 0;
  const maxAttempts = 60; // Wait up to 5 minutes (5 seconds * 60)

  while (reportStatus !== 'DONE' && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
    attempts++;

    const statusResponse = await callSpApi(
      `/reports/2021-06-30/reports/${reportId}`,
      accessToken
    );

    reportStatus = statusResponse.processingStatus;
    console.log(`Report status (attempt ${attempts}):`, reportStatus);

    if (reportStatus === 'FATAL' || reportStatus === 'CANCELLED') {
      // Log full response to understand why it failed
      console.error('Report failed. Full status response:', JSON.stringify(statusResponse, null, 2));
      
      // Try to get the report document to see if there are error details
      try {
        if (statusResponse.reportDocumentId) {
          const errorDocResponse = await callSpApi(
            `/reports/2021-06-30/documents/${statusResponse.reportDocumentId}`,
            accessToken
          );
          console.error('Report document error details:', errorDocResponse);
          
          if (errorDocResponse.url) {
            const errorData = await fetch(errorDocResponse.url);
            const errorText = await errorData.text();
            console.error('Report error content:', errorText);
          }
        }
      } catch (err) {
        console.error('Could not fetch report error details:', err);
      }
      
      throw new Error(`Amazon report failed with status: ${reportStatus}. This may be due to: 1) Too many requests in a short time, 2) No FBA inventory in this marketplace, or 3) Amazon API issues. Please wait a few minutes and try again, or check your Seller Central for inventory status.`);
    }
  }

  if (reportStatus !== 'DONE') {
    throw new Error('Report generation timed out');
  }

  // Step 3: Get report document
  console.log('Fetching report document...');
  const reportResponse = await callSpApi(
    `/reports/2021-06-30/reports/${reportId}`,
    accessToken
  );

  const reportDocumentId = reportResponse.reportDocumentId;
  
  const documentResponse = await callSpApi(
    `/reports/2021-06-30/documents/${reportDocumentId}`,
    accessToken
  );

  const reportUrl = documentResponse.url;

  // Step 4: Download and parse report
  console.log('Downloading report from:', reportUrl);
  const reportData = await fetch(reportUrl);
  const reportText = await reportData.text();

  // Parse CSV/TSV report
  const lines = reportText.split('\n');
  const headers = lines[0].split('\t');

  // Find column indices
  const asinIndex = headers.indexOf('asin');
  const fnskuIndex = headers.indexOf('fnsku');
  const skuIndex = headers.indexOf('sku');
  const conditionIndex = headers.indexOf('condition');
  const titleIndex = headers.indexOf('product-name');
  const quantityIndex = headers.indexOf('afn-total-quantity');
  const availableIndex = headers.indexOf('afn-warehouse-quantity');
  const reservedIndex = headers.indexOf('afn-reserved-quantity');
  const inboundWorkingIndex = headers.indexOf('afn-inbound-working-quantity');
  const inboundShippedIndex = headers.indexOf('afn-inbound-shipped-quantity');
  const inboundReceivingIndex = headers.indexOf('afn-inbound-receiving-quantity');
  const unfulfillableIndex = headers.indexOf('afn-unsellable-quantity');

  if (asinIndex === -1 || fnskuIndex === -1) {
    throw new Error('Report missing required columns (asin, fnsku)');
  }

  console.log(`Found ${lines.length - 1} rows in report`);
  console.log(`Condition column ${conditionIndex !== -1 ? 'found' : 'not found'} in report`);
  console.log(`Title column ${titleIndex !== -1 ? 'found' : 'not found'} in report`);
  console.log(`Quantity column ${quantityIndex !== -1 ? 'found' : 'not found'} in report`);
  console.log(`Available column ${availableIndex !== -1 ? 'found' : 'not found'} in report`);
  console.log(`Reserved column ${reservedIndex !== -1 ? 'found' : 'not found'} in report`);
  console.log(`Inbound columns ${inboundWorkingIndex !== -1 || inboundShippedIndex !== -1 ? 'found' : 'not found'} in report`);

  // Step 5: Prepare batch data for upsert
  const batchSize = 500; // Process in batches of 500
  const sampleMappings = [];
  let processedRows = 0;
  let inventoryRecordsProcessed = 0;

  // Prepare all records
  const records: any[] = [];
  // 🔧 FIX: Use SKU as the unique key instead of ASIN
  // This handles cases where the same ASIN has multiple SKUs (different conditions like New vs NewOpenBox)
  const inventoryBySku: Record<string, { 
    asin: string; 
    sku: string; 
    fnsku: string; 
    title: string; 
    units: number;
    available: number;
    reserved: number;
    inbound: number;
    unfulfilled: number;
  }> = {};

  for (let i = 1; i < lines.length; i++) {
    const columns = lines[i].split('\t');
    const asin = columns[asinIndex];
    const fnsku = columns[fnskuIndex];
    const sku = skuIndex !== -1 ? columns[skuIndex] : null;
    const rawCondition = conditionIndex !== -1 ? columns[conditionIndex] : null;
    const condition = normalizeCondition(rawCondition);
    const title = titleIndex !== -1 ? columns[titleIndex] : 'Unknown Product';
    const quantityRaw = quantityIndex !== -1 ? columns[quantityIndex] : '0';
    const units = parseInt(quantityRaw || '0', 10) || 0;
    
    // Parse FBA inventory status quantities
    const available = availableIndex !== -1 ? parseInt(columns[availableIndex] || '0', 10) || 0 : 0;
    const reserved = reservedIndex !== -1 ? parseInt(columns[reservedIndex] || '0', 10) || 0 : 0;
    const inboundShipped = inboundShippedIndex !== -1 ? parseInt(columns[inboundShippedIndex] || '0', 10) || 0 : 0;
    const inboundReceiving = inboundReceivingIndex !== -1 ? parseInt(columns[inboundReceivingIndex] || '0', 10) || 0 : 0;
    const inbound = inboundShipped + inboundReceiving;
    const unfulfilled = unfulfillableIndex !== -1 ? parseInt(columns[unfulfillableIndex] || '0', 10) || 0 : 0;

    if (!asin || !fnsku) continue;
    // SKU is required for proper inventory tracking
    if (!sku) continue;

    records.push({
      seller_id: sellerId,
      marketplace_id: marketplaceId,
      asin,
      seller_sku: sku,
      fnsku,
      condition,
    });

    // 🔧 FIX: Track inventory by SKU (not ASIN) to handle multiple SKUs per ASIN
    if (!inventoryBySku[sku]) {
      inventoryBySku[sku] = {
        asin,
        sku,
        fnsku,
        title,
        units,
        available,
        reserved,
        inbound,
        unfulfilled,
      };
    } else {
      // Same SKU shouldn't appear twice, but if it does, aggregate
      inventoryBySku[sku].units += units;
      inventoryBySku[sku].available += available;
      inventoryBySku[sku].reserved += reserved;
      inventoryBySku[sku].inbound += inbound;
      inventoryBySku[sku].unfulfilled += unfulfilled;
    }

    // Collect first 5 as samples
    if (sampleMappings.length < 5) {
      sampleMappings.push({ asin, sku, fnsku, condition });
    }
  }

  console.log(`Prepared ${records.length} FNSKU records for batch upsert`);

  // Batch upsert FNSKU mappings
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    console.log(`Upserting FNSKU batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(records.length / batchSize)} (${batch.length} records)`);
    
    const { error } = await supabase
      .from('fnsku_map')
      .upsert(batch, {
        onConflict: 'seller_id,marketplace_id,asin,fnsku'
      });

    if (error) {
      console.error(`Error upserting FNSKU batch at index ${i}:`, error);
    } else {
      processedRows += batch.length;
    }
  }

  console.log(`Successfully processed ${processedRows} FNSKU mappings`);
  console.log('Sample mappings:', sampleMappings);

  // Enrich in-stock inventory items with product details (title, image, price)
  const enrichedProductData: Record<string, { title?: string; imageUrl?: string | null; price?: number | null }> = {};
  const inventoryEntries = Object.values(inventoryBySku);

  // Only enrich items that have some stock (available, reserved, inbound or unfulfilled)
  const inStockEntries = inventoryEntries.filter((record) => {
    const totalStock = (record.available || 0) + (record.reserved || 0) + (record.inbound || 0) + (record.unfulfilled || 0);
    return totalStock > 0;
  });

  // Safety cap to avoid extremely long SP-API runs
  const maxEnrich = 500;
  const entriesToEnrich = inStockEntries.slice(0, maxEnrich);

  console.log(`Preparing to enrich ${entriesToEnrich.length} in-stock SKUs with catalog & pricing data`);

  // Deduplicate ASINs for enrichment (multiple SKUs can share an ASIN)
  const asinToEnrich = new Set<string>();
  entriesToEnrich.forEach(e => asinToEnrich.add(e.asin));
  const uniqueAsinsToEnrich = Array.from(asinToEnrich);

  for (let i = 0; i < uniqueAsinsToEnrich.length; i++) {
    const asin = uniqueAsinsToEnrich[i];

    try {
      // Small delay between SP-API calls to respect rate limits
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Catalog Items API for title and image
      const catalogData = await callSpApi(
        `/catalog/2022-04-01/items/${asin}`,
        accessToken,
        { marketplaceIds: marketplaceId, includedData: 'images,summaries' }
      );

      const titleFromCatalog = catalogData?.summaries?.[0]?.itemName || null;
      const imageUrl =
        catalogData?.images?.[0]?.images?.[0]?.link ||
        null;

      // Pricing API for current price
      let price: number | null = null;
      try {
        const pricingData = await callSpApi(
          `/products/pricing/v0/items/${asin}/offers`,
          accessToken,
          { MarketplaceId: marketplaceId, ItemCondition: 'New' }
        );

        const summary = pricingData?.payload?.Summary;
        const buyBox = (summary?.BuyBoxPrices || [])[0];
        if (buyBox) {
          price =
            buyBox?.LandedPrice?.Amount ??
            buyBox?.ListingPrice?.Amount ??
            null;
        } else {
          const lowest = (summary?.LowestPrices || [])[0];
          if (lowest) {
            price =
              lowest?.LandedPrice?.Amount ??
              lowest?.ListingPrice?.Amount ??
              null;
          }
        }
      } catch (pricingError) {
        console.error('Pricing API error for ASIN', asin, pricingError);
      }

      enrichedProductData[asin] = {
        title: titleFromCatalog || null,
        imageUrl,
        price,
      };

      if ((i + 1) % 50 === 0) {
        console.log(`Enriched ${i + 1} / ${uniqueAsinsToEnrich.length} unique ASINs`);
      }
    } catch (err: any) {
      const msg = err instanceof Error ? (err as Error).message : String(err);
      console.error('Error enriching ASIN', asin, msg);

      // If we hit a hard quota error, stop further enrichment to avoid wasting calls
      if (msg.includes('429')) {
        console.warn('SP-API quota exceeded during enrichment; stopping further product data fetches');
        break;
      }
    }
  }

  // 🔧 FIX: Fetch existing inventory by SKU to determine which are NEW products
  const allSkus = Object.keys(inventoryBySku);
  console.log(`Checking which of ${allSkus.length} SKUs are already in inventory...`);
  
  const existingSkuSet = new Set<string>();
  const existingInventoryMap: Record<string, { title?: string; image_url?: string | null; price?: number | null; available?: number; reserved?: number; inbound?: number; unfulfilled?: number; listing_status?: string | null }> = {};
  
  // Fetch in batches by SKU
  for (let i = 0; i < allSkus.length; i += batchSize) {
    const skuBatch = allSkus.slice(i, i + batchSize);
      const { data: existingRecords } = await supabase
        .from('inventory')
        .select('sku, asin, title, image_url, price, available, reserved, inbound, unfulfilled, listing_status')
      .eq('user_id', userId)
      .in('sku', skuBatch);
    
    if (existingRecords) {
      existingRecords.forEach((rec: any) => {
        existingSkuSet.add(rec.sku);
        existingInventoryMap[rec.sku] = {
          title: rec.title,
          image_url: rec.image_url,
          price: rec.price,
          available: rec.available,
          reserved: rec.reserved,
          inbound: rec.inbound,
          unfulfilled: rec.unfulfilled,
          listing_status: rec.listing_status,
        };
      });
    }
  }
  
  console.log(`Found ${existingSkuSet.size} SKUs already in inventory`);
  console.log(`Will sync ${allSkus.length - existingSkuSet.size} NEW products only`);

  // Fetch data from created_listings to use as FALLBACK when SP-API doesn't have data
  // Also fetch cost/units for unit cost calculation
  // 🔧 FIX: Also look up by SKU for more accurate matching
  const createdListingsMap: Record<string, { title?: string; image_url?: string | null; price?: number | null; cost?: number | null; units?: number | null; amount?: number | null }> = {};
  const createdListingsBySkuMap: Record<string, { title?: string; image_url?: string | null; price?: number | null; cost?: number | null; units?: number | null; amount?: number | null }> = {};
  console.log(`Fetching created_listings data for fallback enrichment and unit cost...`);
  
  // Get all unique ASINs from inventory
  const allAsins = [...new Set(Object.values(inventoryBySku).map(r => r.asin))];
  
  for (let i = 0; i < allAsins.length; i += batchSize) {
    const asinBatch = allAsins.slice(i, i + batchSize);
    const { data: createdListings } = await supabase
      .from('created_listings')
      .select('asin, sku, title, image_url, price, cost, units, amount')
      .eq('user_id', userId)
      .in('asin', asinBatch);
    
    if (createdListings) {
      createdListings.forEach((rec: any) => {
        // Store by ASIN (for backward compatibility)
        if (!createdListingsMap[rec.asin] || rec.cost) {
          createdListingsMap[rec.asin] = {
            title: rec.title,
            image_url: rec.image_url,
            price: rec.price,
            cost: rec.cost,
            units: rec.units,
            amount: rec.amount,
          };
        }
        // Also store by SKU for exact matching
        if (rec.sku) {
          createdListingsBySkuMap[rec.sku] = {
            title: rec.title,
            image_url: rec.image_url,
            price: rec.price,
            cost: rec.cost,
            units: rec.units,
            amount: rec.amount,
          };
        }
      });
    }
  }
  
  console.log(`Found ${Object.keys(createdListingsMap).length} ASINs and ${Object.keys(createdListingsBySkuMap).length} SKUs with data in created_listings`);

  // 🔧 FIX: Prepare inventory records ONLY for NEW products (not already in inventory by SKU)
  const newInventoryRecords = Object.values(inventoryBySku)
    .filter((record) => !existingSkuSet.has(record.sku)) // Only include NEW SKUs
    .map((record) => {
      // Priority: SP-API > created_listings (by SKU first, then ASIN) > defaults
      const enriched = enrichedProductData[record.asin] || {};
      // Try SKU match first, then fall back to ASIN match
      const fromCreatedListings = createdListingsBySkuMap[record.sku] || createdListingsMap[record.asin];

      // Use SP-API enriched data first, then fall back to created_listings
      const title = enriched.title || fromCreatedListings?.title || record.title || 'Unknown Product';
      const imageUrl = enriched.imageUrl || fromCreatedListings?.image_url || null;
      const price = enriched.price ?? fromCreatedListings?.price ?? null;
      
      // Contract A: derive UNIT cost from created_listings via shared helper
      // (prefers amount=UNIT, falls back to cost/units). NEVER copy cost (TOTAL) raw.
      // Inventory writer contract: inventory.cost = UNIT, inventory.amount = UNIT * stockQty.
      const unitCost = fromCreatedListings
        ? getListingUnitCost(fromCreatedListings)
        : null;
      const stockQty = Math.max(
        0,
        Number(record.available || 0) + Number(record.reserved || 0) + Number(record.inbound || 0),
      );

      return {
        user_id: userId,
        asin: record.asin,
        sku: record.sku,
        fnsku: record.fnsku,
        title: title as string,
        image_url: imageUrl as string | null,
        price: typeof price === 'number' ? price : null,
        cost: unitCost, // Contract A: inventory.cost = UNIT cost
        amount: unitCost !== null ? unitCost * stockQty : null, // Contract A: TOTAL value
        units: record.units,
        available: record.available,
        reserved: record.reserved,
        inbound: record.inbound,
        unfulfilled: record.unfulfilled,
        supplier_links: [],
        source: 'amazon_sync',
      };
    });

  console.log(`Filtered to ${newInventoryRecords.length} NEW products to sync (skipping ${existingSkuSet.size} existing products)`);

  // Insert NEW inventory records only (skip existing ones)
  if (newInventoryRecords.length === 0) {
    console.log('No new products to sync - all SKUs already exist in inventory');
  } else {
    for (let i = 0; i < newInventoryRecords.length; i += batchSize) {
      const batch = newInventoryRecords.slice(i, i + batchSize);
      console.log(`Inserting NEW inventory batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(newInventoryRecords.length / batchSize)} (${batch.length} records)`);

      const { error } = await supabase
        .from('inventory')
        .insert(batch);

      if (error) {
        console.error(`Error inserting inventory batch at index ${i}:`, error);
      } else {
        inventoryRecordsProcessed += batch.length;
      }
    }

    console.log(`Successfully inserted ${inventoryRecordsProcessed} NEW inventory records`);
    
    // 🆕 ALSO INSERT INTO CREATED_LISTINGS for new products (so users can fill in costs)
    // Only insert ASINs that don't already exist in created_listings
    console.log('📝 Syncing new products to created_listings table...');
    
    // Get ASINs already in created_listings
    const newAsins = newInventoryRecords.map(r => r.asin);
    const existingCreatedListingsSet = new Set<string>();
    
    for (let i = 0; i < newAsins.length; i += batchSize) {
      const asinBatch = newAsins.slice(i, i + batchSize);
      const { data: existingCL } = await supabase
        .from('created_listings')
        .select('asin')
        .eq('user_id', userId)
        .in('asin', asinBatch);
      
      if (existingCL) {
        existingCL.forEach((r: any) => existingCreatedListingsSet.add(r.asin));
      }
    }
    
    // Filter to only ASINs NOT in created_listings yet
    const newCreatedListingsRecords = newInventoryRecords
      .filter(r => !existingCreatedListingsSet.has(r.asin))
      .map(r => ({
        user_id: userId,
        asin: r.asin,
        sku: r.sku || `AMZSYNC-${r.asin.substring(0, 6)}`,
        fnsku: r.fnsku,
        title: r.title,
        image_url: r.image_url,
        price: r.price,
        cost: null, // User needs to fill in
        units: null, // User needs to fill in
        amount: null, // Will be calculated when cost/units are entered
        supplier_links: [],
      }));
    
    if (newCreatedListingsRecords.length > 0) {
      console.log(`Inserting ${newCreatedListingsRecords.length} new products into created_listings...`);
      
      let clRecordsInserted = 0;
      for (let i = 0; i < newCreatedListingsRecords.length; i += batchSize) {
        const batch = newCreatedListingsRecords.slice(i, i + batchSize);
        const { error } = await supabase
          .from('created_listings')
          .insert(batch);
        
        if (error) {
          console.error(`Error inserting created_listings batch at index ${i}:`, error);
        } else {
          clRecordsInserted += batch.length;
        }
      }
      
      console.log(`✅ Inserted ${clRecordsInserted} new products into created_listings`);
    } else {
      console.log('✅ All new products already exist in created_listings');
    }
  }

  // 🔧 FIX: UPDATE EXISTING INVENTORY RECORDS with latest quantities from Amazon (by SKU)
  console.log('🔄 Updating existing inventory records with latest quantities...');
  
  const existingInventoryToUpdate = Object.values(inventoryBySku)
    .filter((record) => existingSkuSet.has(record.sku)); // Only existing SKUs
  
  console.log(`Found ${existingInventoryToUpdate.length} existing inventory records to update with latest quantities`);
  
  let quantitiesUpdated = 0;
  const updateBatchSize = 100;
  
  for (let i = 0; i < existingInventoryToUpdate.length; i += updateBatchSize) {
    const batch = existingInventoryToUpdate.slice(i, i + updateBatchSize);
    
    // Update each record individually by SKU
    for (const record of batch) {
      const previousRow = existingInventoryMap[record.sku];
      const incomingTotal = getTotalStock(record);
      const previousTotal = getTotalStock(previousRow);
      const suspiciousZero = incomingTotal === 0 && previousTotal > 0 && !(await hasRecentZeroConfirmation(record.sku));

      if (suspiciousZero) {
        console.warn(`⚠️ Blocking suspicious zero overwrite for SKU ${record.sku} / ASIN ${record.asin} (previous=${previousTotal}, incoming=0)`);
        continue;
      }

      const { error: updateError } = await supabase
        .from('inventory')
        .update({
          units: record.units,
          available: record.available,
          reserved: record.reserved,
          inbound: record.inbound,
          unfulfilled: record.unfulfilled,
          fnsku: record.fnsku,
          last_inventory_sync_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('sku', record.sku);  // 🔧 FIX: Match by SKU instead of ASIN
      
      if (updateError) {
        console.error(`Error updating quantities for SKU ${record.sku}:`, updateError);
      } else {
        quantitiesUpdated++;
      }
    }
    
    console.log(`Updated ${Math.min(i + updateBatchSize, existingInventoryToUpdate.length)}/${existingInventoryToUpdate.length} inventory quantities`);
  }
  
  console.log(`✅ Updated quantities for ${quantitiesUpdated} existing inventory records`);

  // 🆕 BACKFILL EXISTING INVENTORY RECORDS with image_url, price, and unit cost from created_listings
  // Note: SP-API is used first for image/title, created_listings is FALLBACK
  console.log('🔄 Backfilling existing inventory records from created_listings (fallback for image/price, source for unit cost)...');
  
  // Find existing inventory records that are missing image_url, price, OR unit cost (amount)
  const { data: inventoryToBackfill, error: backfillFetchError } = await supabase
    .from('inventory')
    .select('id, asin, image_url, price, amount, available, reserved, inbound')
    .eq('user_id', userId)
    .or('image_url.is.null,price.is.null,price.eq.0,amount.is.null,amount.eq.0')
    .eq('unit_cost_manual', false);

  if (backfillFetchError) {
    console.error('Error fetching inventory for backfill:', backfillFetchError);
  } else if (inventoryToBackfill && inventoryToBackfill.length > 0) {
    console.log(`Found ${inventoryToBackfill.length} inventory records missing image, price, or unit cost`);
    
    // Get ASINs that need backfill
    const asinsToBackfill = inventoryToBackfill.map((r: any) => r.asin);
    
    // Fetch corresponding data from created_listings (including cost/units for unit cost)
    const createdListingsForBackfill: Record<string, { image_url?: string | null; price?: number | null; cost?: number | null; units?: number | null; amount?: number | null }> = {};
    
    for (let i = 0; i < asinsToBackfill.length; i += batchSize) {
      const asinBatch = asinsToBackfill.slice(i, i + batchSize);
      const { data: clData } = await supabase
        .from('created_listings')
        .select('asin, image_url, price, cost, units, amount')
        .eq('user_id', userId)
        .in('asin', asinBatch);
      
      if (clData) {
        clData.forEach((cl: any) => {
          // Keep the one with most data (prioritize records with cost data)
          if (!createdListingsForBackfill[cl.asin] || cl.cost) {
            createdListingsForBackfill[cl.asin] = {
              image_url: cl.image_url || null,
              price: cl.price || null,
              cost: cl.cost ?? null,
              units: cl.units ?? null,
              amount: cl.amount ?? null,
            };
          }
        });
      }
    }
    
    console.log(`Found ${Object.keys(createdListingsForBackfill).length} created_listings records with data to backfill`);
    
    // Update inventory records with data from created_listings
    let backfillCount = 0;
    for (const invRecord of inventoryToBackfill) {
      const clData = createdListingsForBackfill[invRecord.asin];
      if (!clData) continue;
      
      const updateData: any = {};
      
      // FALLBACK: Only update image/price if inventory is missing data and created_listings has it
      if (!invRecord.image_url && clData.image_url) {
        updateData.image_url = clData.image_url;
      }
      if ((!invRecord.price || invRecord.price === 0) && clData.price && clData.price > 0) {
        updateData.price = clData.price;
      }
      
      // UNIT COST backfill — Contract A via shared helper.
      //   inventory.cost   = UNIT cost (helper prefers amount=UNIT, else cost/units)
      //   inventory.amount = UNIT * current stock qty (TOTAL inventory value)
      // NEVER write cl.cost (TOTAL batch cost) raw into inventory.cost.
      // The outer SELECT already filters out unit_cost_manual = true rows.
      const backfillUnitCost = getListingUnitCost(clData);
      if (backfillUnitCost !== null) {
        const stockQty = Math.max(
          0,
          (invRecord.available || 0) + (invRecord.reserved || 0) + (invRecord.inbound || 0),
        );
        updateData.cost = backfillUnitCost;
        updateData.amount = backfillUnitCost * stockQty;
        updateData.units = stockQty;
      }
      
      if (Object.keys(updateData).length > 0) {
        const { error: updateError } = await supabase
          .from('inventory')
          .update(updateData)
          .eq('id', invRecord.id);
        
        if (updateError) {
          console.error(`Error backfilling ${invRecord.asin}:`, updateError);
        } else {
          backfillCount++;
        }
      }
    }
    
    console.log(`✅ Backfilled ${backfillCount} inventory records from created_listings`);
  } else {
    console.log('✅ No inventory records need backfill from created_listings');
  }

  // ========== STEP 2: SYNC FBM LISTINGS ==========
  console.log('\n📦 Now syncing FBM (Merchant Fulfilled) listings...');
  let fbmRecordsProcessed = 0;

  try {
    // Create Merchant Listings report (includes both FBA and FBM)
    console.log('Creating Merchant Listings report...');
    const fbmReportBody = JSON.stringify({
      reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
      marketplaceIds: [marketplaceId],
    });

    const fbmCreateResponse = await callSpApi(
      '/reports/2021-06-30/reports',
      accessToken,
      {},
      'POST',
      fbmReportBody
    );

    const fbmReportId = fbmCreateResponse.reportId;
    console.log('FBM Report created with ID:', fbmReportId);

    // Poll for report completion
    let fbmReportStatus = 'IN_QUEUE';
    let fbmAttempts = 0;
    const fbmMaxAttempts = 60;

    while (fbmReportStatus !== 'DONE' && fbmAttempts < fbmMaxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      fbmAttempts++;

      const statusResponse = await callSpApi(
        `/reports/2021-06-30/reports/${fbmReportId}`,
        accessToken
      );

      fbmReportStatus = statusResponse.processingStatus;
      console.log(`FBM Report status (attempt ${fbmAttempts}):`, fbmReportStatus);

      if (fbmReportStatus === 'FATAL' || fbmReportStatus === 'CANCELLED') {
        console.error('FBM Report failed:', fbmReportStatus);
        break;
      }
    }

    if (fbmReportStatus === 'DONE') {
      // Get report document
      const fbmReportResponse = await callSpApi(
        `/reports/2021-06-30/reports/${fbmReportId}`,
        accessToken
      );

      const fbmDocumentId = fbmReportResponse.reportDocumentId;
      const fbmDocResponse = await callSpApi(
        `/reports/2021-06-30/documents/${fbmDocumentId}`,
        accessToken
      );

      const fbmReportUrl = fbmDocResponse.url;
      console.log('Downloading FBM report...');
      const fbmReportData = await fetch(fbmReportUrl);
      const fbmReportText = await fbmReportData.text();

      // Parse the merchant listings report (tab-separated)
      const { lines: fbmLines, headers: fbmHeaders } = parseReportText(fbmReportText);

      // Find column indices for merchant listings
      const mlSkuIndex = findHeaderIndex(fbmHeaders, ['seller-sku', 'seller sku', 'sku']);
      const mlAsinIndex = findHeaderIndex(fbmHeaders, ['asin1', 'asin']);
      const mlTitleIndex = findHeaderIndex(fbmHeaders, ['item-name', 'item name', 'product-name', 'product name', 'title']);
      const mlPriceIndex = findHeaderIndex(fbmHeaders, ['price', 'your-price']);
      const mlQuantityIndex = findHeaderIndex(fbmHeaders, ['quantity', 'available']);
      const mlFulfillmentIndex = findHeaderIndex(fbmHeaders, ['fulfillment-channel', 'fulfillment channel']);
      const mlImageIndex = findHeaderIndex(fbmHeaders, ['image-url', 'image url']);

      console.log(`FBM Report columns: sku=${mlSkuIndex}, asin=${mlAsinIndex}, title=${mlTitleIndex}, fulfillment=${mlFulfillmentIndex}`);
      console.log(`FBM Report has ${fbmLines.length - 1} rows`);

      // Filter for FBM-only listings (fulfillment-channel = DEFAULT or not AMAZON_*)
      const fbmListings: any[] = [];
      
      // Build set of FBA SKUs to avoid duplicates (SKU is unique, not ASIN)
      const existingFbaSkus = new Set<string>();
      Object.values(inventoryBySku).forEach((item: any) => {
        if (item.sku) existingFbaSkus.add(item.sku);
      });

      for (let i = 1; i < fbmLines.length; i++) {
        const cols = fbmLines[i].split('\t');
        if (cols.length < 3) continue;

        const asin = cols[mlAsinIndex]?.trim();
        const sku = cols[mlSkuIndex]?.trim();
        const fulfillmentChannel = cols[mlFulfillmentIndex]?.trim() || '';
        
        // Skip if no ASIN or SKU
        if (!asin || !sku) continue;
        
        // Skip FBA listings (fulfillment-channel contains 'AMAZON' or SKU already synced as FBA)
        if (fulfillmentChannel.includes('AMAZON') || existingFbaSkus.has(sku)) continue;

        fbmListings.push({
          asin,
          sku,
          title: cols[mlTitleIndex]?.trim() || 'Unknown Product',
          price: parseFloat(cols[mlPriceIndex]) || null,
          quantity: parseInt(cols[mlQuantityIndex]) || 0,
          image_url: cols[mlImageIndex]?.trim() || null,
          fulfillment: 'FBM',
        });
      }

      console.log(`Found ${fbmListings.length} FBM-only listings to sync`);

      // Check which FBM SKUs already exist in inventory (use SKU as unique key, not ASIN)
      const fbmSkus = fbmListings.map(l => l.sku);
      const existingFbmSkuSet = new Set<string>();

      for (let i = 0; i < fbmSkus.length; i += batchSize) {
        const skuBatch = fbmSkus.slice(i, i + batchSize);
        const { data: existingFbm } = await supabase
          .from('inventory')
          .select('sku')
          .eq('user_id', userId)
          .in('sku', skuBatch);
        
        if (existingFbm) {
          existingFbm.forEach((r: any) => existingFbmSkuSet.add(r.sku));
        }
      }

      // Separate NEW vs EXISTING FBM listings by SKU
      const newFbmListings = fbmListings.filter(l => !existingFbmSkuSet.has(l.sku));
      const existingFbmListings = fbmListings.filter(l => existingFbmSkuSet.has(l.sku));
      console.log(`${newFbmListings.length} FBM listings are NEW, ${existingFbmListings.length} already exist in inventory`);

      // Update existing items to mark them as FBM and update quantity (use SKU as unique key)
      if (existingFbmListings.length > 0) {
        console.log(`Updating ${existingFbmListings.length} existing inventory items to FBM source...`);
        let fbmUpdated = 0;
        for (let i = 0; i < existingFbmListings.length; i += batchSize) {
          const batch = existingFbmListings.slice(i, i + batchSize);
          for (const listing of batch) {
            const { error } = await supabase
              .from('inventory')
              .update({ 
                source: 'amazon_sync_fbm',
                available: listing.quantity,
                reserved: 0,
                inbound: 0,
                fnsku: null
              })
              .eq('user_id', userId)
              .eq('sku', listing.sku);
            
            if (!error) {
              fbmUpdated++;
            } else {
              console.error(`Error updating FBM item ${listing.sku}:`, error);
            }
          }
        }
        console.log(`✅ Updated ${fbmUpdated} existing inventory items to FBM source`);
      }

      if (newFbmListings.length > 0) {
        // Get created_listings data for unit cost (Contract A: include `amount` = UNIT).
        const fbmCreatedListingsMap: Record<string, { cost?: number | null; units?: number | null; amount?: number | null; image_url?: string | null; price?: number | null }> = {};
        
        for (let i = 0; i < newFbmListings.length; i += batchSize) {
          const asinBatch = newFbmListings.slice(i, i + batchSize).map(l => l.asin);
          const { data: clData } = await supabase
            .from('created_listings')
            .select('asin, image_url, price, cost, units, amount')
            .eq('user_id', userId)
            .in('asin', asinBatch);
          
          if (clData) {
            clData.forEach((cl: any) => {
              if (!fbmCreatedListingsMap[cl.asin] || cl.cost) {
                fbmCreatedListingsMap[cl.asin] = {
                  image_url: cl.image_url,
                  price: cl.price,
                  cost: cl.cost,
                  units: cl.units,
                  amount: cl.amount,
                };
              }
            });
          }
        }

        // Prepare FBM inventory records — Contract A:
        //   inventory.cost   = UNIT cost (via getListingUnitCost: prefer amount, else cost/units)
        //   inventory.amount = UNIT cost * stock qty (TOTAL inventory value)
        //   inventory.units  = stock qty
        const fbmInventoryRecords = newFbmListings.map(listing => {
          const clData = fbmCreatedListingsMap[listing.asin];
          const unitCost: number | null = clData ? getListingUnitCost(clData) : null;
          const stockQty = listing.quantity || 0;

          return {
            user_id: userId,
            asin: listing.asin,
            sku: listing.sku,
            fnsku: null, // FBM doesn't have FNSKU
            title: listing.title,
            image_url: listing.image_url || clData?.image_url || null,
            price: listing.price ?? clData?.price ?? null,
            cost: unitCost, // Contract A: UNIT cost
            amount: unitCost !== null ? unitCost * stockQty : null, // Contract A: TOTAL value
            units: stockQty,
            available: listing.quantity,
            reserved: 0,
            inbound: 0,
            unfulfilled: 0,
            supplier_links: [],
            source: 'amazon_sync_fbm',
          };
        });

        // Insert FBM inventory records
        for (let i = 0; i < fbmInventoryRecords.length; i += batchSize) {
          const batch = fbmInventoryRecords.slice(i, i + batchSize);
          const { error } = await supabase
            .from('inventory')
            .insert(batch);
          
          if (error) {
            console.error(`Error inserting FBM batch at index ${i}:`, error);
          } else {
            fbmRecordsProcessed += batch.length;
          }
        }

        console.log(`✅ Inserted ${fbmRecordsProcessed} FBM inventory records`);

        // Also insert FBM listings into created_listings (for cost tracking)
        const existingFbmCreatedListingsSet = new Set(Object.keys(fbmCreatedListingsMap));
        const newFbmCreatedListings = newFbmListings
          .filter(l => !existingFbmCreatedListingsSet.has(l.asin))
          .map(listing => ({
            user_id: userId,
            asin: listing.asin,
            sku: listing.sku,
            fnsku: null,
            title: listing.title,
            image_url: listing.image_url,
            price: listing.price,
            cost: null,
            units: null,
            amount: null,
            supplier_links: [],
          }));

        if (newFbmCreatedListings.length > 0) {
          let clInserted = 0;
          for (let i = 0; i < newFbmCreatedListings.length; i += batchSize) {
            const batch = newFbmCreatedListings.slice(i, i + batchSize);
            const { error } = await supabase
              .from('created_listings')
              .insert(batch);
            
            if (!error) {
              clInserted += batch.length;
            }
          }
          console.log(`✅ Inserted ${clInserted} FBM products into created_listings`);
        }
      }
    } else {
      console.log('⚠️ FBM report did not complete, skipping FBM sync');
    }
  } catch (fbmError) {
    console.error('Error syncing FBM listings:', fbmError);
    // Don't fail the entire sync if FBM fails
  }

  return { processedRows, sampleMappings, inventoryRecordsProcessed, fbmRecordsProcessed };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Check if this is an automated call (from cron job)
    let requestBody: any = {};
    if (req.method === 'POST') {
      try {
        requestBody = await req.json();
      } catch (error) {
        // No body or invalid JSON, treat as manual call
        console.log('No request body or invalid JSON, treating as manual call');
      }
    }
    const isAutomatedCall = requestBody.user_id && requestBody.seller_id && requestBody.refresh_token;

    let sellerId: string;
    let marketplaceId: string;
    let refreshToken: string;
    let userId: string;

    if (isAutomatedCall) {
      // Automated call from cron job - use provided credentials
      console.log('Processing automated sync for user:', requestBody.user_id);
      sellerId = requestBody.seller_id;
      marketplaceId = requestBody.marketplace_id;
      refreshToken = requestBody.refresh_token;
      userId = requestBody.user_id;
    } else {
      // Manual call from user - verify authentication
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Missing authorization' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);

      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      userId = user.id;

      // Get all seller authorizations for this user (multi-marketplace)
      const { data: authRows, error: sellerError } = await supabase
        .from('seller_authorizations')
        .select('seller_id, marketplace_id, refresh_token')
        .eq('user_id', user.id);

      // Prefer US marketplace, fallback to first available
      const sellerAuth = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
      if (sellerError || !sellerAuth) {
        return new Response(JSON.stringify({ error: 'Seller authorization not found. Please connect your Amazon account first.' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!sellerAuth.refresh_token) {
        return new Response(JSON.stringify({ error: 'Amazon refresh token not found. Please reconnect your Amazon account.' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      sellerId = sellerAuth.seller_id;
      marketplaceId = sellerAuth.marketplace_id;
      refreshToken = sellerAuth.refresh_token;
    }

    // First check if a sync is already in progress to avoid duplicate runs
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: activeSyncs } = await supabase
      .from('fnsku_sync_history')
      .select('id, sync_started_at, status')
      .eq('user_id', userId)
      .eq('seller_id', sellerId)
      .eq('marketplace_id', marketplaceId)
      .eq('status', 'in_progress')
      .gte('sync_started_at', thirtyMinutesAgo)
      .order('sync_started_at', { ascending: false })
      .limit(1);

    if (activeSyncs && activeSyncs.length > 0) {
      const runningSync = activeSyncs[0];
      console.log(`Sync blocked: Another sync is already in progress, started at ${runningSync.sync_started_at}`);
      return new Response(
        JSON.stringify({
          status: 'error',
          error: 'sync_in_progress',
          message: 'A sync is already running in the background. Please wait for it to finish before starting another one.',
          runningSyncId: runningSync.id,
          startedAt: runningSync.sync_started_at,
          httpStatus: 429,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Then check for recent successful syncs (4-hour cooldown for daily reports)
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data: recentSyncs } = await supabase
      .from('fnsku_sync_history')
      .select('sync_started_at, status')
      .eq('user_id', userId)
      .eq('seller_id', sellerId)
      .eq('marketplace_id', marketplaceId)
      .gte('sync_started_at', fourHoursAgo)
      .eq('status', 'completed')
      .order('sync_started_at', { ascending: false })
      .limit(1);

    if (recentSyncs && recentSyncs.length > 0) {
      const lastSync = recentSyncs[0];
      const timeSinceLastSync = Date.now() - new Date(lastSync.sync_started_at).getTime();
      const minutesRemaining = Math.ceil((4 * 60 * 60 * 1000 - timeSinceLastSync) / 60000);

      console.log(`Sync blocked: Last successful sync was ${Math.floor(timeSinceLastSync / 60000)} minutes ago`);
      return new Response(
        JSON.stringify({
          status: 'error',
          error: 'sync_cooldown',
          message: `Amazon's FBA inventory report can only be generated once every 4 hours (Amazon limitation). Please wait ${minutesRemaining} more minutes before syncing again.`,
          lastSyncTime: lastSync.sync_started_at,
          minutesRemaining,
          httpStatus: 429,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Create sync history record
    const { data: syncRecord, error: syncRecordError } = await supabase
      .from('fnsku_sync_history')
      .insert({
        user_id: userId,
        seller_id: sellerId,
        marketplace_id: marketplaceId,
        status: 'in_progress'
      })
      .select()
      .single();

    if (syncRecordError) {
      console.error('Failed to create sync history record:', syncRecordError);
    }

    const syncRecordId = syncRecord?.id;

    // Start background task to process sync
    const backgroundSync = async () => {
      try {
        const result = await syncFnskusFromReport(
          sellerId,
          marketplaceId,
          refreshToken,
          supabase,
          userId
        );

        // Update sync record as completed
        if (syncRecordId) {
          await supabase
            .from('fnsku_sync_history')
            .update({
              status: 'completed',
              sync_completed_at: new Date().toISOString(),
              processed_rows: result.processedRows
            })
            .eq('id', syncRecordId);
        }

        await supabase
          .from('user_sync_status')
          .upsert({
            user_id: userId,
            amazon_connected: true,
            inventory_synced: true,
            inventory_sync_started_at: syncRecord?.sync_started_at || new Date().toISOString(),
            inventory_sync_completed_at: new Date().toISOString(),
            last_error: null,
          }, { onConflict: 'user_id' });

        console.log('Background sync completed successfully:', result);

        // 🆕 AUTO-UPDATE INCOMPLETE RECORDS AFTER SYNC
        console.log('🔄 Starting automatic update of incomplete records...');
        
        // Find incomplete records (missing image, price, or unit_cost)
        const { data: incompleteRecords, error: incompleteError } = await supabase
          .from('inventory')
          .select('*')
          .eq('user_id', userId)
          .eq('source', 'amazon_sync')
          .or('image_url.is.null,price.is.null,price.eq.0,unit_cost.is.null,unit_cost.eq.0');

        if (incompleteError) {
          console.error('Error fetching incomplete records:', incompleteError);
        } else if (incompleteRecords && incompleteRecords.length > 0) {
          console.log(`Found ${incompleteRecords.length} incomplete records to auto-update`);

          // Process in batches of 50 to avoid timeouts
          const BATCH_SIZE = 50;
          const batches = Math.ceil(incompleteRecords.length / BATCH_SIZE);

          for (let batchNum = 0; batchNum < batches; batchNum++) {
            const start = batchNum * BATCH_SIZE;
            const end = Math.min(start + BATCH_SIZE, incompleteRecords.length);
            const batch = incompleteRecords.slice(start, end);

            console.log(`Processing batch ${batchNum + 1}/${batches} (${batch.length} records)`);

            for (const item of batch) {
              try {
                // Check if already complete before updating
                const isComplete = item.image_url && 
                                  item.price && 
                                  item.price > 0 && 
                                  item.unit_cost && 
                                  item.unit_cost > 0;
                
                if (isComplete) {
                  console.log(`⏭️ Skipping ${item.asin} - already complete`);
                  continue;
                }

                console.log(`🔄 Auto-updating ${item.asin}...`);

                // Fetch product data
                const { data: productData, error: productError } = await supabase.functions.invoke(
                  'personalhour-product-data',
                  { body: { asin: item.asin } }
                );

                // Handle errors gracefully - skip Unauthorized and NOT_FOUND
                if (productError) {
                  const errorMsg = productError?.message || JSON.stringify(productError);
                  
                  if (errorMsg.includes('Unauthorized') || errorMsg.includes('NOT_FOUND')) {
                    console.log(`⏭️ Skipping ${item.asin}: ${errorMsg.includes('Unauthorized') ? 'Authentication failed' : 'Product not found'}`);
                    continue;
                  }
                  
                  console.error(`Error fetching data for ${item.asin}:`, productError);
                  continue;
                }

                let updateData: any = {};

                if (productData?.data) {
                  if (productData.data.title) updateData.title = productData.data.title;
                  if (productData.data.image) updateData.image_url = productData.data.image;
                  if (productData.data.price) updateData.price = productData.data.price;
                }

                // Fetch unit cost from created_listings if exists.
                // Contract A: created_listings.cost = TOTAL, amount = UNIT.
                // inventory.cost = UNIT, inventory.amount = UNIT * stock qty.
                // NEVER copy created_listings.cost (TOTAL) raw into inventory.cost.
                // Respect unit_cost_manual: do not overwrite a manually edited cost.
                const { data: createdListing } = await supabase
                  .from('created_listings')
                  .select('cost, units, amount')
                  .eq('user_id', userId)
                  .eq('asin', item.asin)
                  .order('created_at', { ascending: false })
                  .limit(1)
                  .maybeSingle();

                if (createdListing && !item.unit_cost_manual) {
                  // Contract A unit cost via shared helper (prefer amount=UNIT, else cost/units).
                  const unitCost = getListingUnitCost(createdListing);

                  if (unitCost !== null) {
                    const stockQty = Math.max(
                      0,
                      Number(item.available || 0) + Number(item.reserved || 0) + Number(item.inbound || 0),
                    );
                    updateData.cost = unitCost; // inventory.cost = UNIT cost
                    updateData.amount = unitCost * stockQty; // inventory.amount = TOTAL value
                    updateData.units = stockQty; // inventory.units = stock qty
                    updateData.unit_cost_manual = false;
                  }
                }

                // Fetch actual Amazon fees if we have a price
                if (updateData.price && updateData.price > 0) {
                  const { data: roiData, error: roiError } = await supabase.functions.invoke(
                    'calculate-roi',
                    { body: { asin: item.asin, price: updateData.price } }
                  );

                  if (roiError) {
                    const errorMsg = roiError?.message || JSON.stringify(roiError);
                    
                    if (errorMsg.includes('Unauthorized') || errorMsg.includes('QUOTA_EXCEEDED')) {
                      console.log(`⏭️ Skipping ROI for ${item.asin}: ${errorMsg.includes('Unauthorized') ? 'Authentication failed' : 'Quota exceeded'}`);
                    } else {
                      console.error(`Error calculating ROI for ${item.asin}:`, roiError);
                    }
                  } else if (roiData?.fees) {
                    updateData.fees_json = roiData.fees;
                  }

                  // Add delay to manage API rate limits
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }

                // Update the record if we have new data
                if (Object.keys(updateData).length > 0) {
                  const { error: updateError } = await supabase
                    .from('inventory')
                    .update(updateData)
                    .eq('id', item.id);

                  if (updateError) {
                    console.error(`Error updating ${item.asin}:`, updateError);
                  } else {
                    console.log(`✅ Auto-updated ${item.asin}`);
                  }
                }

                // Add delay between records to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));

              } catch (itemError: any) {
                console.error(`Error auto-updating ${item.asin}:`, itemError.message);
              }
            }

            // Delay between batches
            if (batchNum < batches - 1) {
              console.log('⏸️ Pausing before next batch...');
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }

          console.log(`✅ Auto-update completed for ${incompleteRecords.length} records`);
        } else {
          console.log('✅ No incomplete records found - all synced products are complete');
        }

      } catch (syncError: any) {
        console.error('Background sync error:', syncError);

        await supabase
          .from('user_sync_status')
          .upsert({
            user_id: userId,
            amazon_connected: true,
            inventory_synced: false,
            inventory_sync_started_at: syncRecord?.sync_started_at || new Date().toISOString(),
            last_error: syncError.message,
          }, { onConflict: 'user_id' });

        // Update sync record as failed
        if (syncRecordId) {
          await supabase
            .from('fnsku_sync_history')
            .update({
              status: 'failed',
              sync_completed_at: new Date().toISOString(),
              error_message: syncError.message
            })
            .eq('id', syncRecordId);
        }
      }
    };

    // Start background task without awaiting
    if ((globalThis as any).EdgeRuntime?.waitUntil) {
      (globalThis as any).EdgeRuntime?.waitUntil(backgroundSync());
    } else {
      // Fallback for local development
      backgroundSync();
    }

    // Return immediate response
    return new Response(JSON.stringify({
      success: true,
      message: 'Sync started successfully. This may take several minutes for large inventories.',
      syncRecordId
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in sync-fnsku-report function:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
