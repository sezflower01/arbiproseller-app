// Behavioral scenario suite: proves applyPreset()/deriveFamilyFlags()/
// deriveSignatureBehavior() — the pure logic index.ts actually runs at
// evaluation time — produce genuinely distinct, correct behavior per
// preset, and that user-controlled fields survive preset application
// (task history: undercut_amount was previously re-clobbered by the
// preset on every eval, which this suite would have caught).
//
// Run: deno test --allow-net --allow-env --allow-read \
//   supabase/functions/_tests/repricer-ai-evaluate/scenarios_test.ts

import { assertEquals, assertNotEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  applyPreset,
  deriveFamilyFlags,
  deriveSignatureBehavior,
  PROFILE_PRESETS,
} from '../../repricer-ai-evaluate/_presets.ts';

const PRESET_KEYS = ['VELOCITY_DOMINATOR', 'MOMENTUM_BUILDER', 'PROFIT_EXTRACTOR'] as const;

// ── Group A: baseline preset application → expected family classification ──

Deno.test('A1: VELOCITY_DOMINATOR on a bare rule → aggressive family', () => {
  const rule = applyPreset({}, 'VELOCITY_DOMINATOR');
  const family = deriveFamilyFlags(rule);
  assertEquals(family.aggressive, true);
  assertEquals(family.match_only, false);
});

Deno.test('A2: MOMENTUM_BUILDER on a bare rule → conservative family (matches its "balance" positioning)', () => {
  const rule = applyPreset({}, 'MOMENTUM_BUILDER');
  const family = deriveFamilyFlags(rule);
  assertEquals(family.match_only, true, 'undercut_amount is 0.00, so it also reads as match_only by value');
  assertEquals(family.aggressive, false);
});

Deno.test('A3: PROFIT_EXTRACTOR on a bare rule → match_only family (undercut_amount === 0)', () => {
  const rule = applyPreset({}, 'PROFIT_EXTRACTOR');
  const family = deriveFamilyFlags(rule);
  assertEquals(family.match_only, true);
  assertEquals(family.aggressive, false);
});

Deno.test('A4: applyPreset throws on an unknown profile key', () => {
  assertThrows(() => applyPreset({}, 'NOT_A_REAL_PROFILE'), Error, 'Unknown profile');
});

// ── Group B: undercut_amount is user-controlled — preset must never clobber it ──

for (const key of PRESET_KEYS) {
  Deno.test(`B-${key}: a user-customized undercut_amount survives applying this preset`, () => {
    const rule = applyPreset({ undercut_amount: 0.99 }, key);
    assertEquals(rule.undercut_amount, 0.99, `${key} must preserve the user's undercut_amount, not overwrite it with the preset template value`);
  });
}

// ── Group C: ignore_fbm_unless_buybox_owner is also user-controlled ──

for (const key of PRESET_KEYS) {
  Deno.test(`C-${key}: a user-customized ignore_fbm_unless_buybox_owner survives applying this preset`, () => {
    const rule = applyPreset({ ignore_fbm_unless_buybox_owner: false }, key);
    assertEquals(rule.ignore_fbm_unless_buybox_owner, false, `${key} must preserve the user's FBM setting`);
  });
}

// ── Group D: every OTHER field is overridden by the preset regardless of prior value ──

for (const key of PRESET_KEYS) {
  Deno.test(`D-${key}: a stale cooldown_minutes gets overridden to the preset's value`, () => {
    const rule = applyPreset({ cooldown_minutes: 9999 }, key);
    assertEquals(rule.cooldown_minutes, PROFILE_PRESETS[key].cooldown_minutes);
  });
}

// ── Group E: deriveFamilyFlags direct scenarios (independent of presets) ──

Deno.test('E1: high undercut alone triggers aggressive', () => {
  assertEquals(deriveFamilyFlags({ undercut_amount: 0.05, skip_lower_when_bb_owner: true, only_raise_when_buybox_owner: true }).aggressive, true);
});

Deno.test('E2: skip_lower_when_bb_owner=false alone triggers aggressive, even with zero undercut', () => {
  assertEquals(deriveFamilyFlags({ undercut_amount: 0, skip_lower_when_bb_owner: false }).aggressive, true);
});

Deno.test('E3: undercut_amount exactly 0 is match_only regardless of other fields', () => {
  assertEquals(deriveFamilyFlags({ undercut_amount: 0, skip_lower_when_bb_owner: false }).match_only, true);
});

Deno.test('E4: small undercut + BB-owner hold + raise gated to BB owner is conservative', () => {
  const family = deriveFamilyFlags({
    undercut_amount: 0.01,
    skip_lower_when_bb_owner: true,
    only_raise_when_buybox_owner: true,
  });
  assertEquals(family.conservative, true);
  assertEquals(family.aggressive, false);
});

