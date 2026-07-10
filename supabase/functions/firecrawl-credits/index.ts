// Returns Firecrawl team credit balance using the v2 team/credit-usage endpoint.
// Auth: requires Supabase user JWT (verify_jwt enabled by default).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "FIRECRAWL_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const res = await fetch("https://api.firecrawl.dev/v2/team/credit-usage", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: data?.error || `Firecrawl ${res.status}`, status: res.status }),
        { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Response shape: { success: true, data: { remaining_credits, plan_credits, billing_period_start, billing_period_end } }
    const payload = data?.data ?? data ?? {};
    return new Response(
      JSON.stringify({
        remaining: payload.remaining_credits ?? payload.remainingCredits ?? null,
        plan: payload.plan_credits ?? payload.planCredits ?? null,
        period_start: payload.billing_period_start ?? null,
        period_end: payload.billing_period_end ?? null,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? (err as Error).message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
