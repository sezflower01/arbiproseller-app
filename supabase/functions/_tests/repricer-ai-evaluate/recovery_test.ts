// Underpriced-recovery + market-anomaly + fast-lane-cooldown suite, plus the
// "divergence test" _recovery.ts's own docstring promises: index.ts must
// IMPORT these helpers, never re-declare them, or the tests stop proving
// anything about the real engine's behavior.
//
// Run: deno test --allow-net --allow-env --allow-read \
//   supabase/functions/_tests/repricer-ai-evaluate/recovery_test.ts

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  computeUnderpricedRecovery,
  computeFastLaneCooldown,
  detectMarketAnomalies,
  type UnderpricedRecoveryInput,
} from '../../repricer-ai-evaluate/_recovery.ts';

const base: UnderpricedRecoveryInput = {
  currentPrice: 10,
  buyboxPrice: null,
  lowestFbaPrice: null,
  lowestEligibleCompetitorPrice: 15,
  isBuyboxOwner: false,
  isBuyboxSuppressed: false,
  maxRaiseStepDollars: 1,
  maxRaiseStepPercent: 10,
  smartRaiseEnabled: true,
  effectiveFloor: 5,
  maxPrice: 50,
};

// ── Underpriced recovery ──

Deno.test('recovery: 33% gap qualifies and steps toward the anchor, capped by the dollar/percent step', () => {
  const r = computeUnderpricedRecovery(base);
  assert(r?.applies);
  assertEquals(r!.marketAnchor, 15);
  // step cap = min($1, 10%*$10=$1) = $1 -> target 11
  assertEquals(r!.targetPrice, 11);
  assertEquals(r!.isSevere, true, '33% gap is >= the 20% severe threshold');
});

Deno.test('recovery: BB owner never gets underpriced-recovery (has its own raise path)', () => {
  const r = computeUnderpricedRecovery({ ...base, isBuyboxOwner: true });
  assertEquals(r?.applies, false);
  assertEquals(r?.skipReason, 'bb_owner_has_own_raise_path');
});

Deno.test('recovery: suppressed BB never gets underpriced-recovery (uses its own anchor logic)', () => {
  const r = computeUnderpricedRecovery({ ...base, isBuyboxSuppressed: true });
  assertEquals(r?.applies, false);
  assertEquals(r?.skipReason, 'bb_suppressed_uses_own_anchor');
});

Deno.test('recovery: a valid lower Buy Box means we are OVERpriced, not underpriced — must not fire', () => {
  const r = computeUnderpricedRecovery({ ...base, buyboxPrice: 8, lowestEligibleCompetitorPrice: 15 });
  assertEquals(r?.applies, false);
  assert(r?.skipReason?.startsWith('overpriced_vs_valid_lower_market'));
});

Deno.test('recovery: gap below the 5% minimum threshold does not qualify', () => {
  const r = computeUnderpricedRecovery({ ...base, currentPrice: 10, lowestEligibleCompetitorPrice: 10.3 });
  assertEquals(r?.applies, false);
  assert(r?.skipReason?.startsWith('gap_below_threshold'));
});

Deno.test('recovery: smart_raise disabled + non-severe gap is skipped (respects the preset)', () => {
  // 10% gap: qualifies as underpriced (>=5%) but is not severe (<20%)
  const r = computeUnderpricedRecovery({ ...base, smartRaiseEnabled: false, lowestEligibleCompetitorPrice: 11 });
  assertEquals(r?.applies, false);
  assert(r?.skipReason?.startsWith('smart_raise_disabled_and_gap_not_severe'));
});

Deno.test('recovery: smart_raise disabled but SEVERE gap still recovers (never leaves 20%+ on the table)', () => {
  const r = computeUnderpricedRecovery({ ...base, smartRaiseEnabled: false, lowestEligibleCompetitorPrice: 15 });
  assertEquals(r?.applies, true);
  assertEquals(r?.isSevere, true);
});

Deno.test('recovery: target is clamped up to the effective floor if the step would land below it', () => {
  const r = computeUnderpricedRecovery({ ...base, currentPrice: 4, effectiveFloor: 6, lowestEligibleCompetitorPrice: 20, maxRaiseStepDollars: 0.5, maxRaiseStepPercent: 0 });
  assert(r?.applies);
  assertEquals(r!.targetPrice, 6, 'clamped up to the floor, not the tiny step target');
});

Deno.test('recovery: target is clamped down to maxPrice if the step would exceed it', () => {
  const r = computeUnderpricedRecovery({ ...base, currentPrice: 10, maxPrice: 10.3, lowestEligibleCompetitorPrice: 20, maxRaiseStepDollars: 5, maxRaiseStepPercent: 50 });
  assert(r?.applies);
  assertEquals(r!.targetPrice, 10.3);
});

Deno.test('recovery: no current price at all is a hard skip', () => {
  const r = computeUnderpricedRecovery({ ...base, currentPrice: null });
  assertEquals(r?.applies, false);
  assertEquals(r?.skipReason, 'no_current_price');
});

