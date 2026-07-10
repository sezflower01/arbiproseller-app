import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// AWS SigV4 signing helper for SP-API
async function spApiSignedFetch(params: {
  method: string;
  path: string;
  queryParams?: string;
  accessToken: string;
  bodyString?: string;
}): Promise<Response> {
  const { method, path, queryParams = "", accessToken, bodyString } = params;

  const awsAccessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const awsSecretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const awsRegion = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error("AWS credentials not configured (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)");
  }

  const host = "sellingpartnerapi-na.amazon.com";
  const service = "execute-api";
  const url = `https://${host}${path}${queryParams ? `?${queryParams}` : ""}`;

  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);

  const encoder = new TextEncoder();
  const canonicalHeaders = `host:${host}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = "host;x-amz-date";

  const payload = bodyString ?? "";
  const payloadHash = await crypto.subtle.digest("SHA-256", encoder.encode(payload));
  const payloadHashHex = Array.from(new Uint8Array(payloadHash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;

  const canonicalRequestHash = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest));
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHashHex}`;

  const hmacSha256 = async (key: ArrayBuffer | Uint8Array, data: Uint8Array): Promise<ArrayBuffer> => {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key as any,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return await crypto.subtle.sign("HMAC", cryptoKey, data as any);
  };

  const getSignatureKey = async (key: string, dateStamp: string, regionName: string, serviceName: string) => {
    const kDate = await hmacSha256(encoder.encode("AWS4" + key), encoder.encode(dateStamp));
    const kRegion = await hmacSha256(kDate, encoder.encode(regionName));
    const kService = await hmacSha256(kRegion, encoder.encode(serviceName));
    const kSigning = await hmacSha256(kService, encoder.encode("aws4_request"));
    return kSigning;
  };

  const signingKey = await getSignatureKey(awsSecretAccessKey, date, awsRegion, service);
  const signature = await hmacSha256(signingKey, encoder.encode(stringToSign));
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;

  return await fetch(url, {
    method,
    headers: {
      Authorization: authorizationHeader,
      "x-amz-access-token": accessToken,
      "x-amz-date": timestamp,
      host,
      ...(bodyString ? { "Content-Type": "application/json" } : {}),
    },
    ...(bodyString ? { body: bodyString } : {}),
  });
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("SPAPI_LWA_CLIENT_ID") ?? Deno.env.get("LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("SPAPI_LWA_CLIENT_SECRET") ?? Deno.env.get("LWA_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error("LWA credentials not configured");
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
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use global SP-API credentials - no-connect mode
    const globalRefreshToken = Deno.env.get("SPAPI_REFRESH_TOKEN");
    const globalSellerId = Deno.env.get("SPAPI_SELLER_ID");

    if (!globalRefreshToken) {
      return new Response(JSON.stringify({ error: "SPAPI_REFRESH_TOKEN not configured" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!globalSellerId) {
      return new Response(JSON.stringify({ error: "SPAPI_SELLER_ID not configured" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { inboundPlanId, shipmentId, transportationOptionId } = await req.json();
    console.log("Confirming transportation for plan:", inboundPlanId, "shipment:", shipmentId, "option:", transportationOptionId);

    const accessToken = await getAccessToken(globalRefreshToken);

    // Confirm the transportation option with SigV4 signing
    const confirmPath = `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/shipments/${shipmentId}/transportationOptions/confirmation`;
    const confirmResponse = await spApiSignedFetch({
      method: "POST",
      path: confirmPath,
      accessToken,
      bodyString: JSON.stringify({ transportationOptionId }),
    });

    const confirmText = await confirmResponse.text();
    console.log("Confirm transportation response:", confirmResponse.status, confirmText);

    if (!confirmResponse.ok) {
      return new Response(JSON.stringify({ 
        error: "Failed to confirm transportation", 
        details: confirmText 
      }), {
        status: confirmResponse.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const confirmData = JSON.parse(confirmText);

    return new Response(JSON.stringify({
      success: true,
      operationId: confirmData.operationId,
      message: "Transportation confirmed. Shipping label is being generated.",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error confirming transportation:", error);
    return new Response(JSON.stringify({ 
      error: "Failed to confirm transportation", 
      details: (error as Error).message 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
