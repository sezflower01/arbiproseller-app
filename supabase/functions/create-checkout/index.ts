import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CREATE-CHECKOUT] ${step}${d}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? ""
  );

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    // Parse request body for price_id
    const body = await req.json();
    const priceId = body.price_id;
    if (!priceId || typeof priceId !== "string" || !priceId.startsWith("price_")) {
      throw new Error("Invalid or missing price_id");
    }

    // Product Library Premium prices (not in subscription_plans table)
    const PRODUCT_LIBRARY_PRICE_IDS = [
      "price_1TOVOkHbbOMAX8kO1zHM4FCu", // $39.99/mo (current)
      "price_1TKOvdHbbOMAX8kOcmMCXth0", // $9.99/mo (legacy)
    ];

    // Server-side allowlist: only accept price IDs listed in subscription_plans
    // (monthly or annual) plus the Product Library prices above. This prevents
    // a client from selecting arbitrary Stripe prices.
    const supabaseService = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );
    const { data: plans, error: plansErr } = await supabaseService
      .from("subscription_plans")
      .select("stripe_price_id, stripe_annual_price_id");
    if (plansErr) {
      logStep("Failed to load subscription_plans", { error: plansErr.message });
      throw new Error("Failed to validate price_id");
    }
    const allowedPriceIds = new Set<string>(PRODUCT_LIBRARY_PRICE_IDS);
    for (const p of plans ?? []) {
      if (p.stripe_price_id) allowedPriceIds.add(p.stripe_price_id);
      if (p.stripe_annual_price_id) allowedPriceIds.add(p.stripe_annual_price_id);
    }
    if (!allowedPriceIds.has(priceId)) {
      logStep("Rejected price_id not in allowlist", { priceId });
      throw new Error("price_id is not an approved subscription price");
    }
    logStep("Price ID received", { priceId });

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Check for existing Stripe customer
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId: string | undefined;
    let hasUsedTrial = false;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
      logStep("Existing Stripe customer found", { customerId });

      // Check if already has an active subscription
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: "active",
        limit: 1,
      });
      if (subs.data.length > 0) {
        logStep("User already has active subscription", { subId: subs.data[0].id });
        // Update existing subscription to new price instead of creating new checkout
        const sub = subs.data[0];
        const updated = await stripe.subscriptions.update(sub.id, {
          items: [
            { id: sub.items.data[0].id, price: priceId },
          ],
          proration_behavior: "none",
        });
        logStep("Subscription updated to new tier", { subId: updated.id });
        return new Response(
          JSON.stringify({ updated: true, subscription_id: updated.id }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
        );
      }

      // Detect prior trial usage — if the customer has ANY historical subscription
      // (trialing/past_due/canceled/incomplete/etc.), they've consumed their free trial.
      const allSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 5,
      });
      hasUsedTrial = allSubs.data.some(
        (s) => !!s.trial_start || !!s.trial_end || s.status !== "incomplete_expired"
      ) && allSubs.data.length > 0;
      logStep("Trial usage check", { hasUsedTrial, priorSubs: allSubs.data.length });
    }

    const origin = req.headers.get("origin") || "https://quick-start-genesis.lovable.app";

    // Product Library Premium has no free trial (allowlist declared above)
    const isProductLibrary = PRODUCT_LIBRARY_PRICE_IDS.includes(priceId);

    // Create checkout session
    const sessionParams: any = {
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { user_id: user.id },
        ...(isProductLibrary || hasUsedTrial ? {} : { trial_period_days: 60 }),
      },
      success_url: isProductLibrary
        ? `${origin}/tools/created-listings?checkout=success`
        : `${origin}/tools/amazon-connect?checkout=success`,
      cancel_url: isProductLibrary
        ? `${origin}/tools/created-listings?canceled=true`
        : `${origin}/subscriptions?canceled=true`,
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    logStep("Checkout session created", { sessionId: session.id, url: session.url });

    return new Response(
      JSON.stringify({ url: session.url }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error) {
    const msg = error instanceof Error ? (error as Error).message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(
      JSON.stringify({ error: msg }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
