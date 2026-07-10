import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate user
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

    const { code, selling_partner_id, state } = await req.json();

    if (!code) {
      return new Response(JSON.stringify({ error: "Missing authorization code" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Exchanging Amazon authorization code for user:", user.id);
    console.log("Selling Partner ID:", selling_partner_id);

    // Use SPAPI_LWA_* (preferred) with legacy fallback
    const clientId = Deno.env.get("SPAPI_LWA_CLIENT_ID") || Deno.env.get("LWA_CLIENT_ID");
    const clientSecret = Deno.env.get("SPAPI_LWA_CLIENT_SECRET") || Deno.env.get("LWA_CLIENT_SECRET");

    if (!clientId || !clientSecret) {
      console.error("Missing LWA credentials", {
        hasSpapi: !!Deno.env.get("SPAPI_LWA_CLIENT_ID"),
        hasLegacy: !!Deno.env.get("LWA_CLIENT_ID"),
      });
      return new Response(JSON.stringify({
        error: "Server misconfiguration: missing LWA credentials"
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // CRITICAL: Amazon authorization codes are SINGLE-USE.
    // Never loop over multiple redirect URIs — the first attempt burns the code
    // and every subsequent attempt returns invalid_grant.
    // The redirect_uri MUST exactly match what was sent during the OAuth start
    // (see src/pages/tools/AmazonConnect.tsx → redirectUri constant).
    const redirectUri = "https://mstibdszibcheodvnprm.supabase.co/functions/v1/amazon-oauth-callback";

    console.log("Token exchange debug:", {
      redirectUri,
      clientIdPrefix: clientId.substring(0, 12),
      codePrefix: code.substring(0, 12),
    });

    const tokenRes = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const tokenJson: any = await tokenRes.json();
    console.log("Amazon token response:", tokenRes.status, JSON.stringify(tokenJson));

    if (!tokenRes.ok || !tokenJson.refresh_token) {
      return new Response(JSON.stringify({
        error: "Failed to exchange authorization code",
        details: tokenJson,
        status: tokenRes.status,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { access_token, refresh_token, expires_in } = tokenJson;

    // Calculate token expiration
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000);
    let marketplaceId = Deno.env.get("SPAPI_MARKETPLACE_ID") || "ATVPDKIKX0DER";

    try {
      if (state) {
        const stateData = JSON.parse(atob(state));
        if (stateData?.marketplace_id) {
          marketplaceId = stateData.marketplace_id;
        }
      }
    } catch (parseError) {
      console.error("Failed to parse marketplace from state:", parseError);
    }

    // Save tokens to database
    const { data, error } = await supabase
      .from("seller_authorizations")
      .upsert(
        {
          user_id: user.id,
          seller_id: selling_partner_id || "unknown",
          marketplace_id: marketplaceId,
          refresh_token,
          access_token,
          token_expires_at: tokenExpiresAt.toISOString(),
          selling_partner_id: selling_partner_id,
        },
        {
          onConflict: "user_id",
        }
      )
      .select()
      .single();

    if (error) {
      console.error("Database error saving tokens:", error);
      return new Response(JSON.stringify({ 
        error: "Failed to store authorization",
        details: (error as Error).message,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Successfully stored seller authorization for user:", user.id);

    return new Response(JSON.stringify({
      success: true,
      seller_id: data.seller_id,
      marketplace_id: data.marketplace_id,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Exchange code error:", err);
    return new Response(JSON.stringify({ 
      error: "Server error", 
      details: String(err) 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
