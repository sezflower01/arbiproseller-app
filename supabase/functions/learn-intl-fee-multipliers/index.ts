// Nightly learner for international fee multipliers (CA / MX / BR).
//
// For each user × marketplace × fee_component, compares the SP-API fee
// estimate that was captured on `sales_orders` at ingest time against the
// actual settled fee on `financial_events_cache`. The resulting ratio
// (actual / estimated) is stored in `learned_fee_multipliers`.
//
// Phase 1 (this deploy): data collection only. No surface in the app
// consumes these multipliers yet — we want to observe stability for a
// couple of weeks before turning the read path on.
//
// Safety rails:
//  - Per-user, per-marketplace. No global aggregation.
//  - Rolling 180-day window.
//  - Cron-locked + throttle-aware.
//  - Sanity clamp: ignores multipliers outside [0.5, 4.0].
//  - Sample size gates confidence; <10 samples => 'insufficient' and is
//    persisted but flagged as not-applicable.
//  - Settled fees are never written or modified.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const WINDOW_DAYS = 180;
const MARKETPLACES = ["CA", "MX", "BR"] as const;
const COMPONENTS = ["referral", "fba", "closing", "total"] as const;
const MIN_SALE_PRICE_USD = 5;
const CLAMP_MIN = 0.5;
const CLAMP_MAX = 4.0;

type Component = (typeof COMPONENTS)[number];

interface SettledRow {
  amazon_order_id: string;
  referral_fees: number;
  fba_fees: number;
  variable_closing_fees: number;
  fixed_closing_fees: number;
}

interface OrderRow {
  order_id: string;
  marketplace: string | null;
  sold_price: number | null;
  total_sale_amount: number | null;
  referral_fee: number | null;
  fba_fee: number | null;
  closing_fee: number | null;
  total_fees: number | null;
  fees_invalid: boolean | null;
  is_cancelled: boolean | null;
  order_status: string | null;
}

function confidenceFor(n: number): "insufficient" | "low" | "medium" | "high" {
  if (n < 10) return "insufficient";
  if (n < 30) return "low";
  if (n < 100) return "medium";
  return "high";
}

function clampMultiplier(actualSum: number, estSum: number): number | null {
  if (estSum <= 0 || !Number.isFinite(estSum) || !Number.isFinite(actualSum)) {
    return null;
  }
  const m = actualSum / estSum;
  if (!Number.isFinite(m) || m < CLAMP_MIN || m > CLAMP_MAX) return null;
  return Math.round(m * 10000) / 10000;
}

