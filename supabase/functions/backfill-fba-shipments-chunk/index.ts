// Resumable per-chunk backfill for FBA shipments.
//
// Each invocation processes ONE (window_start, window_end, shipment_status)
// slice for the calling user, handling at most `maxPagesPerCall` SP-API pages
// before returning. Progress (next_token, next_page, counters) is persisted to
// `shipment_backfill_progress`, so the UI can resume by calling this function
// again until `state = 'complete'` for every slice.
//
// Body:
//   {
//     year: 2025,
//     window_start: "2025-01-01",
//     window_end:   "2025-04-01",
//     shipment_status: "RECEIVING",
//     maxPagesPerCall?: number   // default 6
//   }
//
// Response:
//   {
//     state: "running" | "complete" | "failed",
//     pagesProcessed: number,
//     shipmentsFound: number,
//     shipmentsUpserted: number,
//     itemsUpserted: number,
//     hasMore: boolean,
//     error?: string
//   }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// --- AWS SigV4 (mirrors sync-fba-shipments) ---
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
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  return (await response.json()).access_token as string;
}
async function callSpApi(
  method: string,
  url: string,
  accessToken: string,
  body = "",
): Promise<any> {
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
  const text = await response.text();
  if (!response.ok) {
    // Surface QuotaExceeded/Throttling distinctly so caller can back off.
    const err = new Error(`SP-API error: ${response.status} - ${text}`);
    (err as any).status = response.status;
    (err as any).body = text;
    throw err;
  }
  return JSON.parse(text);
}

