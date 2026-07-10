// Mints a server-side nonce for the Amazon OAuth flow.
// The client cannot forge a state value — the callback validates it against
// the row we insert here, bound to the authenticated user_id.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const token = authHeader.replace("Bearer ", "");
    let userId: string | null = null;
    try {
      const { data: claimsData } = await supabase.auth.getClaims(token);
      userId = (claimsData?.claims?.sub as string) || null;
    } catch (_e) {
      // getClaims requires asymmetric signing keys; fall through to getUser.
    }
    if (!userId) {
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData?.user?.id) {
        console.error("amazon-oauth-start auth failed:", userErr?.message);
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = userData.user.id;
    }

    const body = await req.json().catch(() => ({}));
    const marketplaceId: string =
      typeof body.marketplace_id === "string" && body.marketplace_id.length > 0
        ? body.marketplace_id
        : "ATVPDKIKX0DER";
    const origin: string =
      typeof body.origin === "string" && body.origin.startsWith("http")
        ? body.origin
        : "https://arbiproseller.com";

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const state = `${crypto.randomUUID()}.${crypto.randomUUID()}`;

    const { error: insertErr } = await admin
      .from("amazon_oauth_states")
      .insert({
        state,
        user_id: userId,
        marketplace_id: marketplaceId,
        origin,
      });

    if (insertErr) {
      console.error("Failed to insert oauth state:", insertErr);
      return new Response(
        JSON.stringify({ error: "Failed to create OAuth state" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // GC old states (>10 min)
    await admin
      .from("amazon_oauth_states")
      .delete()
      .lt("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

    return new Response(JSON.stringify({ state }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String((e as Error).message || e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
