import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface MarketplaceConfig {
  id: string;
  code: string;
  endpoint: string;
  currency: string;
}

const MARKETPLACES: Record<string, MarketplaceConfig> = {
  US: { id: "ATVPDKIKX0DER", code: "US", endpoint: "https://sellingpartnerapi-na.amazon.com", currency: "USD" },
  CA: { id: "A2EUQ1WTGCTBG2", code: "CA", endpoint: "https://sellingpartnerapi-na.amazon.com", currency: "CAD" },
  MX: { id: "A1AM78C64UM0Y8", code: "MX", endpoint: "https://sellingpartnerapi-na.amazon.com", currency: "MXN" },
  BR: { id: "A2Q3Y263D00KWC", code: "BR", endpoint: "https://sellingpartnerapi-na.amazon.com", currency: "BRL" },
  UK: { id: "A1F83G8C2ARO7P", code: "UK", endpoint: "https://sellingpartnerapi-eu.amazon.com", currency: "GBP" },
  DE: { id: "A1PA6795UKMFR9", code: "DE", endpoint: "https://sellingpartnerapi-eu.amazon.com", currency: "EUR" },
  ES: { id: "A1RKKUPIHCS9HS", code: "ES", endpoint: "https://sellingpartnerapi-eu.amazon.com", currency: "EUR" },
};

const NA_MARKETPLACE_IDS = ["ATVPDKIKX0DER", "A2EUQ1WTGCTBG2", "A1AM78C64UM0Y8", "A2Q3Y263D00KWC"];
const EU_MARKETPLACE_IDS = ["A1F83G8C2ARO7P", "A1PA6795UKMFR9", "A1RKKUPIHCS9HS"];