Deno.test('recovery: no market anchor available (all competitor prices null) is a hard skip', () => {
  const r = computeUnderpricedRecovery({ ...base, lowestEligibleCompetitorPrice: null, buyboxPrice: null, lowestFbaPrice: null });
  assertEquals(r?.applies, false);
  assertEquals(r?.skipReason, 'no_market_anchor');
});

// ── Fast-lane cooldown ──

Deno.test('fast-lane: non-severe gap leaves cooldown untouched', () => {
  assertEquals(computeFastLaneCooldown(15, false), 15);
});

Deno.test('fast-lane: severe gap reduces cooldown down to the fast-lane cap', () => {
  assertEquals(computeFastLaneCooldown(60, true), 2);
});

Deno.test('fast-lane: severe gap never INCREASES cooldown when it is already below the cap', () => {
  assertEquals(computeFastLaneCooldown(1, true), 1);
});

Deno.test('fast-lane: custom cap is respected', () => {
  assertEquals(computeFastLaneCooldown(60, true, 5), 5);
});

// ── Anomaly detection ──

Deno.test('anomaly: wildly unrealistic target (>5x AND >$50 gap) is flagged low-confidence', () => {
  const r = detectMarketAnomalies({
    currentPrice: 10, buyboxPrice: 10, lowestFbaPrice: 10, lowestOverallPrice: 10,
    rawTargetPrice: 100, isBuyboxSuppressed: false, effectiveFloor: 5,
  });
  assert(r.tags.includes('data_low_confidence'));
});

Deno.test('anomaly: a merely large but plausible target does not trip the unrealistic-target flag', () => {
  const r = detectMarketAnomalies({
    currentPrice: 10, buyboxPrice: 10, lowestFbaPrice: 10, lowestOverallPrice: 10,
    rawTargetPrice: 12, isBuyboxSuppressed: false, effectiveFloor: 5,
  });
  assertEquals(r.tags.includes('data_low_confidence'), false);
});

Deno.test('anomaly: suppressed BB with a much higher competitor price flags market_inconsistent', () => {
  const r = detectMarketAnomalies({
    currentPrice: 10, buyboxPrice: null, lowestFbaPrice: 35, lowestOverallPrice: 35,
    rawTargetPrice: null, isBuyboxSuppressed: true, effectiveFloor: 5,
  });
  assert(r.tags.includes('market_inconsistent'));
});

Deno.test('anomaly: no BB + lowest FBA more than 2x current flags market_inconsistent', () => {
  const r = detectMarketAnomalies({
    currentPrice: 10, buyboxPrice: null, lowestFbaPrice: 35, lowestOverallPrice: 35,
    rawTargetPrice: null, isBuyboxSuppressed: false, effectiveFloor: 5,
  });
  assert(r.tags.includes('market_inconsistent'));
});

Deno.test('anomaly: clean, consistent market data produces no tags', () => {
  const r = detectMarketAnomalies({
    currentPrice: 10, buyboxPrice: 10.5, lowestFbaPrice: 10.5, lowestOverallPrice: 10.5,
    rawTargetPrice: 10.2, isBuyboxSuppressed: false, effectiveFloor: 5,
  });
  assertEquals(r.tags.length, 0);
});

// ── Divergence test: index.ts must IMPORT these helpers, never re-declare them ──

Deno.test('divergence guard: index.ts imports computeUnderpricedRecovery/computeFastLaneCooldown/detectMarketAnomalies from ./_recovery.ts, and does not re-declare them inline', async () => {
  const src = await Deno.readTextFile(
    new URL('../../repricer-ai-evaluate/index.ts', import.meta.url),
  );
  assert(
    /import\s*\{[^}]*computeUnderpricedRecovery[^}]*\}\s*from\s*['"]\.\/_recovery\.ts['"]/s.test(src),
    'index.ts must import computeUnderpricedRecovery from ./_recovery.ts',
  );
  assert(
    /import\s*\{[^}]*computeFastLaneCooldown[^}]*\}\s*from\s*['"]\.\/_recovery\.ts['"]/s.test(src),
    'index.ts must import computeFastLaneCooldown from ./_recovery.ts',
  );
  assert(
    !/function\s+computeUnderpricedRecovery\s*\(/.test(src),
    'index.ts must not re-declare computeUnderpricedRecovery inline — that would silently stop testing real behavior',
  );
  assert(
    !/function\s+computeFastLaneCooldown\s*\(/.test(src),
    'index.ts must not re-declare computeFastLaneCooldown inline',
  );
});

Deno.test('divergence guard: index.ts imports PROFILE_PRESETS/PROFILE_KEY_TO_LABEL from ./_presets.ts, and does not re-declare them inline', async () => {
  const src = await Deno.readTextFile(
    new URL('../../repricer-ai-evaluate/index.ts', import.meta.url),
  );
  assert(
    /import\s*\{[^}]*PROFILE_PRESETS[^}]*\}\s*from\s*['"]\.\/_presets\.ts['"]/s.test(src),
    'index.ts must import PROFILE_PRESETS from ./_presets.ts',
  );
  assert(
    !/const\s+profilePresets\s*:/.test(src),
    'index.ts must not re-declare an inline profilePresets object — that is exactly how the presets drifted for weeks undetected',
  );
});
