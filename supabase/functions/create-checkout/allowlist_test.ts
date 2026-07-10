// Verifies the Stripe price_id allowlist behaves as documented in the
// security fix: only IDs from `subscription_plans` (monthly OR annual) plus
// the two Product Library IDs are accepted. Anything else is rejected.
//
// This is a pure-logic test: it re-implements the allowlist check the way
// `index.ts` does, so we can confirm the invariant without spinning up the
// full Stripe/Supabase stack.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const PRODUCT_LIBRARY_PRICE_IDS = [
  "price_1TOVOkHbbOMAX8kO1zHM4FCu",
  "price_1TKOvdHbbOMAX8kOcmMCXth0",
];

type Plan = { stripe_price_id: string | null; stripe_annual_price_id: string | null };

function buildAllowlist(plans: Plan[]): Set<string> {
  const s = new Set<string>(PRODUCT_LIBRARY_PRICE_IDS);
  for (const p of plans) {
    if (p.stripe_price_id) s.add(p.stripe_price_id);
    if (p.stripe_annual_price_id) s.add(p.stripe_annual_price_id);
  }
  return s;
}

Deno.test("accepts monthly price from subscription_plans", () => {
  const allow = buildAllowlist([
    { stripe_price_id: "price_MONTHLY_A", stripe_annual_price_id: "price_ANNUAL_A" },
  ]);
  assertEquals(allow.has("price_MONTHLY_A"), true);
});

Deno.test("accepts annual price from subscription_plans", () => {
  const allow = buildAllowlist([
    { stripe_price_id: "price_MONTHLY_A", stripe_annual_price_id: "price_ANNUAL_A" },
  ]);
  assertEquals(allow.has("price_ANNUAL_A"), true);
});

Deno.test("accepts Product Library monthly (current)", () => {
  const allow = buildAllowlist([]);
  assertEquals(allow.has("price_1TOVOkHbbOMAX8kO1zHM4FCu"), true);
});

Deno.test("accepts Product Library monthly (legacy)", () => {
  const allow = buildAllowlist([]);
  assertEquals(allow.has("price_1TKOvdHbbOMAX8kOcmMCXth0"), true);
});

Deno.test("rejects tampered / unknown price_id", () => {
  const allow = buildAllowlist([
    { stripe_price_id: "price_MONTHLY_A", stripe_annual_price_id: null },
  ]);
  assertEquals(allow.has("price_TAMPERED_NOT_IN_ALLOWLIST_12345"), false);
});

Deno.test("rejects empty string", () => {
  const allow = buildAllowlist([{ stripe_price_id: "price_A", stripe_annual_price_id: null }]);
  assertEquals(allow.has(""), false);
});

Deno.test("rejects null/undefined DB values (no accidental undefined match)", () => {
  const allow = buildAllowlist([{ stripe_price_id: null, stripe_annual_price_id: null }]);
  // Only Product Library IDs remain
  assertEquals(allow.size, PRODUCT_LIBRARY_PRICE_IDS.length);
});