const VALID_STATUSES = new Set([
  "WORKING",
  "SHIPPED",
  "IN_TRANSIT",
  "DELIVERED",
  "CHECKED_IN",
  "RECEIVING",
  "CLOSED",
  "CANCELLED",
  "DELETED",
  "ERROR",
]);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceKey);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // Auth: require a real user JWT (this is user-initiated UI work).
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing authorization" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const token = authHeader.replace("Bearer ", "");
  const { data: userResult, error: userErr } = await adminClient.auth.getUser(token);
  if (userErr || !userResult?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = userResult.user.id;

  // Validate inputs.
  const year = Number(body?.year);
  const windowStart = String(body?.window_start ?? "").trim();
  const windowEnd = String(body?.window_end ?? "").trim();
  const shipmentStatus = String(body?.shipment_status ?? "").trim().toUpperCase();
  const maxPagesPerCall = Math.min(
    Math.max(Number(body?.maxPagesPerCall ?? 6) || 6, 1),
    20,
  );

  if (
    !Number.isFinite(year) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(windowStart) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(windowEnd) ||
    !VALID_STATUSES.has(shipmentStatus)
  ) {
    return new Response(
      JSON.stringify({
        error:
          "Invalid input. Required: year, window_start (YYYY-MM-DD), window_end (YYYY-MM-DD), shipment_status (one of " +
          [...VALID_STATUSES].join(", ") +
          ").",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Load or create the progress row.
  const { data: existing } = await adminClient
    .from("shipment_backfill_progress")
    .select("*")
    .eq("user_id", userId)
    .eq("backfill_year", year)
    .eq("window_start", windowStart)
    .eq("window_end", windowEnd)
    .eq("shipment_status", shipmentStatus)
    .maybeSingle();

  if (existing?.state === "complete") {
    return new Response(
      JSON.stringify({
        state: "complete",
        pagesProcessed: existing.pages_processed ?? 0,
        shipmentsFound: existing.shipments_found ?? 0,
        shipmentsUpserted: existing.shipments_upserted ?? 0,
        itemsUpserted: existing.items_upserted ?? 0,
        hasMore: false,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let progress = existing;
  if (!progress) {
    const { data: inserted, error: insertErr } = await adminClient
      .from("shipment_backfill_progress")
      .insert({
        user_id: userId,
        backfill_year: year,
        window_start: windowStart,
        window_end: windowEnd,
        shipment_status: shipmentStatus,
        state: "running",
        started_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    if (insertErr) {
      return new Response(
        JSON.stringify({ error: `Failed to create progress: ${insertErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    progress = inserted;
  } else {
    await adminClient
      .from("shipment_backfill_progress")
      .update({ state: "running", last_error: null })
      .eq("id", progress.id);
  }

  // Get seller authorization (prefer US/NA).
  const { data: authRows, error: authError } = await adminClient
    .from("seller_authorizations")
    .select("refresh_token, marketplace_id, seller_id, created_at")
    .eq("user_id", userId);
  if (authError || !authRows || authRows.length === 0) {
    const msg = "No Amazon seller authorization found";
    await adminClient
      .from("shipment_backfill_progress")
      .update({ state: "failed", last_error: msg })
      .eq("id", progress.id);
    return new Response(JSON.stringify({ state: "failed", error: msg }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const NA_MARKETPLACES = ["ATVPDKIKX0DER", "A2EUQ1WTGCTBG2", "A1AM78C64UM0Y8", "A2Q3Y263D00KWC"];
  const auth =
    authRows.find((r: any) => r.marketplace_id === "ATVPDKIKX0DER") ||
    authRows.find((r: any) => NA_MARKETPLACES.includes(r.marketplace_id)) ||
    authRows[0];
  const marketplaceId = auth.marketplace_id || "ATVPDKIKX0DER";

  let accessToken: string;
  try {
    accessToken = await getLwaAccessToken(auth.refresh_token);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    await adminClient
      .from("shipment_backfill_progress")
      .update({ state: "failed", last_error: msg })
      .eq("id", progress.id);
    return new Response(JSON.stringify({ state: "failed", error: msg }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const startISO = new Date(windowStart).toISOString();
  const endISO = new Date(windowEnd).toISOString();

  let pagesThisCall = 0;
  let pagesProcessed = progress.pages_processed ?? 0;
  let shipmentsFound = progress.shipments_found ?? 0;
  let shipmentsUpserted = progress.shipments_upserted ?? 0;
  let itemsUpserted = progress.items_upserted ?? 0;
  let nextToken: string | null = progress.next_token ?? null;
  let nextPage: number = progress.next_page ?? 1;

  try {
    while (pagesThisCall < maxPagesPerCall) {
      const params = new URLSearchParams({ MarketplaceId: marketplaceId });
      params.set("QueryType", "DATE_RANGE");
      params.set("LastUpdatedAfter", startISO);
      params.set("LastUpdatedBefore", endISO);
      params.set("ShipmentStatusList", shipmentStatus);
      if (nextToken) params.set("NextToken", nextToken);

      const url =
        `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments?${params.toString()}`;
      console.log(
        `[chunk] user=${userId} status=${shipmentStatus} window=${windowStart}..${windowEnd} page=${nextPage}`,
      );

      const response = await callSpApi("GET", url, accessToken);
      const shipments = Array.isArray(response.payload?.ShipmentData)
        ? response.payload.ShipmentData
        : [];
      const newToken =
        typeof response.payload?.NextToken === "string" && response.payload.NextToken.length > 0
          ? (response.payload.NextToken as string)
          : null;

      shipmentsFound += shipments.length;

      // Upsert shipments (bounded chunk).
      for (const shipment of shipments) {
        const { error: shipUpsertErr } = await adminClient.from("fba_shipments").upsert(
          {
            user_id: userId,
            shipment_id: shipment.ShipmentId,
            shipment_name: shipment.ShipmentName,
            shipment_status: shipment.ShipmentStatus,
            destination_fulfillment_center_id: shipment.DestinationFulfillmentCenterId,
            label_prep_type: shipment.LabelPrepType,
            are_cases_required: shipment.AreCasesRequired,
            box_contents_source: shipment.BoxContentsSource,
            confirmed_need_by_date: shipment.ConfirmedNeedByDate,
          },
          { onConflict: "user_id,shipment_id" },
        );
        if (!shipUpsertErr) shipmentsUpserted++;
      }

      // Items per shipment (sequential to respect SP-API quota).
      for (const shipment of shipments) {
        try {
          const itemsUrl =
            `https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments/${shipment.ShipmentId}/items?MarketplaceId=${marketplaceId}`;
          const itemsResp = await callSpApi("GET", itemsUrl, accessToken);
          const items = Array.isArray(itemsResp.payload?.ItemData)
            ? itemsResp.payload.ItemData
            : [];
          for (const item of items) {
            const { error: itemErr } = await adminClient.from("fba_shipment_items").upsert(
              {
                user_id: userId,
                shipment_id: shipment.ShipmentId,
                seller_sku: item.SellerSKU,
                fnsku: item.FulfillmentNetworkSKU,
                quantity_shipped: item.QuantityShipped,
                quantity_received: item.QuantityReceived,
                quantity_in_case: item.QuantityInCase,
              },
              { onConflict: "user_id,shipment_id,seller_sku" },
            );
            if (!itemErr) itemsUpserted++;
          }
          await new Promise((r) => setTimeout(r, 250));
        } catch (itemErr: any) {
          console.error(
            `[chunk] items error shipment=${shipment.ShipmentId}: ${itemErr?.message ?? itemErr}`,
          );
          // Soft-fail items: continue with remaining shipments.
        }
      }

      pagesThisCall++;
      pagesProcessed++;
      nextPage++;
      nextToken = newToken;

      // Persist progress after every page so a shutdown is recoverable.
      await adminClient
        .from("shipment_backfill_progress")
        .update({
          next_page: nextPage,
          next_token: nextToken,
          pages_processed: pagesProcessed,
          shipments_found: shipmentsFound,
          shipments_upserted: shipmentsUpserted,
          items_upserted: itemsUpserted,
          state: nextToken ? "running" : "complete",
          completed_at: nextToken ? null : new Date().toISOString(),
          last_error: null,
        })
        .eq("id", progress.id);

      if (!nextToken) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    const hasMore = !!nextToken;
    return new Response(
      JSON.stringify({
        state: hasMore ? "running" : "complete",
        pagesProcessed,
        shipmentsFound,
        shipmentsUpserted,
        itemsUpserted,
        hasMore,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const isQuota =
      /QuotaExceeded|Throttl/i.test(msg) || (e as any)?.status === 429;
    // For quota errors leave state=running so caller can retry; otherwise mark failed.
    await adminClient
      .from("shipment_backfill_progress")
      .update({
        state: isQuota ? "running" : "failed",
        last_error: msg.slice(0, 500),
        next_page: nextPage,
        next_token: nextToken,
        pages_processed: pagesProcessed,
        shipments_found: shipmentsFound,
        shipments_upserted: shipmentsUpserted,
        items_upserted: itemsUpserted,
      })
      .eq("id", progress.id);
    return new Response(
      JSON.stringify({
        state: isQuota ? "running" : "failed",
        error: msg,
        retryable: isQuota,
        pagesProcessed,
        shipmentsFound,
        shipmentsUpserted,
        itemsUpserted,
        hasMore: !!nextToken,
      }),
      {
        status: isQuota ? 429 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
