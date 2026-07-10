// self-heal-pending-prices
// Continuously repairs pending sales_orders whose estimated_price came from a
// stale signal. Mirrors the freshness-first chain used by sync-sales-orders'
// getSellerDerivedPrices / computeAndPersistEstimatedPrices:
//
//   1) repricer_price_actions (success=true, submitted_at <= order_date)
//   2) asin_my_price_cache (US: ATVPDKIKX0DER)
//   3) inventory.{price,amazon_price,my_price}
//
// Picks the FRESHEST seller-derived signal whose timestamp is <= order_date.
// Only updates rows where:
//   - order_status = Pending
//   - sold_price <= 0  (never touches CONFIRMED Orders API / FEC prices)
//   - price_source starts with 'estimated:' OR is NULL/empty
//   - the new price differs from current estimated_price by >1%
//
// Modes:
//   - default (cron): processes all users, capped per-run for safety
//   - { mode: "backfill", user_id?: uuid }: removes per-run cap; if user_id
//     given, scopes to that user only
//
// US marketplace only (matches the writer's warmup, which is US-only by design;
// non-US has its own pricing pipelines).

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Candidate = { price: number; source: string; ts: number };

async function pickFreshestPerAsin(
  supabase: any,
  userId: string,
  asins: string[],
): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  if (asins.length === 0) return out;
  const consider = (asin: string, price: number, source: string, ts: number) => {
    if (!(price > 0)) return;
    const prev = out.get(asin);
    if (!prev || ts > prev.ts) out.set(asin, { price, source, ts });
  };

  // 1) repricer_price_actions — most recent success per ASIN
  const { data: actions } = await supabase
    .from("repricer_price_actions")
    .select("asin, new_price, created_at, success, marketplace")
    .eq("user_id", userId)
    .eq("success", true)
    .eq("marketplace", "US")
    .gt("new_price", 0)
    .in("asin", asins)
    .order("created_at", { ascending: false })
    .limit(4000);
  const seen = new Set<string>();
  for (const r of actions || []) {
    if (seen.has(r.asin)) continue;
    seen.add(r.asin);
    consider(r.asin, Number(r.new_price || 0), "repricer_price_actions", new Date(r.created_at).getTime());
  }

  // 2) asin_my_price_cache (US)
  const { data: mp } = await supabase
    .from("asin_my_price_cache")
    .select("asin, my_price, fetched_at")
    .eq("user_id", userId)
    .eq("marketplace_id", "ATVPDKIKX0DER")
    .in("asin", asins)
    .order("fetched_at", { ascending: false })
    .limit(2000);
  const seenMp = new Set<string>();
  for (const r of mp || []) {
    if (seenMp.has(r.asin)) continue;
    seenMp.add(r.asin);
    const ts = r.fetched_at ? new Date(r.fetched_at).getTime() : 0;
    consider(r.asin, Number(r.my_price || 0), "asin_my_price_cache", ts);
  }

  // 3) inventory.* — only when no timestamped source already exists
  const { data: inv } = await supabase
    .from("inventory")
    .select("asin, price, amazon_price, my_price, updated_at")
    .eq("user_id", userId)
    .in("asin", asins)
    .limit(2000);
  for (const r of inv || []) {
    if (out.has(r.asin)) continue;
    const price = Number(r.price || 0) || Number(r.amazon_price || 0) || Number(r.my_price || 0);
    const ts = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    const src = r.price ? "inventory.price" : (r.amazon_price ? "inventory.amazon_price" : "inventory.my_price");
    consider(r.asin, price, src, ts);
  }

  return out;
}

