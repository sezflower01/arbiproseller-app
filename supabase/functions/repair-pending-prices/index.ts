import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

// AWS SigV4 signing utilities
async function sha256(message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return await crypto.subtle.digest('SHA-256', data as any);
}

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
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
  const candidates: Array<{ clientId?: string; clientSecret?: string; label: string }> = [
    {
      clientId: Deno.env.get('SPAPI_LWA_CLIENT_ID'),
      clientSecret: Deno.env.get('SPAPI_LWA_CLIENT_SECRET'),
      label: 'SPAPI_LWA_*',
    },
    {
      clientId: Deno.env.get('LWA_CLIENT_ID'),
      clientSecret: Deno.env.get('LWA_CLIENT_SECRET'),
      label: 'LWA_*',
    },
  ];

  let lastStatus: number | null = null;
  let lastBody = '';

  for (const c of candidates) {
    if (!c.clientId || !c.clientSecret) continue;

    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: c.clientId,
        client_secret: c.clientSecret,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return data.access_token;
    }

    lastStatus = response.status;
    lastBody = await response.text().catch(() => '');
    console.warn(`[REPAIR] LWA token refresh failed with ${c.label}: ${response.status} ${lastBody.slice(0, 120)}`);
  }

  throw new Error(`Failed to get LWA access token: ${lastStatus ?? 'unknown'} ${lastBody.slice(0, 120)}`);
}

