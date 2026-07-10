import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { waitForApiToken } from '../_shared/rate-limiter.ts';
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";

// Lazy service-role client used only for shared rate-limiter RPC calls.
let _rlClient: any = null;
function getRateLimiterClient() {
  if (_rlClient) return _rlClient;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  _rlClient = createClient(url, key);
  return _rlClient;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RoiRangeRequest {
  asin: string;
  sku: string;
  marketplace: string;
  min_price: number;
  max_price: number;
  cost: number;
  user_id?: string; // Optional: used by service-role callers (e.g. auto-onboarding)
}

interface RoiResult {
  roi_at_min: number | null;
  roi_at_max: number | null;
  profit_at_min: number | null;
  profit_at_max: number | null;
  fees_at_min: number | null;
  fees_at_max: number | null;
  break_even_price: number | null;
}

// AWS SigV4 signing implementation
async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string
): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const awsSecretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const awsRegion = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error("Missing AWS credentials");
  }

  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname;
  const path = parsedUrl.pathname + parsedUrl.search;
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  
  const encoder = new TextEncoder();
  const bodyHash = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  const payloadHash = Array.from(new Uint8Array(bodyHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${awsRegion}/execute-api/aws4_request`;
  
  const canonicalRequestHash = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHashHex}`;
  
  const getSignatureKey = async (key: string, dateStamp: string, regionName: string, serviceName: string) => {
    const kDate = await hmac(`AWS4${key}`, dateStamp);
    const kRegion = await hmac(kDate, regionName);
    const kService = await hmac(kRegion, serviceName);
    const kSigning = await hmac(kService, 'aws4_request');
    return kSigning;
  };
  
  const hmac = async (key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> => {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      typeof key === 'string' ? encoder.encode(key) : key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  };
  
  const signingKey = await getSignatureKey(awsSecretAccessKey, dateStamp, awsRegion, 'execute-api');
  const signature = await hmac(signingKey, stringToSign);
  const signatureHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;
  
  return {
    "Authorization": authorizationHeader,
    "x-amz-access-token": accessToken,
    "x-amz-date": amzDate,
    "Content-Type": "application/json",
  };
}

async function getLWAAccessToken(): Promise<string> {
  const clientId = Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("SPAPI_LWA_CLIENT_SECRET");
  const refreshToken = Deno.env.get("SPAPI_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing SP-API credentials");
  }

  const tokenUrl = "https://api.amazon.com/auth/o2/token";
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`LWA token error: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Marketplace ID mapping
const MARKETPLACE_IDS: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

// Currency mapping for marketplaces
const MARKETPLACE_CURRENCIES: Record<string, string> = {
  'ATVPDKIKX0DER': 'USD',
  'A2EUQ1WTGCTBG2': 'CAD',
  'A1AM78C64UM0Y8': 'MXN',
  'A2Q3Y263D00KWC': 'BRL',
};

// Fetch FX rates from Supabase
async function getFxRate(supabase: any, targetCurrency: string): Promise<number> {
  if (targetCurrency === 'USD') return 1;
  
  const { data, error } = await supabase
    .from('fx_rates')
    .select('rate')
    .eq('base', 'USD')
    .eq('quote', targetCurrency)
    .single();
  
  if (error || !data) {
    console.log(`[calculate-roi-range] FX rate not found for ${targetCurrency}, using fallback`);
    // Fallback rates
    const fallbacks: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0 };
    return fallbacks[targetCurrency] || 1;
  }
  
  return data.rate;
}

/**
 * Get product fees from Amazon SP-API for a given price
 * This is the SAME LOGIC as calculate-roi uses - ensures consistency
 */
async function getProductFeesWithRetry(
  asin: string,
  price: number,
  accessToken: string,
  marketplaceId: string,
  maxRetries = 3,
  userIdForSignals?: string | null,
): Promise<{ referralFee: number; fbaFee: number; variableClosingFee: number; otherFees: number; totalFees: number } | 'THROTTLED' | null> {
  const currency = MARKETPLACE_CURRENCIES[marketplaceId] || 'USD';
  const feesUrl = `https://sellingpartnerapi-na.amazon.com/products/fees/v0/items/${asin}/feesEstimate`;
  const feesBody = JSON.stringify({
    FeesEstimateRequest: {
      MarketplaceId: marketplaceId,
      IsAmazonFulfilled: true,
      PriceToEstimateFees: {
        ListingPrice: { CurrencyCode: currency, Amount: price }
      },
      Identifier: asin
    }
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const rl = getRateLimiterClient();
    if (rl) {
      console.log(`[calculate-roi-range] fees_api_waiting_token asin=${asin} price=${price} attempt=${attempt + 1}`);
      try {
        await waitForApiToken(rl, 'fees_api', { maxWaitMs: 6000 });
      } catch (waitErr) {
        // Token-bucket exhaustion = Fees API is effectively throttled. Treat
        // identical to a final 429 so the handler responds 200 + {throttled:true}
        // instead of letting the exception escape as HTTP 500 (which surfaces
        // as a "non-2xx" toast in the repricer UI every poll cycle).
        console.warn(`[calculate-roi-range] token wait timed out for ${asin} — treating as THROTTLED`);
        if (userIdForSignals) HealthSignals.feesApiThrottled(userIdForSignals, 'calculate-roi-range', asin);
        return 'THROTTLED';
      }
    }
    const feesHeaders = await signRequest("POST", feesUrl, feesBody, accessToken);
    const feesResp = await fetch(feesUrl, {
      method: "POST",
      headers: feesHeaders,
      body: feesBody,
    });

    if (feesResp.ok) {
      const feesData = await feesResp.json();
      const feeDetails = feesData.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList;
      if (!feeDetails) return null;

      let referralFee = 0, fbaFee = 0, variableClosingFee = 0, otherFees = 0;
      for (const fee of feeDetails) {
        const amount = parseFloat(fee.FeeAmount?.Amount || 0);
        if (fee.FeeType === "ReferralFee") referralFee = amount;
        else if (fee.FeeType === "FBAFees") fbaFee = amount;
        else if (fee.FeeType === "VariableClosingFee") variableClosingFee = amount;
        else otherFees += amount;
      }
      const totalFees = referralFee + fbaFee + variableClosingFee + otherFees;
      console.log(`[calculate-roi-range] Fees for ${asin} at ${currency}${price}: ${currency}${totalFees}`);
      return { referralFee, fbaFee, variableClosingFee, otherFees, totalFees };
    }

    if (feesResp.status === 429 && attempt < maxRetries) {
      const delay = Math.pow(2, attempt + 1) * 1000;
      console.log(`[calculate-roi-range] 429 rate limit, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      if (userIdForSignals) HealthSignals.feesApiThrottled(userIdForSignals, 'calculate-roi-range', asin);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const errorText = await feesResp.text();
    console.error(`[calculate-roi-range] Fees API error ${feesResp.status}:`, errorText);
    if (feesResp.status === 429) {
      // Final 429 after retries — return THROTTLED sentinel so the handler can
      // respond HTTP 200 with a structured payload instead of throwing a
      // non-2xx error that surfaces as a user-facing toast every poll cycle.
      if (userIdForSignals) HealthSignals.feesApiThrottled(userIdForSignals, 'calculate-roi-range', asin);
      return 'THROTTLED';
    }
    return null;
  }
  return null;
}

/**
 * Calculate ROI using the SAME LOGIC as calculate-roi edge function
 * This ensures Min ROI and Max ROI match Actual ROI and BB ROI calculations
 */
function calculateRoi(
  price: number, 
  cost: number, 
  totalFees: number
): { roi: number; profit: number } {
  // Formula: Profit = Price - Cost - Fees
  // ROI = (Profit / Cost) * 100
  const profit = price - cost - totalFees;
  const roi = cost > 0 ? (profit / cost) * 100 : 0;
  
  return {
    roi: parseFloat(roi.toFixed(2)),
    profit: parseFloat(profit.toFixed(2)),
  };
}

function findBreakEvenPrice(cost: number, estimatedFeeRate: number): number {
  // Break-even: price - fees - cost = 0
  // Approximate: fees ≈ price * feeRate
  // price - (price * feeRate) - cost = 0
  // price * (1 - feeRate) = cost
  // price = cost / (1 - feeRate)
  if (estimatedFeeRate >= 1) return cost * 2; // Fallback
  return parseFloat((cost / (1 - estimatedFeeRate)).toFixed(2));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth check - support both user JWT and service role key (for auto-onboarding)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    let userId: string;
    
    // Try user auth first
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (user) {
      userId = user.id;
    } else {
      // If user auth fails, check if it's the service role key calling with user_id in body
      const bodyPeek = await req.clone().json();
      if (bodyPeek.user_id && token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
        userId = bodyPeek.user_id;
      } else {
        throw new Error('Unauthorized');
      }
    }

    const body: RoiRangeRequest = await req.json();
    const { asin, sku, marketplace, min_price, max_price, cost } = body;

    console.log(`[calculate-roi-range] User ${userId} calculating ROI range for ${asin}`, {
      marketplace, min_price, max_price, cost
    });

    if (!asin || !marketplace) {
      throw new Error('ASIN and marketplace are required');
    }

    if (min_price == null || max_price == null || cost == null) {
      throw new Error('min_price, max_price, and cost are required');
    }

    const marketplaceId = MARKETPLACE_IDS[marketplace] || MARKETPLACE_IDS['US'];
    const currency = MARKETPLACE_CURRENCIES[marketplaceId] || 'USD';
    const accessToken = await getLWAAccessToken();

    // === HOME-CURRENCY-AWARE FX CONVERSION ===
    // Cost is in seller's home currency — convert to marketplace currency
    const { convertCurrency, getSellerHomeCurrency } = await import('../_shared/fx-utils.ts');
    const homeCurrency = await getSellerHomeCurrency(supabase, userId!);
    
    const usdCost = cost; // Legacy name — really "cost in home currency"
    let localCost = usdCost;
    let fxRate = 1;
    
    if (homeCurrency !== currency) {
      const fxResult = await convertCurrency(usdCost, homeCurrency, currency, supabase);
      fxRate = fxResult.fxRate;
      localCost = fxResult.converted;
      console.log(`[calculate-roi-range] Converting cost: ${homeCurrency} ${usdCost} → ${currency} ${localCost.toFixed(2)} (rate: ${fxRate.toFixed(4)})`);
    }

    // Fetch fees SEQUENTIALLY with delay to avoid rate limits
    const feesAtMin = await getProductFeesWithRetry(asin, min_price, accessToken, marketplaceId, 3, userId);
    await new Promise(r => setTimeout(r, 600));
    const feesAtMax = await getProductFeesWithRetry(asin, max_price, accessToken, marketplaceId, 3, userId);

    // If Amazon Fees API is throttled, return a structured 200 response so the
    // UI does not surface a "non-2xx" toast every poll cycle. Health signal
    // was already emitted inside getProductFeesWithRetry.
    if (feesAtMin === 'THROTTLED' || feesAtMax === 'THROTTLED') {
      return new Response(
        JSON.stringify({
          throttled: true,
          reason: 'fees_api_quota',
          message: 'Fees API quota temporarily unavailable. ROI suggestion will retry later.',
          roi_at_min: null,
          roi_at_max: null,
          profit_at_min: null,
          profit_at_max: null,
          fees_at_min: null,
          fees_at_max: null,
          break_even_price: null,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let result: RoiResult = {
      roi_at_min: null,
      roi_at_max: null,
      profit_at_min: null,
      profit_at_max: null,
      fees_at_min: feesAtMin?.totalFees ?? null,
      fees_at_max: feesAtMax?.totalFees ?? null,
      break_even_price: null,
    };

    // ============================================================
    // Calculate ROI using SAME FORMULA as Actual ROI:
    // - Price is in local currency (min_price, max_price)
    // - Cost is converted to local currency (localCost)
    // - Fees from SP-API are in local currency
    // - ROI = (Price - LocalCost - Fees) / LocalCost * 100
    // ============================================================
    
    if (feesAtMin?.totalFees != null) {
      const minCalc = calculateRoi(min_price, localCost, feesAtMin.totalFees);
      result.roi_at_min = minCalc.roi;
      result.profit_at_min = minCalc.profit;
      console.log(`[calculate-roi-range] Min: price=${currency}${min_price}, cost=${currency}${localCost.toFixed(2)}, fees=${currency}${feesAtMin.totalFees.toFixed(2)} → ROI=${minCalc.roi}%, profit=${currency}${minCalc.profit}`);
    }

    if (feesAtMax?.totalFees != null) {
      const maxCalc = calculateRoi(max_price, localCost, feesAtMax.totalFees);
      result.roi_at_max = maxCalc.roi;
      result.profit_at_max = maxCalc.profit;
      console.log(`[calculate-roi-range] Max: price=${currency}${max_price}, cost=${currency}${localCost.toFixed(2)}, fees=${currency}${feesAtMax.totalFees.toFixed(2)} → ROI=${maxCalc.roi}%, profit=${currency}${maxCalc.profit}`);
    }

    // Estimate break-even price (in local currency)
    if (feesAtMin?.totalFees != null && min_price > 0) {
      const feeRate = feesAtMin.totalFees / min_price;
      result.break_even_price = findBreakEvenPrice(localCost, feeRate);
    }

    // Cache results in repricer_assignments
    if (sku) {
      const { error: updateError } = await supabase
        .from('repricer_assignments')
        .update({
          roi_at_min_percent: result.roi_at_min,
          roi_at_max_percent: result.roi_at_max,
          roi_range_updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('sku', sku)
        .eq('marketplace', marketplace);

      if (updateError) {
        console.error('[calculate-roi-range] Failed to cache results:', updateError);
      }
    }

    console.log(`[calculate-roi-range] Result for ${asin}:`, result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[calculate-roi-range] Error:', error);
    const msg = (error as Error).message || '';
    // Throttle-shaped failures (quota, rate limit, token wait) must NOT bubble
    // as non-2xx — they fire a user-facing toast every 15s polling cycle.
    if (/QUOTA_EXCEEDED|429|rate.?limit|token|throttl/i.test(msg)) {
      return new Response(
        JSON.stringify({
          throttled: true,
          reason: 'fees_api_quota',
          message: 'Fees API quota temporarily unavailable. ROI will retry later.',
          roi_at_min: null, roi_at_max: null,
          profit_at_min: null, profit_at_max: null,
          fees_at_min: null, fees_at_max: null,
          break_even_price: null,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ error: msg || 'Failed to calculate ROI range' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
