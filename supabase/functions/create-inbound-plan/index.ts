import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface BoxItem {
  productId: string;
  sku: string;
  quantityInThisBox: number;
}

interface Box {
  boxIndex: number;
  items: BoxItem[];
  weight: number;
  weightUnit: "lb" | "kg";
}

interface Product {
  sku: string;
  asin: string;
  fnsku?: string | null;
  title: string;
  quantity: number;
  expirationDate?: string | null;
  prepCategory?: string | null; // e.g., 'NO_PREP', 'POLYBAGGING', 'GRANULAR', etc.
}

interface BoxDimensions {
  length: number;
  width: number;
  height: number;
  dimensionUnit: "in" | "cm";
}

interface ShipmentData {
  shipmentId: string;
  numberOfBoxes: number;
  boxDimensions: BoxDimensions;
  boxes: Box[];
  products: Product[];
  sourceAddress?: {
    businessName?: string;
    name?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    stateOrProvinceCode?: string;
    postalCode?: string;
    countryCode?: string;
    phone?: string;
  };
}

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
    const cryptoKey = await crypto.subtle.importKey("raw", key as any,
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
  const clientId = Deno.env.get("LWA_CLIENT_ID") ?? Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("LWA_CLIENT_SECRET") ?? Deno.env.get("SPAPI_LWA_CLIENT_SECRET");

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
    console.error("Token refresh failed:", error);
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
    const globalMarketplaceId = Deno.env.get("SPAPI_MARKETPLACE_ID") || "ATVPDKIKX0DER";
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

    const body = await req.json();
    // Handle both { shipmentData: {...} } and direct {...} formats
    const shipmentData: Partial<ShipmentData> = (body?.shipmentData ?? body) as Partial<ShipmentData>;

    const products = Array.isArray((shipmentData as any)?.products) ? ((shipmentData as any).products as Product[]) : null;

    if (!products) {
      console.error("Invalid shipmentData payload (missing products array)", {
        topLevelKeys: body && typeof body === "object" ? Object.keys(body) : typeof body,
        shipmentDataKeys:
          shipmentData && typeof shipmentData === "object" ? Object.keys(shipmentData as Record<string, unknown>) : typeof shipmentData,
      });

      return new Response(
        JSON.stringify({
          error: "Invalid shipment payload",
          details: "Expected shipmentData.products to be an array.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log("Creating inbound plan with products:", products.length);

    // ============================================================
    // PRE-FLIGHT VALIDATION + PER-ITEM DEBUG TRACE
    // ============================================================
    // Build a per-item debug record so we can see exactly what is being
    // sent to Amazon vs what came from inventory. This is the fastest way
    // to catch MSKU mapping mistakes (sending ASIN/FNSKU/UPC instead of
    // the Seller Central SKU).
    const ASIN_RE = /^B0[A-Z0-9]{8}$/i;             // Amazon ASIN
    const FNSKU_RE = /^X00[A-Z0-9]{7}$/i;            // Amazon FNSKU (X00...)
    const UPC_RE = /^\d{12,14}$/;                    // raw UPC/EAN

    const validationIssues: Array<{ index: number; asin: string; sku: string; issue: string }> = [];
    const itemDebug = products.map((product, idx) => {
      const sku = (product.sku ?? "").toString().trim();
      const asin = (product.asin ?? "").toString().trim();
      const fnsku = (product.fnsku ?? "").toString().trim() || null;
      const qty = Number(product.quantity);

      const looksLikeAsin = sku && ASIN_RE.test(sku);
      const looksLikeFnsku = sku && FNSKU_RE.test(sku);
      const looksLikeUpc = sku && UPC_RE.test(sku);
      const sameAsAsin = sku && asin && sku.toUpperCase() === asin.toUpperCase();
      const sameAsFnsku = sku && fnsku && sku.toUpperCase() === fnsku.toUpperCase();

      const issues: string[] = [];
      if (!sku) issues.push("missing_msku");
      if (looksLikeAsin || sameAsAsin) issues.push("msku_looks_like_asin");
      if (looksLikeFnsku || sameAsFnsku) issues.push("msku_looks_like_fnsku");
      if (looksLikeUpc) issues.push("msku_looks_like_upc");
      if (!Number.isFinite(qty) || qty <= 0) issues.push("invalid_quantity");

      issues.forEach((iss) => validationIssues.push({ index: idx, asin, sku, issue: iss }));

      return {
        index: idx,
        asin,
        title: product.title,
        inventory_sku: sku,           // what the app pulled from inventory
        msku_sent_to_amazon: sku,     // what we will send (must match Seller Central Manage Inventory)
        fnsku,
        quantity: qty,
        prepOwner: "SELLER",          // initial — may flip to NONE on retry
        marketplaceId: globalMarketplaceId,
        sellerId: globalSellerId,
        looks_like_asin: looksLikeAsin || sameAsAsin,
        looks_like_fnsku: looksLikeFnsku || sameAsFnsku,
        looks_like_upc: looksLikeUpc,
      };
    });

    console.log("[CREATE_INBOUND_PLAN] Per-item debug trace:", JSON.stringify(itemDebug, null, 2));
    console.log("[CREATE_INBOUND_PLAN] Marketplace:", globalMarketplaceId, "Seller:", globalSellerId);

    // Block creation if any item has invalid quantity or the MSKU is clearly wrong format.
    const hardBlockers = validationIssues.filter((v) =>
      ["missing_msku", "invalid_quantity", "msku_looks_like_asin", "msku_looks_like_fnsku", "msku_looks_like_upc"].includes(v.issue),
    );
    if (hardBlockers.length > 0) {
      console.error("[CREATE_INBOUND_PLAN] Blocked — invalid MSKU or quantity:", hardBlockers);
      return new Response(
        JSON.stringify({
          error: "Invalid item payload",
          message:
            "One or more items have an invalid MSKU or quantity. The MSKU must match the SKU in Seller Central → Manage Inventory (not ASIN, FNSKU, or UPC).",
          validationIssues: hardBlockers,
          itemDebug,
          stepResults: [
            {
              step: "createInboundPlan",
              endpoint: "/inbound/fba/2024-03-20/inboundPlans",
              success: false,
              httpStatus: 400,
              code: "INVALID_MSKU_OR_QUANTITY",
              message:
                "Blocked locally: MSKU looks like an ASIN/FNSKU/UPC or quantity is invalid. Verify the SKU in Seller Central.",
              validationIssues: hardBlockers,
              itemDebug,
            },
          ],
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const accessToken = await getAccessToken(globalRefreshToken);

    // ============================================================
    // STEP 0: setPrepDetails — register prep classification per MSKU
    // ============================================================
    // Amazon's createInboundPlan now requires every MSKU to have a prep
    // classification on file. If it's missing the operation accepts the
    // request (HTTP 202) and then fails async with:
    //   "ERROR: Prep classification for this SKU was missing."
    // We POST /inbound/fba/2024-03-20/items/prepDetails with each MSKU's
    // prepCategory (defaulting to NONE = no prep required) BEFORE creating the plan.
    // Docs: https://developer-docs.amazon.com/sp-api/reference/setprepdetails
    // Valid enum (per Amazon error): GRANULAR, SET, FC_PROVIDED, SMALL, UNKNOWN,
    // SHARP, FRAGILE, TEXTILE, BABY, NONE, ADULT, LIQUID, PERFORATED, HANGER.
    // NOTE: "NO_PREP" is NOT a valid value — must use "NONE".
    const VALID_PREP_CATEGORIES = new Set([
      "ADULT", "BABY", "FC_PROVIDED", "FRAGILE", "GRANULAR", "HANGER",
      "LIQUID", "NONE", "PERFORATED", "SET", "SHARP", "SMALL", "TEXTILE", "UNKNOWN",
    ]);
    // Map any legacy aliases (e.g., "NO_PREP") to the correct enum value.
    const PREP_ALIAS: Record<string, string> = {
      NO_PREP: "NONE",
      NONE_REQUIRED: "NONE",
      POLYBAGGING: "UNKNOWN",
      HAZMAT: "NONE", // not in current enum; fall back to NONE
      OTHER: "UNKNOWN",
    };
    const PREP_TYPES_BY_CATEGORY: Record<string, string[]> = {
      NONE: ["ITEM_NO_PREP"],
      FRAGILE: ["ITEM_BUBBLEWRAP"],
      HANGER: ["ITEM_HANG_GARMENT"],
      LIQUID: ["ITEM_POLYBAGGING"],
      SET: ["ITEM_SET_CREATION"],
      SHARP: ["ITEM_BUBBLEWRAP"],
      TEXTILE: ["ITEM_POLYBAGGING"],
      UNKNOWN: ["ITEM_POLYBAGGING"],
    };
    const mskuPrepDetails = products
      .map((p) => {
        const msku = (p.sku ?? "").toString().trim();
        if (!msku) return null;
        const raw = (p.prepCategory ?? "NONE").toString().trim().toUpperCase();
        const aliased = PREP_ALIAS[raw] ?? raw;
        const prepCategory = VALID_PREP_CATEGORIES.has(aliased) ? aliased : "NONE";
        const prepTypes = PREP_TYPES_BY_CATEGORY[prepCategory] ?? ["ITEM_LABELING"];
        return { msku, prepCategory, prepTypes };
      })
      .filter((x): x is { msku: string; prepCategory: string; prepTypes: string[] } => x !== null);

    const lockedAmazonPrepSkus = new Set<string>();
    const parseLockedPrepSkus = (responseText: string): Array<{ msku: string; existingCategory: string }> => {
      const locked: Array<{ msku: string; existingCategory: string }> = [];
      try {
        const parsed = JSON.parse(responseText);
        const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
        for (const err of errors) {
          const message = typeof err?.message === "string" ? err.message : "";
          const match = message.match(/msku\s+(.+?)\s+with existing prep category of\s+([A-Z_]+)/i);
          if (match) locked.push({ msku: match[1].trim(), existingCategory: match[2].trim().toUpperCase() });
        }
      } catch {
        // ignore non-JSON Amazon response
      }
      return locked;
    };

    let prepDetailsStepResult: Record<string, unknown> | null = null;
    if (mskuPrepDetails.length > 0) {
      let activeMskuPrepDetails = mskuPrepDetails;
      const prepAttempts: Array<Record<string, unknown>> = [];
      try {
        const callSetPrepDetails = async (details: typeof mskuPrepDetails) => {
          const prepBody = {
            marketplaceId: globalMarketplaceId,
            mskuPrepDetails: details,
          };
          console.log("[setPrepDetails] body:", JSON.stringify(prepBody));
          const prepResp = await spApiSignedFetch({
            method: "POST",
            path: "/inbound/fba/2024-03-20/items/prepDetails",
            accessToken,
            bodyString: JSON.stringify(prepBody),
          });
          const prepText = await prepResp.text();
          console.log(`[setPrepDetails] response ${prepResp.status}:`, prepText.slice(0, 500));
          prepAttempts.push({ httpStatus: prepResp.status, ok: prepResp.ok, response: prepText.slice(0, 500), mskuCount: details.length });
          return { prepResp, prepText };
        };

        let { prepResp, prepText } = await callSetPrepDetails(activeMskuPrepDetails);
        const lockedSkus = !prepResp.ok ? parseLockedPrepSkus(prepText) : [];
        if (!prepResp.ok && lockedSkus.length > 0) {
          for (const locked of lockedSkus) {
            if (locked.existingCategory === "FC_PROVIDED") lockedAmazonPrepSkus.add(locked.msku);
          }
          const lockedMskus = new Set(lockedSkus.map((locked) => locked.msku));
          activeMskuPrepDetails = activeMskuPrepDetails.filter((detail) => !lockedMskus.has(detail.msku));
          if (activeMskuPrepDetails.length > 0) {
            console.log("[setPrepDetails] retrying without locked MSKUs:", Array.from(lockedMskus));
            ({ prepResp, prepText } = await callSetPrepDetails(activeMskuPrepDetails));
          }
        }

        prepDetailsStepResult = {
          step: "setPrepDetails",
          endpoint: "/inbound/fba/2024-03-20/items/prepDetails",
          success: prepResp.ok,
          status: prepResp.ok ? (lockedSkus.length > 0 ? "partial_success" : "success") : "failed",
          httpStatus: prepResp.status,
          message: prepResp.ok
            ? lockedSkus.length > 0
              ? `Registered prep classification for ${activeMskuPrepDetails.length} MSKU(s); skipped ${lockedSkus.length} SKU(s) whose Amazon prep category is already locked.`
              : `Registered prep classification for ${activeMskuPrepDetails.length} MSKU(s).`
            : `Amazon rejected setPrepDetails: ${prepText.slice(0, 300)}`,
          mskuPrepDetails: activeMskuPrepDetails,
          skippedLockedPrepSkus: lockedSkus,
          attempts: prepAttempts,
        };
        // Don't hard-fail on a setPrepDetails error — Amazon may still accept
        // the inbound plan if prep was already on file. We surface the diag.
      } catch (e) {
        console.warn("[setPrepDetails] exception:", e instanceof Error ? e.message : String(e));
        prepDetailsStepResult = {
          step: "setPrepDetails",
          endpoint: "/inbound/fba/2024-03-20/items/prepDetails",
          success: false,
          status: "failed",
          message: `setPrepDetails threw: ${e instanceof Error ? e.message : String(e)}`,
          mskuPrepDetails: activeMskuPrepDetails,
          attempts: prepAttempts,
        };
      }
    }

    // Build the items array for the inbound plan.
    // Some items require prepOwner = NONE (no prep needed) — sending SELLER causes a 400.
    // Same applies to labelOwner: some MSKUs do not require seller labeling, accepted value is NONE.
    // We start with SELLER for both, and if Amazon rejects with a "does not require prepOwner/labelOwner"
    // error pointing at specific MSKUs, we retry those items with the corresponding owner = NONE.
    const buildItems = (
      list: Product[],
      prepOverrides: Record<string, "SELLER" | "AMAZON" | "NONE">,
      labelOverrides: Record<string, "SELLER" | "AMAZON" | "NONE">,
    ) =>
      list.map((product) => {
        // Default to SELLER for all items. Amazon-locked prep SKUs (FC_PROVIDED) often can't use
        // AMAZON prep in some destination regions, so SELLER is the safer default; the retry loop
        // will flip to NONE if Amazon says prep isn't required.
        const prepOwner = prepOverrides[product.sku] ?? "SELLER";
        const labelOwner = labelOverrides[product.sku] ?? "SELLER";
        const item: Record<string, unknown> = {
          msku: product.sku,
          quantity: product.quantity,
          labelOwner,
        };
        // SP-API: when prep is not required, send prepOwner = NONE explicitly.
        item.prepOwner = prepOwner;
        // Include expiration date for items that require it (food, supplements, etc.)
        // SP-API expects YYYY-MM-DD format under the `expiration` field.
        if (product.expirationDate) {
          const raw = String(product.expirationDate).trim();
          // Normalize MM/DD/YYYY -> YYYY-MM-DD if needed
          let normalized = raw;
          const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (mdy) {
            const [, mm, dd, yyyy] = mdy;
            normalized = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
          }
          if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
            item.expiration = normalized;
          }
        }
        return item;
      });

    let prepOverrides: Record<string, "SELLER" | "AMAZON" | "NONE"> = {};
    let labelOverrides: Record<string, "SELLER" | "AMAZON" | "NONE"> = {};
    let items = buildItems(products, prepOverrides, labelOverrides);

    console.log("Built inbound items:", JSON.stringify(items, null, 2));

    // Get source address from profile or use provided
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    const sourceAddress: any = shipmentData.sourceAddress || {
      name: profile?.contact_name || profile?.first_name || "Seller",
      addressLine1: profile?.address_line1 || "123 Main St",
      city: profile?.city || "Seattle",
      stateOrProvinceCode: profile?.state_code || "WA",
      postalCode: profile?.postal_code || "98101",
      countryCode: profile?.country_code || "US",
    };

    // Build phone number - SP-API requires non-empty phoneNumber (handle empty strings too)
    const rawPhone = (sourceAddress.phone || "").trim() || (profile?.phone || "").trim();
    const phoneNumber = rawPhone.length > 0 ? rawPhone : "0000000000";

    const buildRequestBody = (currentItems: typeof items) => ({
      destinationMarketplaces: [globalMarketplaceId],
      items: currentItems,
      sourceAddress: {
        name: sourceAddress.name || sourceAddress.businessName || "Seller",
        addressLine1: sourceAddress.addressLine1 || "",
        addressLine2: sourceAddress.addressLine2 || undefined,
        city: sourceAddress.city || "",
        stateOrProvinceCode: sourceAddress.stateOrProvinceCode || "",
        postalCode: sourceAddress.postalCode || "",
        countryCode: sourceAddress.countryCode || "US",
        phoneNumber,
      },
    });

    const createPath = "/inbound/fba/2024-03-20/inboundPlans";

    // Parse Amazon's "does not require <owner>" error → MSKUs that should flip to NONE.
    const parseOwnerMismatchSkus = (
      responseText: string,
      ownerKind: "prepOwner" | "labelOwner",
    ): string[] => {
      const skus = new Set<string>();
      try {
        const parsed = JSON.parse(responseText);
        const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
        for (const err of errors) {
          const message = typeof err?.message === "string" ? (err as Error).message : "";
          const re = new RegExp(`ERROR:\\s*(\\S+)\\s+does not require ${ownerKind}`, "i");
          const match = message.match(re);
          if (match) {
            const token = match[1];
            const matchedProduct = products.find((p) => p.sku === token);
            if (matchedProduct) {
              skus.add(matchedProduct.sku);
            } else {
              for (const p of products) skus.add(p.sku);
            }
          }
        }
      } catch { /* ignore */ }
      return Array.from(skus);
    };

    // Parse Amazon's "requires <owner> but NONE was assigned" error → MSKUs that must flip to SELLER.
    const parseOwnerRequiredSkus = (
      responseText: string,
      ownerKind: "prepOwner" | "labelOwner",
    ): string[] => {
      const skus = new Set<string>();
      try {
        const parsed = JSON.parse(responseText);
        const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
        for (const err of errors) {
          const message = typeof err?.message === "string" ? (err as Error).message : "";
          // Pattern: "ERROR: <msku> requires prepOwner but NONE was assigned. Accepted values: [AMAZON, SELLER]"
          const re = new RegExp(`ERROR:\\s*(\\S+)\\s+requires ${ownerKind}\\s+but\\s+NONE`, "i");
          const match = message.match(re);
          if (match) {
            const token = match[1];
            const matchedProduct = products.find((p) => p.sku === token);
            if (matchedProduct) skus.add(matchedProduct.sku);
            else for (const p of products) skus.add(p.sku);
          }
        }
      } catch { /* ignore */ }
      return Array.from(skus);
    };

    // Parse Amazon's "prep and labeling service is discontinued ... mskus:[...] and ownerType: PREP_OWNER"
    // → MSKUs that cannot use AMAZON prep and must fall back to SELLER.
    const parseAmazonPrepDiscontinuedSkus = (responseText: string): string[] => {
      const skus = new Set<string>();
      try {
        const parsed = JSON.parse(responseText);
        const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
        for (const err of errors) {
          const message = typeof err?.message === "string" ? (err as Error).message : "";
          if (!/prep and labeling service is discontinued/i.test(message)) continue;
          const listMatch = message.match(/mskus:\s*\[([^\]]+)\]/i);
          if (listMatch) {
            for (const raw of listMatch[1].split(",")) {
              const sku = raw.trim();
              if (sku) skus.add(sku);
            }
          }
        }
      } catch { /* ignore */ }
      return Array.from(skus);
    };

    const collectProblemText = (value: unknown): string[] => {
      if (!value) return [];
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.flatMap(collectProblemText);
      if (typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      return [item.code, item.message, item.details, item.errors, item.operationProblems, item.problems]
        .flatMap(collectProblemText);
    };

    const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const buildExpirationFailureContext = (sources: unknown[], currentItems: Array<Record<string, unknown>>) => {
      const amazonText = collectProblemText(sources).join(" | ");
      if (!/expiration\s+(date\s+)?required|expiry\s+(date\s+)?required/i.test(amazonText)) return null;

      const sentExpirationBySku = new Map(
        currentItems.map((item) => [String(item.msku ?? ""), Boolean(item.expiration)]),
      );
      const missingExpirationProducts = products
        .filter((product) => !sentExpirationBySku.get(String(product.sku ?? "")))
        .map((product) => ({
          sku: product.sku,
          asin: product.asin,
          title: product.title,
          expirationDate: product.expirationDate ?? null,
        }));
      const mentionedSkus = products
        .map((product) => String(product.sku ?? "").trim())
        .filter((sku) => sku && new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(sku)}([^A-Za-z0-9_-]|$)`, "i").test(amazonText));
      const likelyDateSensitive = missingExpirationProducts.filter((product) =>
        /food|grocery|beverage|drink|supplement|vitamin|pet|dog|cat|treat|salt|garlic|seasoning|sauce|snack|candy|coffee|tea|health|beauty|cosmetic|skincare|topical|personal[_\s-]?care/i.test(
          `${product.sku} ${product.title}`,
        ),
      );
      const suspectedProducts = mentionedSkus.length > 0
        ? missingExpirationProducts.filter((product) => mentionedSkus.includes(product.sku))
        : likelyDateSensitive.length > 0
          ? likelyDateSensitive
          : missingExpirationProducts;
      const skuList = suspectedProducts.slice(0, 20).map((product) => product.sku).filter(Boolean).join(", ");

      return {
        code: "EXPIRATION_DATE_REQUIRED",
        message: mentionedSkus.length > 0
          ? `Amazon requires an expiration date for SKU(s): ${skuList}.`
          : `Amazon says an expiration date is required but did not identify the exact SKU. Selected SKU(s) sent without expiration dates${likelyDateSensitive.length > 0 ? " that look date-sensitive" : ""}: ${skuList || "none"}.`,
        mentionedSkus,
        suspectedProducts: suspectedProducts.slice(0, 20),
        missingExpirationProducts: missingExpirationProducts.slice(0, 50),
        amazonMessage: amazonText.slice(0, 1000),
      };
    };

    const callCreate = async (currentItems: typeof items) => {
      const body = buildRequestBody(currentItems);
      console.log("Creating inbound plan with request:", JSON.stringify(body, null, 2));
      const resp = await spApiSignedFetch({
        method: "POST",
        path: createPath,
        accessToken,
        bodyString: JSON.stringify(body),
      });
      const text = await resp.text();
      console.log("Create inbound plan response:", resp.status, text);
      return { resp, text };
    };

    let { resp: createResponse, text: createText } = await callCreate(items);

    // Retry loop: handle prepOwner/labelOwner mismatches in either direction,
    // plus Amazon-prep-discontinued fallback (AMAZON → SELLER).
    let retryAttempts = 0;
    while (!createResponse.ok && createResponse.status === 400 && retryAttempts < 5) {
      const prepFlipToNone = parseOwnerMismatchSkus(createText, "prepOwner")
        .filter((sku) => prepOverrides[sku] !== "NONE");
      const labelFlipToNone = parseOwnerMismatchSkus(createText, "labelOwner")
        .filter((sku) => labelOverrides[sku] !== "NONE");
      const prepFlipToSeller = parseOwnerRequiredSkus(createText, "prepOwner")
        .filter((sku) => prepOverrides[sku] !== "SELLER");
      const labelFlipToSeller = parseOwnerRequiredSkus(createText, "labelOwner")
        .filter((sku) => labelOverrides[sku] !== "SELLER");
      const amazonPrepDiscontinued = parseAmazonPrepDiscontinuedSkus(createText);

      if (
        prepFlipToNone.length === 0 &&
        labelFlipToNone.length === 0 &&
        prepFlipToSeller.length === 0 &&
        labelFlipToSeller.length === 0 &&
        amazonPrepDiscontinued.length === 0
      ) break;

      if (prepFlipToNone.length > 0) {
        console.log("Retrying with prepOwner=NONE for MSKUs:", prepFlipToNone);
        for (const sku of prepFlipToNone) prepOverrides[sku] = "NONE";
      }
      if (labelFlipToNone.length > 0) {
        console.log("Retrying with labelOwner=NONE for MSKUs:", labelFlipToNone);
        for (const sku of labelFlipToNone) labelOverrides[sku] = "NONE";
      }
      if (prepFlipToSeller.length > 0) {
        console.log("Retrying with prepOwner=SELLER for MSKUs:", prepFlipToSeller);
        for (const sku of prepFlipToSeller) prepOverrides[sku] = "SELLER";
      }
      if (labelFlipToSeller.length > 0) {
        console.log("Retrying with labelOwner=SELLER for MSKUs:", labelFlipToSeller);
        for (const sku of labelFlipToSeller) labelOverrides[sku] = "SELLER";
      }
      if (amazonPrepDiscontinued.length > 0) {
        console.log("Amazon prep discontinued — flipping AMAZON→SELLER for MSKUs:", amazonPrepDiscontinued);
        for (const sku of amazonPrepDiscontinued) {
          prepOverrides[sku] = "SELLER";
          lockedAmazonPrepSkus.delete(sku); // ensure builder doesn't re-set to AMAZON
        }
      }

      items = buildItems(products, prepOverrides, labelOverrides);
      const retry = await callCreate(items);
      createResponse = retry.resp;
      createText = retry.text;
      retryAttempts += 1;
    }

    if (!createResponse.ok) {
      let amazonCode: string | undefined;
      let amazonMessage: string | undefined;
      try {
        const parsedError = JSON.parse(createText);
        const firstError = Array.isArray(parsedError?.errors) ? parsedError.errors[0] : undefined;
        amazonCode = typeof firstError?.code === "string" ? firstError.code : undefined;
        amazonMessage = typeof firstError?.message === "string" ? firstError.message : undefined;
      } catch {
        // Ignore JSON parsing errors and return raw response text below.
      }

      // Friendlier messages for the prep/label owner mismatch cases.
      let friendlyMessage = amazonMessage ?? "Amazon did not accept the inbound plan create request.";
      if (amazonMessage && /does not require prepOwner/i.test(amazonMessage)) {
        friendlyMessage = "Prep owner mismatch: this item does not require prep. Use prepOwner = NONE.";
      } else if (amazonMessage && /does not require labelOwner/i.test(amazonMessage)) {
        friendlyMessage = "Label owner mismatch: this item does not require seller labeling. Use labelOwner = NONE.";
      }

      const expirationContext = buildExpirationFailureContext([amazonMessage, createText], items);
      if (expirationContext) {
        amazonCode = expirationContext.code;
        friendlyMessage = expirationContext.message;
      }

      return new Response(JSON.stringify({ 
        error: friendlyMessage,
        details: createText,
        status: createResponse.status,
        code: amazonCode,
        message: friendlyMessage,
        expirationContext,
        itemDebug,
        marketplaceId: globalMarketplaceId,
        sellerId: globalSellerId,
        stepResults: [
          ...(prepDetailsStepResult ? [prepDetailsStepResult] : []),
          {
            step: "createInboundPlan",
            endpoint: createPath,
            success: false,
            httpStatus: createResponse.status,
            code: amazonCode,
            message: friendlyMessage,
            details: createText,
            expirationContext,
            itemDebug,
            marketplaceId: globalMarketplaceId,
            sellerId: globalSellerId,
          },
        ],
      }), {
        status: createResponse.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const createData = JSON.parse(createText);
    const operationId = createData.operationId;
    
    console.log("Inbound plan creation started, operationId:", operationId);

    const inboundPlanId = createData.inboundPlanId || "";

    if (!inboundPlanId) {
      return new Response(
        JSON.stringify({
          error: "Failed to create inbound plan",
          details: "Missing inboundPlanId in createInboundPlan response",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    console.log("Inbound plan accepted:", inboundPlanId);

    // Poll the operation endpoint to confirm Amazon actually processed the create
    // (HTTP 202 only means the request was accepted, not that the plan is usable).
    // Cap polling to ~25s to stay within edge function limits.
    let operationStatus: string = "IN_PROGRESS";
    let operationProblems: Array<{ code?: string; message?: string; severity?: string }> = [];
    if (operationId) {
      const opPath = `/inbound/fba/2024-03-20/operations/${encodeURIComponent(operationId)}`;
      const startedAt = Date.now();
      const maxMs = 25_000;
      let delayMs = 1500;
      while (Date.now() - startedAt < maxMs) {
        await new Promise((r) => setTimeout(r, delayMs));
        try {
          const opResp = await spApiSignedFetch({
            method: "GET",
            path: opPath,
            accessToken,
          });
          const opText = await opResp.text();
          if (opResp.ok) {
            const opJson = JSON.parse(opText);
            operationStatus = String(opJson?.operationStatus || "IN_PROGRESS");
            if (Array.isArray(opJson?.operationProblems)) {
              operationProblems = opJson.operationProblems;
            }
            console.log(`[poll] operationId=${operationId} status=${operationStatus}`);
            if (operationStatus === "SUCCESS" || operationStatus === "FAILED") break;
          } else {
            console.warn(`[poll] non-OK ${opResp.status}: ${opText.slice(0, 200)}`);
          }
        } catch (e) {
          console.warn(`[poll] error: ${e instanceof Error ? (e as Error).message : String(e)}`);
        }
        delayMs = Math.min(delayMs + 500, 4000);
      }
    }

    // Reflect final prepOwner / labelOwner overrides in the debug trace.
    const finalItemDebug = itemDebug.map((d) => ({
      ...d,
      prepOwner: prepOverrides[d.inventory_sku] ?? "SELLER",
      labelOwner: labelOverrides[d.inventory_sku] ?? "SELLER",
    }));

    // If Amazon reported the operation FAILED, surface it as an error so the UI
    // does not move forward to placement/transportation steps.
    if (operationStatus === "FAILED") {
      const problemMsgs = operationProblems
        .map((p) => p?.message || p?.code)
        .filter(Boolean)
        .join("; ");
      const expirationContext = buildExpirationFailureContext([operationProblems, problemMsgs], items);
      const failureCode = expirationContext?.code;
      const failureMessage = expirationContext?.message || problemMsgs || "Amazon accepted the request but the create operation finished with status FAILED.";
      // HEALTH SIGNAL: shipment ERRORED at Amazon (critical)
      await logHealthSignal({
        user_id: user.id, module: 'shipments', severity: 'critical', confidence: 'high',
        pattern: 'inbound_plan_error',
        title: 'Inbound plan errored at Amazon',
        impact: `Shipment plan ${inboundPlanId} failed at Amazon and cannot proceed.`,
        recommended_fix: 'Open Shipment Builder, fix the flagged items (often MSKU/expiration/prep) and recreate.',
        auto_fix_action: 'create-inbound-plan',
        entity: { marketplace: globalMarketplaceId, asin: items[0]?.msku || undefined } as any,
        function_name: 'create-inbound-plan', source: 'edge_runtime',
        raw_message: `inboundPlanId=${inboundPlanId} step=createInboundPlan ${failureMessage}`,
      });
      return new Response(
        JSON.stringify({
          error: failureMessage,
          details: problemMsgs || "Operation reported FAILED with no problem details.",
          code: failureCode,
          inboundPlanId,
          operationId,
          operationStatus,
          operationProblems,
          expirationContext,
          itemDebug: finalItemDebug,
          stepResults: [
            ...(prepDetailsStepResult ? [prepDetailsStepResult] : []),
            {
              step: "createInboundPlan",
              endpoint: createPath,
              success: false,
              httpStatus: createResponse.status,
              code: failureCode,
              message: failureMessage,
              inboundPlanId,
              operationId,
              operationStatus,
              operationProblems,
              expirationContext,
              itemDebug: finalItemDebug,
              marketplaceId: globalMarketplaceId,
              sellerId: globalSellerId,
            },
          ],
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const successMessage =
      operationStatus === "SUCCESS"
        ? "Amazon confirmed the inbound plan is ready (operation SUCCESS)."
        : "Amazon accepted the inbound plan create request (operation still processing).";

    return new Response(
      JSON.stringify({
        success: true,
        inboundPlanId,
        operationId,
        operationStatus,
        operationProblems,
        itemDebug: finalItemDebug,
        marketplaceId: globalMarketplaceId,
        sellerId: globalSellerId,
        stepResults: [
          ...(prepDetailsStepResult ? [prepDetailsStepResult] : []),
          {
            step: "createInboundPlan",
            endpoint: createPath,
            success: true,
            httpStatus: createResponse.status,
            message: "Amazon accepted the inbound plan create request.",
            inboundPlanId,
            operationId,
            details: createText,
            itemDebug: finalItemDebug,
            marketplaceId: globalMarketplaceId,
            sellerId: globalSellerId,
          },
        ],
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );

  } catch (error) {
    console.error("Error creating inbound plan:", error);
    const details = (error as Error).message;
    // HEALTH SIGNAL: top-level fatal — derive userId from auth header if available
    try {
      const authHeader = req.headers.get("Authorization");
      if (authHeader) {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        const { data: { user: fatalUser } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
        if (fatalUser?.id) {
          await HealthSignals.inboundPlanError(fatalUser.id, 'create-inbound-plan', `Fatal: ${details}`);
        }
      }
    } catch { /* never throw */ }
    return new Response(JSON.stringify({ 
      error: details || "Failed to create inbound plan",
      details,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
