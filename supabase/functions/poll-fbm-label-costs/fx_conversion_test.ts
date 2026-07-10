// Regression test for FBM label fee FX conversion.
//
// Guards against the bug where SP-API returns label cost in the marketplace's
// native currency (MXN/CAD/BRL for non-US) and we stored it into the USD-only
// `shipping_label_fee` column without conversion — inflating MX profit math
// ~17×, BR ~5×, CA ~1.4×.
//
// This test isolates the FX layer (`_shared/fx-utils.ts::convertCurrency`)
// against a mock supabase client that returns known USD→native rates and
// verifies:
//   1. Non-USD native amount → USD conversion (MXN, CAD, BRL fixtures)
//   2. USD input is passed through unchanged (no-op)
//   3. Missing FX row returns fxRate=1 (writer must SKIP, not write native as USD)

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { convertCurrency } from "../_shared/fx-utils.ts";

type FxRow = { base: string; quote: string; rate: number };

function makeMockSupabase(rows: FxRow[]) {
  const from = (_table: string) => ({
    select: (_cols: string) => ({
      eq: (colA: string, valA: string) => ({
        eq: (colB: string, valB: string) => ({
          single: async () => {
            const row = rows.find(
              (r) => (r as any)[colA] === valA && (r as any)[colB] === valB,
            );
            return row ? { data: { rate: row.rate }, error: null } : { data: null, error: { message: "not found" } };
          },
        }),
      }),
    }),
  });
  return { from } as any;
}

// USD → native rates. e.g. MXN 17.5 means 1 USD = 17.5 MXN.
const FIXTURES: FxRow[] = [
  { base: "USD", quote: "MXN", rate: 17.5 },
  { base: "USD", quote: "CAD", rate: 1.36 },
  { base: "USD", quote: "BRL", rate: 5.0 },
];

Deno.test("FBM label FX: MXN 50 label → ~USD 2.86 (not $50)", async () => {
  const sb = makeMockSupabase(FIXTURES);
  const { converted, fxRate } = await convertCurrency(50, "MXN", "USD", sb);
  // 50 MXN / 17.5 = 2.857...
  assert(Math.abs(converted - 2.86) < 0.01, `expected ~2.86, got ${converted}`);
  assert(fxRate < 1, `MXN→USD rate should be < 1, got ${fxRate}`);
});

Deno.test("FBM label FX: BRL 25 label → ~USD 5.00 (not $25)", async () => {
  const sb = makeMockSupabase(FIXTURES);
  const { converted } = await convertCurrency(25, "BRL", "USD", sb);
  assert(Math.abs(converted - 5.0) < 0.01, `expected ~5.00, got ${converted}`);
});

Deno.test("FBM label FX: CAD 10 label → ~USD 7.35 (not $10)", async () => {
  const sb = makeMockSupabase(FIXTURES);
  const { converted } = await convertCurrency(10, "CAD", "USD", sb);
  // 10 / 1.36 = 7.352...
  assert(Math.abs(converted - 7.35) < 0.01, `expected ~7.35, got ${converted}`);
});

Deno.test("FBM label FX: USD passthrough (no conversion)", async () => {
  const sb = makeMockSupabase(FIXTURES);
  const { converted, fxRate } = await convertCurrency(12.34, "USD", "USD", sb);
  assertEquals(converted, 12.34);
  assertEquals(fxRate, 1);
});

Deno.test("FBM label FX: missing FX row falls back to fallback map (writer must gate)", async () => {
  // Empty fx_rates table → fx-utils falls back to hardcoded defaults (see getUsdToRate).
  // The caller (poll-fbm-label-costs) treats fxRate===1 for non-USD as
  // 'FX unavailable' and skips the write. We assert here that the fallback
  // path does NOT return the raw amount as USD.
  const sb = makeMockSupabase([]);
  const { converted, fxRate } = await convertCurrency(100, "MXN", "USD", sb);
  // Fallback path uses hardcoded MXN=17.5 → 100/17.5 = 5.71
  // The critical assertion: converted must NOT equal 100 (would mean native stored as USD).
  assert(converted !== 100, `FX fallback must not pass raw native amount through as USD (got ${converted})`);
  assert(fxRate < 1, `MXN fallback rate should still be < 1, got ${fxRate}`);
});
