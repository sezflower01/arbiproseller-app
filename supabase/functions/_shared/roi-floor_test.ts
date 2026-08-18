// Tests for the auto-lower-min ROI floor math.
//
// The safety guarantee of repricer-auto-lower-min is one sentence: a floor is
// never set below its ROI limit. That reduces to two properties of this module,
// which is what these tests pin down.
//
//   1. ROUND TRIP  roiAtPrice(priceForRoi(target)) === target
//                  If the inverse and forward disagree, the worker computes a
//                  compliant-looking floor that is not compliant.
//   2. FX PINNING  a different fx rate must produce a different, self-consistent
//                  answer — never silently reuse the USD number. This is the
//                  bug the browser has, where the same MX min rendered as 73.2%
//                  and later 99.8% from a drifting cached rate.
//
// Run:
//   deno test supabase/functions/_shared/roi-floor_test.ts

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { priceForRoi, roiAtPrice } from "./roi-floor.ts";

// Rate-based fee shape, as written by asin_fee_cache.
const RATE_FEES = { referral_rate: 0.15, fba_fee_fixed: 3.22, marketplace: "US" };
// Legacy dollar-amount shape, captured at a specific price.
const LEGACY_FEES = { referralFee: 3.0, fbaFee: 4.0, price: 20, marketplace: "US" };

Deno.test("round trip: priceForRoi then roiAtPrice returns the target ROI", () => {
  for (const target of [0, 15, 30, 70, 120]) {
    const p = priceForRoi(10, RATE_FEES, target, 1, "US");
    assert(p !== null, `priceForRoi returned null for target ${target}`);
    const roi = roiAtPrice(10, RATE_FEES, p!, 1, "US");
    assert(roi !== null, `roiAtPrice returned null for target ${target}`);
    // priceForRoi rounds UP to the cent, so the realised ROI is >= target and
    // within a cent's worth of it. Never below — that direction is the unsafe one.
    assert(roi! >= target - 0.001, `ROI ${roi} fell below target ${target}`);
    assertAlmostEquals(roi!, target, 0.5);
  }
});

Deno.test("round trip holds for the legacy dollar-amount fee shape", () => {
  const p = priceForRoi(10, LEGACY_FEES, 70, 1, "US");
  assert(p !== null);
  const roi = roiAtPrice(10, LEGACY_FEES, p!, 1, "US");
  assert(roi !== null);
  assert(roi! >= 70 - 0.001, `ROI ${roi} fell below the 70% floor`);
});

Deno.test("US break-even floor: 0% ROI price covers cost plus fees exactly", () => {
  const p = priceForRoi(10, RATE_FEES, 0, 1, "US");
  assert(p !== null);
  const roi = roiAtPrice(10, RATE_FEES, p!, 1, "US");
  assert(roi !== null);
  assert(roi! >= 0, `break-even price yielded a loss: ${roi}%`);
  // Sanity: cost 10 + 3.22 fixed, grossed up for a 15% referral.
  assertAlmostEquals(p!, (10 + 3.22) / 0.85, 0.02);
});

Deno.test("FX is honoured, not ignored: MX at rate 17.5 differs from USD", () => {
  const usd = priceForRoi(10, RATE_FEES, 70, 1, "US");
  const mxn = priceForRoi(10, RATE_FEES, 70, 17.5, "MX");
  assert(usd !== null && mxn !== null);
  assert(mxn! > usd! * 10, "MX floor should scale with the FX rate");

  // And it must round-trip at that same rate.
  const roi = roiAtPrice(10, RATE_FEES, mxn!, 17.5, "MX");
  assert(roi !== null);
  assert(roi! >= 70 - 0.001, `MX ROI ${roi} fell below the 70% floor`);
});

Deno.test("the FX drift bug: same price + different rate = different ROI", () => {
  // This is the browser behaviour that made screen-reading unsafe. We assert it
  // is REAL (so nobody 'fixes' it by ignoring fx), which is precisely why the
  // worker pins one rate per run instead of trusting a cached client value.
  const a = roiAtPrice(10, RATE_FEES, 400, 17.5, "MX");
  const b = roiAtPrice(10, RATE_FEES, 400, 20.5, "MX");
  assert(a !== null && b !== null);
  assert(Math.abs(a! - b!) > 5, "fx rate must materially move ROI");
});

Deno.test("refuses rather than guesses when inputs are unusable", () => {
  assertEquals(roiAtPrice(0, RATE_FEES, 20, 1, "US"), null, "zero cost must be null, not 0%");
  assertEquals(roiAtPrice(null, RATE_FEES, 20, 1, "US"), null);
  assertEquals(priceForRoi(0, RATE_FEES, 70, 1, "US"), null);
  // A referral rate at/above 100% makes the inverse undefined.
  assertEquals(priceForRoi(10, { referral_rate: 1.0 }, 70, 1, "US"), null);
});

Deno.test("refuses to guess fees rather than assuming a flat 15%", () => {
  // Regression for dry run #1: B074678KNX came back at +1.7% ROI on a price the
  // table had shown at -14.3%, because a missing fee structure fell back to 15%
  // while real fees were ~36%. A floor set from that is loss-making but reads as
  // profitable — so an underivable referral rate must return null, not a number.
  assertEquals(roiAtPrice(10, null, 20, 1, "US"), null, "no fees_json must refuse");
  assertEquals(priceForRoi(10, null, 70, 1, "US"), null, "no fees_json must refuse");
  assertEquals(roiAtPrice(10, {}, 20, 1, "US"), null, "empty fees_json must refuse");
  assertEquals(
    roiAtPrice(10, { someUnrelatedKey: 1 }, 20, 1, "US"),
    null,
    "unrecognised fee shape must refuse",
  );
  // Legacy amounts without the capture price cannot yield a referral RATE.
  assertEquals(
    priceForRoi(10, { referralFee: 3.0, fbaFee: 4.0 }, 70, 1, "US"),
    null,
    "legacy fees without a capture price must refuse",
  );
  // ...but the same shape WITH a capture price is usable.
  assert(priceForRoi(10, { referralFee: 3.0, fbaFee: 4.0, price: 20 }, 70, 1, "US") !== null);
});

Deno.test("higher target ROI always means a higher floor (monotonic)", () => {
  let prev = -Infinity;
  for (const target of [0, 10, 30, 70, 100, 200]) {
    const p = priceForRoi(12.5, RATE_FEES, target, 1, "US");
    assert(p !== null);
    assert(p! > prev, `floor did not increase at target ${target}`);
    prev = p!;
  }
});
