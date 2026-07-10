// Phase C4 — Manual / on-demand inbound-plan dry-run.
//
// Strong guardrails:
//  • User-authenticated only (no service-role caller, no cron).
//  • Listing must already be ACTIVE (Stages 1-5 passed).
//  • Requires a complete ship-from address on the user's profile.
//  • Creates an inbound plan with the smallest possible payload (1 SKU, qty 1)
//    and IMMEDIATELY cancels it.
//  • If Amazon accepts the plan but the cancel call fails, the listing is NOT
//    promoted; we write a row to `inbound_dry_run_alerts` so the user sees a
//    real Amazon plan was left open and can clean it up in Seller Central.
//  • Auditable: every step (CREATE_REQUEST / CREATE_RESPONSE / CANCEL_REQUEST /
//    CANCEL_RESPONSE / DRY_RUN_PASSED / DRY_RUN_FAILED / CANCEL_FAILED) is
//    written to `listing_validation_audit`.
//  • On dry-run failure the listing remains active; the failed precheck is
//    recorded on inbound_dry_run_status/error without hiding the listing.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---------- SP-API helpers (mirrors create-inbound-plan) ----------
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
    throw new Error("AWS credentials not configured");
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
  const payloadHashHex = Array.from(new Uint8Array(payloadHash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;
  const canonicalRequestHash = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest));
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHashHex}`;
  const hmacSha256 = async (key: ArrayBuffer | Uint8Array, data: Uint8Array): Promise<ArrayBuffer> => {
    const k = await crypto.subtle.importKey("raw", key as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return await crypto.subtle.sign("HMAC", k, data as any);
  };
  const sigKey = await (async () => {
    const kDate = await hmacSha256(encoder.encode("AWS4" + awsSecretAccessKey), encoder.encode(date));
    const kRegion = await hmacSha256(kDate, encoder.encode(awsRegion));
    const kService = await hmacSha256(kRegion, encoder.encode(service));
    return await hmacSha256(kService, encoder.encode("aws4_request"));
  })();
  const signature = await hmacSha256(sigKey, encoder.encode(stringToSign));
  const signatureHex = Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
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
  const clientId = Deno.env.get("LWA_CLIENT_ID") ?? Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("LWA_CLIENT_SECRET") ?? Deno.env.get("SPAPI_LWA_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("LWA credentials not configured");
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!r.ok) throw new Error(`Failed to refresh token: ${await r.text()}`);
  return (await r.json()).access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- Auth: user JWT REQUIRED. No service-role / cron callers. ----
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const token = authHeader.replace("Bearer ", "");
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const user = userData.user;

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const listingId = String(body?.listingId || "").trim();
  if (!listingId) {
    return new Response(JSON.stringify({ error: "listingId is required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const audit = async (event: string, payload: Record<string, unknown>) => {
    try {
      await supabase.from("listing_validation_audit").insert({
        listing_id: listingId,
        user_id: user.id,
        stage: "inbound_dry_run",
        event,
        payload,
      });
    } catch (e) { console.error("audit failed", e); }
  };

  // ---- Load listing & enforce gates ----
  const { data: listing, error: lErr } = await supabase
    .from("created_listings")
    .select("id, user_id, asin, sku, fnsku, marketplace_id, validation_status, inbound_dry_run_status")
    .eq("id", listingId)
    .maybeSingle();

  if (lErr || !listing) {
    return new Response(JSON.stringify({ error: "Listing not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (listing.user_id !== user.id) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (listing.validation_status !== "ACTIVE") {
    return new Response(JSON.stringify({ error: `Listing must be ACTIVE before dry-run (currently ${listing.validation_status})` }), {
      status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (listing.inbound_dry_run_status === "RUNNING") {
    return new Response(JSON.stringify({ error: "A dry-run is already in progress for this listing" }), {
      status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!listing.fnsku) {
    const message = "No FNSKU on file yet. Amazon assigns the FNSKU after listing creation — re-run this precheck once the listing is live.";
    await supabase.from("created_listings").update({
      inbound_dry_run_status: "NOT_RUN",
      inbound_dry_run_error: message,
    }).eq("id", listingId);
    await supabase.from("fba_readiness_cache").upsert({
      user_id: user.id,
      asin: listing.asin,
      marketplace: listing.marketplace_id || "US",
      stage: "inbound_dry_run",
      status: "warn",
      reason: message,
      checked_at: new Date().toISOString(),
    }, { onConflict: "user_id,asin,marketplace,stage" });
    await audit("DRY_RUN_NOT_READY", { reason: "FNSKU_PENDING" });
    return new Response(JSON.stringify({ ok: false, status: "NOT_READY", reason: message }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ---- Require ship-from address on profile ----
  const { data: profile } = await supabase
    .from("profiles")
    .select("contact_name, first_name, last_name, address_line1, city, state_code, postal_code, country_code, phone")
    .eq("id", user.id)
    .maybeSingle();

  const missing: string[] = [];
  if (!profile?.address_line1) missing.push("addressLine1");
  if (!profile?.city) missing.push("city");
  if (!profile?.state_code) missing.push("stateOrProvinceCode");
  if (!profile?.postal_code) missing.push("postalCode");
  if (!profile?.country_code) missing.push("countryCode");
  if (missing.length > 0) {
    await audit("BLOCKED_NO_ADDRESS", { missing });
    return new Response(JSON.stringify({
      error: "Ship-from address required",
      detail: `Set ${missing.join(", ")} on your profile before running an inbound dry-run.`,
    }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ---- Mark RUNNING (idempotency lock) ----
  const { error: lockErr } = await supabase
    .from("created_listings")
    .update({ inbound_dry_run_status: "RUNNING", inbound_dry_run_error: null })
    .eq("id", listingId)
    .eq("inbound_dry_run_status", listing.inbound_dry_run_status); // optimistic lock
  if (lockErr) {
    return new Response(JSON.stringify({ error: "Could not lock listing for dry-run" }), {
      status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ---- SP-API credentials ----
  const refreshToken = Deno.env.get("SPAPI_REFRESH_TOKEN");
  const marketplaceId = listing.marketplace_id || Deno.env.get("SPAPI_MARKETPLACE_ID") || "ATVPDKIKX0DER";
  if (!refreshToken) {
    await supabase.from("created_listings").update({
      inbound_dry_run_status: "NOT_RUN",
      inbound_dry_run_error: "SPAPI_REFRESH_TOKEN not configured",
    }).eq("id", listingId);
    return new Response(JSON.stringify({ error: "SPAPI_REFRESH_TOKEN not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(refreshToken);
  } catch (e) {
    await supabase.from("created_listings").update({
      inbound_dry_run_status: "NOT_RUN",
      inbound_dry_run_error: `LWA error: ${(e as Error).message}`,
    }).eq("id", listingId);
    return new Response(JSON.stringify({ error: "Auth error", detail: (e as Error).message }), {
      status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ---- Build minimal create payload ----
  const sourceAddress = {
    name: profile?.contact_name || profile?.first_name || "Seller",
    addressLine1: profile!.address_line1!,
    city: profile!.city!,
    stateOrProvinceCode: profile!.state_code!,
    postalCode: profile!.postal_code!,
    countryCode: profile!.country_code || "US",
    phoneNumber: ((profile?.phone || "").trim() || "0000000000"),
  };
  const createBody = {
    destinationMarketplaces: [marketplaceId],
    sourceAddress,
    items: [{
      msku: listing.sku,
      quantity: 1,
      prepOwner: "NONE",
      labelOwner: "NONE",
    }],
  };
  const createPath = "/inbound/fba/2024-03-20/inboundPlans";
  await audit("CREATE_REQUEST", { path: createPath, body: createBody });

  // ---- Call createInboundPlan ----
  let createResp: Response;
  let createText = "";
  let inboundPlanId: string | null = null;
  try {
    createResp = await spApiSignedFetch({
      method: "POST",
      path: createPath,
      accessToken,
      bodyString: JSON.stringify(createBody),
    });
    createText = await createResp.text();
  } catch (e) {
    await supabase.from("created_listings").update({
      inbound_dry_run_status: "FAILED",
      inbound_dry_run_at: new Date().toISOString(),
      inbound_dry_run_error: `Network error: ${(e as Error).message}`,
    }).eq("id", listingId);
    await audit("DRY_RUN_FAILED", { reason: "NETWORK_ERROR", error: (e as Error).message });
    return new Response(JSON.stringify({ ok: false, error: "Network error" }), {
      status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let createJson: any = null;
  try { createJson = createText ? JSON.parse(createText) : null; } catch { /* keep raw */ }
  inboundPlanId = createJson?.inboundPlanId || createJson?.payload?.inboundPlanId || null;

  await audit("CREATE_RESPONSE", { status: createResp.status, inboundPlanId, body: createJson ?? createText.slice(0, 4000) });

  // ---- If create failed: dry-run failed, no plan to cancel ----
  if (!createResp.ok || !inboundPlanId) {
    const reasonText = (createJson?.errors && Array.isArray(createJson.errors))
      ? createJson.errors.map((e: any) => e?.message || JSON.stringify(e)).join(" | ")
      : (createText || `HTTP ${createResp.status}`);
    await supabase.from("created_listings").update({
      inbound_dry_run_status: "FAILED",
      inbound_dry_run_at: new Date().toISOString(),
      inbound_dry_run_error: reasonText.slice(0, 2000),
    }).eq("id", listingId);
    await supabase.from("fba_readiness_cache").upsert({
      user_id: user.id,
      asin: listing.asin,
      marketplace: marketplaceId,
      stage: "inbound_dry_run",
      status: "warn",
      reason: reasonText.slice(0, 1000),
      checked_at: new Date().toISOString(),
    }, { onConflict: "user_id,asin,marketplace,stage" });
    await audit("DRY_RUN_FAILED", { reason: "CREATE_REJECTED", http: createResp.status, message: reasonText });
    return new Response(JSON.stringify({ ok: false, status: "FAILED", reason: reasonText }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ---- Plan was created. CANCEL IMMEDIATELY. ----
  const cancelPath = `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/cancellation`;
  await audit("CANCEL_REQUEST", { path: cancelPath, inboundPlanId });

  let cancelOk = false;
  let cancelError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const cancelResp = await spApiSignedFetch({
        method: "PUT",
        path: cancelPath,
        accessToken,
      });
      const cancelText = await cancelResp.text();
      await audit("CANCEL_RESPONSE", { attempt, status: cancelResp.status, body: cancelText.slice(0, 2000) });
      // Amazon returns 202 with operationId on success.
      if (cancelResp.ok || cancelResp.status === 202) {
        cancelOk = true;
        break;
      }
      cancelError = `HTTP ${cancelResp.status}: ${cancelText.slice(0, 500)}`;
    } catch (e) {
      cancelError = `Network: ${(e as Error).message}`;
      await audit("CANCEL_EXCEPTION", { attempt, error: cancelError });
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }

  if (!cancelOk) {
    // SAFETY: real plan left open. Do NOT promote. Alert the user.
    await supabase.from("inbound_dry_run_alerts").insert({
      user_id: user.id,
      listing_id: listingId,
      asin: listing.asin,
      sku: listing.sku,
      marketplace: marketplaceId,
      inbound_plan_id: inboundPlanId,
      alert_type: "CANCEL_FAILED",
      cancel_error: cancelError.slice(0, 1000),
      raw: { createResponse: createJson, lastCancelError: cancelError },
    });
    await supabase.from("created_listings").update({
      inbound_dry_run_status: "FAILED",
      inbound_dry_run_at: new Date().toISOString(),
      inbound_dry_run_plan_id: inboundPlanId,
      inbound_dry_run_error: `Created plan ${inboundPlanId} but cancel failed: ${cancelError}`,
      // Do NOT change validation_status — listing is still valid; the plan
      // itself is the open issue. User must cancel it manually in Seller Central.
    }).eq("id", listingId);
    await audit("CANCEL_FAILED", { inboundPlanId, error: cancelError });
    return new Response(JSON.stringify({
      ok: false,
      status: "CANCEL_FAILED",
      inboundPlanId,
      message: `Inbound plan ${inboundPlanId} was created but could not be cancelled. Cancel it manually in Seller Central.`,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ---- Plan created and cancelled cleanly: PASSED ----
  await supabase.from("created_listings").update({
    inbound_dry_run_status: "PASSED",
    inbound_dry_run_at: new Date().toISOString(),
    inbound_dry_run_plan_id: inboundPlanId,
    inbound_dry_run_error: null,
  }).eq("id", listingId);

  await supabase.from("fba_readiness_cache").upsert({
    user_id: user.id,
    asin: listing.asin,
    marketplace: marketplaceId,
    stage: "inbound_dry_run",
    status: "ok",
    reason: null,
    checked_at: new Date().toISOString(),
  }, { onConflict: "user_id,asin,marketplace,stage" });

  await audit("DRY_RUN_PASSED", { inboundPlanId });

  return new Response(JSON.stringify({
    ok: true,
    status: "PASSED",
    inboundPlanId,
  }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
