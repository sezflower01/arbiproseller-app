import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[ENFORCE-SUBSCRIPTION] ${step}${d}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = requireInternalCall(req);
  if (__forbidden) return __forbidden;


  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    log("Started");

    const now = new Date().toISOString();

    // Find users whose subscription OR trial has expired:
    // 1. cancel_at_period_end = true AND current_period_end <= now AND status NOT already 'expired'
    // 2. status = 'cancelled'/'canceled' and current_period_end <= now
    // 3. status = 'trial' AND trial_end_date <= now (trial expired)
    const { data: expiredSubs, error: fetchErr } = await supabase
      .from("user_subscriptions")
      .select("user_id, status, cancel_at_period_end, current_period_end, stripe_subscription_id, trial_end_date")
      .or(
        `and(cancel_at_period_end.eq.true,current_period_end.lte.${now},status.neq.expired),` +
        `and(status.in.(cancelled,canceled),current_period_end.lte.${now},status.neq.expired),` +
        `and(status.eq.trial,trial_end_date.lte.${now})`
      );

    if (fetchErr) throw new Error(`Fetch error: ${fetchErr.message}`);

    if (!expiredSubs || expiredSubs.length === 0) {
      log("No expired subscriptions to process");
      return new Response(
        JSON.stringify({ success: true, processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log(`Found ${expiredSubs.length} expired subscription(s) to process`);
    const results: Array<{ user_id: string; actions: string[] }> = [];

    for (const sub of expiredSubs) {
      const userId = sub.user_id;
      const actions: string[] = [];

      try {
        // Skip admin users — admins bypass all subscription enforcement
        const { data: adminRole } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userId)
          .eq("role", "admin")
          .maybeSingle();

        if (adminRole) {
          log("Skipping admin user", { userId });
          continue;
        }
        // 1. Disable repricer scheduler (pause, don't destroy)
        const { error: repErr } = await supabase
          .from("repricer_settings")
          .update({
            scheduler_enabled: false,
            queue_paused: true,
            queue_pause_reason: "subscription_expired",
          })
          .eq("user_id", userId);

        if (!repErr) actions.push("repricer_paused");
        else log("Failed to pause repricer", { userId, error: repErr.message });

        // 2. Keep Amazon authorizations connected — only pause repricing
        // This reduces friction for resubscription (no reconnect needed)
        actions.push("amazon_kept_connected");

        // 3. Mark subscription as expired
        const { error: subErr } = await supabase
          .from("user_subscriptions")
          .update({ status: "expired" })
          .eq("user_id", userId);

        if (!subErr) actions.push("status_expired");
        else log("Failed to update status", { userId, error: subErr.message });

        // 4. Log the event
        await supabase.from("subscription_events").insert({
          user_id: userId,
          event_type: "auto_pause",
          details: {
            actions,
            stripe_subscription_id: sub.stripe_subscription_id,
            previous_status: sub.status,
            enforced_at: new Date().toISOString(),
          },
        });

        actions.push("event_logged");
        log("Processed user", { userId, actions });
        results.push({ user_id: userId, actions });
      } catch (userErr) {
        log("Error processing user", {
          userId,
          error: userErr instanceof Error ? userErr.message : String(userErr),
        });
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const msg = error instanceof Error ? (error as Error).message : String(error);
    log("ERROR", { message: msg });
    return new Response(
      JSON.stringify({ error: msg }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
