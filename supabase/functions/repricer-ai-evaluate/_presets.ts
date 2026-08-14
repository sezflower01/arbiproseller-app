// Canonical preset definitions — index.ts imports these directly (no inline
// copy) so there is exactly one source of truth. This file previously held
// values that had drifted from index.ts's own inline copy for weeks
// (undercut_amount, monopoly settings, stock_overlay_enabled) with nothing
// catching it, because index.ts never actually imported this file and the
// snapshot test that should have caught the divergence was never written.
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
  MATCH_BUYBOX: "Match Buy Box",
  MATCH_LOWEST: "Match Lowest",
  SMART_MATCH: "Smart Match",
  MOMENTUM_SMART: "Momentum Smart",
};

export const PROFILE_PRESETS: Record<string, Record<string, any>> = {
  VELOCITY_DOMINATOR: {
    undercut_amount: 0.02,
    enable_smart_raise: true,
    enable_monopoly_mode: true,
    monopoly_mode_type: "conservative",
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
  },
  MOMENTUM_BUILDER: {
    undercut_amount: 0.00,
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
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
  },
  // MATCH_BUYBOX / MATCH_LOWEST: pure "match, never chase" presets. No
  // monopoly mode, no opportunistic smart-raise, no extended cooldown —
  // just track the anchor (buybox / lowest_offer, set via target_anchor on
  // the frontend template) and settle there. undercut_amount=0 already puts
  // these in the engine's `matchExactly` path, which bypasses cooldown for
  // corrective moves in both directions (see resolved_profile_audit / the
  // isMatchOnlyProfile, conservativeProfiles, and maxRaiseAboveBuyboxPercent
  // call sites in index.ts, which explicitly include these two keys).
  MATCH_BUYBOX: {
    undercut_amount: 0,
    enable_smart_raise: false,
    enable_monopoly_mode: false,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
  },
  MATCH_LOWEST: {
    undercut_amount: 0,
    enable_smart_raise: false,
    enable_monopoly_mode: false,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
  },
  // SMART_MATCH: same "match, never chase" identity as MATCH_BUYBOX/MATCH_LOWEST
  // (undercut_amount=0, no monopoly mode, no opportunistic smart-raise) — the
  // only difference is target_anchor (set on the frontend template, see
  // AiRuleBuilder.tsx's PROFILE_PRESETS), which picks 'smart_recapture'
  // instead of a fixed 'buybox'/'lowest_offer': anchor to Buy Box when
  // already lowest or already the BB owner, switch to Lowest FBA when not.
  SMART_MATCH: {
    undercut_amount: 0,
    enable_smart_raise: false,
    enable_monopoly_mode: false,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
  },
  // MOMENTUM_SMART: hybrid of MOMENTUM_BUILDER (margin-raising intelligence)
  // and SMART_MATCH (fast, low-risk Buy Box recovery). Deliberately NOT a
  // single interpolated cooldown — the whole point is asymmetric reaction:
  //   - losing the Buy Box  -> react fast (cooldown_minutes_losing_bb),
  //     matching Smart Match's urgency, because sales are at risk.
  //   - holding the Buy Box -> react slow (cooldown_minutes_winning_bb),
  //     because a profitable position doesn't need to be disturbed.
  // cooldown_minutes is the fallback baseline for the "stable" tier (neither
  // clearly winning nor losing) and for any code path not yet updated to
  // read the losing/winning split.
  // require_market_supported_raise gates enable_smart_raise: a raise only
  // fires when the underlying competitor floor (lowest FBA), not just the
  // Buy Box price, has also risen -- avoids raising into a price no
  // competitor actually follows, which is how Momentum Builder alone can
  // lose the Buy Box to its own decision rather than a competitor's.
  // V2 (tightened after real Rule Performance data showed 5/43 raises,
  // 11.6%, lost the Buy Box afterward vs Momentum Builder's 0/175 over the
  // same window): the market-supported gate is no longer satisfied by "the
  // floor rose at all" -- it now requires the floor's rise to be at least
  // min_floor_support_ratio of the Buy Box's rise (was the market actually
  // moving, or just the BB price alone), plus a post_raise_cooldown_hours
  // block on stacking further raises before there's evidence the last one
  // held. Losing/winning cooldown and monopoly mode are unchanged -- this
  // only makes the raise DECISION more selective, not the defense speed.
  MOMENTUM_SMART: {
    undercut_amount: 0.00,
    enable_smart_raise: true,
    require_market_supported_raise: true,
    min_floor_support_ratio: 0.5,
    post_raise_cooldown_hours: 2,
    raise_trigger_percent: 1.5,
    max_raise_step_dollars: 0.75,
    max_raise_step_percent: 4,
    enable_monopoly_mode: true,
    monopoly_mode_type: "conservative",
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    cooldown_minutes_losing_bb: 8,
    cooldown_minutes_winning_bb: 20,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
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
// undercut_amount is user-controlled too — the preset is only a template at
// rule creation, never a runtime override (it must never re-clobber a value
// the user has since customized).
export const USER_CONTROLLED_FIELDS = new Set(["ignore_fbm_unless_buybox_owner", "undercut_amount"]);

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
