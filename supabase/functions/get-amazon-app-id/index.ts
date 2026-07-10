import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Returns the SP-API Application ID (amzn1.sp.solution.xxxx) that matches the
// backend SPAPI_LWA_CLIENT_ID. Safe to expose: this is a public identifier
// shown in Amazon's authorize URL — NOT a secret.
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const application_id = Deno.env.get("SPAPI_LWA_APP_ID") || "";
  const clientId = Deno.env.get("SPAPI_LWA_CLIENT_ID") || Deno.env.get("LWA_CLIENT_ID") || "";

  return new Response(
    JSON.stringify({
      application_id,
      client_id_prefix: clientId ? clientId.substring(0, 12) : null,
      configured: !!application_id,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