async function repairUser(supabase: any, userId: string, opts: { perUserCap: number; targetAsins?: string[] }): Promise<{ scanned: number; corrected: number; sample: any[] }> {
  // Find pending US orders whose price came from a stale estimate.
  let orderQuery = supabase
    .from("sales_orders")
    .select("id, order_id, asin, sku, marketplace, order_date, purchase_timestamp_utc, order_status, sold_price, estimated_price, price_source, quantity")
    .eq("user_id", userId)
    .in("marketplace", ["US", "ATVPDKIKX0DER"])
    .in("order_status", ["Pending", "Unknown", ""])
    .or("sold_price.is.null,sold_price.eq.0")
    .or("price_source.like.estimated:%,price_source.is.null");
  if (opts.targetAsins && opts.targetAsins.length > 0) {
    orderQuery = orderQuery.in("asin", opts.targetAsins);
  }
  const { data: orders, error } = await orderQuery
    .order("purchase_timestamp_utc", { ascending: false, nullsFirst: false })
    .order("order_date", { ascending: false })
    .limit(opts.perUserCap);

  if (error) throw error;
  const pending = (orders || []).filter((o: any) => Number(o.sold_price || 0) <= 0);
  if (pending.length === 0) return { scanned: 0, corrected: 0, sample: [] };

  const asins = Array.from(new Set(pending.map((o: any) => o.asin).filter(Boolean)));
  const freshest = await pickFreshestPerAsin(supabase, userId, asins);

  const updates: any[] = [];
  const corrections: any[] = [];
  for (const o of pending) {
    const fresh = freshest.get(o.asin);
    if (!fresh) continue;
    // Only use signals that existed at-or-before order_date.
    const orderTs = o.purchase_timestamp_utc
      ? new Date(o.purchase_timestamp_utc).getTime()
      : (o.order_date ? new Date(o.order_date).getTime() : Date.now());
    if (fresh.ts > 0 && fresh.ts > orderTs + 60_000) continue; // 60s grace
    const est = Number(o.estimated_price || 0);
    const drift = est > 0 ? Math.abs(fresh.price - est) / Math.max(est, 0.01) : 1;
    if (est > 0 && drift <= 0.01) continue;

    updates.push({
      id: o.id,
      estimated_price: Math.round(fresh.price * 100) / 100,
      price_source: `estimated:${fresh.source}`,
      price_calc_mode: "self_heal",
      updated_at: new Date().toISOString(),
    });
    corrections.push({
      user_id: userId,
      order_id: o.order_id,
      asin: o.asin,
      sku: o.sku,
      marketplace: o.marketplace,
      correction_type: "pending_price_self_heal",
      previous_price_source: o.price_source || null,
      new_price_source: `estimated:${fresh.source}`,
      previous_unit_price: est || null,
      new_unit_price: Math.round(fresh.price * 100) / 100,
      revenue_delta: ((fresh.price - est) * Number(o.quantity || 1)) || null,
      corrected_at: new Date().toISOString(),
    });
  }

  if (updates.length === 0) return { scanned: pending.length, corrected: 0, sample: [] };

  let ok = 0;
  for (const u of updates) {
    const { error: uerr } = await supabase
      .from("sales_orders")
      .update({
        estimated_price: u.estimated_price,
        price_source: u.price_source,
        price_calc_mode: u.price_calc_mode,
        updated_at: u.updated_at,
      })
      .eq("id", u.id);
    if (!uerr) ok++;
  }

  // Log corrections (best-effort)
  if (corrections.length > 0) {
    await supabase.from("sales_correction_history").insert(corrections).then(() => null, () => null);
  }

  // Invalidate Live Sales cache for this user
  await supabase
    .from("live_sales_period_cache")
    .delete()
    .eq("user_id", userId)
    .then(() => null, () => null);

  return {
    scanned: pending.length,
    corrected: ok,
    sample: corrections.slice(0, 10),
  };
}

