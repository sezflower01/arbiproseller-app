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
  console.log(`[CHECK-SUBSCRIPTION] ${step}${d}`);
};

const toIsoOrNull = (value?: number | string | null) => {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) return null;
  const date = new Date(numeric * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
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

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });

    if (customers.data.length === 0) {
      logStep("No Stripe customer found");
      // Check if user is on trial — preserve trial status, don't mark as cancelled
      const { data: existingSub } = await supabaseClient
        .from("user_subscriptions")
        .select("status, trial_end_date")
        .eq("user_id", user.id)
        .maybeSingle();

      if (existingSub?.status === 'trial') {
        const trialEnd = existingSub.trial_end_date ? new Date(existingSub.trial_end_date) : null;
        const trialActive = trialEnd && trialEnd > new Date();
        logStep("User is on trial", { trialEnd: existingSub.trial_end_date, trialActive });
        return new Response(
          JSON.stringify({ subscribed: trialActive, status: 'trial', trial_end: existingSub.trial_end_date }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
        );
      }

      // Not on trial — mark as cancelled
      await supabaseClient
        .from("user_subscriptions")
        .update({ status: "cancelled" })
        .eq("user_id", user.id)
        .neq("status", "cancelled");
      return new Response(
        JSON.stringify({ subscribed: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    const customerId = customers.data[0].id;
    logStep("Found Stripe customer", { customerId });

    // Check active or trialing subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 5,
    });

    const activeSub = subscriptions.data.find(
      (s: any) => s.status === "active" || s.status === "trialing"
    );

    if (!activeSub) {
      logStep("No active/trialing subscription");
      // Sync: mark local record as cancelled
      await supabaseClient
        .from("user_subscriptions")
        .update({ status: "cancelled" })
        .eq("user_id", user.id)
        .neq("status", "cancelled");
      return new Response(
        JSON.stringify({ subscribed: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    const priceId = activeSub.items.data[0]?.price?.id;
    const productId = activeSub.items.data[0]?.price?.product;
    const subscriptionEnd = toIsoOrNull(activeSub.current_period_end);
    const trialEnd = toIsoOrNull(activeSub.trial_end);
    const cancelAtPeriodEnd = activeSub.cancel_at_period_end ?? false;

    logStep("Active subscription found", {
      subId: activeSub.id,
      status: activeSub.status,
      priceId,
      productId,
      trialEnd,
      cancelAtPeriodEnd,
    });

    // --- Sync to user_subscriptions table ---
    // Look up which plan this price belongs to
    const { data: planRows } = await supabaseClient
      .from("subscription_plans")
      .select("id, stripe_price_id, stripe_annual_price_id")
      .or(`stripe_price_id.eq.${priceId},stripe_annual_price_id.eq.${priceId}`);

    const matchedPlan = planRows?.[0];
    const planId = matchedPlan?.id ?? "tier_100";
    const isAnnual = matchedPlan?.stripe_annual_price_id === priceId;
    const billingInterval = isAnnual ? "annual" : "monthly";

    logStep("Syncing user_subscriptions", { planId, billingInterval, cancelAtPeriodEnd });

    await supabaseClient
      .from("user_subscriptions")
      .upsert(
        {
          user_id: user.id,
          plan_id: planId,
          billing_interval: billingInterval,
          status: activeSub.status,
          expires_at: subscriptionEnd,
          cancel_at_period_end: cancelAtPeriodEnd,
          current_period_end: subscriptionEnd,
          stripe_subscription_id: activeSub.id,
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    return new Response(
      JSON.stringify({
        subscribed: true,
        status: activeSub.status,
        price_id: priceId,
        product_id: productId,
        subscription_end: subscriptionEnd,
        trial_end: trialEnd,
        subscription_id: activeSub.id,
      }),
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
