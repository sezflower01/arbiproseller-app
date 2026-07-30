// Self-contained live SP-API Fees fetch for ASINs with insufficient learned-
// fee-multiplier history (below the 3-sample floor). Mirrors the signing /
// retry pattern already proven in calculate-roi/index.ts's getProductFees,
// duplicated here (not imported) so this stays isolated from that
// already-working function — no shared-code risk to it.
//
// Rate-limit safe: gated by the shared fees_api token bucket
// (waitForApiToken) before every call, plus exponential backoff with
// jitter on 429/QuotaExceeded, matching the account-wide convention used
// by repricer-sp-api-pricing and calculate-roi.

import { waitForApiToken, backoffMs } from "./rate-limiter.ts";

const MARKETPLACE_CONFIG: Record<string, { id: string; currency: string; endpoint: string }> = {
  US: { id: "ATVPDKIKX0DER", currency: "USD", endpoint: "sellingpartnerapi-na.amazon.com" },
  CA: { id: "A2EUQ1WTGCTBG2", currency: "CAD", endpoint: "sellingpartnerapi-na.amazon.com" },
  MX: { id: "A1AM78C64UM0Y8", currency: "MXN", endpoint: "sellingpartnerapi-na.amazon.com" },
  BR: { id: "A2Q3Y263D00KWC", currency: "BRL", endpoint: "sellingpartnerapi-na.amazon.com" },
};

function getMarketplaceConfig(marketplace: string) {
  return MARKETPLACE_CONFIG[marketplace] || MARKETPLACE_CONFIG.US;
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string,
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
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-access-token;x-amz-date";

  const encoder = new TextEncoder();
  const bodyHash = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  const payloadHash = Array.from(new Uint8Array(bodyHash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${awsRegion}/execute-api/aws4_request`;

  const canonicalRequestHash = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest));
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHashHex}`;

  const hmac = async (key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> => {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      typeof key === "string" ? encoder.encode(key) : key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  };

  const getSignatureKey = async (key: string, dateStamp: string, regionName: string, serviceName: string) => {
    const kDate = await hmac(`AWS4${key}`, dateStamp);
    const kRegion = await hmac(kDate, regionName);
    const kService = await hmac(kRegion, serviceName);
    const kSigning = await hmac(kService, "aws4_request");
    return kSigning;
  };

  const signingKey = await getSignatureKey(awsSecretAccessKey, dateStamp, awsRegion, "execute-api");
  const signature = await hmac(signingKey, stringToSign);
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const authorizationHeader = `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;

  return {
    "Authorization": authorizationHeader,
    "x-amz-access-token": accessToken,
    "x-amz-date": amzDate,
    "Content-Type": "application/json",
  };
}

let cachedLwaToken: { token: string; fetchedAt: number } | null = null;

async function getLWAAccessToken(): Promise<string> {
  // LWA tokens are valid ~1 hour; reuse within a single invocation to avoid
  // requesting a fresh one per ASIN when refreshing many in one run.
  if (cachedLwaToken && Date.now() - cachedLwaToken.fetchedAt < 50 * 60 * 1000) {
    return cachedLwaToken.token;
  }

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
    const errBody = await response.text();
    throw new Error(`LWA token error: ${response.status} - ${errBody}`);
  }

  const data = await response.json();
  cachedLwaToken = { token: data.access_token, fetchedAt: Date.now() };
  return data.access_token;
}

export interface LiveFeeResult {
  referralFee: number;
  fbaFee: number;
  closingFee: number;
  isMedia: boolean;
  referralRate: number;
}

/**
 * Fetch a live SP-API fees estimate for one ASIN at a given native-currency
 * price. Rate-limited via the shared fees_api token bucket, with
 * exponential-backoff retry on 429/QuotaExceeded (up to maxRetries).
 * Returns null on persistent failure — callers should leave the existing
 * cache entry untouched rather than overwrite it with a failed attempt.
 */
export async function fetchLiveFeesForAsin(
  supabase: any,
  asin: string,
  marketplace: string,
  price: number,
  maxRetries = 2,
): Promise<LiveFeeResult | null> {
  if (!(price > 0)) return null;
  const config = getMarketplaceConfig(marketplace);

  let accessToken: string;
  try {
    accessToken = await getLWAAccessToken();
  } catch (e) {
    console.warn(`[spapi-fees-live] LWA token error for ${asin}/${marketplace}:`, (e as Error).message);
    return null;
  }

  const feesUrl = `https://${config.endpoint}/products/fees/v0/items/${asin}/feesEstimate`;
  const feesBody = JSON.stringify({
    FeesEstimateRequest: {
      MarketplaceId: config.id,
      IsAmazonFulfilled: true,
      PriceToEstimateFees: {
        ListingPrice: { CurrencyCode: config.currency, Amount: price },
      },
      Identifier: asin,
    },
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await waitForApiToken(supabase, "fees_api");
    const headers = await signRequest("POST", feesUrl, feesBody, accessToken);

    let resp: Response;
    try {
      resp = await fetch(feesUrl, { method: "POST", headers, body: feesBody });
    } catch (e) {
      console.warn(`[spapi-fees-live] fetch error for ${asin}/${marketplace}:`, (e as Error).message);
      return null;
    }

    if (resp.ok) {
      const data = await resp.json();
      const feeDetails = data.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList;
      if (!feeDetails) return null;

      let referralFee = 0, fbaFee = 0, closingFee = 0;
      for (const fee of feeDetails) {
        const amount = parseFloat(fee.FeeAmount?.Amount || "0");
        if (fee.FeeType === "ReferralFee") referralFee = amount;
        else if (fee.FeeType === "FBAFees") fbaFee = amount;
        else if (fee.FeeType === "VariableClosingFee") closingFee += amount;
        else if (fee.FeeType === "FixedClosingFee") closingFee += amount;
      }
      const referralRate = price > 0 ? referralFee / price : 0;
      return { referralFee, fbaFee, closingFee, isMedia: closingFee > 0, referralRate };
    }

    if (resp.status === 429 && attempt < maxRetries) {
      const delay = backoffMs(attempt + 1, 2000, 15000);
      console.warn(`[spapi-fees-live] 429 for ${asin}/${marketplace}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    const errText = await resp.text().catch(() => "");
    console.warn(`[spapi-fees-live] Fees API error ${resp.status} for ${asin}/${marketplace}: ${errText.slice(0, 300)}`);
    return null;
  }

  return null;
}
