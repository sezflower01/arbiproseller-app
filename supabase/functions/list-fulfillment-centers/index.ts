import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Common US Amazon Fulfillment Centers
const US_FULFILLMENT_CENTERS = [
  { id: "ABE2", name: "ABE2 - Allentown, PA", city: "Allentown", state: "PA" },
  { id: "ABE3", name: "ABE3 - Allentown, PA", city: "Allentown", state: "PA" },
  { id: "ABE4", name: "ABE4 - Robbinsville, NJ", city: "Robbinsville", state: "NJ" },
  { id: "ABE8", name: "ABE8 - Carteret, NJ", city: "Carteret", state: "NJ" },
  { id: "ACY1", name: "ACY1 - West Deptford, NJ", city: "West Deptford", state: "NJ" },
  { id: "AVP1", name: "AVP1 - Pittston, PA", city: "Pittston", state: "PA" },
  { id: "BDL1", name: "BDL1 - Windsor, CT", city: "Windsor", state: "CT" },
  { id: "BFI4", name: "BFI4 - Kent, WA", city: "Kent", state: "WA" },
  { id: "BNA3", name: "BNA3 - Lebanon, TN", city: "Lebanon", state: "TN" },
  { id: "BWI2", name: "BWI2 - Baltimore, MD", city: "Baltimore", state: "MD" },
  { id: "BWI4", name: "BWI4 - Sparrows Point, MD", city: "Sparrows Point", state: "MD" },
  { id: "CHA1", name: "CHA1 - Chattanooga, TN", city: "Chattanooga", state: "TN" },
  { id: "CLT2", name: "CLT2 - Charlotte, NC", city: "Charlotte", state: "NC" },
  { id: "CMH1", name: "CMH1 - Columbus, OH", city: "Columbus", state: "OH" },
  { id: "CVG1", name: "CVG1 - Hebron, KY", city: "Hebron", state: "KY" },
  { id: "CVG3", name: "CVG3 - Hebron, KY", city: "Hebron", state: "KY" },
  { id: "DFW6", name: "DFW6 - Coppell, TX", city: "Coppell", state: "TX" },
  { id: "DFW7", name: "DFW7 - Fort Worth, TX", city: "Fort Worth", state: "TX" },
  { id: "EWR4", name: "EWR4 - Robbinsville, NJ", city: "Robbinsville", state: "NJ" },
  { id: "EWR5", name: "EWR5 - Avenel, NJ", city: "Avenel", state: "NJ" },
  { id: "FAT1", name: "FAT1 - Fresno, CA", city: "Fresno", state: "CA" },
  { id: "FTW1", name: "FTW1 - Fort Worth, TX", city: "Fort Worth", state: "TX" },
  { id: "GYR1", name: "GYR1 - Goodyear, AZ", city: "Goodyear", state: "AZ" },
  { id: "HOU2", name: "HOU2 - Houston, TX", city: "Houston", state: "TX" },
  { id: "IND1", name: "IND1 - Whitestown, IN", city: "Whitestown", state: "IN" },
  { id: "IND2", name: "IND2 - Plainfield, IN", city: "Plainfield", state: "IN" },
  { id: "IND4", name: "IND4 - Greenwood, IN", city: "Greenwood", state: "IN" },
  { id: "IND5", name: "IND5 - Whitestown, IN", city: "Whitestown", state: "IN" },
  { id: "JAX2", name: "JAX2 - Jacksonville, FL", city: "Jacksonville", state: "FL" },
  { id: "LAS1", name: "LAS1 - Las Vegas, NV", city: "Las Vegas", state: "NV" },
  { id: "LAS2", name: "LAS2 - North Las Vegas, NV", city: "North Las Vegas", state: "NV" },
  { id: "LAX9", name: "LAX9 - San Bernardino, CA", city: "San Bernardino", state: "CA" },
  { id: "LGB3", name: "LGB3 - Eastvale, CA", city: "Eastvale", state: "CA" },
  { id: "LGB6", name: "LGB6 - Moreno Valley, CA", city: "Moreno Valley", state: "CA" },
  { id: "LGB8", name: "LGB8 - Rialto, CA", city: "Rialto", state: "CA" },
  { id: "MCI5", name: "MCI5 - Kansas City, KS", city: "Kansas City", state: "KS" },
  { id: "MCO1", name: "MCO1 - Orlando, FL", city: "Orlando", state: "FL" },
  { id: "MDT1", name: "MDT1 - Carlisle, PA", city: "Carlisle", state: "PA" },
  { id: "MDW2", name: "MDW2 - Chicago, IL", city: "Chicago", state: "IL" },
  { id: "MDW6", name: "MDW6 - Joliet, IL", city: "Joliet", state: "IL" },
  { id: "MDW7", name: "MDW7 - Edwardsville, IL", city: "Edwardsville", state: "IL" },
  { id: "MEM1", name: "MEM1 - Memphis, TN", city: "Memphis", state: "TN" },
  { id: "MIA1", name: "MIA1 - Opa-Locka, FL", city: "Opa-Locka", state: "FL" },
  { id: "MKE1", name: "MKE1 - Kenosha, WI", city: "Kenosha", state: "WI" },
  { id: "MSP1", name: "MSP1 - Shakopee, MN", city: "Shakopee", state: "MN" },
  { id: "ONT2", name: "ONT2 - San Bernardino, CA", city: "San Bernardino", state: "CA" },
  { id: "ONT6", name: "ONT6 - Moreno Valley, CA", city: "Moreno Valley", state: "CA" },
  { id: "ONT8", name: "ONT8 - Eastvale, CA", city: "Eastvale", state: "CA" },
  { id: "ORD2", name: "ORD2 - Waukegan, IL", city: "Waukegan", state: "IL" },
  { id: "PHL4", name: "PHL4 - Lewisberry, PA", city: "Lewisberry", state: "PA" },
  { id: "PHL5", name: "PHL5 - Middletown, PA", city: "Middletown", state: "PA" },
  { id: "PHL6", name: "PHL6 - Lewisberry, PA", city: "Lewisberry", state: "PA" },
  { id: "PHX3", name: "PHX3 - Phoenix, AZ", city: "Phoenix", state: "AZ" },
  { id: "PHX5", name: "PHX5 - Goodyear, AZ", city: "Goodyear", state: "AZ" },
  { id: "PHX6", name: "PHX6 - Phoenix, AZ", city: "Phoenix", state: "AZ" },
  { id: "PHX7", name: "PHX7 - Phoenix, AZ", city: "Phoenix", state: "AZ" },
  { id: "RDU1", name: "RDU1 - Garner, NC", city: "Garner", state: "NC" },
  { id: "RIC1", name: "RIC1 - Petersburg, VA", city: "Petersburg", state: "VA" },
  { id: "RIC2", name: "RIC2 - Petersburg, VA", city: "Petersburg", state: "VA" },
  { id: "SAT1", name: "SAT1 - San Antonio, TX", city: "San Antonio", state: "TX" },
  { id: "SAV3", name: "SAV3 - Pooler, GA", city: "Pooler", state: "GA" },
  { id: "SBD1", name: "SBD1 - San Bernardino, CA", city: "San Bernardino", state: "CA" },
  { id: "SDF4", name: "SDF4 - Shepherdsville, KY", city: "Shepherdsville", state: "KY" },
  { id: "SDF8", name: "SDF8 - Jeffersonville, IN", city: "Jeffersonville", state: "IN" },
  { id: "SJC7", name: "SJC7 - Tracy, CA", city: "Tracy", state: "CA" },
  { id: "SLC1", name: "SLC1 - Salt Lake City, UT", city: "Salt Lake City", state: "UT" },
  { id: "SMF3", name: "SMF3 - Stockton, CA", city: "Stockton", state: "CA" },
  { id: "STL4", name: "STL4 - St. Peters, MO", city: "St. Peters", state: "MO" },
  { id: "TEB3", name: "TEB3 - Carlstadt, NJ", city: "Carlstadt", state: "NJ" },
  { id: "TPA1", name: "TPA1 - Ruskin, FL", city: "Ruskin", state: "FL" },
  { id: "TPA2", name: "TPA2 - Lakeland, FL", city: "Lakeland", state: "FL" },
  { id: "TUL1", name: "TUL1 - Tulsa, OK", city: "Tulsa", state: "OK" },
  { id: "TUL2", name: "TUL2 - Inola, OK", city: "Inola", state: "OK" },
];

async function getAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("SPAPI_LWA_CLIENT_ID")!;
  const clientSecret = Deno.env.get("SPAPI_LWA_CLIENT_SECRET")!;

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
    throw new Error("Failed to refresh token");
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

    // Get seller authorization
    const { data: sellerAuth, error: authError } = await supabase
      .from("seller_authorizations")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (authError || !sellerAuth) {
      // Return static list if no seller auth
      console.log("No seller auth found, returning static FC list");
      return new Response(JSON.stringify({
        success: true,
        fulfillmentCenters: US_FULFILLMENT_CENTERS,
        source: "static",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // For now, return the static list since getting real-time FC availability
    // requires creating an inbound plan first
    // In the future, this could be enhanced to call Amazon's API
    
    console.log("Returning fulfillment centers list");
    
    return new Response(JSON.stringify({
      success: true,
      fulfillmentCenters: US_FULFILLMENT_CENTERS,
      source: "static",
      message: "Available fulfillment centers for FBA shipments",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error listing fulfillment centers:", error);
    return new Response(JSON.stringify({ 
      error: "Failed to list fulfillment centers", 
      details: (error as Error).message 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
