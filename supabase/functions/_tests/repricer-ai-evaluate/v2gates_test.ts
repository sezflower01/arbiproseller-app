// Momentum Smart V2 raise-safety gate suite (post-raise cooldown +
// market-supported-raise ratio), plus the divergence test _v2gates.ts's own
// docstring promises: index.ts must IMPORT these helpers, never re-declare
// them, or the tests stop proving anything about the real engine's behavior.
//
// Task #104: this file exists specifically because a live dry-run test
// against a real assignment could NOT be made to reliably reach the
// Smart Raise branch (it requires being the live Buy Box owner at the
// right moment) -- so the 2-hour cooldown path is verified here instead,
// directly against the same pure gate functions index.ts calls in
// production, per _v2gates.ts's contract.
//
// Run: deno test --allow-net --allow-env --allow-read \
//   supabase/functions/_tests/repricer-ai-evaluate/v2gates_test.ts

import { assertEquals, assertAlmostEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  evaluatePostRaiseCooldown,
  evaluateMarketSupportedRaise,
} from '../../repricer-ai-evaluate/_v2gates.ts';

// ── Post-raise cooldown ──

const HOUR = 3600000;
const MIN = 60000;

Deno.test('cooldown: no last raise at all -> not active (nothing to cool down from)', () => {
  const r = evaluatePostRaiseCooldown({ lastRaiseAt: null, postRaiseCooldownHours: 2, nowMs: 0 });
  assertEquals(r.active, false);
  assertEquals(r.remainingMinutes, null);
});

Deno.test('cooldown: postRaiseCooldownHours null -> feature off, never active regardless of lastRaiseAt', () => {
  const r = evaluatePostRaiseCooldown({
    lastRaiseAt: new Date(0).toISOString(),
    postRaiseCooldownHours: null,
    nowMs: 5 * MIN,
  });
  assertEquals(r.active, false);
  assertEquals(r.remainingMinutes, null);
});

Deno.test('cooldown: 10 minutes after a raise, 2h cooldown -> active with ~110min remaining', () => {
  const raiseAt = 0;
  const now = 10 * MIN;
  const r = evaluatePostRaiseCooldown({ lastRaiseAt: new Date(raiseAt).toISOString(), postRaiseCooldownHours: 2, nowMs: now });
  assertEquals(r.active, true);
  assertEquals(r.remainingMinutes, 110);
});

Deno.test('cooldown: exactly at the 2h boundary -> no longer active (>= elapsed clears it)', () => {
  const raiseAt = 0;
  const now = 2 * HOUR;
  const r = evaluatePostRaiseCooldown({ lastRaiseAt: new Date(raiseAt).toISOString(), postRaiseCooldownHours: 2, nowMs: now });
  assertEquals(r.active, false);
});

Deno.test('cooldown: 3 hours after a raise, 2h cooldown -> no longer active', () => {
  const raiseAt = 0;
  const now = 3 * HOUR;
  const r = evaluatePostRaiseCooldown({ lastRaiseAt: new Date(raiseAt).toISOString(), postRaiseCooldownHours: 2, nowMs: now });
  assertEquals(r.active, false);
  assertEquals(r.remainingMinutes, null);
});

// ── The user's explicit 5-step validation sequence ──
// 1. A raise is triggered  2. It's recorded  3. A second attempt occurs
// before 2h  4. It's blocked  5. An attempt after 2h is allowed again.

Deno.test('cooldown: full 5-step sequence — trigger, record, block-before-2h, allow-after-2h', () => {
  // Step 1: before any raise has happened, cooldown cannot be active.
  const beforeAnyRaise = evaluatePostRaiseCooldown({ lastRaiseAt: null, postRaiseCooldownHours: 2, nowMs: 0 });
  assertEquals(beforeAnyRaise.active, false, 'step 1: no prior raise -> not blocked, the raise is free to trigger');

  // Step 2: the raise fires and is recorded (repricer-scheduler stamps last_raise_at).
  const raiseRecordedAt = 1000 * HOUR; // arbitrary anchor instant

  // Step 3 + 4: a second raise attempt 90 minutes later (before the 2h window closes) must be blocked.
  const secondAttemptAt = raiseRecordedAt + 90 * MIN;
  const secondAttempt = evaluatePostRaiseCooldown({
    lastRaiseAt: new Date(raiseRecordedAt).toISOString(),
    postRaiseCooldownHours: 2,
    nowMs: secondAttemptAt,
  });
  assertEquals(secondAttempt.active, true, 'step 3/4: 90min < 2h cooldown -> raise must be blocked');
  assertEquals(secondAttempt.remainingMinutes, 30);

  // Step 5: a third attempt 2h05m after the original raise (all other conditions satisfied) must be allowed.
  const thirdAttemptAt = raiseRecordedAt + 2 * HOUR + 5 * MIN;
  const thirdAttempt = evaluatePostRaiseCooldown({
    lastRaiseAt: new Date(raiseRecordedAt).toISOString(),
    postRaiseCooldownHours: 2,
    nowMs: thirdAttemptAt,
  });
  assertEquals(thirdAttempt.active, false, 'step 5: 2h05m >= 2h cooldown -> raise is allowed again');
});

// ── Market-supported raise (floor-support ratio) ──

Deno.test('floor-ratio V1 (ratio=null): floor rose at all -> supported', () => {
  const r = evaluateMarketSupportedRaise({
    buyboxPrice: 21, refPrice: 20, lowestFbaPrice: 20.10, floorRefPrice: 20, minFloorSupportRatio: null,
  });
  assertEquals(r.supported, true);
});