// NEW: Fetch fees from Amazon Fees API using LOCAL CURRENCY price
// This is the SAME approach as fetch-listing-prices tool (which works!)
async function fetchMarketplaceFeesForRepair(
  asin: string,
  marketplaceId: string,
  currency: string,
  priceLocal: number,
  accessToken: string,
  fxRates: Record<string, number>
): Promise<{ referralFee: number; fbaFee: number; closingFee: number; totalFees: number; feeSource: string; currency: string } | null> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const awsSecretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const awsRegion = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';

  const endpoint = 'https://sellingpartnerapi-na.amazon.com';
  const path = `/products/fees/v0/items/${asin}/feesEstimate`;
  const url = `${endpoint}${path}`;
  const host = 'sellingpartnerapi-na.amazon.com';

  // Build request body with LOCAL CURRENCY price (this is the key!)
  const requestBody = JSON.stringify({
    FeesEstimateRequest: {
      MarketplaceId: marketplaceId,
      IsAmazonFulfilled: true,
      PriceToEstimateFees: {
        ListingPrice: {
          CurrencyCode: currency,
          Amount: priceLocal,
        },
      },
      Identifier: asin,
    },
  });

  console.log(`[REPAIR_FEES_API] Request for ${asin}: marketplace=${marketplaceId}, price=${currency} ${priceLocal}`);

  // AWS SigV4 signing for POST
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const date = timestamp.slice(0, 8);
  const service = 'execute-api';

  const payloadHash = toHex(await sha256(requestBody));
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';

  const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const canonicalRequestHash = toHex(await sha256(canonicalRequest));

  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHash}`;

  const signingKey = await getSignatureKey(awsSecretAccessKey, date, awsRegion, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authorizationHeader,
        'x-amz-access-token': accessToken,
        'x-amz-date': timestamp,
        'host': host,
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });
  } catch (err) {
    console.error(`[REPAIR_FEES_API] Fetch error for ${asin}:`, err);
    return null;
  }

  const responseText = await response.text();
  console.log(`[REPAIR_FEES_API] ${marketplaceId} status: ${response.status}`);

  if (!response.ok) {
    console.error(`[REPAIR_FEES_API] Error for ${asin} in ${marketplaceId}: ${responseText.substring(0, 300)}`);
    return null;
  }

  try {
    const data = JSON.parse(responseText);
    const result = data?.payload?.FeesEstimateResult;
    const status = String(result?.Status ?? '').toLowerCase();
    
    if (status && status !== 'success') {
      console.warn(`[REPAIR_FEES_API] Non-success status for ${asin}: ${result?.Status}`);
      return null;
    }

    const feeDetails = result?.FeesEstimate?.FeeDetailList;
    if (!Array.isArray(feeDetails) || feeDetails.length === 0) {
      console.warn(`[REPAIR_FEES_API] No fee details for ${asin}`);
      return null;
    }

    let referralFeeLocal = 0;
    let fbaFeeLocal = 0;
    let feeCurrency = currency;

    for (const fee of feeDetails) {
      const type = String(fee?.FeeType ?? '');
      const amount = parseFloat(fee?.FeeAmount?.Amount ?? '0') || 0;
      const curr = fee?.FeeAmount?.CurrencyCode;
      if (curr) feeCurrency = curr;

      console.log(`[REPAIR_FEES_API] ${asin} ${marketplaceId} fee: ${type} = ${amount} ${feeCurrency}`);

      if (type === 'ReferralFee' || type.includes('Referral')) {
        referralFeeLocal += amount;
      } else if (type === 'FBAFees' || type.startsWith('FBA') || type.includes('Fulfillment')) {
        fbaFeeLocal += amount;
      }
      // Skip ClosingFee for now (not charged on pending orders)
    }

    // Convert fees from LOCAL currency to USD
    const fxRate = fxRates[feeCurrency] || 1;
    const referralFeeUsd = feeCurrency !== 'USD' ? referralFeeLocal / fxRate : referralFeeLocal;
    const fbaFeeUsd = feeCurrency !== 'USD' ? fbaFeeLocal / fxRate : fbaFeeLocal;
    const totalFeesUsd = referralFeeUsd + fbaFeeUsd;
    
    console.log(`[REPAIR_FEES_API] ✅ ${asin} ${marketplaceId}: LOCAL ${feeCurrency} referral=${referralFeeLocal.toFixed(2)}, fba=${fbaFeeLocal.toFixed(2)} → USD referral=$${referralFeeUsd.toFixed(2)}, fba=$${fbaFeeUsd.toFixed(2)}, total=$${totalFeesUsd.toFixed(2)} (fxRate=${fxRate})`);

    return { 
      referralFee: referralFeeUsd, 
      fbaFee: fbaFeeUsd, 
      closingFee: 0, // Always 0 until settled
      totalFees: totalFeesUsd, 
      feeSource: currency !== 'USD' ? 'fees_api_fx' : 'fees_api',
      currency: 'USD', // Always return USD fees
    };
  } catch (err) {
    console.error(`[REPAIR_FEES_API] Parse error for ${asin}:`, err);
    return null;
  }
}

// WRAPPER: Keeps the old function signature for compatibility, but uses the new approach
async function getProductFees(
  asin: string,
  referencePriceUsd: number,
  accessToken: string,
  marketplaceId: string = 'ATVPDKIKX0DER',
  actualSalePriceUsd?: number,
  fxRates?: Record<string, number>,
  localPriceOverride?: number,
  localCurrencyOverride?: string
): Promise<{ referralFee: number; fbaFee: number; closingFee: number; totalFees: number; feeSource: string; currency?: string } | null> {
  if (!asin || asin === 'UNKNOWN' || asin === 'PENDING' || referencePriceUsd <= 0) return null;
  
  // Determine currency for this marketplace
  const marketplaceToCurrency: Record<string, string> = {
    'ATVPDKIKX0DER': 'USD',
    'A2EUQ1WTGCTBG2': 'CAD',
    'A1AM78C64UM0Y8': 'MXN',
    'A2Q3Y263D00KWC': 'BRL',
  };
  const currency = localCurrencyOverride || marketplaceToCurrency[marketplaceId] || 'USD';
  
  // Use local price if provided, otherwise convert USD to local
  let priceLocal: number;
  if (localPriceOverride && localPriceOverride > 0) {
    priceLocal = localPriceOverride;
    console.log(`[REPAIR_FEES] Using provided local price: ${currency} ${priceLocal}`);
  } else {
    const fxRate = (fxRates && fxRates[currency]) ? fxRates[currency] : 1;
    priceLocal = currency !== 'USD' ? referencePriceUsd * fxRate : referencePriceUsd;
    console.log(`[REPAIR_FEES] Converting USD $${referencePriceUsd} to ${currency} ${priceLocal.toFixed(2)} (rate=${fxRate})`);
  }
  
  // Use the same FX rates object
  const rates = fxRates || { USD: 1 };
  
  return await fetchMarketplaceFeesForRepair(asin, marketplaceId, currency, priceLocal, accessToken, rates);
}

// Marketplace ID mapping
const MARKETPLACE_CODE_TO_ID: Record<string, string> = {
  'US': 'ATVPDKIKX0DER',
  'CA': 'A2EUQ1WTGCTBG2',
  'MX': 'A1AM78C64UM0Y8',
  'BR': 'A2Q3Y263D00KWC',
};

// Helper to fetch FX rates from database (dynamic, not hardcoded)
async function getFxRates(supabase: any): Promise<Record<string, number>> {
  const { data: fxRows, error } = await supabase
    .from('fx_rates')
    .select('quote, rate');
  
  if (error || !fxRows) {
    console.warn('[REPAIR] Failed to fetch fx_rates, using fallback rates:', error?.message);
    // Fallback rates (but these should rarely be used)
    return { 'USD': 1, 'MXN': 20.50, 'CAD': 1.44, 'BRL': 6.20 };
  }
  
  const rates: Record<string, number> = { 'USD': 1 };
  for (const row of fxRows) {
    rates[row.quote] = row.rate;
  }
  return rates;
}

// Convert foreign currency to USD using fx_rates table
// fx_rates stores: 1 USD = X foreign currency (e.g., 1 USD = 20.50 MXN)
// So to convert MXN to USD: MXN_amount / rate
function convertToUsd(amount: number, currencyCode: string, fxRates: Record<string, number>): number {
  if (currencyCode === 'USD') return amount;
  const rate = fxRates[currencyCode];
  if (!rate || rate === 0) {
    console.warn(`[REPAIR] No FX rate for ${currencyCode}, treating as USD`);
    return amount;
  }
  // CRITICAL: fx_rates stores "1 USD = X foreign", so divide to get USD
  return amount / rate;
}

// Exponential backoff: 15min, 30min, 60min, 2hr, 4hr, 6hr (cap)
function getBackoffMinutes(attemptCount: number): number {
  const backoffs = [15, 30, 60, 120, 240, 360];
  return backoffs[Math.min(attemptCount, backoffs.length - 1)];
}

// Marketplace code to currency mapping
const MARKETPLACE_TO_CURRENCY: Record<string, string> = {
  'MX': 'MXN',
  'A1AM78C64UM0Y8': 'MXN',
  'CA': 'CAD', 
  'A2EUQ1WTGCTBG2': 'CAD',
  'BR': 'BRL',
  'A2Q3Y263D00KWC': 'BRL',
  'US': 'USD',
  'ATVPDKIKX0DER': 'USD',
};

// NEW: Direct FX recalculation for non-US orders
// This fixes prices that were stored in foreign currency as if they were USD
async function recalculateFxPrices(
  supabase: any,
  userId: string,
  limit: number,
  asinFilter: string | null
): Promise<{ recalculated: number; failed: number; skipped: number }> {
  // Load FX rates from database
  const fxRates = await getFxRates(supabase);
  console.log(`[FX_RECALC] FX rates: MXN=${fxRates['MXN']}, CAD=${fxRates['CAD']}, BRL=${fxRates['BRL']}`);
  
  // Query non-US orders that likely have wrong prices.
  // Historically we converted ALL non-US `listings_api` prices to USD, but some
  // sellers have USD-priced offers even on MX/CA/BR marketplaces (or our parsing
  // returned USD). That created the infamous "$0.79" bug: $14.20 / 17.9 = $0.79.
  //
  // We now:
  // - convert ONLY when the price looks like LOCAL currency (heuristic threshold)
  // - also allow reverting bad prior `fx_recalc` conversions when we can.
  let query = supabase
    .from('sales_orders')
    .select('id, order_id, asin, marketplace, sold_price, total_sale_amount, estimated_price, quantity, price_source, referral_fee, fba_fee, closing_fee, total_fees')
    .eq('user_id', userId)
    .in('marketplace', ['MX', 'CA', 'BR', 'A1AM78C64UM0Y8', 'A2EUQ1WTGCTBG2', 'A2Q3Y263D00KWC'])
    // Include prior fx_recalc rows so we can revert bad conversions.
    .in('price_source', ['listings_api', 'fx_recalc'])
    .not('order_id', 'like', '%-REFUND%')
    .order('order_date', { ascending: false })
    .limit(limit);
  
  if (asinFilter) {
    query = query.eq('asin', asinFilter);
  }
  
  const { data: orders, error } = await query;
  
  if (error) {
    console.error('[FX_RECALC] Query error:', error);
    return { recalculated: 0, failed: 1, skipped: 0 };
  }
  
  if (!orders || orders.length === 0) {
    console.log('[FX_RECALC] No orders found to recalculate');
    return { recalculated: 0, failed: 0, skipped: 0 };
  }
  
  console.log(`[FX_RECALC] Found ${orders.length} non-US orders with listings_api prices to fix`);
  
  let recalculated = 0;
  let failed = 0;
  let skipped = 0;
  
  for (const order of orders) {
    try {
      const marketplace = order.marketplace || 'US';
      const currency = MARKETPLACE_TO_CURRENCY[marketplace] || 'USD';
      
      if (currency === 'USD') {
        console.log(`[FX_RECALC] Skipping ${order.order_id} - US marketplace`);
        skipped++;
        continue;
      }
      
      const rate = fxRates[currency] || 1;

      // Heuristic thresholds for *local* currency amounts.
      // If the value is below this, it's very likely already USD (or a bad prior conversion).
      const minLocal = currency === 'MXN'
        ? 80
        : currency === 'CAD'
          ? 20
          : currency === 'BRL'
            ? 60
            : 0;

      const sold = Number(order.sold_price || 0);
      const est = Number(order.estimated_price || 0);

      // Revert bad prior `fx_recalc` conversion when it produced tiny USD values.
      // Example: $14.20 (USD) incorrectly treated as MXN → 14.20/17.9 = $0.79.
      if (order.price_source === 'fx_recalc' && sold > 0 && sold < 5 && est >= 10) {
        const qty = order.quantity || 1;
        const correctedUsdPrice = est;
        const correctedTotalSale = correctedUsdPrice * qty;

        console.log(
          `[FX_RECALC][REVERT] ${order.order_id}: ${marketplace} sold=$${sold.toFixed(2)} looked too small; reverting to estimated_price=$${est.toFixed(2)}`
        );

        const { error: updateError } = await supabase
          .from('sales_orders')
          .update({
            sold_price: correctedUsdPrice,
            total_sale_amount: correctedTotalSale,
            price_source: 'estimated_price',
          })
          .eq('id', order.id);

        if (updateError) {
          console.error(`[FX_RECALC][REVERT] Update error for ${order.order_id}:`, updateError);
          failed++;
        } else {
          recalculated++;
        }

        continue;
      }

      // If a non-US order has a small price (below local threshold), treat it as already-USD and skip.
      // This prevents converting legitimate USD prices (or USD parsing fallbacks) into tiny amounts.
      if (sold > 0 && sold < minLocal) {
        console.log(
          `[FX_RECALC][SKIP] ${order.order_id}: ${marketplace} sold=${sold} < ${minLocal} (${currency}) → assume already USD, skipping conversion`
        );
        skipped++;
        continue;
      }

      // Convert local currency → USD. fx_rates stores: 1 USD = X local.
      const correctedUsdPrice = sold / rate;
      const qty = order.quantity || 1;
      const correctedTotalSale = correctedUsdPrice * qty;
      
      console.log(`[FX_RECALC] ${order.order_id}: ${marketplace} ${order.sold_price} ${currency} -> $${correctedUsdPrice.toFixed(2)} USD (rate=${rate})`);
      
      // Also recalculate fees if they exist (they were likely also in wrong currency)
      let updates: Record<string, any> = {
        sold_price: correctedUsdPrice,
        total_sale_amount: correctedTotalSale,
        price_source: 'fx_recalc', // Mark as recalculated
      };
      
      // If fees exist and are non-zero, recalculate them too
      if (order.referral_fee && order.referral_fee > 0) {
        updates.referral_fee = order.referral_fee / rate;
      }
      if (order.fba_fee && order.fba_fee > 0) {
        updates.fba_fee = order.fba_fee / rate;
      }
      if (order.closing_fee && order.closing_fee > 0) {
        updates.closing_fee = order.closing_fee / rate;
      }
      if (order.total_fees && order.total_fees > 0) {
        updates.total_fees = order.total_fees / rate;
      }
      
      const { error: updateError } = await supabase
        .from('sales_orders')
        .update(updates)
        .eq('id', order.id);
      
      if (updateError) {
        console.error(`[FX_RECALC] Update error for ${order.order_id}:`, updateError);
        failed++;
      } else {
        recalculated++;
      }
    } catch (err) {
      console.error(`[FX_RECALC] Error processing ${order.order_id}:`, err);
      failed++;
    }
  }
  
  console.log(`[FX_RECALC] Complete: ${recalculated} recalculated, ${failed} failed, ${skipped} skipped`);
  return { recalculated, failed, skipped };
}

// NEW: Fetch listing price from Pricing API (same approach as fetch-listing-prices tool)
// This is more reliable for non-US orders as it returns the actual marketplace price
async function getMarketplacePricingPrice(
  asin: string,
  marketplaceId: string,
  accessToken: string,
  fxRates: Record<string, number>
): Promise<{ priceUsd: number | null; localPrice: number | null; currency: string; fxRate: number }> {
  try {
    const endpoint = 'https://sellingpartnerapi-na.amazon.com';
    const path = `/products/pricing/v0/items/${asin}/offers`;
    const queryParams = `MarketplaceId=${marketplaceId}&ItemCondition=New`;
    const url = `${endpoint}${path}?${queryParams}`;

    const headers = await signRequest('GET', url, '', accessToken);
    const response = await fetch(url, { method: 'GET', headers });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`[PRICING_API] Error for ASIN ${asin} (${marketplaceId}): ${response.status} ${text.slice(0, 200)}`);
      return { priceUsd: null, localPrice: null, currency: 'USD', fxRate: 1 };
    }

    const data = await response.json();
    const summary = data?.payload?.Summary;
    const offers = data?.payload?.Offers || [];

    let listingPrice: number | null = null;
    let currency = 'USD';

    // PRIORITY 1: Get listing price from first offer (matches Fetch Listing Price tool)
    // This is the ACTUAL listing price, not the BuyBox price
    if (offers.length > 0) {
      const firstOffer = offers[0];
      listingPrice = firstOffer.ListingPrice?.Amount || null;
      currency = firstOffer.ListingPrice?.CurrencyCode || 'USD';
      if (listingPrice) {
        console.log(`[PRICING_API] Found listing price from Offers: ${currency} ${listingPrice}`);
      }
    }

    // PRIORITY 2: Fallback to LowestPrices for FBA items
    if (listingPrice === null && summary?.LowestPrices) {
      const newLowest = summary.LowestPrices.find((p: any) => p.condition === 'New' && p.fulfillmentChannel === 'Amazon');
      if (newLowest) {
        listingPrice = newLowest.ListingPrice?.Amount || newLowest.LandedPrice?.Amount || null;
        currency = newLowest.ListingPrice?.CurrencyCode || newLowest.LandedPrice?.CurrencyCode || 'USD';
        if (listingPrice) {
          console.log(`[PRICING_API] Found listing price from LowestPrices: ${currency} ${listingPrice}`);
        }
      }
    }

    // PRIORITY 3: Last resort - BuyBox price (only if no listing price available)
    if (listingPrice === null) {
      const buyBoxPrices = summary?.BuyBoxPrices || [];
      if (buyBoxPrices.length > 0) {
        const newBuyBox = buyBoxPrices.find((p: any) => p.condition === 'New');
        if (newBuyBox) {
          listingPrice = newBuyBox.ListingPrice?.Amount || newBuyBox.LandedPrice?.Amount || null;
          currency = newBuyBox.ListingPrice?.CurrencyCode || newBuyBox.LandedPrice?.CurrencyCode || 'USD';
          console.log(`[PRICING_API] Fallback to BuyBox price: ${currency} ${listingPrice}`);
        }
      }
    }

    if (listingPrice === null || listingPrice <= 0) {
      console.log(`[PRICING_API] No valid price found for ASIN ${asin} (${marketplaceId})`);
      return { priceUsd: null, localPrice: null, currency: 'USD', fxRate: 1 };
    }

    // Convert to USD using database FX rates
    const fxRate = fxRates[currency] || 1;
    const priceUsd = listingPrice / fxRate;

    console.log(`[PRICING_API] ✓ ASIN ${asin} (${marketplaceId}): ${currency} ${listingPrice} / ${fxRate} = USD $${priceUsd.toFixed(2)}`);
    return { priceUsd, localPrice: listingPrice, currency, fxRate };
  } catch (err) {
    console.error(`[PRICING_API] Error fetching price for ASIN ${asin}:`, err);
    return { priceUsd: null, localPrice: null, currency: 'USD', fxRate: 1 };
  }
}

// Fetch seller's live listing price from Amazon Listings API
// NOTE: We request includedData=offers because repricer/current listing prices are exposed there.
async function getLiveListingPrice(
  sku: string,
  sellerId: string,
  marketplaceId: string,
  accessToken: string
): Promise<{ price: number | null; currency: string }> {
  try {
    const encodedSku = encodeURIComponent(sku);
    const listingsUrl = `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${sellerId}/${encodedSku}?marketplaceIds=${marketplaceId}&includedData=offers`;

    const headers = await signRequest('GET', listingsUrl, '', accessToken);
    const response = await fetch(listingsUrl, { method: 'GET', headers });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`[REPAIR] Listings API error for SKU ${sku}: ${response.status} ${text.slice(0, 200)}`);
      return { price: null, currency: 'USD' };
    }

    const data = await response.json();

    // Listings API returns "offers" when includedData=offers
    const offers: any[] = Array.isArray(data?.offers) ? data.offers : [];
    if (offers.length === 0) {
      console.log(`[REPAIR] Listings API: no offers for SKU ${sku}`);
      return { price: null, currency: 'USD' };
    }

    // Pick the first B2C offer if present, otherwise first offer
    const offer = offers.find(o => (o?.offerType || '').toUpperCase() === 'B2C') ?? offers[0];

    // Try multiple known shapes for price
    const candidate =
      offer?.price ??
      offer?.listingPrice ??
      offer?.ourPrice ??
      offer?.points?.[0]?.pointsNumber;

    const rawValue =
      candidate?.amount ??
      candidate?.value ??
      candidate?.value_with_tax ??
      candidate;

    const currency =
      candidate?.currency ??
      offer?.price?.currency ??
      offer?.listingPrice?.currency ??
      offer?.currencyCode ??
      'USD';

    const parsed = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue ?? ''));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.log(`[REPAIR] Listings API: offer has no usable price for SKU ${sku}`);
      return { price: null, currency: 'USD' };
    }

    return { price: parsed, currency };
  } catch (err) {
    console.error(`[REPAIR] Error fetching live price for SKU ${sku}:`, err);
    return { price: null, currency: 'USD' };
  }
}

// Helper to log enrichment attempts
async function logEnrichmentAttempt(
  supabase: any,
  userId: string,
  orderId: string,
  asin: string,
  status: 'started' | 'success' | 'failed',
  source: string,
  errorMessage?: string
) {
  try {
    await supabase.from('enrichment_logs').insert({
      user_id: userId,
      order_id: orderId,
      asin: asin,
      enrichment_type: 'both', // Must be 'price', 'fees', or 'both' per DB constraint
      source: source || 'repair_pending_prices',
      status: status,
      error_message: errorMessage || null,
      completed_at: status !== 'started' ? new Date().toISOString() : null,
    });
  } catch (err) {
    console.warn(`[REPAIR] Failed to log enrichment attempt:`, err);
  }
}

async function correctSuspiciousHalfPriceRows(
  supabase: any,
  userId: string,
  asin: string,
  correctedUnitPrice: number,
  limit: number
) {
  const nowIso = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from('sales_orders')
    .select('id, order_id, asin, quantity, sold_price, estimated_price, referral_fee, fba_fee, closing_fee, total_fees, unit_cost, total_cost, price_last_error')
    .eq('user_id', userId)
    .eq('asin', asin)
    .not('order_id', 'like', '%-REFUND%')
    .limit(limit);

  if (error) throw error;

  let repaired = 0;
  let skipped = 0;

  for (const row of rows || []) {
    const qty = Math.max(1, Number(row.quantity || 1));
    const currentUnit = Number(row.sold_price || row.estimated_price || 0);
    const isHeld = row.price_last_error === 'SUSPICIOUS_HALF_PRICE_HOLD';
    const isHalfPrice = currentUnit > 0 && currentUnit < correctedUnitPrice * 0.6;
    const isPendingAtCorrectEstimate = Number(row.sold_price || 0) === 0 && Math.abs(Number(row.estimated_price || 0) - correctedUnitPrice) < 0.02;

    if (!isHeld && !isHalfPrice && !isPendingAtCorrectEstimate) {
      skipped++;
      continue;
    }

    const totalSaleAmount = Math.round(correctedUnitPrice * qty * 100) / 100;
    const totalFees = Number(row.total_fees || 0);
    const unitCost = Number(row.unit_cost || 0);
    const totalCost = unitCost > 0 ? Math.round(unitCost * qty * 100) / 100 : Number(row.total_cost || 0);
    const netProfit = totalSaleAmount - totalFees - totalCost;
    const roi = totalCost > 0 ? Math.round((netProfit / totalCost) * 1000) / 10 : null;

    const { error: updateError } = await supabase
      .from('sales_orders')
      .update({
        sold_price: Math.round(correctedUnitPrice * 100) / 100,
        item_price: Math.round(correctedUnitPrice * 100) / 100,
        shipping_price: 0,
        total_sale_amount: totalSaleAmount,
        estimated_price: Math.round(correctedUnitPrice * 100) / 100,
        total_cost: totalCost > 0 ? totalCost : null,
        roi,
        price_source: 'corrected_listing_price',
        price_confidence: 'CORRECTED',
        price_enrich_status: 'enriched',
        needs_price_enrich: false,
        price_last_error: null,
        price_last_attempt_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', row.id);

    if (updateError) throw updateError;
    await logEnrichmentAttempt(supabase, userId, row.order_id, asin, 'success', 'corrected_listing_price');
    repaired++;
  }

  return { repaired, skipped, failed: 0 };
}

// Helper to get timezone-aware day boundaries
function getDayBoundsForTimezone(dateStr: string, timezone: string): { start: string; end: string } {
  // Parse the date string and create start/end of day in the given timezone
  // dateStr format: YYYY-MM-DD
  const [year, month, day] = dateStr.split('-').map(Number);
  
  // Create date at start of day in user's timezone
  const startDate = new Date(`${dateStr}T00:00:00`);
  const endDate = new Date(`${dateStr}T23:59:59.999`);
  
  return {
    start: dateStr,
    end: dateStr,
  };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Internal cron/scheduled calls should NOT rely on JWT (they often send a non-user token).
    const internalSecret = req.headers.get('x-internal-secret');
    const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    const isInternalCall = Boolean(internalSecret && expectedSecret && internalSecret === expectedSecret);

    const authHeader = req.headers.get('Authorization');
    let userId: string | null = null;

    // For manual trigger, use auth header (JWT)
    if (!isInternalCall && authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        console.error('[REPAIR] Auth error:', authError);
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      userId = user.id;
    }
    
    // Parse request body for optional params
    let limitParam = 30;
    let forceListingPrice = false;
    let asinFilter: string | null = null;
    let repairMissingOnly = false;
    let scopeToday = false;
    let userTimezone = 'America/Los_Angeles'; // Default to Pacific
    let nonUsOnly = false; // Only process non-US marketplace orders (MX, CA, BR)
    let forceOverwriteNonUs = false; // Force overwrite even if price_source isn't in the default "bad" list
    let fxRecalcOnly = false; // NEW: Direct FX recalculation without API calls
    let correctedUnitPrice: number | null = null;
    let correctSuspiciousHalfPrice = false;
    
    try {
      const body = await req.json();
      if (body.limit) limitParam = Math.min(body.limit, 200); // Increased for FX recalc
      if (body.userId) userId = body.userId; // For cron job
      if (body.force_listing_price) forceListingPrice = true;
      if (body.repair_missing_only) repairMissingOnly = true;
      if (body.scope === 'today') scopeToday = true;
      if (body.timezone) userTimezone = body.timezone;
      if (typeof body.asin === 'string' && body.asin.trim()) asinFilter = body.asin.trim();
      if (body.non_us_only) nonUsOnly = true;
      if (body.force_overwrite_non_us) forceOverwriteNonUs = true;
      if (body.fx_recalc_only) fxRecalcOnly = true; // NEW: Direct FX recalculation mode
      if (body.correct_suspicious_half_price) correctSuspiciousHalfPrice = true;
      if (body.corrected_unit_price !== undefined) {
        const parsedPrice = Number(body.corrected_unit_price);
        if (Number.isFinite(parsedPrice) && parsedPrice > 0) correctedUnitPrice = parsedPrice;
      }
    } catch {}
    
    // For cron job, process all users with pending orders
    if (!userId) {
      console.log('[REPAIR] Cron mode: processing all users with pending orders');
      
      // NEW QUERY: Use needs_price_enrich OR needs_fee_enrich flags
      const nowIso = new Date().toISOString();
      const { data: pendingRows } = await supabase
        .from('sales_orders')
        .select('user_id')
        .or('needs_price_enrich.eq.true,needs_fee_enrich.eq.true')
        .or(`next_enrich_after.is.null,next_enrich_after.lte.${nowIso}`)
        .not('asin', 'eq', 'PENDING')
        .not('order_id', 'like', '%-REFUND%')
        .limit(200);
      
      // Fallback: also check legacy sold_price=0 rows that weren't migrated
      const { data: legacyRows } = await supabase
        .from('sales_orders')
        .select('user_id')
        .eq('sold_price', 0)
        .neq('price_enrich_status', 'enriched')
        .not('asin', 'eq', 'PENDING')
        .not('order_id', 'like', '%-REFUND%')
        .limit(100);
      
      const allUserIds = [
        ...((pendingRows || []).map((r: any) => r.user_id)),
        ...((legacyRows || []).map((r: any) => r.user_id)),
      ];
      
      const uniqueUserIds = [...new Set(allUserIds.filter((id: any) => typeof id === 'string'))] as string[];
      console.log(`[REPAIR] Found ${uniqueUserIds.length} users with pending orders (flag-based + legacy)`);
      
      let totalRepaired = 0;
      let totalFailed = 0;
      
      for (const uid of uniqueUserIds) {
        try {
          // Process up to 10 orders per user in cron mode (respect backoff)
          const result = await processUserOrders(supabase, uid, 10, false, { 
            forceListingPrice: false, 
            asinFilter: null, 
            repairMissingOnly: true,
            scopeToday: false,
            userTimezone: 'America/Los_Angeles',
          });
          totalRepaired += result.repaired;
          totalFailed += result.failed;
        } catch (err) {
          console.error(`[REPAIR] Error processing user ${uid}:`, err);
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        mode: 'cron',
        usersProcessed: uniqueUserIds.length,
        totalRepaired,
        totalFailed,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (correctSuspiciousHalfPrice) {
      if (!asinFilter || !correctedUnitPrice) {
        return new Response(JSON.stringify({ error: 'asin and corrected_unit_price are required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const result = await correctSuspiciousHalfPriceRows(supabase, userId, asinFilter, correctedUnitPrice, limitParam);
      return new Response(JSON.stringify({
        success: true,
        mode: 'correct_suspicious_half_price',
        ...result,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    // NEW: Direct FX recalculation mode - fixes prices stored in foreign currency as USD
    if (fxRecalcOnly) {
      console.log(`[FX_RECALC] Starting direct FX recalculation for user ${userId}`);
      const result = await recalculateFxPrices(supabase, userId, limitParam, asinFilter);
      return new Response(JSON.stringify({
        success: true,
        mode: 'fx_recalc',
        ...result,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    // Manual trigger: process single user with forceRetry to bypass backoff
    console.log(
      `[REPAIR] Manual mode: processing user ${userId} (bypassing backoff)` +
        `${forceListingPrice ? ' [force_listing_price]' : ''}` +
        `${repairMissingOnly ? ' [repair_missing_only]' : ''}` +
        `${scopeToday ? ` [scope=today, tz=${userTimezone}]` : ''}` +
        `${nonUsOnly ? ' [non_us_only]' : ''}` +
        `${forceOverwriteNonUs ? ' [force_overwrite_non_us]' : ''}`
    );
    const result = await processUserOrders(supabase, userId, limitParam, true, { 
      forceListingPrice, 
      asinFilter, 
      repairMissingOnly,
      scopeToday,
      userTimezone,
      nonUsOnly,
      forceOverwriteNonUs,
    });
    
    return new Response(JSON.stringify({
      success: true,
      mode: 'manual',
      ...result,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[REPAIR] Error:', error);
    return new Response(JSON.stringify({ 
      error: (error as Error).message || 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function processUserOrders(
  supabase: any,
  userId: string,
  limit: number,
  forceRetry: boolean = false,
  opts: { 
    forceListingPrice: boolean; 
    asinFilter: string | null; 
    repairMissingOnly?: boolean;
    scopeToday?: boolean;
    userTimezone?: string;
    nonUsOnly?: boolean;
    forceOverwriteNonUs?: boolean;
  } = { forceListingPrice: false, asinFilter: null, repairMissingOnly: false, scopeToday: false, userTimezone: 'America/Los_Angeles', nonUsOnly: false, forceOverwriteNonUs: false }
) {
  const now = new Date();
  const nowIso = now.toISOString();
  const {
    forceListingPrice,
    asinFilter,
    repairMissingOnly = false,
    scopeToday = false,
    userTimezone = 'America/Los_Angeles',
    nonUsOnly = false,
    forceOverwriteNonUs = false,
  } = opts;
  
  // Build query using the NEW FLAG-BASED LOGIC per ChatGPT's recommendation
  // Primary: needs_price_enrich=true OR needs_fee_enrich=true (respect next_enrich_after)
  // Fallback: legacy sold_price=0 check for unmigrated rows
  
  // For manual repair actions (especially non-US fixes), process newest first so the button feels effective.
  const orderDirection = (forceListingPrice || nonUsOnly) ? false : true; // false = DESC, true = ASC
  
  let query = supabase
    .from('sales_orders')
    .select('id, order_id, asin, sku, quantity, order_date, price_attempt_count, price_last_attempt_at, marketplace, estimated_price, order_status, price_source, price_enrich_status, sold_price, referral_fee, fba_fee, closing_fee, total_fees, locked_est_price, locked_from, fees_source, needs_price_enrich, needs_fee_enrich, next_enrich_after, enrich_attempts, last_enrich_attempt_at, last_enrich_error, seller_sku')
    .eq('user_id', userId)
    .not('order_id', 'like', '%-REFUND%')
    .not('asin', 'eq', 'PENDING') // Skip placeholder rows
    .order('order_date', { ascending: orderDirection });

  if (asinFilter) {
    query = query.eq('asin', asinFilter);
  }

  // NEW: Filter for non-US marketplace orders only (MX, CA, BR)
  if (nonUsOnly) {
    console.log('[REPAIR] Non-US only mode: filtering for MX, CA, BR marketplaces');
    query = query.in('marketplace', ['MX', 'CA', 'BR', 'A1AM78C64UM0Y8', 'A2EUQ1WTGCTBG2', 'A2Q3Y263D00KWC']);
  }

  // Scope to today only - use Pacific Time for Amazon business day
  if (scopeToday) {
    // Amazon business day = midnight PT, so always use Pacific Time
    const AMAZON_BUSINESS_TZ = 'America/Los_Angeles';
    const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: AMAZON_BUSINESS_TZ });
    console.log(`[REPAIR] Scoping to today (PT): ${todayPT}`);
    
    // Filter by order_date in Pacific Time business day
    query = query.gte('order_date', todayPT).lte('order_date', todayPT);
  }

  if (forceListingPrice) {
    // In force-listing mode, we want to refresh *all* Pending orders (up to limit).
    query = query.eq('order_status', 'Pending');
  } else if (nonUsOnly) {
    if (forceOverwriteNonUs) {
      // IMPORTANT: When the user clicks the Sales page button, we must be able to re-process rows
      // even if they already have a "good" price_source (pricing_api_*) because they can still be wrong.
      // ALSO include rows where price is GOOD but fees are PENDING (critical ChatGPT fix)
      // So we select: ALL non-US rows (no price_source filtering)
      console.log('[REPAIR] Non-US mode: force_overwrite_non_us=true → selecting ALL non-US rows (including good prices with pending fees)');
    } else {
      // For non_us_only mode (non-forced): target non-US orders that need repair
      // Include: 
      // 1. Bad price sources (listings_api, fx_recalc, etc.)
      // 2. sold_price=0 (pending orders)
      // 3. Suspiciously low prices (<$5)
      // 4. CRITICAL: Good price but pending fees (needs_fee_enrich=true OR fees_source in unavailable/pending)
      console.log('[REPAIR] Non-US mode: targeting orders with bad price sources OR sold_price=0 OR pending fees');
      query = query.or(
        `price_source.eq.listings_api,` +
        `price_source.eq.fx_recalc,` +
        `price_source.eq.estimated_price,` +
        `price_source.eq.manual_fix,` +
        `price_source.eq.estimated:inventory.price,` +
        `price_source.eq.estimated:inventory,` +
        `price_source.eq.estimated:asin_my_price_cache,` +
        `price_source.like.estimated:%,` + // Catch all "estimated:*" variants
        `sold_price.eq.0,` +
        `and(sold_price.lt.5,sold_price.gt.0),` +
        // CRITICAL: Include rows with GOOD price but PENDING fees
        `needs_fee_enrich.eq.true,` +
        `fees_source.eq.unavailable,` +
        `fees_source.eq.pending,` +
        `total_fees.is.null`
      );
    }
  } else {
    // Standard mode: Query by flags first, with legacy fallback
    // Use .or() to match either flag-based or legacy criteria
    query = query.or(
      // 1) New flags
      `needs_price_enrich.eq.true,` +
      `needs_fee_enrich.eq.true,` +
      // 2) Legacy: pending rows with no price
      `and(sold_price.eq.0,price_enrich_status.neq.enriched),` +
      // 3) CRITICAL: Corrupt US rows that were "enriched" with foreign-currency-as-USD values
      // (e.g., sold_price $476 for a normally $19 ASIN). These won't have flags, so we must pull them.
      // NOTE: Many rows have order_status NULL, so do NOT filter by order_status here.
      `and(marketplace.eq.US,sold_price.gt.200,price_source.eq.inventory_refresh),` +
      `and(marketplace.eq.US,estimated_price.gt.200,price_source.eq.estimated_price)`
    );
  }

  const { data: pendingOrders, error: fetchError } = await query.limit(forceRetry ? limit : limit * 2);

  if (fetchError) {
    console.error('[REPAIR] Fetch error:', fetchError);
    throw fetchError;
  }

  if (!pendingOrders || pendingOrders.length === 0) {
    console.log('[REPAIR] No pending orders to repair');
    return { repaired: 0, failed: 0, pending: 0, skipped: 0 };
  }

  // For manual trigger (forceRetry), skip backoff filtering entirely
  // For cron: respect next_enrich_after
  let eligibleOrders: any[];
  let skippedCount: number;
  
  if (forceRetry) {
    // Manual mode: bypass backoff, process all pending orders
    eligibleOrders = pendingOrders.slice(0, limit);
    skippedCount = 0;
    console.log(`[REPAIR] Force retry mode: processing ${eligibleOrders.length} orders (ignoring backoff)`);
  } else {
    // Cron mode: respect next_enrich_after (new) and legacy price_last_attempt_at
    eligibleOrders = pendingOrders.filter((order: any) => {
      // New flag system: check next_enrich_after
      if (order.next_enrich_after) {
        const nextEnrich = new Date(order.next_enrich_after);
        if (now < nextEnrich) return false;
      }
      // Legacy backoff check
      if (!order.next_enrich_after && order.price_last_attempt_at) {
        const lastAttempt = new Date(order.price_last_attempt_at);
        const backoffMinutes = getBackoffMinutes(order.price_attempt_count || 0);
        const nextEligible = new Date(lastAttempt.getTime() + backoffMinutes * 60 * 1000);
        if (now < nextEligible) return false;
      }
      return true;
    }).slice(0, limit);
    
    skippedCount = pendingOrders.length - eligibleOrders.length;
    
    if (eligibleOrders.length === 0) {
      console.log(`[REPAIR] All ${pendingOrders.length} orders in backoff period`);
      return { repaired: 0, failed: 0, pending: pendingOrders.length, skipped: skippedCount };
    }
    
    console.log(`[REPAIR] Processing ${eligibleOrders.length} orders (${skippedCount} in backoff)`);
  }

  // Get ALL seller authorizations (US, MX, CA, BR)
  const { data: allAuths } = await supabase
    .from('seller_authorizations')
    .select('refresh_token, marketplace_id, seller_id, selling_partner_id')
    .eq('user_id', userId);

  // Build a map of marketplace_id -> auth for quick lookup
  const authByMarketplace = new Map<string, typeof allAuths[0]>();
  if (allAuths) {
    for (const a of allAuths) {
      authByMarketplace.set(a.marketplace_id, a);
      // Also map marketplace codes to IDs
      if (a.marketplace_id === 'ATVPDKIKX0DER') authByMarketplace.set('US', a);
      if (a.marketplace_id === 'A1AM78C64UM0Y8') authByMarketplace.set('MX', a);
      if (a.marketplace_id === 'A2EUQ1WTGCTBG2') authByMarketplace.set('CA', a);
      if (a.marketplace_id === 'A2Q3Y263D00KWC') authByMarketplace.set('BR', a);
    }
  }

  // Default to US auth for backwards compatibility
  const auth = authByMarketplace.get('ATVPDKIKX0DER') || allAuths?.[0];

  if (!auth?.refresh_token) {
    console.error('[REPAIR] No seller authorization found');
    return { repaired: 0, failed: eligibleOrders.length, pending: 0, skipped: skippedCount, error: 'No Amazon connection' };
  }

  // Helper to get the correct auth for an order's marketplace
  const getAuthForMarketplace = (marketplace: string | null): typeof auth => {
    if (!marketplace) return auth;
    // Try direct lookup
    const directAuth = authByMarketplace.get(marketplace);
    if (directAuth) return directAuth;
    // Convert code to ID
    const marketplaceId = MARKETPLACE_CODE_TO_ID[marketplace];
    if (marketplaceId) {
      const mappedAuth = authByMarketplace.get(marketplaceId);
      if (mappedAuth) return mappedAuth;
    }
    // Fallback to default
    return auth;
  };

  // Get LWA access token
  let accessToken: string;
  try {
    accessToken = await getLWAAccessToken(auth.refresh_token);
  } catch (err) {
    console.error('[REPAIR] Failed to get access token:', err);
    return { repaired: 0, failed: eligibleOrders.length, pending: 0, skipped: skippedCount, error: 'Auth token failed' };
  }

  // LOAD DYNAMIC FX RATES from database (no hardcoded rates!)
  const fxRates = await getFxRates(supabase);
  console.log(`[REPAIR] Loaded FX rates: MXN=${fxRates['MXN']}, CAD=${fxRates['CAD']}, BRL=${fxRates['BRL']}`);

  let repaired = 0;
  let failed = 0;
  const rateLimitDelay = 500; // 500ms between API calls

  for (const order of eligibleOrders) {
    // CRITICAL: Define qty at the TOP of the loop so all code paths can use it
    const qty = Number(order.quantity || 1) || 1;
    
    try {
      // Log enrichment start
      await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'started', 'repair_pending_prices');
      
      // Check if this is a non-US order that needs forced overwrite
      const isNonUsOrder = ['MX', 'CA', 'BR', 'A1AM78C64UM0Y8', 'A2EUQ1WTGCTBG2', 'A2Q3Y263D00KWC'].includes(order.marketplace || '');
      const ps = String(order.price_source || '');
      const hasBadPriceSource =
        ['listings_api', 'fx_recalc', 'estimated_price', 'manual_fix'].includes(ps) ||
        ps.startsWith('estimated:');
      
      // CRITICAL: Also consider sold_price=0 as needing repair (pending orders that got pricing_api source but no price yet)
      const hasZeroPrice = (order.sold_price || 0) === 0;

      // Force-overwrite mode: allow the caller (Sales button) to re-run repair on rows that
      // may have been previously set from US-derived sources, even if they aren't in the
      // default "bad" list. Also repair any order with sold_price=0.
      const forceOverwriteThisOrder =
        nonUsOnly &&
        isNonUsOrder &&
        (forceOverwriteNonUs || hasBadPriceSource || hasZeroPrice);
      
      if (forceOverwriteThisOrder) {
        console.log(`[REPAIR] 🔧 FORCE OVERWRITE: ${order.order_id} (${order.marketplace}) - price_source="${order.price_source}", sold_price=$${order.sold_price}${hasZeroPrice ? ' (ZERO PRICE)' : ''}`);
      }
      
      // NEW: For non-US orders with force overwrite, use Pricing API (like fetch-listing-prices tool)
      // This gets the actual marketplace listing price and converts it correctly to USD
      if (forceOverwriteThisOrder && order.asin && order.asin !== 'PENDING' && order.asin !== 'UNKNOWN') {
        const orderAuth = getAuthForMarketplace(order.marketplace);
        const marketplaceId = orderAuth?.marketplace_id || MARKETPLACE_CODE_TO_ID[order.marketplace] || 'ATVPDKIKX0DER';
        
        console.log(`[REPAIR] 🌎 NON-US PRICING API: ${order.order_id} ASIN=${order.asin} marketplace=${order.marketplace} (${marketplaceId})`);
        
        // Call the Pricing API to get the actual marketplace price
        const pricingResult = await getMarketplacePricingPrice(order.asin, marketplaceId, accessToken, fxRates);
        
        if (pricingResult.priceUsd !== null && pricingResult.priceUsd > 0) {
          const pricingApiPrice = pricingResult.priceUsd;
          const totalSaleAmount = pricingApiPrice * qty;
          
          console.log(`[REPAIR] ✅ PRICING API SUCCESS: ${order.order_id} - ${pricingResult.currency} ${pricingResult.localPrice} / ${pricingResult.fxRate} = USD $${pricingApiPrice.toFixed(2)}`);
          
          // CHATGPT STRATEGY: Check if order is PENDING or already shipped/settled
          // For PENDING orders: only set estimated_price, keep sold_price/item_price/shipping_price NULL
          // For SETTLED orders: write to sold_price/item_price for accurate ROI
          const orderStatus = String(order.order_status || '').toLowerCase();
          const isPendingOrder = orderStatus === 'pending' || orderStatus === '';
          
          // Get fees for this ASIN (use marketplace-specific fees)
          // CRITICAL: Pass the LOCAL price directly to Fees API (best accuracy per ChatGPT)
          let referralFee = 0;
          let fbaFee = 0;
          let closingFee = 0;
          let totalFees = 0;
          let feesSource = 'unavailable';
          let feesMissing = true;
          
          // Pass localPrice and currency directly - this is the most accurate way
          // since we already have the actual marketplace price from Pricing API
          console.log(`[REPAIR] 📊 Calling Fees API for ${order.asin} with local price: ${pricingResult.currency} ${pricingResult.localPrice} (USD ref: $${pricingApiPrice.toFixed(2)})`);
          const apiFees = await getProductFees(
            order.asin, 
            pricingApiPrice, 
            accessToken, 
            marketplaceId, 
            pricingApiPrice, 
            fxRates,
            pricingResult.localPrice || undefined, // Pass local price directly
            pricingResult.currency // Pass currency directly
          );
          if (apiFees) {
            referralFee = apiFees.referralFee * qty;
            fbaFee = apiFees.fbaFee * qty;
            closingFee = apiFees.closingFee * qty;
            totalFees = apiFees.totalFees * qty;
            feesSource = apiFees.feeSource;
            feesMissing = false;
            console.log(`[REPAIR] 💰 Fees for ${order.asin}: referral=$${referralFee.toFixed(2)}, fba=$${fbaFee.toFixed(2)}, total=$${totalFees.toFixed(2)}`);
          } else {
            console.warn(`[REPAIR] ⚠️ Fees API failed for ${order.asin} - will set needs_fee_enrich=true for retry`);
          }
          
          // CHATGPT STRATEGY FOR NON-US PENDING ORDERS:
          // - PENDING orders: store Pricing API in estimated_price ONLY
          //   sold_price, item_price, shipping_price remain NULL until Financial Events settles
          // - SETTLED/SHIPPED orders: write to sold_price/item_price (these are already settled)
          
          let updatePayload: Record<string, any>;
          
          if (isPendingOrder) {
            // PENDING ORDER: Store correct estimate and CLEAR any wrong sold_price
            // CRITICAL FIX: Explicitly set sold_price=0 to clear old incorrect values
            // (e.g., $13.4 US price stored for a CA order that should be $19.43 CAD)
            console.log(`[REPAIR] 📋 PENDING ORDER STRATEGY: ${order.order_id} - storing Pricing API as estimate, CLEARING sold_price to 0`);
            updatePayload = {
              // CRITICAL: Explicitly set sold_price/item_price/shipping_price to 0
              // This clears any incorrect old value. The UI should use estimated_price for pending orders.
              sold_price: 0,
              item_price: 0,
              shipping_price: 0,
              total_sale_amount: 0,
              
              // Store the Pricing API price as an ESTIMATE only
              estimated_price: Math.round(pricingApiPrice * 100) / 100,
              locked_est_price: Math.round(pricingApiPrice * 100) / 100,
              locked_from: 'pricing_api_estimate',
              
              // Fees: if we got them, store them; otherwise mark as needing retry
              referral_fee: feesMissing ? null : Math.round(referralFee * 100) / 100,
              fba_fee: feesMissing ? null : Math.round(fbaFee * 100) / 100,
              closing_fee: feesMissing ? null : Math.round(closingFee * 100) / 100,
              total_fees: feesMissing ? null : Math.round(totalFees * 100) / 100,
              fees_source: feesSource,
              fees_missing: feesMissing,
              
              // Mark price as NOT enriched - we only have an estimate
              price_enrich_status: 'estimated',
              price_source: `estimate_pricing_api_${order.marketplace?.toLowerCase() || 'non_us'}`,
              
              // Keep needs_price_enrich=true so settlement can fill actual sold_price
              needs_price_enrich: true,
              needs_fee_enrich: feesMissing, // If fees failed, retry later
              
              // Clear errors, update attempt tracking
              next_enrich_after: null,
              last_enrich_error: null,
              last_enrich_attempt_at: nowIso,
              enrich_attempts: (order.enrich_attempts || 0) + 1,
              price_attempt_count: (order.price_attempt_count || 0) + 1,
              price_last_attempt_at: nowIso,
              price_last_error: null,
            };
          } else {
            // SETTLED/SHIPPED ORDER: Write to sold_price (this is the actual transaction price)
            console.log(`[REPAIR] ✅ SETTLED ORDER STRATEGY: ${order.order_id} (status=${orderStatus}) - writing Pricing API to sold_price`);
            updatePayload = {
              sold_price: Math.round(pricingApiPrice * 100) / 100,
              item_price: Math.round(pricingApiPrice * 100) / 100, // ITEM price only (Pricing API = listing price)
              shipping_price: 0, // Shipping unknown until Financial Events - set to 0 for clean ROI
              total_sale_amount: Math.round(totalSaleAmount * 100) / 100,
              
              // Fees
              referral_fee: feesMissing ? null : Math.round(referralFee * 100) / 100,
              fba_fee: feesMissing ? null : Math.round(fbaFee * 100) / 100,
              closing_fee: feesMissing ? null : Math.round(closingFee * 100) / 100,
              total_fees: feesMissing ? null : Math.round(totalFees * 100) / 100,
              fees_source: feesSource,
              fees_missing: feesMissing,
              
              // Price metadata
              price_enrich_status: 'enriched',
              price_source: `pricing_api_${order.marketplace?.toLowerCase() || 'non_us'}`,
              estimated_price: pricingApiPrice,
              locked_est_price: pricingApiPrice,
              locked_from: 'pricing_api',
              
              // Clear flags
              needs_price_enrich: false,
              needs_fee_enrich: feesMissing,
              next_enrich_after: null,
              last_enrich_error: null,
              last_enrich_attempt_at: nowIso,
              enrich_attempts: (order.enrich_attempts || 0) + 1,
              price_attempt_count: (order.price_attempt_count || 0) + 1,
              price_last_attempt_at: nowIso,
              price_last_error: null,
            };
          }
          
          const { error: updateError } = await supabase
            .from('sales_orders')
            .update(updatePayload)
            .eq('id', order.id);
          
          if (updateError) {
            console.error(`[REPAIR] Update error for ${order.order_id}:`, updateError);
            await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'pricing_api', updateError.message);
            failed++;
          } else {
            await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'success', isPendingOrder ? 'pricing_api_estimate' : 'pricing_api');
            repaired++;
          }
          
          await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
          continue;
        } else {
          console.log(`[REPAIR] ⚠️ PRICING API returned no price for ${order.order_id} - will try Orders API fallback`);
          // Fall through to Orders API below
        }
      }
      
      // NEW: FEES-ONLY PATH for non-US orders that already have a GOOD price but PENDING fees
      // This handles rows where price_source starts with 'pricing_api_' but fees are still unavailable
      let priceSource = String(order.price_source || '');
      const hasGoodPricingApiSource = priceSource.startsWith('pricing_api_');
      const hasGoodPrice = (order.sold_price || 0) > 0;
      const hasPendingFees = 
        order.needs_fee_enrich === true || 
        order.fees_source === 'unavailable' || 
        order.fees_source === 'pending' || 
        order.total_fees === null || 
        order.total_fees === 0;
      
      if (isNonUsOrder && hasGoodPricingApiSource && hasGoodPrice && hasPendingFees) {
        console.log(`[REPAIR] 🎯 FEES-ONLY PATH: ${order.order_id} has good price ($${order.sold_price}) from ${priceSource}, but fees pending`);
        
        const orderAuth = getAuthForMarketplace(order.marketplace);
        const marketplaceId = orderAuth?.marketplace_id || MARKETPLACE_CODE_TO_ID[order.marketplace] || 'ATVPDKIKX0DER';
        const soldPrice = order.sold_price;
        
        // First, try to get the local price from Pricing API so we can pass it to Fees API
        const pricingResult = await getMarketplacePricingPrice(order.asin, marketplaceId, accessToken, fxRates);
        
        let localPrice: number | undefined = undefined;
        let localCurrency: string | undefined = undefined;
        
        if (pricingResult.localPrice && pricingResult.localPrice > 0) {
          localPrice = pricingResult.localPrice;
          localCurrency = pricingResult.currency;
          console.log(`[REPAIR] 📊 Got local price for fees: ${localCurrency} ${localPrice}`);
        } else {
          // Fallback: convert USD to local for Fees API
          console.log(`[REPAIR] 📊 No local price from Pricing API, will convert USD $${soldPrice} to local for Fees API`);
        }
        
        // Call Fees API with local price (best accuracy)
        console.log(`[REPAIR] 📊 Calling Fees API for ${order.asin} (fees-only path)`);
        const apiFees = await getProductFees(
          order.asin, 
          soldPrice, 
          accessToken, 
          marketplaceId, 
          soldPrice, 
          fxRates,
          localPrice,
          localCurrency
        );
        
        if (apiFees) {
          const referralFee = apiFees.referralFee * qty;
          const fbaFee = apiFees.fbaFee * qty;
          const closingFee = apiFees.closingFee * qty;
          const totalFees = apiFees.totalFees * qty;
          
          console.log(`[REPAIR] ✅ FEES-ONLY SUCCESS for ${order.order_id}: referral=$${referralFee.toFixed(2)}, fba=$${fbaFee.toFixed(2)}, total=$${totalFees.toFixed(2)}`);
          
          // Update ONLY fees columns - preserve existing price data
          const { error: updateError } = await supabase
            .from('sales_orders')
            .update({
              referral_fee: Math.round(referralFee * 100) / 100,
              fba_fee: Math.round(fbaFee * 100) / 100,
              closing_fee: Math.round(closingFee * 100) / 100,
              total_fees: Math.round(totalFees * 100) / 100,
              fees_source: apiFees.feeSource,
              fees_missing: false,
              needs_fee_enrich: false,
              last_enrich_attempt_at: nowIso,
              last_enrich_error: null,
              enrich_attempts: (order.enrich_attempts || 0) + 1,
            })
            .eq('id', order.id);
          
          if (updateError) {
            console.error(`[REPAIR] Update error for ${order.order_id}:`, updateError);
            await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'fees_only', updateError.message);
            failed++;
          } else {
            await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'success', 'fees_only');
            repaired++;
          }
        } else {
          console.warn(`[REPAIR] ⚠️ Fees API failed for ${order.order_id} (fees-only) - setting backoff`);
          
          const attemptCount = (order.enrich_attempts || 0) + 1;
          const backoffMinutes = getBackoffMinutes(attemptCount);
          const nextRetry = new Date(now.getTime() + backoffMinutes * 60 * 1000);
          
          await supabase
            .from('sales_orders')
            .update({
              needs_fee_enrich: true,
              fees_source: 'unavailable',
              fees_missing: true,
              last_enrich_attempt_at: nowIso,
              last_enrich_error: 'Fees API failed (fees-only path)',
              enrich_attempts: attemptCount,
              next_enrich_after: nextRetry.toISOString(),
            })
            .eq('id', order.id);
          
          await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'fees_only', 'Fees API failed');
          failed++;
        }
        
        await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
        continue;
      }
      
      // NON-DESTRUCTIVE MODE: Only fill 0/null fields, never overwrite non-zero values
      // BUT: For non-US orders with bad sources, ALWAYS overwrite (forceOverwriteThisOrder)
      if (repairMissingOnly && !forceListingPrice && !forceOverwriteThisOrder) {
        // Treat obviously-corrupt US prices as NOT valid so we can fix them.
        // Example: MXN 476 mistakenly stored as USD for a US order.
        const isUsMarketplace = (order.marketplace || 'US') === 'US';
        const priceSourceStr = String(order.price_source || '');
        const isLikelyCorruptUsPrice =
          isUsMarketplace &&
          (order.sold_price || 0) >= 200 &&
          // Corruption has historically come from these estimate/refresh paths
          ['inventory_refresh', 'estimated_price', 'locked_estimate', 'manual_fix'].includes(priceSourceStr);

        const hasValidPrice = order.sold_price > 0 && !isLikelyCorruptUsPrice;
        const hasValidFees = order.total_fees > 0;
        const hasLockedPrice = order.locked_est_price > 0;
        
        if (hasValidPrice && hasValidFees) {
          console.log(`[REPAIR] Skipping ${order.order_id} - already has price ($${order.sold_price}) and fees ($${order.total_fees})`);
          
          // Clear flags since it's already enriched
          await supabase
            .from('sales_orders')
            .update({
              needs_price_enrich: false,
              needs_fee_enrich: false,
              next_enrich_after: null,
              last_enrich_error: null,
              price_enrich_status: 'enriched',
            })
            .eq('id', order.id);
          
          await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'success', 'already_enriched');
          continue;
        }

        if (isLikelyCorruptUsPrice) {
          console.log(
            `[REPAIR] ⚠️ Detected corrupt US price for ${order.order_id}: sold_price=$${Number(order.sold_price || 0).toFixed(2)} source=${priceSourceStr} (will overwrite with inventory USD)`
          );
        }
      }

      // Special mode: force-refresh Pending order price from Listings API (your repricer's current price)
      // IMPORTANT: Block Listings refresh if inventory shows OOS (your repricer raises price when OOS)
      if (forceListingPrice) {
        // CRITICAL: Use marketplace-specific auth for this order
        const orderAuth = getAuthForMarketplace(order.marketplace);
        const sellerId = orderAuth.selling_partner_id || orderAuth.seller_id;
        const marketplaceId = orderAuth.marketplace_id || 'ATVPDKIKX0DER';
        console.log(`[REPAIR] Using ${order.marketplace || 'US'} auth: sellerId=${sellerId}, marketplaceId=${marketplaceId}`);
        // Check if item is OOS in inventory - if so, block Listings refresh
        let inventoryQty = 0;
        let invItem: any = null;
        if (order.asin && order.asin !== 'PENDING') {
          const { data: invByAsin } = await supabase
            .from('inventory')
            .select('sku, price, my_price, amazon_price, available')
            .eq('user_id', userId)
            .eq('asin', order.asin)
            .maybeSingle();

          invItem = invByAsin;
          inventoryQty = invByAsin?.available ?? 0;
        }

        // If OOS, block Listings API refresh - the repricer price is wrong
        if (inventoryQty === 0) {
          console.log(`[REPAIR] ⛔ BLOCKED: ${order.order_id} is OOS (qty=0) - Listings price would be wrong (repricer raised it)`);
          
          // If order already has a locked estimate, keep it
          if (order.locked_est_price > 0) {
            console.log(`[REPAIR] Using locked_est_price=$${order.locked_est_price} for OOS order ${order.order_id}`);
            await supabase
              .from('sales_orders')
              .update({
                price_attempt_count: (order.price_attempt_count || 0) + 1,
                price_last_attempt_at: nowIso,
                price_last_error: 'Blocked: OOS - using locked estimate',
                needs_price_enrich: false,
                needs_fee_enrich: order.total_fees <= 0,
                last_enrich_attempt_at: nowIso,
              })
              .eq('id', order.id);
            
            await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'success', 'locked_estimate_oos');
            continue;
          }
          
          // No locked price and OOS - mark as failed with backoff
          const attemptCount = (order.enrich_attempts || order.price_attempt_count || 0) + 1;
          const backoffMinutes = getBackoffMinutes(attemptCount);
          const nextRetry = new Date(now.getTime() + backoffMinutes * 60 * 1000);
          
          await supabase
            .from('sales_orders')
            .update({
              price_attempt_count: attemptCount,
              price_last_attempt_at: nowIso,
              price_last_error: 'Blocked: OOS - no locked estimate available',
              enrich_attempts: attemptCount,
              last_enrich_attempt_at: nowIso,
              last_enrich_error: 'OOS - no locked estimate',
              next_enrich_after: nextRetry.toISOString(),
            })
            .eq('id', order.id);
          
          await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'oos_no_estimate');
          failed++;
          continue;
        }

        let unitPriceUsd = 0;
        // Track marketplace in price source (e.g., listings_api_mx)
        const marketplaceSuffix = order.marketplace && order.marketplace !== 'US' ? `_${order.marketplace.toLowerCase()}` : '';
        priceSource = `listings_api${marketplaceSuffix}`;
        let skuToUse: string | null = order.sku ?? null;

        if (!skuToUse && invItem) {
          skuToUse = invItem?.sku ?? null;
          console.log(`[REPAIR] SKU lookup for ${order.asin}: found SKU=${skuToUse || 'none'}`);
        }

        if (skuToUse) {
          console.log(`[REPAIR] Calling Listings API for SKU ${skuToUse} (order ${order.order_id})`);
          const livePrice = await getLiveListingPrice(skuToUse, sellerId, marketplaceId, accessToken);
          console.log(`[REPAIR] Listings API response: price=${livePrice.price}, currency=${livePrice.currency}`);
          if (livePrice.price && livePrice.price > 0) {
            // Use dynamic FX rates (not hardcoded!)
            unitPriceUsd = convertToUsd(livePrice.price, livePrice.currency, fxRates);
            console.log(`[REPAIR] Converted price: $${unitPriceUsd.toFixed(2)} USD (currency=${livePrice.currency})`);
          }
        } else {
          console.log(`[REPAIR] No SKU available for ${order.order_id} (ASIN=${order.asin}), skipping Listings API`);
        }

        // --- Fallback: inventory table (if Listings API doesn't return a price) ---
        // CRITICAL FIX: For non-US orders, do NOT use inventory fallback (it has US price)
        if (unitPriceUsd <= 0) {
          const orderMarketplace = order.marketplace || 'US';
          
          if (orderMarketplace !== 'US') {
            console.log(`[REPAIR] ⛔ BLOCKED: ${order.order_id} is ${orderMarketplace} marketplace - cannot use US inventory price as fallback`);
            // Non-US order with no Listings API price - skip inventory fallback
          } else {
            // US marketplace - safe to use inventory fallback
            console.log(`[REPAIR] Listings API returned no price, falling back to inventory for ${order.order_id}`);
            const invPrice = invItem?.price || invItem?.my_price || invItem?.amazon_price || 0;
            if (invPrice > 0) {
              unitPriceUsd = invPrice;
              priceSource = 'inventory';
              console.log(`[REPAIR] Using inventory price: $${invPrice.toFixed(2)} (US marketplace)`);
            }
          }
        }

        // Also update estimated_price to the new correct value (clears stale Buy Box cache)
        const estimatedPriceUpdate = unitPriceUsd > 0 ? unitPriceUsd : null;

        if (unitPriceUsd <= 0) {
          console.warn(`[REPAIR] Force listing price: no price for order ${order.order_id}`);
          
          const attemptCount = (order.enrich_attempts || order.price_attempt_count || 0) + 1;
          const backoffMinutes = getBackoffMinutes(attemptCount);
          const nextRetry = new Date(now.getTime() + backoffMinutes * 60 * 1000);
          
          await supabase
            .from('sales_orders')
            .update({
              price_attempt_count: attemptCount,
              price_last_attempt_at: nowIso,
              price_last_error: 'Force listing price: no listings/inventory price',
              enrich_attempts: attemptCount,
              last_enrich_attempt_at: nowIso,
              last_enrich_error: 'No price available',
              next_enrich_after: nextRetry.toISOString(),
            })
            .eq('id', order.id);
          
          await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'no_price', 'No listings/inventory price');
          failed++;
          continue;
        }

        const totalSaleAmount = unitPriceUsd * qty;
        const soldPrice = unitPriceUsd;

        // STRICT: Initialize fees to 0 - only use actual API fees if available
        let referralFee = 0;
        let fbaFee = 0;
        let closingFee = 0;
        let totalFees = 0;
        let feeError: string | null = null;
        let feesSource: string = 'unavailable';

        if (order.asin && order.asin !== 'UNKNOWN' && order.asin !== 'PENDING') {
          const { data: buyBoxCache } = await supabase
            .from('buy_box_cache')
            .select('price')
            .eq('asin', order.asin)
            .maybeSingle();
          
          const referencePrice = buyBoxCache?.price || invItem?.amazon_price || soldPrice;
          
          // getProductFees returns PER-UNIT fees - must multiply by qty for line totals
          // Use the order's marketplace for fees (MX fees are different from US)
          const apiFees = await getProductFees(order.asin, referencePrice, accessToken, marketplaceId, soldPrice, fxRates);
          if (apiFees) {
            // CRITICAL: API returns per-unit fees, multiply by qty for line totals
            referralFee = apiFees.referralFee * qty;
            fbaFee = apiFees.fbaFee * qty; // Fixed per-unit, but line total = perUnit * qty
            closingFee = apiFees.closingFee * qty;
            totalFees = apiFees.totalFees * qty;
            feesSource = apiFees.feeSource;
            console.log(`[REPAIR] 💰 Using fees for ${order.asin}: referral=$${referralFee.toFixed(2)} (×${qty}), fba=$${fbaFee.toFixed(2)} (×${qty}), total=$${totalFees.toFixed(2)}`);
          } else {
            feeError = 'Fees API unavailable';
            feesSource = 'unavailable';
          }
        }

        console.log(`[REPAIR] ✓ Force listing price ${order.order_id}: $${soldPrice.toFixed(2)} x${qty} (source: ${priceSource})`);

        // SUCCESS: Clear BOTH flags
        const { error: updateError } = await supabase
          .from('sales_orders')
          .update({
            sold_price: Math.round(soldPrice * 100) / 100,
            total_sale_amount: Math.round(totalSaleAmount * 100) / 100,
            referral_fee: Math.round(referralFee * 100) / 100,
            fba_fee: Math.round(fbaFee * 100) / 100,
            closing_fee: Math.round(closingFee * 100) / 100,
            total_fees: Math.round(totalFees * 100) / 100,
            price_enrich_status: 'enriched',
            price_source: priceSource,
            estimated_price: estimatedPriceUpdate,
            fees_source: feesSource,
            price_attempt_count: (order.price_attempt_count || 0) + 1,
            price_last_attempt_at: nowIso,
            price_last_error: feeError,
            // NEW: Clear both flags on success
            needs_price_enrich: false,
            needs_fee_enrich: false,
            next_enrich_after: null,
            last_enrich_error: feeError,
            last_enrich_attempt_at: nowIso,
            enrich_attempts: (order.enrich_attempts || 0) + 1,
          })
          .eq('id', order.id);

        if (updateError) {
          console.error(`[REPAIR] Update error for ${order.order_id}:`, updateError);
          await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', priceSource, updateError.message);
          failed++;
        } else {
          await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'success', priceSource);
          repaired++;
        }

        await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
        continue;
      }

      // FIRST: Check if estimated_price already exists - no API call needed!
      // BUT: For non-US orders, estimated_price is often the WRONG US price, so skip this and go to Orders API
      // ALSO: Check if current inventory.price differs from estimated_price - use the fresher value
      const isNonUsMarketplace = ['MX', 'CA', 'BR', 'A1AM78C64UM0Y8', 'A2EUQ1WTGCTBG2', 'A2Q3Y263D00KWC'].includes(order.marketplace || '');
      
      // Fetch current inventory price to compare against stale estimated_price
      let currentInventoryPrice = 0;
      if (order.asin && order.asin !== 'UNKNOWN' && order.asin !== 'PENDING') {
        const { data: invCheck } = await supabase
          .from('inventory')
          .select('price, my_price, amazon_price')
          .eq('user_id', userId)
          .eq('asin', order.asin)
          .maybeSingle();
        if (invCheck) {
          // IMPORTANT: For US orders, NEVER allow an obviously foreign (MXN/CAD/BRL) value
          // to be treated as USD. Prefer the most plausible USD candidate.
          const invPrice = Number(invCheck.price || 0);
          const invMyPrice = Number(invCheck.my_price || 0);
          const invAmazonPrice = Number(invCheck.amazon_price || 0);

          const isUsOrder = (order.marketplace || 'US') === 'US';

          // Base priority (same as before)
          let chosen = invPrice || invMyPrice || invAmazonPrice || 0;

          if (isUsOrder) {
            // If `price` looks wildly too large but `my_price` looks reasonable, prefer `my_price`.
            // This protects against legacy corruption where MXN/CAD values were stored into inventory.price.
            if (
              invPrice > 0 &&
              invMyPrice > 0 &&
              invMyPrice < 200 &&
              (invPrice > 200 || invPrice / invMyPrice >= 2.5)
            ) {
              chosen = invMyPrice;
            }

            // If chosen is still huge but amazon_price looks reasonable, prefer amazon_price.
            if (
              chosen > 0 &&
              invAmazonPrice > 0 &&
              invAmazonPrice < 200 &&
              (chosen > 200 || chosen / invAmazonPrice >= 2.5)
            ) {
              chosen = invAmazonPrice;
            }
          }

          currentInventoryPrice = chosen;
        }
      }
      
      // CRITICAL FIX: If inventory price differs from estimated_price by >5%, use inventory price
      // This handles cases where the order was captured with stale pricing
      const estimatedPrice = order.estimated_price || 0;
      const priceDiffPct = estimatedPrice > 0 && currentInventoryPrice > 0 
        ? Math.abs(currentInventoryPrice - estimatedPrice) / estimatedPrice 
        : 0;

      // Additional guard for US orders: if the estimate is clearly insane vs inventory, force inventory.
      // Example bug: MXN 476 saved as if USD for a US order.
      const isUsOrder = (order.marketplace || 'US') === 'US';
      const looksLikeForeignOrCorruptUsd =
        isUsOrder &&
        currentInventoryPrice > 0 &&
        estimatedPrice > 0 &&
        ((estimatedPrice > 200 && currentInventoryPrice < 200) || estimatedPrice / currentInventoryPrice >= 2.5);

      const shouldUseInventoryPrice =
        currentInventoryPrice > 0 &&
        (estimatedPrice === 0 || priceDiffPct > 0.05 || looksLikeForeignOrCorruptUsd);
      
      if (shouldUseInventoryPrice && !isNonUsMarketplace) {
        console.log(`[REPAIR] 🔄 Price update: estimated=$${estimatedPrice.toFixed(2)} → inventory=$${currentInventoryPrice.toFixed(2)} (${(priceDiffPct * 100).toFixed(1)}% diff)`);
      }
      
      if ((order.estimated_price && order.estimated_price > 0 || shouldUseInventoryPrice) && !isNonUsMarketplace) {
        // Use current inventory price if it differs significantly from stale estimated_price
        const unitPrice = shouldUseInventoryPrice ? currentInventoryPrice : order.estimated_price;
        const priceSourceSuffix = shouldUseInventoryPrice ? 'inventory_refresh' : 'estimated_price';
        const lineTotal = unitPrice * qty; // LINE TOTAL = unit price × quantity
        
        // STRICT: Initialize fees to 0 - only use actual API fees if available
        let unitReferralFee = 0;
        let unitFbaFee = 0;
        let unitClosingFee = 0;
        let unitTotalFees = 0;
        let feeError: string | null = null;
        let feesSource: string = 'unavailable';

        if (order.asin && order.asin !== 'UNKNOWN' && order.asin !== 'PENDING') {
          const { data: buyBoxCache } = await supabase
            .from('buy_box_cache')
            .select('price')
            .eq('asin', order.asin)
            .maybeSingle();
          
          const invAmazonPrice = currentInventoryPrice; // Already fetched above
          
          const referencePrice = buyBoxCache?.price || invAmazonPrice || unitPrice;
          
          // getProductFees returns PER-UNIT fees
          const apiFees = await getProductFees(order.asin, referencePrice, accessToken, 'ATVPDKIKX0DER', unitPrice);
          if (apiFees) {
            unitReferralFee = apiFees.referralFee;
            unitFbaFee = apiFees.fbaFee;
            unitClosingFee = apiFees.closingFee;
            unitTotalFees = apiFees.totalFees;
            feesSource = apiFees.feeSource;
            console.log(`[REPAIR] 💰 Using fees for ${order.asin} (estimated_price path): referral=$${unitReferralFee.toFixed(2)}/unit × ${qty}, fba=$${unitFbaFee.toFixed(2)}/unit × ${qty}`);
          } else {
            feeError = 'Fees API unavailable';
            feesSource = 'unavailable';
          }
        }
        
        // CRITICAL: Calculate LINE TOTALS for storage (unit × qty)
        const lineReferralFee = unitReferralFee * qty;
        const lineFbaFee = unitFbaFee * qty;
        const lineClosingFee = unitClosingFee * qty;
        const lineTotalFees = unitTotalFees * qty;
        
        console.log(`[REPAIR] ✓ Order ${order.order_id}: $${unitPrice.toFixed(2)}/unit × ${qty} = $${lineTotal.toFixed(2)} (source: ${priceSourceSuffix})`);
        
        // SUCCESS: Clear BOTH flags
        // CRITICAL: Store unit price in sold_price, LINE TOTALS in total_sale_amount and fees
        // ALSO: Update estimated_price with the fresh value if we used inventory_refresh
        const { error: updateError } = await supabase
          .from('sales_orders')
          .update({
            sold_price: Math.round(unitPrice * 100) / 100, // UNIT price
            total_sale_amount: Math.round(lineTotal * 100) / 100, // LINE total = unit × qty
            referral_fee: Math.round(lineReferralFee * 100) / 100, // LINE total
            fba_fee: Math.round(lineFbaFee * 100) / 100, // LINE total
            closing_fee: Math.round(lineClosingFee * 100) / 100, // LINE total
            total_fees: Math.round(lineTotalFees * 100) / 100, // LINE total
            price_enrich_status: 'enriched',
            price_source: priceSourceSuffix, // 'estimated_price' or 'inventory_refresh'
            // Update estimated_price to the fresh value if we refreshed from inventory
            estimated_price: shouldUseInventoryPrice ? unitPrice : order.estimated_price,
            fees_source: feesSource,
            price_attempt_count: (order.price_attempt_count || 0) + 1,
            price_last_attempt_at: nowIso,
            price_last_error: feeError,
            // NEW: Clear both flags on success
            needs_price_enrich: false,
            needs_fee_enrich: false,
            next_enrich_after: null,
            last_enrich_error: feeError,
            last_enrich_attempt_at: nowIso,
            enrich_attempts: (order.enrich_attempts || 0) + 1,
          })
          .eq('id', order.id);
        
        if (updateError) {
          console.error(`[REPAIR] Update error for ${order.order_id}:`, updateError);
          await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', priceSourceSuffix, updateError.message);
          failed++;
        } else {
          await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'success', priceSourceSuffix);
          repaired++;
        }
        continue;
      }
      
      // If no estimated_price, call GetOrderItems API
      const orderItemsUrl = `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${order.order_id}/orderItems`;
      const headers = await signRequest('GET', orderItemsUrl, '', accessToken);
      
      const response = await fetch(orderItemsUrl, { method: 'GET', headers });
      
      if (response.status === 429) {
        console.warn(`[REPAIR] Rate limited on order ${order.order_id}`);
        
        // Set exponential backoff
        const attemptCount = (order.enrich_attempts || order.price_attempt_count || 0) + 1;
        const backoffMinutes = getBackoffMinutes(attemptCount);
        const nextRetry = new Date(now.getTime() + backoffMinutes * 60 * 1000);
        
        await supabase
          .from('sales_orders')
          .update({
            price_attempt_count: attemptCount,
            price_last_attempt_at: nowIso,
            price_last_error: 'Rate limited (429)',
            enrich_attempts: attemptCount,
            last_enrich_attempt_at: nowIso,
            last_enrich_error: 'Rate limited (429)',
            next_enrich_after: nextRetry.toISOString(),
          })
          .eq('id', order.id);
        
        await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'orders_api', 'Rate limited (429)');
        failed++;
        break; // Stop processing on rate limit
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[REPAIR] API error for ${order.order_id}:`, response.status, errorText);
        
        const attemptCount = (order.enrich_attempts || order.price_attempt_count || 0) + 1;
        const backoffMinutes = getBackoffMinutes(attemptCount);
        const nextRetry = new Date(now.getTime() + backoffMinutes * 60 * 1000);
        
        await supabase
          .from('sales_orders')
          .update({
            price_attempt_count: attemptCount,
            price_last_attempt_at: nowIso,
            price_last_error: `API error: ${response.status}`,
            enrich_attempts: attemptCount,
            last_enrich_attempt_at: nowIso,
            last_enrich_error: `API error: ${response.status}`,
            next_enrich_after: nextRetry.toISOString(),
          })
          .eq('id', order.id);
        
        await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'orders_api', `API error: ${response.status}`);
        failed++;
        continue;
      }

      const data = await response.json();
      const items = data?.payload?.OrderItems || [];
      
      if (items.length === 0) {
        console.warn(`[REPAIR] No items found for order ${order.order_id}`);
        
        const attemptCount = (order.enrich_attempts || order.price_attempt_count || 0) + 1;
        const backoffMinutes = getBackoffMinutes(attemptCount);
        const nextRetry = new Date(now.getTime() + backoffMinutes * 60 * 1000);
        
        await supabase
          .from('sales_orders')
          .update({
            price_attempt_count: attemptCount,
            price_last_attempt_at: nowIso,
            price_last_error: 'No order items returned',
            enrich_attempts: attemptCount,
            last_enrich_attempt_at: nowIso,
            last_enrich_error: 'No order items returned',
            next_enrich_after: nextRetry.toISOString(),
          })
          .eq('id', order.id);
        
        await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'orders_api', 'No order items returned');
        failed++;
        continue;
      }

      // Find matching item by ASIN
      const item = items.find((i: any) => i.ASIN === order.asin) || items[0];
      
      // Extract ALL price components for robust calculation (per ChatGPT recommendation)
      const itemCurrency = item.ItemPrice?.CurrencyCode || item.ShippingPrice?.CurrencyCode || 'USD';
      
      const itemPriceRaw = parseFloat(item.ItemPrice?.Amount || '0') || 0;
      const itemTaxRaw = parseFloat(item.ItemTax?.Amount || '0') || 0;
      const shippingPriceRaw = parseFloat(item.ShippingPrice?.Amount || '0') || 0;
      const shippingTaxRaw = parseFloat(item.ShippingTax?.Amount || '0') || 0;
      const promotionDiscountRaw = parseFloat(item.PromotionDiscount?.Amount || '0') || 0;
      const shippingDiscountRaw = parseFloat(item.ShippingDiscount?.Amount || '0') || 0;
      
      // Full calculation: ItemPrice + ItemTax + ShippingPrice + ShippingTax - PromotionDiscount - ShippingDiscount
      let rawTotal = itemPriceRaw + itemTaxRaw + shippingPriceRaw + shippingTaxRaw - promotionDiscountRaw - shippingDiscountRaw;
      
      // Log detailed breakdown for debugging
      console.log(`[REPAIR] 📦 Orders API response for ${order.order_id}:`, {
        marketplace: order.marketplace,
        currency: itemCurrency,
        itemPrice: itemPriceRaw,
        itemTax: itemTaxRaw,
        shippingPrice: shippingPriceRaw,
        shippingTax: shippingTaxRaw,
        promotionDiscount: promotionDiscountRaw,
        shippingDiscount: shippingDiscountRaw,
        rawTotal: rawTotal,
        fxRate: fxRates[itemCurrency] || 1,
      });
      
      priceSource = 'orders_api';
      let lockedFrom: string | null = 'orders_api';
      
      // If Amazon API returns no price (common for Pending orders), we have fallbacks
      if (rawTotal <= 0) {
        // Check if we have a locked estimate - use that instead of Listings API
        if (order.locked_est_price > 0) {
          console.log(`[REPAIR] Order ${order.order_id} has locked_est_price=$${order.locked_est_price}, using that`);
          rawTotal = order.locked_est_price;
          priceSource = 'locked_estimate';
          lockedFrom = order.locked_from || 'previous';
        } else {
          console.log(`[REPAIR] No API price for ${order.order_id}, checking inventory...`);
          
          // CRITICAL FIX: For non-US orders, do NOT use inventory fallback (it has US price)
          // Only use inventory fallback for US marketplace orders
          const orderMarketplace = order.marketplace || 'US';
          if (orderMarketplace !== 'US') {
            // For non-US orders, inventory fallback is dangerous (it can be a US price).
            // However, when we're in nonUsOnly + forceOverwrite mode, we *must* recover from
            // the historic bad fx_recalc ($0.79) even if Orders API returns 0.
            const estUnit = Number(order.estimated_price || 0);
            const currentSold = Number(order.sold_price || 0);
            if (forceOverwriteThisOrder && estUnit > 0 && currentSold > 0 && currentSold < 5) {
              rawTotal = estUnit * qty;
              priceSource = 'estimated_price';
              lockedFrom = 'estimated_price_fallback_non_us';
              console.log(
                `[REPAIR] ✅ NON-US FALLBACK: ${order.order_id} (${orderMarketplace}) Orders API returned 0; reverting bad fx_recalc sold=$${currentSold.toFixed(2)} -> estimated_price=$${estUnit.toFixed(2)}`
              );
            } else {
              console.log(`[REPAIR] ⛔ BLOCKED: ${order.order_id} is ${orderMarketplace} marketplace - inventory fallback would use US price (wrong!)`);
            
            const attemptCount = (order.enrich_attempts || order.price_attempt_count || 0) + 1;
            const backoffMinutes = getBackoffMinutes(attemptCount);
            const nextRetry = new Date(now.getTime() + backoffMinutes * 60 * 1000);
            
            await supabase
              .from('sales_orders')
              .update({
                price_attempt_count: attemptCount,
                price_last_attempt_at: nowIso,
                price_last_error: `No API price for ${orderMarketplace} order - cannot use US inventory`,
                enrich_attempts: attemptCount,
                last_enrich_attempt_at: nowIso,
                last_enrich_error: `No API price for ${orderMarketplace} - inventory is US`,
                next_enrich_after: nextRetry.toISOString(),
              })
              .eq('id', order.id);
            
            await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'orders_api', `Non-US order without API price - blocked inventory fallback`);
            failed++;
            continue;
            }
          }
          
          // US marketplace - safe to use inventory fallback
          // Go directly to inventory fallback
          let invItem = null;
          
          if (order.asin && order.asin !== 'PENDING') {
            const { data: byAsin } = await supabase
              .from('inventory')
              .select('price, my_price, amazon_price, available')
              .eq('user_id', userId)
              .eq('asin', order.asin)
              .maybeSingle();
            invItem = byAsin;
          }
          
          if (!invItem && order.sku) {
            const { data: bySku } = await supabase
              .from('inventory')
              .select('price, my_price, amazon_price, available')
              .eq('user_id', userId)
              .eq('sku', order.sku)
              .maybeSingle();
            invItem = bySku;
          }
          
          const invPrice = invItem?.price || invItem?.my_price || invItem?.amazon_price || 0;
          
          if (invPrice > 0) {
            rawTotal = invPrice;
            priceSource = 'inventory';
            lockedFrom = 'inventory_fallback';
            console.log(`[REPAIR] Using inventory price for ${order.order_id}: $${invPrice} (fallback, US marketplace)`);
          } else {
            console.warn(`[REPAIR] No price data for order ${order.order_id} (API or inventory)`);
            
            const attemptCount = (order.enrich_attempts || order.price_attempt_count || 0) + 1;
            const backoffMinutes = getBackoffMinutes(attemptCount);
            const nextRetry = new Date(now.getTime() + backoffMinutes * 60 * 1000);
            
            await supabase
              .from('sales_orders')
              .update({
                price_attempt_count: attemptCount,
                price_last_attempt_at: nowIso,
                price_last_error: 'No price in API or inventory',
                enrich_attempts: attemptCount,
                last_enrich_attempt_at: nowIso,
                last_enrich_error: 'No price in API or inventory',
                next_enrich_after: nextRetry.toISOString(),
              })
              .eq('id', order.id);
            
            await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'orders_api', 'No price in API or inventory');
            failed++;
            continue;
          }
        }
      }

      // Convert to USD using dynamic FX rates (not hardcoded!)
      // CRITICAL: Separate item_price from shipping_price for accurate ROI calculation
      const fxRate = fxRates[itemCurrency] || 1;
      const itemPriceUSD = (priceSource === 'orders_api' && itemCurrency !== 'USD') 
        ? convertToUsd(itemPriceRaw, itemCurrency, fxRates) 
        : itemPriceRaw;
      const shippingPriceUSD = (priceSource === 'orders_api' && itemCurrency !== 'USD') 
        ? convertToUsd(shippingPriceRaw, itemCurrency, fxRates) 
        : shippingPriceRaw;
      const totalSaleAmount = itemPriceUSD + shippingPriceUSD;
      const quantity = parseInt(item.QuantityOrdered || '1', 10) || 1;
      
      // sold_price = item_price per unit (for ROI calculation - excludes shipping)
      const soldPrice = itemPriceUSD / quantity;
      // Separate shipping_price per unit (tracked separately for transparency)
      const shippingPricePerUnit = shippingPriceUSD / quantity;
      
      // Log the final FX conversion result with proper breakdown
      console.log(`[REPAIR] 💰 FX CONVERSION for ${order.order_id}: ${itemCurrency} item=${itemPriceRaw} shipping=${shippingPriceRaw} / ${fxRate} = USD item=$${itemPriceUSD.toFixed(2)} shipping=$${shippingPriceUSD.toFixed(2)} (unit: $${soldPrice.toFixed(2)} + $${shippingPricePerUnit.toFixed(2)} × ${quantity})`);
      
      // LOCK THE PRICE: Store the first valid price and never overwrite with Listings API
      const lockedEstPrice = soldPrice;
      const priceLockedAt = nowIso;
      
      // STRICT: Initialize fees to 0 - only use actual API fees if available
      let referralFee = 0;
      let fbaFee = 0;
      let closingFee = 0;
      let totalFees = 0;
      let feeError: string | null = null;
      let feesSource: string = 'unavailable';

      const orderAsin = order.asin || item?.ASIN;
      if (orderAsin && orderAsin !== 'UNKNOWN' && orderAsin !== 'PENDING') {
        // MARKETPLACE-AWARE FEES: Use correct marketplace ID for non-US orders
        const orderMarketplace = order.marketplace || 'US';
        const orderMarketplaceId = MARKETPLACE_CODE_TO_ID[orderMarketplace] || 
          (orderMarketplace.startsWith('A') ? orderMarketplace : 'ATVPDKIKX0DER');
        
        // CRITICAL FIX: For non-US orders, use soldPrice as reference (it's already USD from the actual marketplace)
        // Buy Box/inventory prices are US-centric and would result in wrong fee calculations
        const isNonUsOrder = ['MX', 'CA', 'BR'].includes(orderMarketplace);
        
        let referencePrice = soldPrice; // Default for non-US
        
        if (!isNonUsOrder) {
          // For US orders, try to get a Buy Box reference price for better fee accuracy
          const { data: buyBoxCache } = await supabase
            .from('buy_box_cache')
            .select('price')
            .eq('asin', orderAsin)
            .maybeSingle();
          
          let invAmazonPrice = 0;
          const { data: invData } = await supabase
            .from('inventory')
            .select('amazon_price')
            .eq('user_id', userId)
            .eq('asin', orderAsin)
            .maybeSingle();
          if (invData?.amazon_price) invAmazonPrice = invData.amazon_price;
          
          referencePrice = buyBoxCache?.price || invAmazonPrice || soldPrice;
        }
        
        console.log(`[REPAIR] 📍 Fetching fees for ${orderAsin} in marketplace ${orderMarketplace} (${orderMarketplaceId}) ref=$${referencePrice.toFixed(2)}${isNonUsOrder ? ' (using soldPrice for non-US)' : ''}`);
        
        // getProductFees returns PER-UNIT fees - must multiply by qty for line totals
        // Pass fxRates for non-US marketplaces to convert fees to USD
        const apiFees = await getProductFees(orderAsin, referencePrice, accessToken, orderMarketplaceId, soldPrice, fxRates);
        if (apiFees) {
          // CRITICAL: API returns per-unit fees, multiply by quantity for line totals
          referralFee = apiFees.referralFee * quantity;
          fbaFee = apiFees.fbaFee * quantity; // Fixed per-unit, but line total = perUnit * qty
          closingFee = apiFees.closingFee * quantity;
          totalFees = apiFees.totalFees * quantity;
          feesSource = apiFees.feeSource;
          console.log(`[REPAIR] 💰 Using fees for ${orderAsin} (${orderMarketplace}): referral=$${referralFee.toFixed(2)} (×${quantity}), fba=$${fbaFee.toFixed(2)} (×${quantity}), total=$${totalFees.toFixed(2)}`);
        } else {
          feeError = `Fees API unavailable for ${orderMarketplace}`;
          feesSource = 'unavailable';
        }
      }

      console.log(`[REPAIR] ✓ Order ${order.order_id}: $${soldPrice.toFixed(2)} (source: ${priceSource}, locked_from: ${lockedFrom})`);

      // SUCCESS: Clear BOTH flags and update the order
      // CRITICAL: Store item_price and shipping_price separately for accurate ROI
      const { error: updateError } = await supabase
        .from('sales_orders')
        .update({
          sold_price: Math.round(soldPrice * 100) / 100,
          item_price: Math.round(soldPrice * 100) / 100, // Item price per unit (excludes shipping)
          shipping_price: Math.round(shippingPricePerUnit * 100) / 100, // Shipping per unit (separate for ROI accuracy)
          total_sale_amount: Math.round(totalSaleAmount * 100) / 100,
          // STRICT: if fees are unavailable, store NULLs (not 0) so UI can show "Fees pending"
          referral_fee: feesSource === 'unavailable' ? null : Math.round(referralFee * 100) / 100,
          fba_fee: feesSource === 'unavailable' ? null : Math.round(fbaFee * 100) / 100,
          closing_fee: feesSource === 'unavailable' ? null : Math.round(closingFee * 100) / 100,
          total_fees: feesSource === 'unavailable' ? null : Math.round(totalFees * 100) / 100,
          price_enrich_status: 'enriched',
          price_source: priceSource,
          fees_source: feesSource,
          fees_missing: feesSource === 'unavailable',
          locked_est_price: Math.round(lockedEstPrice * 100) / 100,
          locked_from: lockedFrom,
          price_locked_at: priceLockedAt,
          price_attempt_count: (order.price_attempt_count || 0) + 1,
          price_last_attempt_at: nowIso,
          price_last_error: feeError,
          // NEW: Clear both flags on success
          needs_price_enrich: false,
          // If Fees API failed, keep needs_fee_enrich=true so another repair pass can retry
          needs_fee_enrich: feesSource === 'unavailable',
          next_enrich_after: null,
          last_enrich_error: feeError,
          last_enrich_attempt_at: nowIso,
          enrich_attempts: (order.enrich_attempts || 0) + 1,
        })
        .eq('id', order.id);

      if (updateError) {
        console.error(`[REPAIR] Update error for ${order.order_id}:`, updateError);
        await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', priceSource, updateError.message);
        failed++;
      } else {
        await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'success', priceSource);
        repaired++;
      }

      await new Promise(resolve => setTimeout(resolve, rateLimitDelay));

    } catch (err: any) {
      console.error(`[REPAIR] Error processing order ${order.order_id}:`, err);
      
      const attemptCount = (order.enrich_attempts || order.price_attempt_count || 0) + 1;
      const backoffMinutes = getBackoffMinutes(attemptCount);
      const nextRetry = new Date(now.getTime() + backoffMinutes * 60 * 1000);
      
      await supabase
        .from('sales_orders')
        .update({
          price_attempt_count: attemptCount,
          price_last_attempt_at: nowIso,
          price_last_error: (err as Error).message || 'Unknown error',
          enrich_attempts: attemptCount,
          last_enrich_attempt_at: nowIso,
          last_enrich_error: (err as Error).message || 'Unknown error',
          next_enrich_after: nextRetry.toISOString(),
        })
        .eq('id', order.id);
      
      await logEnrichmentAttempt(supabase, userId, order.order_id, order.asin, 'failed', 'unknown', (err as Error).message);
      failed++;
    }
  }

  console.log(`[REPAIR] Complete: ${repaired} repaired, ${failed} failed, ${skippedCount} skipped (backoff)`);
  
  return { 
    repaired, 
    failed, 
    pending: pendingOrders.length - repaired,
    skipped: skippedCount,
  };
}
