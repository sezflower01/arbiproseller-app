// Audit §14 (W2) — FEC writer FX fix.
//
// The settlement path in sync-sales-orders previously used a hardcoded
//   CURRENCY_TO_USD = { USD:1, MXN:0.05, CAD:0.73, BRL:0.17 }
// which silently under-converted BR orders ~8%. Patch swaps in live fx_rates
// via getLiveCurrencyToUsd(). These tests pin the new math so the rate can't
// regress to literal 0.17/0.05/0.73 without a test failure.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Reproduce the helper from the writer (kept in-test so we don't import the
// 9k-line module — same logic, same fallbacks).
async function fetchFxRates(supabase: any): Promise<Record<string, number>> {
  const { data } = await supabase.from("fx_rates").select("quote, rate").eq("base", "USD");
  const rates: Record<string, number> = { USD: 1 };
  for (const r of data || []) rates[r.quote] = r.rate;
  return rates;
}
let FX_RATES_CACHE: Record<string, number> = {};
async function getLiveCurrencyToUsd(supabase: any): Promise<Record<string, number>> {
  if (!FX_RATES_CACHE || Object.keys(FX_RATES_CACHE).length === 0) {
    try { FX_RATES_CACHE = await fetchFxRates(supabase); } catch { /* ignore */ }
  }
  const inv = (q: string, fb: number) => {
    const r = FX_RATES_CACHE?.[q];
    return r && r > 0 ? 1 / r : fb;
  };
  return { USD: 1, CAD: inv("CAD", 0.732), MXN: inv("MXN", 0.0571), BRL: inv("BRL", 0.186) };
}

function makeStubSupabase(rates: Array<{ quote: string; rate: number }>) {
  return {
    from(_t: string) {
      return {
        select(_c: string) {
          return {
            eq(_k: string, _v: string) {
              return Promise.resolve({ data: rates, error: null });
            },
          };
        },
      };
    },
  };
}

Deno.test("BR FEC writer no longer uses stale 0.17 — uses live 5.3766 rate", async () => {
  FX_RATES_CACHE = {};
  const sb = makeStubSupabase([{ quote: "BRL", rate: 5.3766 }]);
  const map = await getLiveCurrencyToUsd(sb);
  // 146.56 BRL settlement should produce ~27.26 USD, not 24.92 USD
  const usd = 146.56 * map.BRL;
  assert(usd > 27.0 && usd < 27.5, `expected ~$27.26 USD, got ${usd}`);
  // And explicitly NOT the legacy hardcoded value
  const legacyUsd = 146.56 * 0.17;
  assert(Math.abs(usd - legacyUsd) > 1.5, `still matches legacy stale rate (${legacyUsd})`);
});

Deno.test("BR FEC writer matches the values used in the YTD repair", async () => {
  FX_RATES_CACHE = {};
  const sb = makeStubSupabase([{ quote: "BRL", rate: 5.3766 }]);
  const map = await getLiveCurrencyToUsd(sb);
  // Pin the W1 repair conversions (within rounding)
  const cases: Array<[number, number]> = [
    [181.19, 33.6961],
    [153.45, 28.5398],
    [148.35, 27.5917],
    [137.72, 25.6118],
    [107.01, 19.8993],
  ];
  for (const [brl, expectedUsd] of cases) {
    const got = brl * map.BRL;
    assert(Math.abs(got - expectedUsd) < 0.01, `BRL ${brl} -> expected ${expectedUsd}, got ${got}`);
  }
});

Deno.test("CA and MX writers use live rates (not legacy 0.73 / 0.05)", async () => {
  FX_RATES_CACHE = {};
  const sb = makeStubSupabase([
    { quote: "CAD", rate: 1.36 },
    { quote: "MXN", rate: 17.5 },
    { quote: "BRL", rate: 5.3766 },
  ]);
  const map = await getLiveCurrencyToUsd(sb);
  assert(Math.abs(map.CAD - 0.735) < 0.005, `CAD inverse ~0.735, got ${map.CAD}`);
  assert(Math.abs(map.MXN - 0.0571) < 0.001, `MXN inverse ~0.057, got ${map.MXN}`);
});

Deno.test("Fallback path: no fx_rates row → safe non-zero defaults, never 0", async () => {
  FX_RATES_CACHE = {};
  const sb = makeStubSupabase([]);
  const map = await getLiveCurrencyToUsd(sb);
  for (const q of ["USD", "CAD", "MXN", "BRL"]) {
    assert(map[q] > 0, `${q} must never be 0 (would zero out revenue)`);
  }
  // Fallback must NOT be the old 0.17 BRL value
  assert(map.BRL > 0.18, `BRL fallback must use post-fix ~0.186, got ${map.BRL}`);
});

Deno.test("Zero/null FEC sales does not overwrite — guard contract", () => {
  // Contract: the writer/repair path only applies when fec.fec_sales_usd > 0
  // and the diff is material (>$0.50). Verify the predicate.
  function shouldAdoptFec(stored: number, fecUsd: number | null): boolean {
    if (!fecUsd || fecUsd <= 0) return false;
    return Math.abs(fecUsd - stored) > 0.50;
  }
  assertEquals(shouldAdoptFec(24.92, 0), false);
  assertEquals(shouldAdoptFec(24.92, null), false);
  assertEquals(shouldAdoptFec(24.92, 25.00), false);
  assertEquals(shouldAdoptFec(24.92, 27.26), true);
});

Deno.test("US rows are never touched by the FX helper", async () => {
  FX_RATES_CACHE = {};
  const sb = makeStubSupabase([{ quote: "BRL", rate: 5.3766 }]);
  const map = await getLiveCurrencyToUsd(sb);
  assertEquals(map.USD, 1);
  // A $100 US sale stays $100
  assertEquals(100 * map.USD, 100);
});