Deno.test('floor-ratio V1 (ratio=null): floor did not rise -> unsupported even though BB rose', () => {
  const r = evaluateMarketSupportedRaise({
    buyboxPrice: 21, refPrice: 20, lowestFbaPrice: 20, floorRefPrice: 20, minFloorSupportRatio: null,
  });
  assertEquals(r.supported, false);
});

Deno.test('floor-ratio V2: the $20->$21 BB / $20->$20.50 floor worked example is exactly at the 0.5 ratio boundary -> supported', () => {
  const r = evaluateMarketSupportedRaise({
    buyboxPrice: 21, refPrice: 20, lowestFbaPrice: 20.50, floorRefPrice: 20, minFloorSupportRatio: 0.5,
  });
  assertEquals(r.bbIncrease, 1);
  assertEquals(r.floorIncrease, 0.5);
  assertEquals(r.requiredFloorIncrease, 0.5);
  assertEquals(r.supported, true, 'floor rise exactly meets the required 50% -> the >= boundary must pass, not fail');
});

Deno.test('floor-ratio V2: floor rise just under the required ratio -> rejected (this is the exact case V1 missed)', () => {
  const r = evaluateMarketSupportedRaise({
    buyboxPrice: 21, refPrice: 20, lowestFbaPrice: 20.40, floorRefPrice: 20, minFloorSupportRatio: 0.5,
  });
  assertAlmostEquals(r.floorIncrease, 0.4);
  assertEquals(r.supported, false, '0.4 rise covers only 40% of the $1 BB rise, below the 50% requirement');
});

Deno.test('floor-ratio V2: floor rise well above the ratio requirement -> supported', () => {
  const r = evaluateMarketSupportedRaise({
    buyboxPrice: 21, refPrice: 20, lowestFbaPrice: 20.90, floorRefPrice: 20, minFloorSupportRatio: 0.5,
  });
  assertEquals(r.supported, true);
});

Deno.test('floor-ratio: missing floor data is never a free pass, V1 or V2', () => {
  const v1 = evaluateMarketSupportedRaise({
    buyboxPrice: 21, refPrice: 20, lowestFbaPrice: null, floorRefPrice: null, minFloorSupportRatio: null,
  });
  const v2 = evaluateMarketSupportedRaise({
    buyboxPrice: 21, refPrice: 20, lowestFbaPrice: null, floorRefPrice: null, minFloorSupportRatio: 0.5,
  });
  assertEquals(v1.supported, false);
  assertEquals(v1.hasFloorData, false);
  assertEquals(v2.supported, false);
  assertEquals(v2.hasFloorData, false);
});

Deno.test('floor-ratio: a stricter ratio (e.g. 1.0, "floor must fully match BB rise") is respected', () => {
  const r = evaluateMarketSupportedRaise({
    buyboxPrice: 21, refPrice: 20, lowestFbaPrice: 20.50, floorRefPrice: 20, minFloorSupportRatio: 1.0,
  });
  assertEquals(r.supported, false, '0.5 floor rise does not cover a required 100% of the $1 BB rise');
});

// ── Divergence guard: index.ts must IMPORT these helpers and actually wire their results into guardsApplied ──

Deno.test('divergence guard: index.ts imports evaluatePostRaiseCooldown/evaluateMarketSupportedRaise from ./_v2gates.ts, and does not re-declare them inline', async () => {
  const src = await Deno.readTextFile(
    new URL('../../repricer-ai-evaluate/index.ts', import.meta.url),
  );
  assert(
    /import\s*\{[^}]*evaluatePostRaiseCooldown[^}]*\}\s*from\s*['"]\.\/_v2gates\.ts['"]/s.test(src),
    'index.ts must import evaluatePostRaiseCooldown from ./_v2gates.ts',
  );
  assert(
    /import\s*\{[^}]*evaluateMarketSupportedRaise[^}]*\}\s*from\s*['"]\.\/_v2gates\.ts['"]/s.test(src),
    'index.ts must import evaluateMarketSupportedRaise from ./_v2gates.ts',
  );
  assert(
    !/function\s+evaluatePostRaiseCooldown\s*\(/.test(src),
    'index.ts must not re-declare evaluatePostRaiseCooldown inline — that would silently stop testing real behavior',
  );
  assert(
    !/function\s+evaluateMarketSupportedRaise\s*\(/.test(src),
    'index.ts must not re-declare evaluateMarketSupportedRaise inline',
  );
});

Deno.test('divergence guard: index.ts pushes the three raise-safety guard tags these gates exist to produce', async () => {
  const src = await Deno.readTextFile(
    new URL('../../repricer-ai-evaluate/index.ts', import.meta.url),
  );
  assert(
    /guardsApplied\.push\(\s*['"]post_raise_cooldown_active['"]\s*\)/.test(src),
    'index.ts must push post_raise_cooldown_active when evaluatePostRaiseCooldown reports active',
  );
  assert(
    /guardsApplied\.push\(\s*['"]market_supported_raise_confirmed['"]\s*\)/.test(src),
    'index.ts must push market_supported_raise_confirmed on the success path',
  );
  assert(
    /guardsApplied\.push\(\s*['"]market_supported_raise_rejected['"]\s*\)/.test(src),
    'index.ts must push market_supported_raise_rejected on the rejection path — this tag did not exist before task #103 and is what #105 will key off of',
  );
});
