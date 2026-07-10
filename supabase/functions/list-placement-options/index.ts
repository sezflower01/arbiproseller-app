import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TERMINAL_OPERATION_FAILURES = new Set(["FAILED", "FAULTED", "CANCELLED", "ERRORED"]);

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Server misconfigured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "").trim();
    if (!jwt) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { inboundPlanId } = await req.json();
    if (!inboundPlanId || typeof inboundPlanId !== "string") {
      return new Response(
        JSON.stringify({ error: "Invalid inboundPlanId" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Use global SP-API credentials - no-connect mode
    const globalRefreshToken = Deno.env.get("SPAPI_REFRESH_TOKEN");
    const globalSellerId = Deno.env.get("SPAPI_SELLER_ID");

    if (!globalRefreshToken) {
      return new Response(
        JSON.stringify({ error: "SPAPI_REFRESH_TOKEN not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!globalSellerId) {
      return new Response(
        JSON.stringify({ error: "SPAPI_SELLER_ID not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const refreshToken = globalRefreshToken;

    // Refresh LWA token
    const creds = [
      {
        clientId: Deno.env.get("SPAPI_LWA_CLIENT_ID"),
        clientSecret: Deno.env.get("SPAPI_LWA_CLIENT_SECRET"),
        label: "SPAPI_LWA_CLIENT_*",
      },
      {
        clientId: Deno.env.get("LWA_CLIENT_ID"),
        clientSecret: Deno.env.get("LWA_CLIENT_SECRET"),
        label: "LWA_CLIENT_*",
      },
    ].filter((c) => c.clientId && c.clientSecret);

    if (creds.length === 0) {
      return new Response(
        JSON.stringify({ error: "Missing LWA credentials" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let accessToken: string | null = null;
    let lastErr: unknown = null;

    for (const c of creds) {
      try {
        console.log(`Refreshing LWA token using ${c.label}`);

        const tokenRes = await fetch("https://api.amazon.com/auth/o2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: c.clientId!,
            client_secret: c.clientSecret!,
          }),
        });

        const tokenText = await tokenRes.text();
        if (!tokenRes.ok) throw new Error(`LWA refresh failed: ${tokenText}`);
        const tokenJson = JSON.parse(tokenText);
        accessToken = tokenJson.access_token;
        break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!accessToken) {
      return new Response(
        JSON.stringify({ error: "Failed to refresh token", details: String(lastErr) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const stepResults: Array<Record<string, unknown>> = [];

    // 1) Generate + confirm packing option first when supported by the inbound plan.
    try {
      const genPackingPath = `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/packingOptions`;
      const genPackRes = await spApiSignedFetch({
        method: "POST",
        path: genPackingPath,
        accessToken,
        bodyString: JSON.stringify({}),
      });
      const genPackText = await genPackRes.text();
      console.log("Generate packing response:", genPackRes.status, genPackText);
      let packingNotSupported = false;
      try {
        const genPackJson = JSON.parse(genPackText);
        const firstError = Array.isArray(genPackJson?.errors) ? genPackJson.errors[0] : undefined;
        packingNotSupported =
          firstError?.code === "BadRequest" &&
          typeof firstError?.message === "string" &&
          /does not support packing options/i.test(firstError.message);
      } catch {
        // ignore parse failures and fall back to default handling
      }
      stepResults.push({
        step: "generatePackingOptions",
        endpoint: genPackingPath,
        success: genPackRes.ok || packingNotSupported,
        status: packingNotSupported ? "skipped" : genPackRes.ok ? "success" : "failed",
        httpStatus: genPackRes.status,
        code: packingNotSupported ? "PACKING_OPTIONS_NOT_SUPPORTED" : undefined,
        message: packingNotSupported
          ? "Amazon reports this inbound plan does not support packing options, so the packing step was skipped."
          : genPackRes.ok
            ? "Amazon accepted the packing options generation request."
            : "Amazon did not accept the packing options generation request.",
        inboundPlanId,
        details: genPackText,
      });

      if (packingNotSupported) {
        stepResults.push({
          step: "confirmPackingOption",
          endpoint: "Not called because packing options are not supported for this inbound plan",
          success: false,
          status: "skipped",
          code: "PACKING_OPTIONS_NOT_SUPPORTED",
          message: "confirmPackingOption was skipped because Amazon says this inbound plan does not support packing options.",
          inboundPlanId,
          details: genPackText,
        });
      }

      let packingOptions: any[] = [];
      for (let pAttempt = 1; !packingNotSupported && pAttempt <= 6; pAttempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const listPackRes = await spApiSignedFetch({
          method: "GET",
          path: genPackingPath,
          accessToken,
        });
        const listPackText = await listPackRes.text();
        console.log(`List packing options attempt ${pAttempt}:`, listPackRes.status, listPackText);

        if (listPackRes.ok) {
          try {
            const listPackJson = JSON.parse(listPackText);
            packingOptions = listPackJson.packingOptions || [];
            if (packingOptions.length > 0) break;
          } catch {
            // ignore
          }
        }
      }

      if (packingOptions.length > 0) {
        const packingOptionId = packingOptions[0].packingOptionId;
        const confirmPackingPath = `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/packingOptions/${packingOptionId}/confirmation`;
        const confirmPackRes = await spApiSignedFetch({
          method: "POST",
          path: confirmPackingPath,
          accessToken,
          bodyString: JSON.stringify({}),
        });
        const confirmPackText = await confirmPackRes.text();
        console.log("Confirm packing response:", confirmPackRes.status, confirmPackText);
        stepResults.push({
          step: "confirmPackingOption",
          endpoint: confirmPackingPath,
          success: confirmPackRes.ok,
          httpStatus: confirmPackRes.status,
          message: confirmPackRes.ok
            ? "Amazon accepted the packing option confirmation request."
            : "Amazon did not accept the packing option confirmation request.",
          inboundPlanId,
          details: confirmPackText,
        });
      }
    } catch (e) {
      console.log("Packing step failed (continuing):", e);
      stepResults.push({
        step: "packingWorkflow",
        endpoint: `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/packingOptions`,
        success: false,
        message: "Packing option generation/confirmation could not be completed.",
        inboundPlanId,
        details: String(e),
      });
    }

    // 2) Generate placement options
    const generatePath = `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/placementOptions`;
    const genRes = await spApiSignedFetch({
      method: "POST",
      path: generatePath,
      accessToken,
      bodyString: JSON.stringify({}),
    });

    const genText = await genRes.text();
    console.log("Generate placement response:", genRes.status, genText);
    stepResults.push({
      step: "generatePlacementOptions",
      endpoint: generatePath,
      success: genRes.ok,
      httpStatus: genRes.status,
      message: genRes.ok
        ? "Amazon accepted the placement options generation request."
        : "Amazon did not accept the placement options generation request.",
      inboundPlanId,
      details: genText,
    });

    let generateOperationId: string | null = null;
    try {
      const genJson = JSON.parse(genText);
      generateOperationId = genJson?.operationId || null;
    } catch {
      // ignore
    }

    // Check operation status
    let operationStatus: string | null = null;
    let operationProblems: any[] = [];
    let operationStatusHttp: number | null = null;

    if (generateOperationId) {
      const opPath = `/inbound/fba/2024-03-20/operations/${generateOperationId}`;
      for (let i = 1; i <= 6; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const opRes = await spApiSignedFetch({
          method: "GET",
          path: opPath,
          accessToken,
        });

        operationStatusHttp = opRes.status;
        const opText = await opRes.text();
        console.log(`Operation status attempt ${i}:`, opRes.status, opText);

        if (!opRes.ok) {
          try {
            const opJson = JSON.parse(opText);
            operationProblems = opJson?.errors || opJson?.operationProblems || [];
          } catch {
            // ignore
          }
          break;
        }

        try {
          const opJson = JSON.parse(opText);
          operationStatus = opJson.operationStatus || null;
          operationProblems = opJson.operationProblems || [];

          if (operationStatus && operationStatus !== "IN_PROGRESS") break;
        } catch {
          break;
        }
      }
    }

    // 3) List placement options
    let placementOptions: any[] = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      const listRes = await spApiSignedFetch({
        method: "GET",
        path: generatePath,
        accessToken,
      });

      const listText = await listRes.text();
      console.log(`List placement response attempt ${attempt}:`, listRes.status, listText);

      if (!listRes.ok) {
        return new Response(
          JSON.stringify({ error: "Amazon API error", details: listText }),
          { status: listRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const listJson = JSON.parse(listText);
      placementOptions = listJson.placementOptions || [];
      if (placementOptions.length > 0) break;

      await new Promise((r) => setTimeout(r, 5000));
    }

    // 4) Fetch shipment details for each placement option to get destination FC names
    for (const opt of placementOptions) {
      if (opt.shipmentIds && opt.shipmentIds.length > 0) {
        const shipmentsDetails: any[] = [];
        for (const shipmentId of opt.shipmentIds) {
          try {
            const shipmentPath = `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}/shipments/${shipmentId}`;
            const shipmentRes = await spApiSignedFetch({
              method: "GET",
              path: shipmentPath,
              accessToken,
            });
            if (shipmentRes.ok) {
              const shipmentText = await shipmentRes.text();
              const shipmentJson = JSON.parse(shipmentText);
              shipmentsDetails.push({
                shipmentId,
                destinationFcId: shipmentJson.destination?.warehouseId || shipmentJson.destinationAddress?.warehouseId || shipmentId,
                destinationFcName: shipmentJson.destination?.name || shipmentJson.destinationAddress?.name || null,
              });
            } else {
              shipmentsDetails.push({ shipmentId, destinationFcId: shipmentId, destinationFcName: null });
            }
          } catch (e) {
            console.log(`Failed to fetch shipment ${shipmentId}:`, e);
            shipmentsDetails.push({ shipmentId, destinationFcId: shipmentId, destinationFcName: null });
          }
        }
        opt.shipments = shipmentsDetails;
      }
    }

    // 5) Fallback: check inbound plan for shipments and detect terminal plan failures
    let fallbackUsed = false;
    let inboundPlanStatus: string | null = null;
    let inboundPlanErrorDetails: unknown[] = [];
    if (placementOptions.length === 0) {
      const planPath = `/inbound/fba/2024-03-20/inboundPlans/${inboundPlanId}`;
      const planRes = await spApiSignedFetch({
        method: "GET",
        path: planPath,
        accessToken,
      });

      const planText = await planRes.text();
      console.log("Inbound plan details response:", planRes.status, planText);

      if (planRes.ok) {
        try {
          const planJson = JSON.parse(planText);
          inboundPlanStatus = typeof planJson.status === "string" ? planJson.status : null;
          inboundPlanErrorDetails = Array.isArray(planJson.errors)
            ? planJson.errors
            : Array.isArray(planJson.operationProblems)
              ? planJson.operationProblems
              : [];
          const shipments = planJson.shipments || [];
          const shipmentIds = shipments
            .map((s: any) => s.shipmentId)
            .filter((v: any) => typeof v === "string" && v.length > 0);

          if (shipmentIds.length > 0) {
            const shipmentsDetails = shipments.map((s: any) => ({
              shipmentId: s.shipmentId,
              destinationFcId: s.destination?.warehouseId || s.destinationAddress?.warehouseId || s.shipmentId,
              destinationFcName: s.destination?.name || s.destinationAddress?.name || null,
            }));
            placementOptions = [
              {
                placementOptionId: "fallback-from-shipments",
                shipmentIds,
                shipments: shipmentsDetails,
                status: "OFFERED",
              },
            ];
            fallbackUsed = true;
          }
        } catch {
          // ignore
        }
      }
    }

    const noteParts: string[] = [];
    noteParts.push(`GeneratePlacementOptions HTTP ${genRes.status}`);
    if (generateOperationId) noteParts.push(`operationId: ${generateOperationId}`);
    if (operationStatusHttp) noteParts.push(`operationStatus HTTP ${operationStatusHttp}`);
    if (operationStatus) noteParts.push(`operationStatus: ${operationStatus}`);
    if (operationProblems?.length) noteParts.push(`operationProblems: ${JSON.stringify(operationProblems)}`);
    if (fallbackUsed) noteParts.push("fallback: using shipmentIds from inbound plan details");
    if (inboundPlanStatus) noteParts.push(`inboundPlanStatus: ${inboundPlanStatus}`);
    if (placementOptions.length === 0) noteParts.push("placementOptions: still empty — Amazon may take several minutes or your app may be missing required SP-API roles/scopes for this operation.");

    if (inboundPlanStatus && TERMINAL_OPERATION_FAILURES.has(inboundPlanStatus)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "INBOUND_PLAN_ERRORED",
          code: "INBOUND_PLAN_ERRORED",
          message: `Amazon rejected the inbound plan and marked it as ${inboundPlanStatus}. Seller Central will not show a usable shipment for this attempt.`,
          details: inboundPlanErrorDetails.length ? inboundPlanErrorDetails : [`Inbound plan status: ${inboundPlanStatus}`],
          note: noteParts.join("\n"),
          stepResults,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const hasReadOnlyError = Array.isArray(operationProblems) && operationProblems.some((p: any) => p?.code === "FBA_INB_0422");
    if (hasReadOnlyError) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "READ_ONLY_WORKFLOW",
          code: "FBA_INB_0422",
          message: "Amazon blocked shipment creation because this Fulfillment Inbound workflow is read-only for the connected SP-API app.",
          details: operationProblems,
          note: noteParts.join("\n"),
          stepResults,
          nextSteps: [
            "Verify your SP-API application is approved/enabled for the FBA Inbound (Fulfillment Inbound) role.",
            "If the role was enabled recently, reauthorize seller consent to generate a new refresh token, then update SPAPI_REFRESH_TOKEN.",
            "Confirm you are using the correct regional endpoint for the seller marketplace (NA/EU/FE).",
          ],
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        placementOptions,
        note: noteParts.join("\n"),
        stepResults,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error in list-placement-options:", error);
    return new Response(
      JSON.stringify({ error: "Failed to list placement options", details: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