// ----------------------------------------------------------------------------
// PASS 2 — Re-poll Listings API for pending orders that already used
// `seller_derived:listings_api_us` at sync time but have no corroborating
// signal (no recent repricer action / no fresh my_price_cache near that price).
//
// We invoke the existing `backfill-my-price-cache` edge function (which calls
// SP-API Listings Items for each SKU and upserts asin_my_price_cache). Then we
// read the freshly refreshed cache and apply the same drift-based correction.
//
// Safety:
//   - Only pending US rows with sold_price<=0 and no Orders-API/FEC confirm.
//   - Skips orders younger than RE_POLL_MIN_AGE_MIN (let Amazon settle first).
//   - Caps to MAX_ASINS_PER_USER per run to stay under SP-API limits.
//   - Skips ASINs already corroborated (cache within ±2% in last 30min).
//   - Never reads Buy Box / snapshot / competitor as "my price".
//   - Logs every correction to sales_correction_history with explicit source.
// ----------------------------------------------------------------------------

const RE_POLL_MIN_AGE_MIN = 10;          // wait 10min before re-polling
const RE_POLL_CACHE_FRESH_MIN = 30;      // a cache entry within 30min = corroborated
const RE_POLL_CORROBORATION_PCT = 0.02;  // ±2% match counts as corroborated
const RE_POLL_DRIFT_PCT = 0.01;          // only update when >1% drift

