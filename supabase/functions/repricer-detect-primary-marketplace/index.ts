// Auto-detects each seller's real primary marketplace from actual sales
// volume (trailing 90 days, converted to USD), rather than relying on a
// manual dropdown that's easy to leave wrong and materially changes how
// the repricer dispatch engine behaves (which marketplace gets the
// always-on, protected evaluation slot vs. which ones share the smaller
// capped pool). Runs as a weekly cron fan-out across all users.
//
// POST { all_users: true } (service role) → fan-out for all users (cron)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireInternalCall } from "../_shared/require-internal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MARKETPLACE_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL",
};

// Below this many total orders across all marketplaces in the trailing
// window, there isn't enough signal to trust — leave the setting as-is
// rather than risk flipping it on noise (e.g. a brand-new account).
const MIN_ORDERS_FOR_SIGNAL = 10;
const TRAILING_DAYS = 90;

interface DetectResult {
  user_id: string;
  previous: string | null;
  detected: string | null;
  changed: boolean;
  totals_usd: Record<string, number>;
  reason?: string;
}

async function detectForUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
  fxRates: Record<string, number>,
): Promise<DetectResult> {
  const since = new Date(Date.now() - TRAILING_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: settings } = await admin
    .from("repricer_settings")
    .select("primary_marketplace")
    .eq("user_id", userId)
    .maybeSingle();
  const previous = (settings as any)?.primary_marketplace || null;

  const orders: { marketplace: string | null; total_sale_amount: number | null }[] = [];
  const PAGE = 1000;
  for (let from = 0; from < 20000; from += PAGE) {
    const { data: page, error } = await admin
      .from("sales_orders")
      .select("marketplace, total_sale_amount")
      .eq("user_id", userId)
      .eq("is_cancelled", false)
      .gte("order_date", since)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!page || page.length === 0) break;
    orders.push(...page);
    if (page.length < PAGE) break;
  }

  const toUsd = (amount: number, mp: string) => {
    const currency = MARKETPLACE_CURRENCY[mp] || "USD";
    if (currency === "USD") return amount;
    const rate = fxRates[currency];
    return rate && rate > 0 ? amount / rate : amount;
  };

  const totalsUsd: Record<string, number> = {};
  const counts: Record<string, number> = {};
  let totalOrders = 0;
  for (const o of orders) {
    const mp = String(o.marketplace || "").toUpperCase();
    if (!mp || !(mp in MARKETPLACE_CURRENCY)) continue;
    const usd = toUsd(Number(o.total_sale_amount) || 0, mp);
    totalsUsd[mp] = (totalsUsd[mp] || 0) + usd;
    counts[mp] = (counts[mp] || 0) + 1;
    totalOrders++;
  }

  if (totalOrders < MIN_ORDERS_FOR_SIGNAL) {
    return { user_id: userId, previous, detected: previous, changed: false, totals_usd: totalsUsd, reason: "insufficient_signal" };
  }

  const marketplaces = Object.keys(totalsUsd);
  let best = marketplaces[0];
  for (const mp of marketplaces) {
    if (totalsUsd[mp] > totalsUsd[best]) best = mp;
    // Tie (or effectively tied): prefer whatever's already set, to avoid
    // flip-flopping on noise between two close marketplaces.
    else if (Math.abs(totalsUsd[mp] - totalsUsd[best]) < 0.01 && mp === previous) best = mp;
  }

  const changed = best !== previous;
  if (changed) {
    await admin
      .from("repricer_settings")
      .update({ primary_marketplace: best, primary_marketplace_detected_at: new Date().toISOString() } as any)
      .eq("user_id", userId);
  }

  return { user_id: userId, previous, detected: best, changed, totals_usd: totalsUsd };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }

    if (body?.all_users !== true) {
      return new Response(JSON.stringify({ error: "all_users required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const forbidden = requireInternalCall(req);
    if (forbidden) return forbidden;

    const { withCronLock } = await import("../_shared/cron-lock.ts");
    const outcome = await withCronLock(admin as any, "repricer-detect-primary-marketplace", 900, async () => {
      const { data: fxRows } = await admin.from("fx_rates").select("quote, rate");
      const fxRates: Record<string, number> = {};
      for (const row of (fxRows as any[]) || []) fxRates[String(row.quote || "")] = Number(row.rate) || 1;

      const { data: settingsRows } = await admin.from("repricer_settings").select("user_id");
      const userIds = Array.from(new Set((settingsRows ?? []).map((r: any) => r.user_id)));

      const results: DetectResult[] = [];
      let changedCount = 0;
      for (const uid of userIds) {
        try {
          const r = await detectForUser(admin, uid, fxRates);
          results.push(r);
          if (r.changed) changedCount++;
        } catch (e) {
          console.error("[detect-primary-marketplace] user failed", uid, e);
        }
      }

      return {
        items_processed: userIds.length,
        detail: { changed: changedCount, unchanged: userIds.length - changedCount },
      };
    });

    return new Response(JSON.stringify(outcome), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
