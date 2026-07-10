// Tests for the Tier A/B time-anchoring fix in repair-pending-listings-price.
//
// IMPORTANT: this test imports the helpers directly from ./time-anchored.ts
// (the same module index.ts uses in production). Do NOT reintroduce inline
// copies here — that was the exact failure mode that let a syntax error ship
// undetected through "12/12 passing" previously.
//
// Reproduces order 113-6259671-5797062 / B0064CUFVC:
//   • Purchase at 2026-07-07 20:17:00 UTC
//   • Amazon shelf at purchase: $28.97 (repricer_price_actions @ 20:04:37)
//   • Repricer subsequently bumped $28.97 → $29.00 → $29.09 → $29.14
//   • Listings API "now" at repair time: $29.14
//   • Correct fix: pick $28.97 via Tier A, NOT $29.14 via Tier C.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isAlreadyTimeAnchored, resolveTimeAnchoredPrice } from "./time-anchored.ts";

// ── Fake supabase for resolveTimeAnchoredPrice ───────────────────────────────
type RpaRow = {
  user_id: string; asin: string; marketplace: string; success: boolean;
  new_price: number | null; amazon_accepted_price: number | null;
  created_at: string;
};
type SnapRow = {
  user_id: string; order_id: string; asin: string;
  snapshot_item_price: number; captured_at: string;
};

function makeFakeSupabase(rpa: RpaRow[], snaps: SnapRow[]) {
  return {
    from(table: string) {
      const state: any = { table, filters: {} as Record<string, any>, gtFilters: {} as Record<string, any>, lte: null as string | null, order: null as any, limitN: null as number | null, notNulls: [] as string[] };
      const chain: any = {
        select() { return chain; },
        eq(col: string, val: any) { state.filters[col] = val; return chain; },
        gt(col: string, val: any) { state.gtFilters[col] = val; return chain; },
        lte(col: string, val: any) { state.lte = val; state.lteCol = col; return chain; },
        not(col: string, _op: string, _val: any) { state.notNulls.push(col); return chain; },
        order(_col: string, opts: any) { state.order = opts; return chain; },
        limit(n: number) { state.limitN = n; return chain; },
        async maybeSingle() {
          let src: any[] = table === "repricer_price_actions" ? rpa : snaps;
          src = src.filter((r) => {
            for (const [k, v] of Object.entries(state.filters)) if ((r as any)[k] !== v) return false;
            for (const [k, v] of Object.entries(state.gtFilters)) if (!((r as any)[k] > (v as any))) return false;
            if (state.lte && (r as any)[state.lteCol] > state.lte) return false;
            for (const nn of state.notNulls) if ((r as any)[nn] === null) return false;
            return true;
          });

          const desc = state.order?.ascending === false;
          const key = state.lteCol || "captured_at";
          src.sort((a, b) => (desc ? (b[key] > a[key] ? 1 : -1) : (a[key] > b[key] ? 1 : -1)));
          return { data: src[0] || null, error: null };
        },
      };
      return chain;
    },
  };
}

// ── Fixtures for the reference case ──────────────────────────────────────────
const USER = "user-1";
const ASIN = "B0064CUFVC";
const MP = "US";
const PURCHASE_TS = "2026-07-07T20:17:00.000Z";

const REFERENCE_RPA: RpaRow[] = [
  { user_id: USER, asin: ASIN, marketplace: MP, success: true, new_price: 29.00, amazon_accepted_price: null, created_at: "2026-07-07T14:27:16.000Z" },
  { user_id: USER, asin: ASIN, marketplace: MP, success: true, new_price: 28.97, amazon_accepted_price: null, created_at: "2026-07-07T15:10:44.000Z" },
  { user_id: USER, asin: ASIN, marketplace: MP, success: true, new_price: 29.00, amazon_accepted_price: null, created_at: "2026-07-07T16:13:34.000Z" },
  { user_id: USER, asin: ASIN, marketplace: MP, success: true, new_price: 28.97, amazon_accepted_price: null, created_at: "2026-07-07T19:45:14.000Z" },
  { user_id: USER, asin: ASIN, marketplace: MP, success: true, new_price: 29.00, amazon_accepted_price: null, created_at: "2026-07-07T20:03:44.000Z" },
  // ↓ the winning row for purchase @ 20:17
  { user_id: USER, asin: ASIN, marketplace: MP, success: true, new_price: 28.97, amazon_accepted_price: null, created_at: "2026-07-07T20:04:37.000Z" },
  // ↓ post-purchase; MUST be excluded by the ≤ purchase_ts filter
  { user_id: USER, asin: ASIN, marketplace: MP, success: true, new_price: 29.00, amazon_accepted_price: null, created_at: "2026-07-07T20:25:26.000Z" },
  { user_id: USER, asin: ASIN, marketplace: MP, success: true, new_price: 29.09, amazon_accepted_price: null, created_at: "2026-07-07T20:47:40.000Z" },
  { user_id: USER, asin: ASIN, marketplace: MP, success: true, new_price: 29.14, amazon_accepted_price: null, created_at: "2026-07-07T21:08:15.000Z" },
];

// ─────────────────────────────────────────────────────────────────────────────

Deno.test("Tier A picks price-at-purchase, not price-at-repair, for oscillating ASIN", async () => {
  const supabase = makeFakeSupabase(REFERENCE_RPA, []);
  const result = await resolveTimeAnchoredPrice(supabase, {
    user_id: USER, order_id: "113-6259671-5797062", asin: ASIN, marketplace: MP,
    purchase_timestamp_utc: PURCHASE_TS,
  });
  assert(result !== null, "Tier A must resolve");
  assertEquals(result!.price, 28.97, "must pick $28.97 (the shelf price at 20:17), NOT $29.14 (Listings API now)");
  assertEquals(result!.source, "seller_derived:repricer_action");
  assertEquals(result!.anchored_at, "2026-07-07T20:04:37.000Z");
});