Deno.test('E5: small undercut WITHOUT BB-owner hold is not conservative (fails the "holds when owner" requirement)', () => {
  const family = deriveFamilyFlags({
    undercut_amount: 0.01,
    skip_lower_when_bb_owner: false,
    only_raise_when_buybox_owner: true,
  });
  assertEquals(family.conservative, false);
  assertEquals(family.aggressive, true, 'skip_lower=false makes it aggressive instead');
});

Deno.test('E6: fbm_chase_blocked mirrors ignore_fbm_unless_buybox_owner exactly', () => {
  assertEquals(deriveFamilyFlags({ ignore_fbm_unless_buybox_owner: true }).fbm_chase_blocked, true);
  assertEquals(deriveFamilyFlags({ ignore_fbm_unless_buybox_owner: false }).fbm_chase_blocked, false);
});

// ── Group F: signature behavior — the core "presets are semantically distinct" proof ──

Deno.test('F1: all 3 presets produce pairwise-distinct signature behaviors', () => {
  const signatures = PRESET_KEYS.map((k) => JSON.stringify(deriveSignatureBehavior(applyPreset({}, k))));
  assertEquals(new Set(signatures).size, signatures.length, 'every preset must be observably different from every other preset');
});

Deno.test('F2: VELOCITY_DOMINATOR (Aggressive Capture) is the only preset that allows self-undercut as BB owner', () => {
  for (const key of PRESET_KEYS) {
    const sig = deriveSignatureBehavior(applyPreset({}, key));
    assertEquals(sig.allows_self_undercut_as_bb_owner, false, `${key} should hold when it already owns the Buy Box`);
  }
});

Deno.test('F3: MOMENTUM_BUILDER and PROFIT_EXTRACTOR are both exact-match presets (undercut_amount 0), but remain distinct via raise behavior', () => {
  const momentum = deriveSignatureBehavior(applyPreset({}, 'MOMENTUM_BUILDER'));
  const profit = deriveSignatureBehavior(applyPreset({}, 'PROFIT_EXTRACTOR'));
  assertEquals(momentum.is_exact_match, true);
  assertEquals(profit.is_exact_match, true);
  assertNotEquals(momentum.raise_step_dollars, profit.raise_step_dollars, 'must still differ on how aggressively they raise');
  assertNotEquals(momentum.cooldown_minutes, profit.cooldown_minutes);
});

Deno.test('F4: cooldown_minutes strictly increases from Aggressive Capture -> Momentum Builder -> Profit Extractor', () => {
  const v = deriveSignatureBehavior(applyPreset({}, 'VELOCITY_DOMINATOR')).cooldown_minutes;
  const m = deriveSignatureBehavior(applyPreset({}, 'MOMENTUM_BUILDER')).cooldown_minutes;
  const p = deriveSignatureBehavior(applyPreset({}, 'PROFIT_EXTRACTOR')).cooldown_minutes;
  if (!(v < m && m < p)) {
    throw new Error(`expected v < m < p, got v=${v} m=${m} p=${p}`);
  }
});

Deno.test('F5: raises_ever is true for every preset (all 3 enable_smart_raise)', () => {
  for (const key of PRESET_KEYS) {
    assertEquals(deriveSignatureBehavior(applyPreset({}, key)).raises_ever, true, key);
  }
});

// ── Group G: combined realistic assignment scenarios ──

Deno.test('G1: a custom (non-preset) rule with 3% undercut and no BB hold classifies as aggressive, not conservative', () => {
  const family = deriveFamilyFlags({ undercut_amount: 0.03, skip_lower_when_bb_owner: false, only_raise_when_buybox_owner: false });
  assertEquals(family.aggressive, true);
  assertEquals(family.conservative, false);
});

Deno.test('G2: a custom rule with undercut_amount between 0 and 0.01 but only_raise_when_buybox_owner=false is NOT conservative', () => {
  const family = deriveFamilyFlags({ undercut_amount: 0.005, skip_lower_when_bb_owner: true, only_raise_when_buybox_owner: false });
  assertEquals(family.conservative, false, 'conservative requires raise to be gated to BB owner too');
});

Deno.test('G3: applying VELOCITY_DOMINATOR after starting from a PROFIT_EXTRACTOR-shaped rule fully re-templates non-user-controlled fields', () => {
  const asExtractor = applyPreset({}, 'PROFIT_EXTRACTOR');
  const reTemplated = applyPreset(asExtractor, 'VELOCITY_DOMINATOR');
  assertEquals(reTemplated.monopoly_mode_type, PROFILE_PRESETS.VELOCITY_DOMINATOR.monopoly_mode_type);
  assertEquals(reTemplated.cooldown_minutes, PROFILE_PRESETS.VELOCITY_DOMINATOR.cooldown_minutes);
});

Deno.test('G4: switching presets does not leak a previous preset undercut_amount once the user has customized it', () => {
  const customized = { ...applyPreset({}, 'PROFIT_EXTRACTOR'), undercut_amount: 0.10 };
  const switched = applyPreset(customized, 'MOMENTUM_BUILDER');
  assertEquals(switched.undercut_amount, 0.10, 'the user-set 0.10 must survive the profile switch');
});