async function processUserMarketplace(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  marketplace: "CA" | "MX" | "BR",
  windowStart: string,
  windowEnd: string,
): Promise<{ written: number; skipped: number }> {
  // 1) Pull settled fees from FEC for this marketplace, this window.
  //    Aggregate per amazon_order_id (one order can have multiple shipment events).
  const settledByOrder = new Map<string, SettledRow>();
  const PAGE = 1000;
  for (let from = 0; from < 200000; from += PAGE) {
    const { data, error } = await supabase
      .from("financial_events_cache")
      .select(
        "amazon_order_id, referral_fees, fba_fees, variable_closing_fees, fixed_closing_fees",
      )
      .eq("user_id", userId)
      .eq("event_type", "shipment")
      .eq("marketplace", marketplace)
      .gte("event_date", windowStart)
      .lte("event_date", windowEnd)
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn(
        `[learn-intl-fee-multipliers] FEC pull error user=${userId} mp=${marketplace}:`,
        error.message,
      );
      break;
    }
    if (!data || data.length === 0) break;
    for (const r of data) {
      const oid = String(r.amazon_order_id || "").trim();
      if (!oid) continue;
      const prev = settledByOrder.get(oid) || {
        amazon_order_id: oid,
        referral_fees: 0,
        fba_fees: 0,
        variable_closing_fees: 0,
        fixed_closing_fees: 0,
      };
      // Settled fees in FEC are negative; we want absolute values.
      prev.referral_fees += Math.abs(Number(r.referral_fees || 0));
      prev.fba_fees += Math.abs(Number(r.fba_fees || 0));
      prev.variable_closing_fees += Math.abs(
        Number(r.variable_closing_fees || 0),
      );
      prev.fixed_closing_fees += Math.abs(Number(r.fixed_closing_fees || 0));
      settledByOrder.set(oid, prev);
    }
    if (data.length < PAGE) break;
  }

  if (settledByOrder.size === 0) {
    // Upsert insufficient rows so the table reflects "we tried but had no data".
    for (const component of COMPONENTS) {
      await supabase
        .from("learned_fee_multipliers")
        .upsert(
          {
            user_id: userId,
            marketplace,
            fee_component: component,
            sample_count: 0,
            multiplier: null,
            confidence: "insufficient",
            window_start: windowStart,
            window_end: windowEnd,
            sample_orders: [],
            raw_estimated_total: 0,
            raw_actual_total: 0,
            last_computed_at: new Date().toISOString(),
          },
          { onConflict: "user_id,marketplace,fee_component" },
        );
    }
    return { written: 0, skipped: 0 };
  }

  // 2) Pull matching sales_orders rows for the estimates.
  const orderIds = Array.from(settledByOrder.keys());
  const estByOrder = new Map<string, OrderRow>();
  const CHUNK = 200;
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const slice = orderIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("sales_orders")
      .select(
        "order_id, marketplace, sold_price, total_sale_amount, referral_fee, fba_fee, closing_fee, total_fees, fees_invalid, is_cancelled, order_status",
      )
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .in("order_id", slice);
    if (error) {
      console.warn(
        `[learn-intl-fee-multipliers] sales_orders pull error user=${userId} mp=${marketplace}:`,
        error.message,
      );
      continue;
    }
    for (const r of data || []) {
      const oid = String(r.order_id || "").trim();
      if (!oid) continue;
      // Skip refund / cancel / invalid rows.
      if (oid.endsWith("-REFUND")) continue;
      if (r.is_cancelled === true) continue;
      if (r.fees_invalid === true) continue;
      const salePrice = Number(r.total_sale_amount || r.sold_price || 0);
      if (!(salePrice >= MIN_SALE_PRICE_USD)) continue;
      estByOrder.set(oid, r as OrderRow);
    }
  }

  // 3) Build per-component sums.
  const sums: Record<
    Component,
    { actual: number; estimated: number; samples: string[] }
  > = {
    referral: { actual: 0, estimated: 0, samples: [] },
    fba: { actual: 0, estimated: 0, samples: [] },
    closing: { actual: 0, estimated: 0, samples: [] },
    total: { actual: 0, estimated: 0, samples: [] },
  };

  for (const [oid, est] of estByOrder) {
    const settled = settledByOrder.get(oid);
    if (!settled) continue;

    const settledClosing =
      settled.variable_closing_fees + settled.fixed_closing_fees;
    const settledTotal =
      settled.referral_fees +
      settled.fba_fees +
      settledClosing;

    const components: Record<Component, { actual: number; estimated: number }> =
      {
        referral: {
          actual: settled.referral_fees,
          estimated: Number(est.referral_fee || 0),
        },
        fba: {
          actual: settled.fba_fees,
          estimated: Number(est.fba_fee || 0),
        },
        closing: {
          actual: settledClosing,
          estimated: Number(est.closing_fee || 0),
        },
        total: {
          actual: settledTotal,
          estimated: Number(est.total_fees || 0),
        },
      };

    for (const c of COMPONENTS) {
      const { actual, estimated } = components[c];
      // Skip orders where the estimate is missing or zero — they'd produce
      // div-by-zero or infinite ratios. We still count `total` as long as
      // any positive estimate exists.
      if (!(estimated > 0)) continue;
      if (!(actual >= 0)) continue;
      sums[c].actual += actual;
      sums[c].estimated += estimated;
      if (sums[c].samples.length < 5) sums[c].samples.push(oid);
    }
  }

  // 4) Upsert per component.
  let written = 0;
  let skipped = 0;
  for (const component of COMPONENTS) {
    const s = sums[component];
    // sample_count = orders that contributed (we used samples.length only for
    // the audit list; the true count is harder — derive from estByOrder size
    // when estimated>0 for this component). Recompute properly:
    let n = 0;
    for (const [oid, est] of estByOrder) {
      if (!settledByOrder.has(oid)) continue;
      const v =
        component === "referral"
          ? Number(est.referral_fee || 0)
          : component === "fba"
            ? Number(est.fba_fee || 0)
            : component === "closing"
              ? Number(est.closing_fee || 0)
              : Number(est.total_fees || 0);
      if (v > 0) n += 1;
    }
    const multiplier = clampMultiplier(s.actual, s.estimated);
    const confidence = multiplier === null ? "insufficient" : confidenceFor(n);

    const { error } = await supabase
      .from("learned_fee_multipliers")
      .upsert(
        {
          user_id: userId,
          marketplace,
          fee_component: component,
          sample_count: n,
          multiplier,
          confidence,
          window_start: windowStart,
          window_end: windowEnd,
          sample_orders: s.samples,
          raw_estimated_total: Math.round(s.estimated * 10000) / 10000,
          raw_actual_total: Math.round(s.actual * 10000) / 10000,
          last_computed_at: new Date().toISOString(),
        },
        { onConflict: "user_id,marketplace,fee_component" },
      );
    if (error) {
      console.warn(
        `[learn-intl-fee-multipliers] upsert error user=${userId} mp=${marketplace} c=${component}:`,
        error.message,
      );
      skipped += 1;
    } else {
      written += 1;
    }
  }

  return { written, skipped };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Cron-lock so overlapping invocations don't double-write.
  let cronRunId: number | null = null;
  try {
    const { data: lockOk } = await supabase.rpc("try_acquire_cron_lock", {
      p_job_name: "learn-intl-fee-multipliers",
      p_ttl_seconds: 1800,
    });
    if (!lockOk) {
      return new Response(
        JSON.stringify({ ok: false, reason: "lock_busy" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const { data: runId } = await supabase.rpc("record_cron_run_start", {
      p_job: "learn-intl-fee-multipliers",
      p_overlap_window_minutes: 30,
    });
    cronRunId = typeof runId === "number" ? runId : null;

    // Optional throttle.
    try {
      const { data: throttled } = await supabase.rpc("should_throttle_now");
      if (throttled === true) {
        if (cronRunId) {
          await supabase.rpc("record_cron_run_finish", {
            p_id: cronRunId,
            p_status: "throttled",
          });
        }
        return new Response(
          JSON.stringify({ ok: false, reason: "throttled" }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    } catch (_) {
      // throttle helper optional
    }

    // Allow targeting a single user (manual debug) via body.
    let onlyUserId: string | null = null;
    try {
      const body = await req.json().catch(() => null);
      if (body && typeof body.user_id === "string") onlyUserId = body.user_id;
    } catch (_) {}

    // Window bounds.
    const today = new Date();
    const windowEnd = today.toISOString().slice(0, 10);
    const start = new Date(today.getTime() - WINDOW_DAYS * 86400 * 1000);
    const windowStart = start.toISOString().slice(0, 10);

    // Get user set. We pull distinct users from financial_events_cache who
    // have any settled intl event in the window — no point computing for
    // users who don't have intl settlement history.
    let userIds: string[] = [];
    if (onlyUserId) {
      userIds = [onlyUserId];
    } else {
      const { data, error } = await supabase
        .from("financial_events_cache")
        .select("user_id")
        .eq("event_type", "shipment")
        .in("marketplace", MARKETPLACES as unknown as string[])
        .gte("event_date", windowStart)
        .lte("event_date", windowEnd)
        .limit(50000);
      if (error) {
        console.warn(
          "[learn-intl-fee-multipliers] user enumeration error:",
          error.message,
        );
      }
      const set = new Set<string>();
      for (const r of data || []) {
        const uid = String((r as { user_id?: string }).user_id || "").trim();
        if (uid) set.add(uid);
      }
      userIds = Array.from(set);
    }

    let totalWritten = 0;
    let totalSkipped = 0;
    let userCount = 0;
    for (const uid of userIds) {
      for (const mp of MARKETPLACES) {
        try {
          const r = await processUserMarketplace(
            supabase,
            uid,
            mp,
            windowStart,
            windowEnd,
          );
          totalWritten += r.written;
          totalSkipped += r.skipped;
        } catch (e) {
          console.warn(
            `[learn-intl-fee-multipliers] user=${uid} mp=${mp} failed:`,
            (e as Error).message,
          );
        }
        // tiny pause to avoid bursting
        await new Promise((res) => setTimeout(res, 50));
      }
      userCount += 1;
    }

    if (cronRunId) {
      await supabase.rpc("record_cron_run_finish", {
        p_id: cronRunId,
        p_status: "done",
        p_rows: totalWritten,
        p_notes: `users=${userCount} written=${totalWritten} skipped=${totalSkipped}`,
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        users: userCount,
        rows_written: totalWritten,
        rows_skipped: totalSkipped,
        window_start: windowStart,
        window_end: windowEnd,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[learn-intl-fee-multipliers] fatal:", e);
    if (cronRunId) {
      await supabase
        .rpc("record_cron_run_finish", {
          p_id: cronRunId,
          p_status: "error",
          p_notes: String((e as Error).message || e).slice(0, 500),
        })
        .catch(() => {});
    }
    return new Response(
      JSON.stringify({ ok: false, error: String((e as Error).message || e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
