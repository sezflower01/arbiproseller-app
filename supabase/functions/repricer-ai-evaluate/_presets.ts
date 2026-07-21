// Canonical preset definitions — extracted for snapshot testing.
// MUST stay in sync with the inline `profilePresets` block in index.ts.
// If you change one, change the other (a snapshot test will fail otherwise).
//
// ⚠ PROFIT GUARD REMOVED (manual-min-only policy).
// No preset may declare `enable_profit_guard` or `profit_guard_mode`.
// LIQUIDATION preset was removed because its sole purpose was to bypass
// Profit Guard — with Profit Guard gone, LIQUIDATION is redundant.
// See mem://strategy/repricer/manual-min-only-v1

export const PROFILE_KEY_TO_LABEL: Record<string, string> = {
  VELOCITY_DOMINATOR: "Aggressive Capture",
  MOMENTUM_BUILDER: "Momentum Builder",
  PROFIT_EXTRACTOR: "Profit Extractor",
};

export const PROFILE_PRESETS: Record<string, Record<string, any>> = {
  VELOCITY_DOMINATOR: {
    undercut_amount: 0.02,
    enable_smart_raise: true,
    enable_monopoly_mode: false,
    monopoly_mode_type: "aggressive",
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 5,
    skip_lower_when_bb_owner: false,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
    raise_trigger_percent: 3,
    max_raise_step_dollars: 0.30,
    max_raise_step_percent: 2,
  },
  MOMENTUM_BUILDER: {
    undercut_amount: 0.01,
    enable_smart_raise: true,
    raise_trigger_percent: 1.5,
    max_raise_step_dollars: 1.00,
    max_raise_step_percent: 5,
    enable_monopoly_mode: true,
    monopoly_mode_type: "conservative",
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 15,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
  },
  PROFIT_EXTRACTOR: {
    undercut_amount: 0,
    enable_smart_raise: true,
    raise_trigger_percent: 1,
    max_raise_step_dollars: 1.50,
    max_raise_step_percent: 6,
    enable_monopoly_mode: true,
    monopoly_mode_type: "aggressive",
    monopoly_cooldown_minutes: 45,
    use_ai_tuning: true,
    cooldown_minutes: 20,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: false,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
  },
};

export type FamilyFlags = {
  aggressive: boolean;
  match_only: boolean;
  conservative: boolean;
  fbm_chase_blocked: boolean;
};

// Family classification — MUST match the derivation in index.ts ([resolved_profile_audit]).
export function deriveFamilyFlags(rule: Record<string, any>): FamilyFlags {
  const undercut = Number(rule.undercut_amount);
  const aggressive = undercut > 0.01 || rule.skip_lower_when_bb_owner === false;
  const match_only = undercut === 0;
  const conservative =
    undercut > 0 &&
    undercut <= 0.01 &&
    rule.skip_lower_when_bb_owner === true &&
    rule.only_raise_when_buybox_owner === true;
  const fbm_chase_blocked = rule.ignore_fbm_unless_buybox_owner === true;
  return { aggressive, match_only, conservative, fbm_chase_blocked };
}

// "Signature behavior" — one observable property per preset that proves it
// behaves differently from every other preset, not just resolves differently.
export type SignatureBehavior = {
  allows_self_undercut_as_bb_owner: boolean;
  is_exact_match: boolean;
  raise_step_dollars: number;
  raises_ever: boolean;
  cooldown_minutes: number;
  monopoly_cooldown_minutes: number;
};

export function deriveSignatureBehavior(rule: Record<string, any>): SignatureBehavior {
  return {
    allows_self_undercut_as_bb_owner: rule.skip_lower_when_bb_owner === false,
    is_exact_match: Number(rule.undercut_amount) === 0,
    raise_step_dollars: Number(rule.max_raise_step_dollars),
    raises_ever: rule.enable_smart_raise === true,
    cooldown_minutes: Number(rule.cooldown_minutes),
    monopoly_cooldown_minutes: Number(rule.monopoly_cooldown_minutes),
  };
}

// Apply preset to a base rule the same way the engine does (preserving user-controlled fields).
const USER_CONTROLLED_FIELDS = new Set(["ignore_fbm_unless_buybox_owner"]);

export function applyPreset(baseRule: Record<string, any>, profileKey: string): Record<string, any> {
  const preset = PROFILE_PRESETS[profileKey];
  if (!preset) throw new Error(`Unknown profile: ${profileKey}`);
  const out = { ...baseRule };
  for (const [k, v] of Object.entries(preset)) {
    if (!USER_CONTROLLED_FIELDS.has(k)) out[k] = v;
  }
  for (const k of USER_CONTROLLED_FIELDS) {
    if (out[k] === undefined && preset[k] !== undefined) out[k] = preset[k];
  }
  return out;
}
