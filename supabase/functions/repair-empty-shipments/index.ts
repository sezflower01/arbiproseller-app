// repair-empty-shipments
//
// Re-pulls line items from Amazon SP-API for shipments whose items table is
// empty (typically multi-destination splits where the items endpoint returned
// nothing during the original sync). This function:
//   • is admin-only (other roles get 403)
//   • processes a small batch per call (caller loops for progress UI)
//   • NEVER deletes existing items — uses upsert keyed on (user_id, shipment_id, seller_sku)
//   • returns per-shipment outcomes so the UI can display
//     checked / repaired / still empty / failed
//   • logs every shipment_id and result to the function logs
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ============================================================
// SP-API auth helpers (mirrors sync-fba-shipments)
// ============================================================
async function sha256(message: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
}

async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as any,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode("AWS4" + secretKey), dateStamp);
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
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = toHex(await sha256(body));
  const canonicalHeaders =
    `host:${host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-access-token;x-amz-date";
  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    toHex(await sha256(canonicalRequest)),
  ].join("\n");

  const signingKey = await getSigningKey(awsSecretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));

  return {
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    "x-amz-access-token": accessToken,
    host,
  };
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("LWA_CLIENT_ID")!;
  const clientSecret = Deno.env.get("LWA_CLIENT_SECRET")!;
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
    throw new Error(`LWA token error: ${response.status} - ${await response.text()}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function callSpApi(
  method: string,
  url: string,
  accessToken: string,
  body = "",
): Promise<{ status: number; payload: any }> {
  const headers = await signRequest(method, url, body, accessToken);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: headers["Authorization"],
      "x-amz-date": headers["x-amz-date"],
      "x-amz-access-token": accessToken,
      "Content-Type": "application/json",
    },
    body: body || undefined,
  });
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

// ============================================================
// Items-fetch with pagination — Amazon paginates v0 items endpoint
// for large multi-SKU shipments using NextToken. Without this, multi-SKU
// shipments would still come back partial.
// ============================================================
async function fetchAllItems(
  shipmentId: string,
  marketplaceId: string,
  accessToken: string,
): Promise<{ items: any[]; pages: number; lastStatus: number }> {
  const collected: any[] = [];
  let nextToken: string | null = null;
  let pages = 0;
  let lastStatus = 0;

  do {
    const baseUrl =
      `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items` +
      `?MarketplaceId=${marketplaceId}` +
      (nextToken ? `&NextToken=${encodeURIComponent(nextToken)}` : "");
    const { status, payload } = await callSpApi("GET", baseUrl, accessToken);
    lastStatus = status;
    pages++;

    if (status >= 400) {
      // Bubble up — caller handles the per-shipment failure path.
      throw new Error(
        `SP-API items HTTP ${status}: ${JSON.stringify(payload).slice(0, 300)}`,
      );
    }

    const itemData = payload?.payload?.ItemData;
    if (Array.isArray(itemData)) {
      collected.push(...itemData);
    }
    nextToken = payload?.payload?.NextToken || null;

    // Safety stop — should never need more than 50 pages for a single shipment
    if (pages >= 50) break;
  } while (nextToken);

  return { items: collected, pages, lastStatus };
}

