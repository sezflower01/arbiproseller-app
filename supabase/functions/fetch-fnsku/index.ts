import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// AWS Signature V4 helpers
async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", key as any,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  return new Uint8Array(sig);
}

async function getSigningKey(key: string, dateStamp: string, region: string, service: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256(encoder.encode("AWS4" + key), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return await hmacSha256(kService, "aws4_request");
}

async function getAwsSignature(
  method: string,
  host: string,
  path: string,
  queryString: string,
  headers: Record<string, string>,
  payload: string,
  awsAccessKeyId: string,
  awsSecretAccessKey: string,
  region: string,
  service: string
): Promise<string> {
  const encoder = new TextEncoder();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const dateStamp = amzDate.slice(0, 8);

  // Canonical request
  const payloadHash = await crypto.subtle.digest("SHA-256", encoder.encode(payload))
    .then((buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join(""));

  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = Object.keys(headers).sort().join(";");

  const canonicalRequest = [
    method,
    path,
    queryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const canonicalRequestHash = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest))
    .then((buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join(""));

  // String to sign
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, canonicalRequestHash].join("\n");

  // Signing key
  const signingKey = await getSigningKey(awsSecretAccessKey, dateStamp, region, service);
  const signature = await hmacSha256(signingKey, stringToSign)
    .then((sig) => Array.from(sig).map(b => b.toString(16).padStart(2, "0")).join(""));

  return `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// Get LWA access token
async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("SPAPI_LWA_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error("Missing LWA credentials");
  }

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("LWA token error:", errorText);
    throw new Error(`Failed to get LWA access token: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Call SP-API
async function callSpApi(
  path: string,
  accessToken: string,
  queryParams: Record<string, string> = {},
  method = "GET",
  body?: any
): Promise<any> {
  const awsAccessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const awsSecretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const region = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error("Missing AWS credentials");
  }

  const host = `sellingpartnerapi-na.amazon.com`;
  const service = "execute-api";
  const queryString = new URLSearchParams(queryParams).toString();
  const payload = body ? JSON.stringify(body) : "";

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  const headers: Record<string, string> = {
    host,
    "x-amz-access-token": accessToken,
    "x-amz-date": amzDate,
  };

  if (body) {
    headers["content-type"] = "application/json";
  }

  const authHeader = await getAwsSignature(
    method,
    host,
    path,
    queryString,
    headers,
    payload,
    awsAccessKeyId,
    awsSecretAccessKey,
    region,
    service
  );

  const url = `https://${host}${path}${queryString ? "?" + queryString : ""}`;
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
      Authorization: authHeader,
    },
    body: body ? payload : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`SP-API ${path} error:`, response.status, errorText);
    throw new Error(`SP-API request failed: ${response.status}`);
  }

  return await response.json();
}

const fnskuCache = new Map<string, string | null>();

function makeCacheKey(sellerId: string, marketplaceId: string, asin: string) {
  return `${sellerId}::${marketplaceId}::${asin.toUpperCase()}`;
}

async function getFnskuFromInventory(
  asin: string,
  accessToken: string,
  marketplaceId: string,
  sellerId: string
): Promise<string | null> {
  const upperAsin = asin.toUpperCase();
  const cacheKey = makeCacheKey(sellerId, marketplaceId, upperAsin);

  if (fnskuCache.has(cacheKey)) {
    const cached = fnskuCache.get(cacheKey) ?? null;
    console.log(`FNSKU cache hit for ${cacheKey}: ${cached}`);
    return cached;
  }

  let nextToken: string | undefined;
  let page = 1;

  while (true) {
    const queryParams: Record<string, string> = {
      marketplaceIds: marketplaceId,
      details: "true",
      granularityType: "Marketplace",
      granularityId: marketplaceId,
    };

    if (nextToken) {
      queryParams.nextToken = nextToken;
    }

    console.log(
      `Calling FBA inventory summaries page ${page} for ASIN ${upperAsin} in marketplace ${marketplaceId}`
    );

    const inventoryResponse = await callSpApi(
      "/fba/inventory/v1/summaries",
      accessToken,
      queryParams
    );

    const inventorySummaries = inventoryResponse?.payload?.inventorySummaries || [];
    const matchingItem = inventorySummaries.find(
      (item: any) => item.asin === upperAsin
    );

    if (matchingItem) {
      const fnsku =
        matchingItem.fnSku || matchingItem.sellerSku || upperAsin || null;

      if (fnsku && fnsku === upperAsin) {
        console.log(
          `FNSKU equals ASIN for ${upperAsin} (likely stickerless / commingled inventory)`
        );
      }

      console.log(`Found FNSKU: ${fnsku} for ASIN: ${upperAsin}`);
      fnskuCache.set(cacheKey, fnsku);
      return fnsku;
    }

    nextToken = inventoryResponse?.payload?.nextToken;
    if (!nextToken) {
      break;
    }

    page += 1;
  }

  console.log(
    `FNSKU not found in inventory summaries for ASIN ${upperAsin} in marketplace ${marketplaceId}`
  );
  fnskuCache.set(cacheKey, null);
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authenticate user
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get all seller authorizations for this user (multi-marketplace)
    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, seller_id, marketplace_id')
      .eq('user_id', user.id);

    // Prefer US marketplace, fallback to first available
    const sellerAuth = authRows?.find(a => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (authError || !sellerAuth) {
      return new Response(
        JSON.stringify({ 
          error: "Amazon seller account not connected. Please connect your Amazon account first." 
        }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse request
    const { asin } = await req.json();
    if (!asin) {
      return new Response(JSON.stringify({ error: "ASIN is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Fetching FNSKU for ASIN: ${asin}`);

    // Get LWA access token using user's refresh token
    const accessToken = await getLwaAccessToken(sellerAuth.refresh_token);

    // Use user's marketplace ID
    const marketplaceId = sellerAuth.marketplace_id || "ATVPDKIKX0DER";

    // Call FBA Inventory API to get FNSKU using getInventorySummaries
    const fnsku = await getFnskuFromInventory(
      asin,
      accessToken,
      marketplaceId,
      sellerAuth.seller_id
    );

    return new Response(
      JSON.stringify({ fnsku }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Error in fetch-fnsku function:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