async function sha256(message: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
}

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as any,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode(`AWS4${secretKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, "aws4_request");
}

async function signRequest(
  method: string,
  url: string,
  body: string,
  accessToken: string,
): Promise<Record<string, string>> {
  const awsAccessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID")!;
  const awsSecretKey = Deno.env.get("AWS_SECRET_ACCESS_KEY")!;
  const region = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";
  const service = "execute-api";

  const urlObj = new URL(url);
  const host = urlObj.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = toHex(await sha256(body));

  const canonicalHeaders = `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-access-token;x-amz-date";
  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, toHex(await sha256(canonicalRequest))].join("\n");
  const signingKey = await getSignatureKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  return {
    Authorization: `${algorithm} Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    "x-amz-access-token": accessToken,
    host,
  };
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("LWA_CLIENT_ID") || Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("LWA_CLIENT_SECRET") || Deno.env.get("SPAPI_LWA_CLIENT_SECRET");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Amazon authorization credentials");
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
    throw new Error(`LWA token error: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

function getRegionMarketplaceIds(marketplaceId: string) {
  return NA_MARKETPLACE_IDS.includes(marketplaceId) ? NA_MARKETPLACE_IDS : EU_MARKETPLACE_IDS;
}

function normalizeAmazonStatus(status?: string | string[] | null) {
  if (Array.isArray(status)) {
    const normalized = status
      .map((value) => String(value || "").toUpperCase())
      .filter(Boolean);

    if (normalized.includes("ACTIVE")) return "ACTIVE";
    if (normalized.includes("BUYABLE")) return "BUYABLE";
    if (normalized.includes("DISCOVERABLE")) return "DISCOVERABLE";
    if (normalized.includes("INACTIVE")) return "INACTIVE";
    if (normalized.includes("INCOMPLETE")) return "INCOMPLETE";

    return normalized[0] || "UNKNOWN";
  }

  return String(status || "UNKNOWN").toUpperCase();
}

function getLiveMessage(status: string) {
  if (["ACTIVE", "BUYABLE", "DISCOVERABLE"].includes(status)) {
    return "Amazon confirms this seller listing exists and is currently live.";
  }
  if (["INACTIVE", "INCOMPLETE"].includes(status)) {
    return "Amazon confirms this seller listing exists, but it is not active right now.";
  }
  if (status === "NOT_IN_CATALOG") {
    return "Amazon says this SKU is not in the catalog for this marketplace. This usually means the listing was deleted, suppressed, or never became a valid live offer.";
  }
  if (status === "NOT_FOUND") {
    return "Amazon could not find this seller listing for the selected SKU and marketplace.";
  }
  return "Amazon returned a listing response, but the status was not clearly classified.";
}

function classifyIssues(issues: Array<{ code?: string; message?: string; severity?: string; enforcements?: { actions?: Array<{ action?: string }> } }>) {
  const codes = new Set(issues.map((issue) => String(issue.code || "").toUpperCase()));
  const messages = issues.map((issue) => String(issue.message || "").toLowerCase());
  const actions = issues.flatMap((issue) => issue.enforcements?.actions?.map((action) => String(action.action || "").toUpperCase()) || []);

  if (
    codes.has("13013") ||
    messages.some((message) => message.includes("not in the catalog")) ||
    actions.includes("LISTING_SUPPRESSED")
  ) {
    return "NOT_IN_CATALOG";
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = claimsData.claims.sub as string;
    const { asin, sku, marketplace = "US" } = await req.json();

    if (!asin || !/^[A-Z0-9]{10}$/i.test(asin)) {
      return new Response(JSON.stringify({ error: "Invalid ASIN format" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const marketplaceConfig = MARKETPLACES[marketplace];
    if (!marketplaceConfig) {
      return new Response(JSON.stringify({ error: "Invalid marketplace" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: authRows } = await supabase
      .from("seller_authorizations")
      .select("refresh_token, seller_id, selling_partner_id, marketplace_id, is_active")
      .eq("user_id", userId);

    if (!authRows || authRows.length === 0) {
      return new Response(JSON.stringify({ error: "No Amazon authorization found", authorizationRequired: true }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const regionMarketplaceIds = getRegionMarketplaceIds(marketplaceConfig.id);
    const activeAuthRows = authRows.filter((row) => row.is_active !== false);
    const authData =
      activeAuthRows.find((row) => row.marketplace_id === marketplaceConfig.id) ||
      activeAuthRows.find((row) => regionMarketplaceIds.includes(row.marketplace_id)) ||
      activeAuthRows[0] ||
      authRows[0];

    let effectiveSku = sku as string | null;
    if (!effectiveSku) {
      const { data: invRow } = await supabase
        .from("inventory")
        .select("sku")
        .eq("user_id", userId)
        .eq("asin", asin)
        .maybeSingle();
      effectiveSku = invRow?.sku || null;
    }

    if (!effectiveSku) {
      return new Response(JSON.stringify({ error: "SKU required for live listing verification", needsSku: true }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sellerId = authData.selling_partner_id || authData.seller_id;
    if (!sellerId) {
      return new Response(JSON.stringify({ error: "No seller ID found in authorization" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accessToken = await getLwaAccessToken(authData.refresh_token);
    const path = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(effectiveSku)}`;
    const url = new URL(`${marketplaceConfig.endpoint}${path}`);
    url.searchParams.set("marketplaceIds", marketplaceConfig.id);
    url.searchParams.set("includedData", "summaries,issues");
    const headers = await signRequest("GET", url.toString(), "", accessToken);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 404) {
      const payload = {
        asin,
        sku: effectiveSku,
        marketplace,
        marketplaceId: marketplaceConfig.id,
        checkedAt: new Date().toISOString(),
        amazonExists: false,
        amazonStatus: "NOT_FOUND",
        liveMessage: getLiveMessage("NOT_FOUND"),
        summary: null,
      };

      return new Response(JSON.stringify(payload), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (response.status === 403) {
      return new Response(JSON.stringify({
        error: "Product Listing permission required. Please reconnect Amazon with listing access.",
        authorizationRequired: true,
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (response.status === 429) {
      return new Response(JSON.stringify({ error: "Amazon rate limit reached. Please try again in a moment." }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(JSON.stringify({ error: `Amazon listing check failed: ${response.status}`, details: errorText }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    console.log("[verify-amazon-listing] Raw response:", JSON.stringify(data).slice(0, 2000));
    const summaries = Array.isArray(data?.summaries) ? data.summaries : [];
    const summary = summaries.find((entry: any) => entry.marketplaceId === marketplaceConfig.id) || summaries[0] || null;
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    const amazonStatus = normalizeAmazonStatus(summary?.status);
    const issueDerivedStatus = classifyIssues(issues);
    const hasAnySummary = summaries.length > 0;
    const effectiveStatus = hasAnySummary
      ? (amazonStatus === "UNKNOWN" ? "EXISTS_NO_STATUS" : amazonStatus)
      : (issueDerivedStatus || "NOT_FOUND");
    const effectiveExists = hasAnySummary && !["NOT_FOUND", "NOT_IN_CATALOG"].includes(effectiveStatus);

    return new Response(JSON.stringify({
      asin,
      sku: effectiveSku,
      marketplace,
      marketplaceId: marketplaceConfig.id,
      checkedAt: new Date().toISOString(),
      amazonExists: effectiveExists,
      amazonStatus: effectiveStatus,
      liveMessage: effectiveStatus === "EXISTS_NO_STATUS"
        ? "Amazon returned this listing but did not include a status field. The listing likely exists but may need investigation."
        : getLiveMessage(effectiveStatus),
      issuesCount: issues.length,
      issues: issues.slice(0, 5).map((i: any) => ({
        code: i.code,
        message: i.message,
        severity: i.severity,
      })),
      summary: summary
        ? {
            asin: summary.asin || asin,
            itemName: summary.itemName || null,
            productType: summary.productType || null,
            conditionType: summary.conditionType || null,
            status: Array.isArray(summary.status) ? summary.status.join(", ") : summary.status || null,
          }
        : null,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? (error as Error).message : String(error);
    console.error("[verify-amazon-listing]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});