async function repollUncorroboratedListingsApi(
  supabase: any,
  userId: string,
  opts: { maxAsinsPerUser: number; targetAsins?: string[] },
): Promise<{ scanned: number; repolled: number; corrected: number; sample: any[] }> {
  const cutoffISO = new Date(Date.now() - RE_POLL_MIN_AGE_MIN * 60_000).toISOString();

  // Candidate pending rows: written by sync-sales-orders with the live Listings
  // API as the seller-owned source, but stale relative to the actual listing.
  let orderQuery = supabase
    .from("sales_orders")
    .select("id, order_id, asin, sku, marketplace, order_date, purchase_timestamp_utc, order_status, sold_price, estimated_price, price_source, quantity")
    .eq("user_id", userId)
    .in("marketplace", ["US", "ATVPDKIKX0DER"])
    .in("order_status", ["Pending", "Unknown", ""])
    .or("sold_price.is.null,sold_price.eq.0")
    .eq("price_source", "seller_derived:listings_api_us");
  if (opts.targetAsins && opts.targetAsins.length > 0) {
    orderQuery = orderQuery.in("asin", opts.targetAsins);
  }
  const { data: orders, error } = await orderQuery
    .order("purchase_timestamp_utc", { ascending: false, nullsFirst: false })
    .order("order_date", { ascending: false })
    .limit(500);

  if (error) throw error;
  const cutoffMs = new Date(cutoffISO).getTime();
  const pending = (orders || []).filter((o: any) => {
    if (!(Number(o.sold_price || 0) <= 0 && o.asin && o.sku)) return false;
    const orderTs = o.purchase_timestamp_utc
      ? new Date(o.purchase_timestamp_utc).getTime()
      : (o.order_date ? new Date(o.order_date).getTime() : 0);
    return orderTs > 0 && orderTs < cutoffMs;
  });
  if (pending.length === 0) return { scanned: 0, repolled: 0, corrected: 0, sample: [] };

  // Deduplicate by ASIN+SKU and check existing corroboration in my_price_cache.
  const asins = Array.from(new Set(pending.map((o: any) => o.asin)));
  const corroborationCutoff = new Date(Date.now() - RE_POLL_CACHE_FRESH_MIN * 60_000).toISOString();
  const { data: freshCache } = await supabase
    .from("asin_my_price_cache")
    .select("asin, my_price, fetched_at")
    .eq("user_id", userId)
    .eq("marketplace_id", "ATVPDKIKX0DER")
    .in("asin", asins)
    .gte("fetched_at", corroborationCutoff);

  const corroborated = new Set<string>();
  for (const c of freshCache || []) {
    // Need to match against the order's estimated_price for that ASIN.
    const orderForAsin = pending.find((p: any) => p.asin === c.asin);
    if (!orderForAsin) continue;
    const est = Number(orderForAsin.estimated_price || 0);
    const cachedPx = Number(c.my_price || 0);
    if (est > 0 && cachedPx > 0 && Math.abs(cachedPx - est) / est <= RE_POLL_CORROBORATION_PCT) {
      corroborated.add(c.asin);
    }
  }

  // Build the unique (asin, sku) re-poll list, capped per user.
  const seenAsin = new Set<string>();
  const items: Array<{ asin: string; sku: string }> = [];
  for (const o of pending) {
    if (corroborated.has(o.asin)) continue;
    if (seenAsin.has(o.asin)) continue;
    seenAsin.add(o.asin);
    items.push({ asin: o.asin, sku: o.sku });
    if (items.length >= opts.maxAsinsPerUser) break;
  }
  if (items.length === 0) return { scanned: pending.length, repolled: 0, corrected: 0, sample: [] };

  // Invoke backfill-my-price-cache for these items (it handles SP-API auth +
  // rate-limit per its own internal pacing). We pass user_id + items.
  try {
    const internalSecret = Deno.env.get("INTERNAL_SYNC_SECRET");
    const { data, error } = await supabase.functions.invoke("backfill-my-price-cache", {
      headers: internalSecret ? { "x-internal-secret": internalSecret } : undefined,
      body: { user_id: userId, items },
    });
    if (error) throw error;
    if (data?.error) throw new Error(String(data.error));
  } catch (e: any) {
    console.warn(`re-poll backfill-my-price-cache failed for ${userId}:`, e?.message || e);
    return { scanned: pending.length, repolled: items.length, corrected: 0, sample: [] };
  }

  // Re-read the freshly refreshed cache and apply drift-based corrections.
  const repolledAsins = items.map((i) => i.asin);
  const { data: refreshed } = await supabase
    .from("asin_my_price_cache")
    .select("asin, my_price, fetched_at")
    .eq("user_id", userId)
    .eq("marketplace_id", "ATVPDKIKX0DER")
    .in("asin", repolledAsins)
    .order("fetched_at", { ascending: false })
    .limit(1000);

  const latestPxByAsin = new Map<string, { price: number; ts: number }>();
  for (const r of refreshed || []) {
    const px = Number(r.my_price || 0);
    if (!(px > 0)) continue;
    const ts = r.fetched_at ? new Date(r.fetched_at).getTime() : 0;
    const prev = latestPxByAsin.get(r.asin);
    if (!prev || ts > prev.ts) latestPxByAsin.set(r.asin, { price: px, ts });
  }

  const updates: any[] = [];
  const corrections: any[] = [];
  const repolledStart = Date.now() - 5 * 60_000; // only trust cache rows from this run
  for (const o of pending) {
    const fresh = latestPxByAsin.get(o.asin);
    if (!fresh) continue;
    if (fresh.ts < repolledStart) continue; // must be a row written by this re-poll
    const orderTs = o.purchase_timestamp_utc
      ? new Date(o.purchase_timestamp_utc).getTime()
      : (o.order_date ? new Date(o.order_date).getTime() : Date.now());
    // Listings API reflects "right now"; only apply if order placed in the recent
    // past — we already filter by RE_POLL_MIN_AGE_MIN, so this is safe. Skip if
    // the order is older than 24h (Amazon should have confirmed by then).
    if (Date.now() - orderTs > 24 * 60 * 60 * 1000) continue;

    const est = Number(o.estimated_price || 0);
    const drift = est > 0 ? Math.abs(fresh.price - est) / Math.max(est, 0.01) : 1;
    if (est > 0 && drift <= RE_POLL_DRIFT_PCT) continue;

    const newPrice = Math.round(fresh.price * 100) / 100;
    updates.push({ id: o.id, newPrice });
    corrections.push({
      user_id: userId,
      order_id: o.order_id,
      asin: o.asin,
      sku: o.sku,
      marketplace: o.marketplace,
      correction_type: "pending_price_listings_api_repoll",
      previous_price_source: o.price_source || null,
      new_price_source: "estimated:listings_api_repoll",
      previous_unit_price: est || null,
      new_unit_price: newPrice,
      revenue_delta: ((newPrice - est) * Number(o.quantity || 1)) || null,
      corrected_at: new Date().toISOString(),
    });
  }

  let ok = 0;
  for (const u of updates) {
    const { error: uerr } = await supabase
      .from("sales_orders")
      .update({
        estimated_price: u.newPrice,
        // Keep pending-estimate semantics so UI / accounting know this is not
        // Amazon-confirmed ItemPrice. sync-sales-orders will overwrite this
        // once Orders API publishes the real ItemPrice.
        price_source: "estimated:listings_api_repoll",
        price_calc_mode: "self_heal_repoll",
        updated_at: new Date().toISOString(),
      })
      .eq("id", u.id);
    if (!uerr) ok++;
  }

  if (corrections.length > 0) {
    await supabase.from("sales_correction_history").insert(corrections).then(() => null, () => null);
  }
  if (ok > 0) {
    await supabase
      .from("live_sales_period_cache")
      .delete()
      .eq("user_id", userId)
      .then(() => null, () => null);
  }

  return {
    scanned: pending.length,
    repolled: items.length,
    corrected: ok,
    sample: corrections.slice(0, 10),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const mode = String(body?.mode || "cron");
    const targetUser: string | null = body?.user_id || null;
    const targetAsins = Array.isArray(body?.asins)
      ? body.asins
        .map((a: any) => String(a || "").trim().toUpperCase())
        .filter((a: string) => /^[A-Z0-9]{10}$/.test(a))
        .slice(0, 50)
      : [];
    const perUserCap = mode === "backfill" ? 5000 : 500;
    // SP-API safety cap for the Listings API re-poll pass.
    const maxAsinsPerUserRepoll = mode === "backfill" ? 200 : 50;
    const enableRepoll = body?.repoll !== false; // default on

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // Resolve users to process
    let users: string[] = [];
    if (targetUser) {
      users = [targetUser];
    } else {
      // Users with recent pending US orders that may need self-healing — either
      // estimate-based (pass 1) or listings_api_us-based (pass 2 re-poll).
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: rows } = await supabase
        .from("sales_orders")
        .select("user_id")
        .in("marketplace", ["US", "ATVPDKIKX0DER"])
        .in("order_status", ["Pending", "Unknown"])
        .or("price_source.like.estimated:%,price_source.eq.seller_derived:listings_api_us,price_source.is.null")
        .gte("order_date", since)
        .limit(10000);
      users = Array.from(new Set((rows || []).map((r: any) => r.user_id).filter(Boolean)));
    }

    const results: any[] = [];
    let totalCorrected = 0;
    let totalRepolled = 0;
    for (const uid of users) {
      const userResult: any = { user_id: uid };
      try {
        const r1 = await repairUser(supabase, uid, { perUserCap, targetAsins });
        totalCorrected += r1.corrected;
        userResult.pass1 = r1;
      } catch (e: any) {
        userResult.pass1_error = e?.message || String(e);
      }
      if (enableRepoll) {
        try {
          const r2 = await repollUncorroboratedListingsApi(supabase, uid, {
            maxAsinsPerUser: maxAsinsPerUserRepoll,
            targetAsins,
          });
          totalCorrected += r2.corrected;
          totalRepolled += r2.repolled;
          userResult.pass2_repoll = r2;
        } catch (e: any) {
          userResult.pass2_error = e?.message || String(e);
        }
      }
      const p1 = userResult.pass1 || {};
      const p2 = userResult.pass2_repoll || {};
      if ((p1.scanned || 0) > 0 || (p1.corrected || 0) > 0 || (p2.scanned || 0) > 0 || (p2.corrected || 0) > 0 || userResult.pass1_error || userResult.pass2_error) {
        results.push(userResult);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, mode, users: users.length, total_corrected: totalCorrected, total_repolled: totalRepolled, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
