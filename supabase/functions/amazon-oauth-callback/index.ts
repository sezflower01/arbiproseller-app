import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);

    const spapiOauthCode = url.searchParams.get("spapi_oauth_code");
    const state = url.searchParams.get("state");
    const sellingPartnerId = url.searchParams.get("selling_partner_id");

    console.log("Amazon OAuth callback query:", {
      hasSpapiOauthCode: !!spapiOauthCode,
      spapiOauthCodePrefix: spapiOauthCode?.substring(0, 15),
      state,
      sellingPartnerId,
    });

    if (!spapiOauthCode) {
      console.error("Missing spapi_oauth_code in callback URL");
      return new Response(
        JSON.stringify({ error: "Missing spapi_oauth_code" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Validate state BEFORE calling Amazon. This prevents anonymous callers
    // from forcing arbitrary token-exchange requests through us and gives us
    // testable rejection paths for unknown / expired / reused nonces.
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (!state) {
      return new Response(
        JSON.stringify({ error: "Invalid state parameter: missing state" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: stateRow, error: stateErr } = await supabase
      .from("amazon_oauth_states")
      .select("user_id, marketplace_id, origin, created_at")
      .eq("state", state)
      .maybeSingle();

    if (stateErr || !stateRow) {
      console.error("State lookup failed:", stateErr, { hasRow: !!stateRow });
      return new Response(
        JSON.stringify({ error: "Invalid or expired state" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const ageMs = Date.now() - new Date(stateRow.created_at).getTime();
    if (ageMs > 10 * 60 * 1000) {
      await supabase.from("amazon_oauth_states").delete().eq("state", state);
      return new Response(
        JSON.stringify({ error: "State expired, please retry" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const validatedUserId: string = stateRow.user_id;
    const validatedMarketplaceId: string = stateRow.marketplace_id || "ATVPDKIKX0DER";
    const validatedOrigin: string =
      stateRow.origin && /^https?:\/\//.test(stateRow.origin)
        ? stateRow.origin
        : "https://arbiproseller.com";

    // Single-use: burn the nonce now so a concurrent replay can't succeed even
    // if Amazon's response is slow.
    await supabase.from("amazon_oauth_states").delete().eq("state", state);


    const redirectUri =
      "https://mstibdszibcheodvnprm.supabase.co/functions/v1/amazon-oauth-callback";

    const clientId = Deno.env.get("SPAPI_LWA_CLIENT_ID") || Deno.env.get("LWA_CLIENT_ID");
    const clientSecret = Deno.env.get("SPAPI_LWA_CLIENT_SECRET") || Deno.env.get("LWA_CLIENT_SECRET");

    if (!clientId || !clientSecret) {
      console.error("Missing LWA credentials env vars", {
        hasSpapiClientId: !!Deno.env.get("SPAPI_LWA_CLIENT_ID"),
        hasSpapiClientSecret: !!Deno.env.get("SPAPI_LWA_CLIENT_SECRET"),
        hasLegacyClientId: !!Deno.env.get("LWA_CLIENT_ID"),
        hasLegacyClientSecret: !!Deno.env.get("LWA_CLIENT_SECRET"),
      });
      return new Response(
        JSON.stringify({
          error:
            "Server misconfiguration: missing SPAPI_LWA_CLIENT_ID/SPAPI_LWA_CLIENT_SECRET",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: spapiOauthCode,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    console.log("Amazon token request debug:", {
      redirectUri,
      hasCode: !!spapiOauthCode,
      codePrefix: spapiOauthCode.substring(0, 15),
      lwaClientIdPrefix: clientId.substring(0, 10),
    });

    const tokenRes = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
    });

    const tokenJson = await tokenRes.json();
    console.log("Amazon token response debug:", tokenRes.status, tokenJson);

    if (!tokenRes.ok) {
      return new Response(
        JSON.stringify({
          error: "Failed to exchange authorization code",
          details: tokenJson,
          status: tokenRes.status,
        }),
        {
          status: tokenRes.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Extract tokens from response
    const { access_token, refresh_token, expires_in } = tokenJson;

    // State was already validated + burned before the Amazon token exchange.
    // Reuse the validated values here.
    const userId = validatedUserId;
    const marketplaceId = validatedMarketplaceId;
    const clientOrigin = validatedOrigin;

    // Calculate token expiration
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000);


    const { data, error } = await supabase
      .from("seller_authorizations")
      .upsert(
        {
          user_id: userId,
          seller_id: sellingPartnerId || "unknown",
          marketplace_id: marketplaceId,
          refresh_token,
          access_token,
          token_expires_at: tokenExpiresAt.toISOString(),
          selling_partner_id: sellingPartnerId,
        },
        {
          onConflict: "seller_id,marketplace_id",
        }
      )
      .select()
      .single();

    if (error) {
      console.error("Database error:", error);
      return new Response(
        JSON.stringify({ error: "Failed to store authorization" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log("Successfully stored seller authorization:", data);

    // Trigger all syncs in the background (don't block the redirect)
    // Matches the logic in AmazonConnect.tsx runFullAutoSync()
    const runAllSyncs = async () => {
      try {
        console.log("🚀 Starting all background syncs for user:", userId);
        
        // Get a fresh session token for the user to call the sync functions
        const { data: userData } = await supabase.auth.admin.getUserById(userId);
        
        if (!userData?.user) {
          console.error("Could not find user for background syncs");
          return;
        }
        
        // Generate an access token for the user
        const { data: sessionData, error: sessionError } = await (supabase.auth.admin as any).createSession({
          user_id: userId,
        });
        
        if (sessionError) {
          console.error("Failed to create session for syncs:", sessionError);
          return;
        }
        
        if (!sessionData?.access_token) {
          console.error("No access token generated for syncs");
          return;
        }
        
        const authHeaders = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sessionData.access_token}`,
        };
        
        // Helper to format date as YYYY-MM-DD
        const formatDate = (d: Date) => d.toISOString().split('T')[0];
        
        // Calculate 2-year date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setFullYear(startDate.getFullYear() - 2);
        
        // ============================================================
        // 1. Sync FNSKU/Inventory Report (matches AmazonConnect.tsx Step 1)
        // ============================================================
        try {
          console.log("📊 [1/5] Starting FNSKU/inventory report sync...");
          const fnskuResponse = await fetch(`${supabaseUrl}/functions/v1/sync-fnsku-report`, {
            method: "POST",
            headers: authHeaders,
          });
          const fnskuResult = await fnskuResponse.json();
          console.log("📊 [1/5] FNSKU sync result:", fnskuResult);
        } catch (err) {
          console.error("📊 [1/5] FNSKU sync error:", err);
        }
        
        // Delay between syncs to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // ============================================================
        // 2. Sync FBA Shipments (recent, status-based)
        // ============================================================
        try {
          console.log("📦 [2/6] Starting FBA shipments sync...");
          const shipmentsResponse = await fetch(`${supabaseUrl}/functions/v1/sync-fba-shipments`, {
            method: "POST",
            headers: authHeaders,
          });
          const shipmentsResult = await shipmentsResponse.json();
          console.log("📦 [2/6] Shipments sync result:", shipmentsResult);
        } catch (err) {
          console.error("📦 [2/6] Shipments sync error:", err);
        }
        
        // Delay between syncs
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // ============================================================
        // 2.5. Sync 2-Year FBA Shipment History (DATE_RANGE, chunked monthly)
        // This catches CLOSED shipments that status-based sync misses
        // ============================================================
        try {
          console.log("📦 [2.5/6] Starting 2-year FBA shipment history (DATE_RANGE)...");
          
          // Process in 2-month chunks to avoid rate limits
          const chunkMonths = 2;
          const totalMonths = 24; // 2 years
          let syncedChunks = 0;
          
          for (let i = 0; i < totalMonths; i += chunkMonths) {
            const chunkEnd = new Date();
            chunkEnd.setMonth(chunkEnd.getMonth() - i);
            
            const chunkStart = new Date();
            chunkStart.setMonth(chunkStart.getMonth() - i - chunkMonths);
            
            console.log(`📦 [2.5/6] Syncing chunk ${i / chunkMonths + 1}/${totalMonths / chunkMonths}: ${formatDate(chunkStart)} to ${formatDate(chunkEnd)}`);
            
            try {
              const chunkResponse = await fetch(`${supabaseUrl}/functions/v1/sync-fba-shipments`, {
                method: "POST",
                headers: authHeaders,
                body: JSON.stringify({
                  dateRangeStart: formatDate(chunkStart),
                  dateRangeEnd: formatDate(chunkEnd),
                }),
              });
              const chunkResult = await chunkResponse.json();
              console.log(`📦 [2.5/6] Chunk result:`, chunkResult);
              syncedChunks++;
            } catch (chunkErr) {
              console.error(`📦 [2.5/6] Chunk error:`, chunkErr);
            }
            
            // Wait 5 seconds between chunks to avoid rate limiting
            if (i + chunkMonths < totalMonths) {
              await new Promise(resolve => setTimeout(resolve, 5000));
            }
          }
          
          console.log(`📦 [2.5/6] Completed ${syncedChunks} chunks of 2-year shipment history`);
        } catch (err) {
          console.error("📦 [2.5/6] 2-year shipment history error:", err);
        }
        
        // Delay between syncs
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // ============================================================
        // 3. Sync Amazon Inventory
        // ============================================================
        try {
          console.log("📋 [3/6] Starting Amazon inventory sync...");
          const inventoryResponse = await fetch(`${supabaseUrl}/functions/v1/sync-amazon-inventory`, {
            method: "POST",
            headers: authHeaders,
          });
          const inventoryResult = await inventoryResponse.json();
          console.log("📋 [3/6] Inventory sync result:", inventoryResult);
        } catch (err) {
          console.error("📋 [3/6] Inventory sync error:", err);
        }
        
        // Delay between syncs
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // ============================================================
        // 4. Sync 2 Years Sales History (matches AmazonConnect.tsx Step 3)
        // ============================================================
        try {
          console.log("💰 [4/6] Starting 2-year sales history sync...");
          const salesResponse = await fetch(`${supabaseUrl}/functions/v1/sync-sales-orders`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              sync_history: true,
              start_date: formatDate(startDate),
              end_date: formatDate(endDate),
            }),
          });
          const salesResult = await salesResponse.json();
          console.log("💰 [4/6] Sales sync result:", salesResult);
        } catch (err) {
          console.error("💰 [4/6] Sales sync error:", err);
        }
        
        // Delay between syncs
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // ============================================================
        // 5. Sync 2 Years Refund History (matches AmazonConnect.tsx Step 4)
        // ============================================================
        try {
          console.log("💸 [5/6] Starting 2-year refund history sync...");
          const refundsResponse = await fetch(`${supabaseUrl}/functions/v1/sync-sales-orders`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              sync_all_refunds_historical: true,
            }),
          });
          const refundsResult = await refundsResponse.json();
          console.log("💸 [5/6] Refunds sync result:", refundsResult);
        } catch (err) {
          console.error("💸 [5/6] Refunds sync error:", err);
        }
        
        console.log("✅ All background syncs completed for user:", userId);
        
      } catch (syncErr) {
        console.error("Background sync error:", syncErr);
      }
    };

    // Run all syncs in background without blocking redirect
    (globalThis as any).EdgeRuntime?.waitUntil(runAllSyncs());

    // Redirect back to the app with success message
    const redirectUrl = `${clientOrigin}/tools/amazon-connect?success=true`;
    return new Response(null, {
      status: 302,
      headers: {
        ...corsHeaders,
        Location: redirectUrl,
      },
    });
  } catch (err) {
    console.error("Amazon OAuth callback error", err);
    return new Response(
      JSON.stringify({ error: "Server error", details: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
