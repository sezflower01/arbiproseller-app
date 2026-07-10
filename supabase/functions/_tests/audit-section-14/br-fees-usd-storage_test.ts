// AUDIT §14d — BR fee cache must never store native-currency fba_fee_fixed.
//
// The warm-up path in sync-sales-orders previously called
//   fetchProductFees(token, asin, refPrice)
// without marketplaceId/fxRates, so Brazil/MX/CA fees came back in native
// currency and were written to asin_fee_cache as USD. After a later
// data-repair flipped sold_price USD, total_fees stayed native — a $28.54 BR
// sale ended up with $21.86 in "fees" instead of ~$4.07.
//
// This regression test scans the warm-up call sites in
// supabase/functions/sync-sales-orders/index.ts and fails if any
// fetchProductFees(...) invocation that writes to asin_fee_cache is missing
// the marketplaceId + FX context arguments.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = await Deno.readTextFile(
  new URL("../../sync-sales-orders/index.ts", import.meta.url),
);

Deno.test("warm-up path passes marketplaceId + fx to fetchProductFees", () => {
  // The warm-up block lives just before the `asin_fee_cache` upsert tagged
  // `fee_source: 'fees_api'`. Find that upsert and confirm the nearest
  // `fetchProductFees(` call above it carries the extra args.
  const upsertIdx = SRC.indexOf("fee_source: 'fees_api'");
  assert(upsertIdx > 0, "could not find fees_api upsert in sync-sales-orders");

  const window = SRC.slice(Math.max(0, upsertIdx - 4000), upsertIdx);
  const callIdx = window.lastIndexOf("fetchProductFees(");
  assert(callIdx > 0, "could not find fetchProductFees call in warm-up window");

  // Extract the call signature up to the matching close paren.
  const tail = window.slice(callIdx);
  const closeIdx = tail.indexOf(");");
  assert(closeIdx > 0, "could not find end of fetchProductFees call");
  const call = tail.slice(0, closeIdx + 1);

  assert(
    /marketplaceId/.test(call),
    `warm-up fetchProductFees() missing marketplaceId arg — non-US fees will store native. Call: ${call}`,
  );
  assert(
    /FX_RATES_CACHE/.test(call),
    `warm-up fetchProductFees() missing FX_RATES_CACHE arg — non-US fees will store native. Call: ${call}`,
  );
});

Deno.test("warm-up refuses non-US fee storage when fx_rate is missing", () => {
  // The magnitude/fx guards we added must both be present so a future
  // refactor cannot silently re-enable native fee storage.
  assert(
    SRC.includes("FEE_CACHE_WARMUP_SKIP") &&
      /fx_rate missing\/invalid/.test(SRC),
    "missing FX_RATES_CACHE skip guard in warm-up path",
  );
  assert(
    SRC.includes("FEE_CACHE_WARMUP_SANITY_REJECT") &&
      /likely native/.test(SRC),
    "missing magnitude sanity-reject guard in warm-up path",
  );
});
