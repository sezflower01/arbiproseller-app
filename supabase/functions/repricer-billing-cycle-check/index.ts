// repricer-billing-cycle-check
//
// Grace-period capacity policy (2026-07-26 request):
//   - The repricer never blocks activation in real time, no matter how far
//     over plan an account runs mid-cycle (see auto-onboard-asin).
//   - Instead, each account's OWN capacity vs. plan is only reconciled at
//     THEIR billing renewal. If still meaningfully over plan at that exact
//     moment (>110% of listing_limit), the subscription is auto-upgraded to
//     the smallest tier that covers the current active-listing count.
//   - If usage dropped back within 110% by renewal, nothing happens -- the
//     account simply renews at its current plan. A mid-cycle spike that
//     resolves itself before renewal is never charged for.
//
// Runs hourly via cron. For every active/trialing, non-admin-overridden
// subscription, we ask Stripe directly for the authoritative
// current_period_end (never trust the local cache for this decision) and
// compare it to what we last recorded. A newer period_end means a renewal
// just happened -- that's the trigger to evaluate capacity. Otherwise we
// just refresh the local cache and move on.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { requireInternalCall } from "../_shared/require-internal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const GRACE_MULTIPLIER = 1.10;

const log = (step: string, details?: unknown) => {
  console.log(`[BILLING-CYCLE-CHECK] ${step}${details ? ` - ${JSON.stringify(details)}` : ""}`);
};

const toIso = (unixSeconds: number | null | undefined): string | null => {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toISOString();
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY is not set" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const { data: subs, error: subsErr } = await supabase
      .from("user_subscriptions")
      .select("user_id, plan_id, billing_interval, status, current_period_end, stripe_subscription_id, stripe_customer_id")
      .in("status", ["active", "trialing"])
      .not("stripe_subscription_id", "is", null);
    if (subsErr) throw subsErr;

    const { data: overrides } = await supabase
      .from("admin_subscription_override")
      .select("user_id, override_enabled");
    const overriddenUsers = new Set((overrides ?? []).filter(o => o.override_enabled).map(o => o.user_id));

    const { data: plans, error: plansErr } = await supabase
      .from("subscription_plans")
      .select("id, listing_limit, stripe_price_id, stripe_annual_price_id")
      .order("listing_limit", { ascending: true });
    if (plansErr) throw plansErr;
    const planById = new Map((plans ?? []).map(p => [p.id, p]));

    let checked = 0;
    let renewed = 0;
    let upgraded = 0;
    const upgradeLog: Array<{ user_id: string; from_plan: string; to_plan: string; active_count: number; limit: number }> = [];

    for (const sub of subs ?? []) {
      if (overriddenUsers.has(sub.user_id)) continue;
      checked++;

      try {
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id!);
        const stripePeriodEnd = toIso((stripeSub as any).current_period_end);
        if (!stripePeriodEnd) continue;

        const localPeriodEnd = sub.current_period_end;
        const justRenewed = localPeriodEnd !== null && new Date(stripePeriodEnd).getTime() > new Date(localPeriodEnd).getTime();
        const firstRun = localPeriodEnd === null;

        if (!justRenewed && !firstRun) continue; // no renewal since last check -- nothing to reconcile

        renewed++;
        const currentPlan = planById.get(sub.plan_id);
        let newPlanId = sub.plan_id;

        if (justRenewed && currentPlan) {
          const { data: countsData } = await supabase.rpc("get_managed_listings_counts", { p_user_id: sub.user_id });
          const activeCount = (countsData as any)?.total ?? 0;
          const threshold = currentPlan.listing_limit * GRACE_MULTIPLIER;

          if (activeCount > threshold) {
            const nextPlan = (plans ?? []).find(p => p.listing_limit >= activeCount);
            if (nextPlan && nextPlan.id !== currentPlan.id) {
              const newPriceId = sub.billing_interval === "annual" ? nextPlan.stripe_annual_price_id : nextPlan.stripe_price_id;
              if (newPriceId) {
                const items = stripeSub.items.data;
                await stripe.subscriptions.update(sub.stripe_subscription_id!, {
                  items: [{ id: items[0].id, price: newPriceId }],
                  proration_behavior: "none",
                });
                newPlanId = nextPlan.id;
                upgraded++;
                upgradeLog.push({
                  user_id: sub.user_id, from_plan: currentPlan.id, to_plan: nextPlan.id,
                  active_count: activeCount, limit: currentPlan.listing_limit,
                });

                await supabase.from("subscription_events").insert({
                  user_id: sub.user_id,
                  event_type: "auto_upgrade_capacity",
                  details: {
                    from_plan: currentPlan.id,
                    to_plan: nextPlan.id,
                    active_listings: activeCount,
                    previous_limit: currentPlan.listing_limit,
                    grace_threshold: threshold,
                    reconciled_at: new Date().toISOString(),
                  },
                });
                log("Auto-upgraded for capacity", { userId: sub.user_id, from: currentPlan.id, to: nextPlan.id, activeCount });
              } else {
                log("No stripe price for target plan/interval, skipping upgrade", { userId: sub.user_id, targetPlan: nextPlan.id, interval: sub.billing_interval });
              }
            }
          }
        }

        // Always refresh the local cache so the next run's diff-check is accurate,
        // whether or not an upgrade happened.
        await supabase
          .from("user_subscriptions")
          .update({
            plan_id: newPlanId,
            current_period_end: stripePeriodEnd,
            status: stripeSub.status,
            cancel_at_period_end: stripeSub.cancel_at_period_end ?? false,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", sub.user_id);
      } catch (userErr) {
        log("Error processing subscription", {
          userId: sub.user_id,
          error: userErr instanceof Error ? userErr.message : String(userErr),
        });
      }
    }

    log("Run complete", { checked, renewed, upgraded });
    return new Response(
      JSON.stringify({ success: true, checked, renewed, upgraded, upgrades: upgradeLog }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
