// Preset behavior-lock: snapshot + uniqueness.
//
// Real incident this guards against: _presets.ts held stale values (old
// undercut_amount, monopoly settings, stock_overlay_enabled) that had
// already been fixed in index.ts's inline copy but never propagated back
// here, because index.ts never imported this file and no test ever ran it.
// index.ts now imports PROFILE_PRESETS/PROFILE_KEY_TO_LABEL/
// USER_CONTROLLED_FIELDS from here directly — there is exactly one copy,
// so this test locks its exact values and proves the 3 presets stay
// semantically distinct from each other.
//
// Run: deno test --allow-net --allow-env --allow-read \
//   supabase/functions/_tests/repricer-ai-evaluate/presets_snapshot_test.ts

import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  PROFILE_KEY_TO_LABEL,
  PROFILE_PRESETS,
  USER_CONTROLLED_FIELDS,
} from '../../repricer-ai-evaluate/_presets.ts';

const PROFILE_KEYS = ['VELOCITY_DOMINATOR', 'MOMENTUM_BUILDER', 'PROFIT_EXTRACTOR'] as const;

Deno.test('exactly 3 presets exist, matching the 3 UI-facing profile keys', () => {
  assertEquals(Object.keys(PROFILE_PRESETS).sort(), [...PROFILE_KEYS].sort());
  assertEquals(Object.keys(PROFILE_KEY_TO_LABEL).sort(), [...PROFILE_KEYS].sort());
});

Deno.test('snapshot: VELOCITY_DOMINATOR (Aggressive Capture)', () => {
  assertEquals(PROFILE_PRESETS.VELOCITY_DOMINATOR, {
    undercut_amount: 0.02,
    enable_smart_raise: true,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'conservative',
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 5,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
    raise_trigger_percent: 3,
    max_raise_step_dollars: 0.30,
    max_raise_step_percent: 2,
  });
});

Deno.test('snapshot: MOMENTUM_BUILDER', () => {
  assertEquals(PROFILE_PRESETS.MOMENTUM_BUILDER, {
    undercut_amount: 0.00,
    enable_smart_raise: true,
    raise_trigger_percent: 1.5,
    max_raise_step_dollars: 1.00,
    max_raise_step_percent: 5,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'conservative',
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 15,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
  });
});

Deno.test('snapshot: PROFIT_EXTRACTOR', () => {
  assertEquals(PROFILE_PRESETS.PROFIT_EXTRACTOR, {
    undercut_amount: 0,
    enable_smart_raise: true,
    raise_trigger_percent: 1,
    max_raise_step_dollars: 1.50,
    max_raise_step_percent: 6,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'aggressive',
    monopoly_cooldown_minutes: 45,
    use_ai_tuning: true,
    cooldown_minutes: 20,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
  });
});

Deno.test('uniqueness: every preset pair differs in at least one field (no accidental duplicate)', () => {
  for (let i = 0; i < PROFILE_KEYS.length; i++) {
    for (let j = i + 1; j < PROFILE_KEYS.length; j++) {
      const a = PROFILE_PRESETS[PROFILE_KEYS[i]];
      const b = PROFILE_PRESETS[PROFILE_KEYS[j]];
      const aStr = JSON.stringify(a, Object.keys(a).sort());
      const bStr = JSON.stringify(b, Object.keys(b).sort());
      assertNotEquals(
        aStr,
        bStr,
        `${PROFILE_KEYS[i]} and ${PROFILE_KEYS[j]} must not be identical presets`,
      );
    }
  }
});

Deno.test('undercut_amount matches the documented spread: only VELOCITY_DOMINATOR undercuts, the other two match exactly', () => {
  assertEquals(PROFILE_PRESETS.VELOCITY_DOMINATOR.undercut_amount, 0.02);
  assertEquals(PROFILE_PRESETS.MOMENTUM_BUILDER.undercut_amount, 0);
  assertEquals(PROFILE_PRESETS.PROFIT_EXTRACTOR.undercut_amount, 0);
});

Deno.test('VELOCITY_DOMINATOR (Aggressive Capture) undercuts the most of the 3', () => {
  const v = PROFILE_PRESETS.VELOCITY_DOMINATOR.undercut_amount;
  const m = PROFILE_PRESETS.MOMENTUM_BUILDER.undercut_amount;
  const p = PROFILE_PRESETS.PROFIT_EXTRACTOR.undercut_amount;
  if (!(v > m && v > p)) {
    throw new Error(`VELOCITY_DOMINATOR must undercut more than the others: v=${v} m=${m} p=${p}`);
  }
});

Deno.test('PROFIT_EXTRACTOR never undercuts (undercut_amount === 0)', () => {
  assertEquals(PROFILE_PRESETS.PROFIT_EXTRACTOR.undercut_amount, 0);
});

Deno.test('PROFIT_EXTRACTOR has the largest raise step of the 3 (its whole purpose is capturing margin via raises)', () => {
  const dollars = PROFILE_KEYS.map((k) => PROFILE_PRESETS[k].max_raise_step_dollars);
  assertEquals(Math.max(...dollars), PROFILE_PRESETS.PROFIT_EXTRACTOR.max_raise_step_dollars);
});

Deno.test('every preset enables smart_raise, ai_tuning, and monopoly_mode (uniform baseline)', () => {
  for (const key of PROFILE_KEYS) {
    const preset = PROFILE_PRESETS[key];
    assertEquals(preset.enable_smart_raise, true, `${key}.enable_smart_raise`);
    assertEquals(preset.use_ai_tuning, true, `${key}.use_ai_tuning`);
    assertEquals(preset.enable_monopoly_mode, true, `${key}.enable_monopoly_mode`);
  }
});

Deno.test('no preset declares enable_profit_guard or profit_guard_mode (removed policy)', () => {
  for (const key of PROFILE_KEYS) {
    const preset = PROFILE_PRESETS[key] as Record<string, unknown>;
    assertEquals('enable_profit_guard' in preset, false, `${key} must not declare enable_profit_guard`);
    assertEquals('profit_guard_mode' in preset, false, `${key} must not declare profit_guard_mode`);
  }
});

Deno.test('USER_CONTROLLED_FIELDS includes undercut_amount and ignore_fbm_unless_buybox_owner', () => {
  assertEquals(USER_CONTROLLED_FIELDS.has('undercut_amount'), true);
  assertEquals(USER_CONTROLLED_FIELDS.has('ignore_fbm_unless_buybox_owner'), true);
});