Deno.test("Tier A excludes repricer actions AFTER purchase timestamp", async () => {
  const supabase = makeFakeSupabase(REFERENCE_RPA, []);
  const result = await resolveTimeAnchoredPrice(supabase, {
    user_id: USER, order_id: "test", asin: ASIN, marketplace: MP,
    purchase_timestamp_utc: PURCHASE_TS,
  });
  assert(result!.anchored_at <= PURCHASE_TS, `anchored_at ${result!.anchored_at} must be ≤ purchase ${PURCHASE_TS}`);
});

Deno.test("Tier A returns null when purchase_timestamp_utc is missing", async () => {
  const supabase = makeFakeSupabase(REFERENCE_RPA, []);
  const result = await resolveTimeAnchoredPrice(supabase, {
    user_id: USER, order_id: "test", asin: ASIN, marketplace: MP,
    purchase_timestamp_utc: null,
  });
  assertEquals(result, null, "cannot time-anchor without a purchase timestamp; caller must backfill via GetOrder first");
});

Deno.test("Tier B falls back to order_price_snapshots when repricer has no history", async () => {
  const supabase = makeFakeSupabase([], [
    { user_id: USER, order_id: "test", asin: ASIN, snapshot_item_price: 27.50, captured_at: "2026-07-07T20:00:00.000Z" },
  ]);
  const result = await resolveTimeAnchoredPrice(supabase, {
    user_id: USER, order_id: "test", asin: ASIN, marketplace: MP,
    purchase_timestamp_utc: PURCHASE_TS,
  });
  assertEquals(result?.price, 27.50);
  assertEquals(result?.source, "seller_derived:snapshot");
});

Deno.test("Tier A returns null when no repricer action exists ≤ purchase_ts (falls through to Tier C)", async () => {
  const laterOnly: RpaRow[] = [{ user_id: USER, asin: ASIN, marketplace: MP, success: true, new_price: 29.14, amazon_accepted_price: null, created_at: "2026-07-07T21:08:15.000Z" }];
  const supabase = makeFakeSupabase(laterOnly, []);
  const result = await resolveTimeAnchoredPrice(supabase, {
    user_id: USER, order_id: "test", asin: ASIN, marketplace: MP,
    purchase_timestamp_utc: PURCHASE_TS,
  });
  assertEquals(result, null, "all repricer actions are AFTER purchase — Tier A must decline and let Tier C handle it");
});

// ── isAlreadyTimeAnchored guard ──────────────────────────────────────────────

Deno.test("Guard: blocks overwrite of row already anchored via Tier A", () => {
  assertEquals(isAlreadyTimeAnchored({
    price_source: "seller_derived:repricer_action",
    estimated_price: 28.97,
    price_confidence: "HIGH_CONFIDENCE_PENDING",
  }), true);
});

Deno.test("Guard: blocks overwrite of row anchored via Tier B (snapshot)", () => {
  assertEquals(isAlreadyTimeAnchored({
    price_source: "seller_derived:snapshot",
    estimated_price: 27.50,
    price_confidence: "HIGH_CONFIDENCE_PENDING",
  }), true);
});

Deno.test("Guard: ALLOWS repair of Tier C row (seller_derived:listings_api_us) — this is the reference bug", () => {
  assertEquals(isAlreadyTimeAnchored({
    price_source: "seller_derived:listings_api_us",
    estimated_price: 29.14,
    price_confidence: "HIGH_CONFIDENCE_PENDING",
  }), false, "listings_api_us is NOT time-anchored — must remain eligible for repair");
});

Deno.test("Guard: ALLOWS repair of stale-cache row (estimated:*)", () => {
  assertEquals(isAlreadyTimeAnchored({
    price_source: "estimated:asin_my_price_cache",
    estimated_price: 36.00,
    price_confidence: "HIGH_CONFIDENCE_PENDING",
  }), false);
});

Deno.test("Guard: does NOT block rows with estimated_price=0 (Group A zeros)", () => {
  assertEquals(isAlreadyTimeAnchored({
    price_source: "seller_derived:repricer_action",
    estimated_price: 0,
    price_confidence: "HIGH_CONFIDENCE_PENDING",
  }), false, "zero-price rows still need repair even if source label looks anchored");
});

Deno.test("Guard: does NOT protect LOW_CONFIDENCE_HINT rows", () => {
  assertEquals(isAlreadyTimeAnchored({
    price_source: "seller_derived:repricer_action",
    estimated_price: 28.97,
    price_confidence: "LOW_CONFIDENCE_HINT",
  }), false);
});

// ── End-to-end reference case ────────────────────────────────────────────────

Deno.test("REFERENCE CASE: order 113-6259671-5797062 resolves to $28.97 (buyer's paid price), not $29.14 (Listings API now)", async () => {
  const supabase = makeFakeSupabase(REFERENCE_RPA, []);
  const referenceRow = {
    user_id: USER,
    order_id: "113-6259671-5797062",
    asin: "B0064CUFVC",
    marketplace: "US",
    purchase_timestamp_utc: PURCHASE_TS,
  };
  const result = await resolveTimeAnchoredPrice(supabase, referenceRow);

  // qty × unit_price parity check against Amazon Seller Central: 5 × $28.97 = $144.85
  const quantity = 5;
  const totalRevenue = quantity * (result?.price ?? 0);
  assertEquals(totalRevenue, 144.85, "5 units × $28.97 must equal Amazon's $144.85, not $145.70");
  assertEquals(result?.source, "seller_derived:repricer_action");
});