// ============================================================
// Main handler
// ============================================================
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Auth: must be a logged-in admin user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await adminClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin-only check
    const { data: isAdmin, error: roleErr } = await adminClient.rpc("has_role", {
      _user_id: user.id,
      _role: "admin",
    });
    if (roleErr) {
      return new Response(JSON.stringify({ error: roleErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!isAdmin) {
      return new Response(
        JSON.stringify({ error: "Forbidden — admin role required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Parse batch size (default 5 — keeps us well under SP-API throttling)
    let batchSize = 5;
    try {
      const body = await req.json();
      if (typeof body?.batchSize === "number" && body.batchSize > 0) {
        batchSize = Math.min(Math.floor(body.batchSize), 25);
      }
    } catch {
      // No body / invalid JSON — fall back to default 5
    }

    // Find candidate shipments (RPC enforces caller scope via auth.uid())
    // We invoke the RPC as the user so SECURITY DEFINER + auth.uid() work.
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: candidates, error: listErr } = await userClient.rpc(
      "list_shipments_missing_items",
      { p_limit: batchSize },
    );
    if (listErr) {
      return new Response(JSON.stringify({ error: listErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const targets: Array<{ shipment_id: string; shipment_name: string | null }> =
      candidates ?? [];

    // Lookup remaining count for the UI badge / progress bar
    const { data: remainingCountRaw } = await userClient.rpc(
      "count_shipments_missing_items",
    );
    const remainingBefore = Number(remainingCountRaw ?? 0);

    if (targets.length === 0) {
      console.log(`[REPAIR] user=${user.id} nothing to repair`);
      return new Response(
        JSON.stringify({
          checked: 0,
          repaired: 0,
          stillEmpty: 0,
          failed: 0,
          remaining: remainingBefore,
          results: [],
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Pick the user's NA seller authorization (US first)
    const { data: authRows, error: authErr } = await adminClient
      .from("seller_authorizations")
      .select("refresh_token, marketplace_id, seller_id")
      .eq("user_id", user.id);
    if (authErr || !authRows?.length) {
      return new Response(
        JSON.stringify({ error: "No Amazon seller authorization found." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const NA_MARKETPLACES = [
      "ATVPDKIKX0DER",
      "A2EUQ1WTGCTBG2",
      "A1AM78C64UM0Y8",
      "A2Q3Y263D00KWC",
    ];
    const auth =
      authRows.find((r: any) => r.marketplace_id === "ATVPDKIKX0DER") ||
      authRows.find((r: any) => NA_MARKETPLACES.includes(r.marketplace_id)) ||
      authRows[0];
    const marketplaceId = auth.marketplace_id || "ATVPDKIKX0DER";

    const accessToken = await getLwaAccessToken(auth.refresh_token);

    let repaired = 0;
    let stillEmpty = 0;
    let failed = 0;
    const results: Array<{
      shipment_id: string;
      shipment_name: string | null;
      outcome: "repaired" | "still_empty" | "failed";
      items_inserted: number;
      pages: number;
      error?: string;
    }> = [];

    for (const t of targets) {
      const shipmentId = t.shipment_id;
      try {
        const { items, pages } = await fetchAllItems(
          shipmentId,
          marketplaceId,
          accessToken,
        );

        if (items.length === 0) {
          stillEmpty++;
          console.log(
            `[REPAIR] user=${user.id} shipment=${shipmentId} STILL_EMPTY pages=${pages}`,
          );
          results.push({
            shipment_id: shipmentId,
            shipment_name: t.shipment_name,
            outcome: "still_empty",
            items_inserted: 0,
            pages,
          });
          continue;
        }

        // Upsert each item — never delete existing, only add or refresh.
        let inserted = 0;
        for (const item of items) {
          const sku = item?.SellerSKU;
          if (!sku) continue;
          const row = {
            user_id: user.id,
            shipment_id: shipmentId,
            seller_sku: sku,
            fnsku: item?.FulfillmentNetworkSKU || null,
            asin: item?.ASIN || null,
            quantity_shipped: Number(item?.QuantityShipped) || 0,
            quantity_received: Number(item?.QuantityReceived) || 0,
            quantity_in_case: Number(item?.QuantityInCase) || 0,
            updated_at: new Date().toISOString(),
          };
          const { error: upErr } = await adminClient
            .from("fba_shipment_items")
            .upsert(row, { onConflict: "user_id,shipment_id,seller_sku" });
          if (!upErr) inserted++;
          else {
            console.log(
              `[REPAIR] user=${user.id} shipment=${shipmentId} sku=${sku} upsert_error=${upErr.message}`,
            );
          }
        }

        repaired++;
        console.log(
          `[REPAIR] user=${user.id} shipment=${shipmentId} REPAIRED items=${inserted} pages=${pages}`,
        );
        results.push({
          shipment_id: shipmentId,
          shipment_name: t.shipment_name,
          outcome: "repaired",
          items_inserted: inserted,
          pages,
        });
      } catch (err: any) {
        failed++;
        const msg = err?.message ?? String(err);
        console.log(
          `[REPAIR] user=${user.id} shipment=${shipmentId} FAILED ${msg}`,
        );
        results.push({
          shipment_id: shipmentId,
          shipment_name: t.shipment_name,
          outcome: "failed",
          items_inserted: 0,
          pages: 0,
          error: msg.slice(0, 300),
        });
      }
    }

    // Recount after the batch so the UI can show real "remaining" for next click.
    const { data: remainingAfterRaw } = await userClient.rpc(
      "count_shipments_missing_items",
    );
    const remainingAfter = Number(remainingAfterRaw ?? 0);

    return new Response(
      JSON.stringify({
        checked: targets.length,
        repaired,
        stillEmpty,
        failed,
        remaining: remainingAfter,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[REPAIR] Fatal", err);
    return new Response(
      JSON.stringify({ error: err?.message ?? String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
