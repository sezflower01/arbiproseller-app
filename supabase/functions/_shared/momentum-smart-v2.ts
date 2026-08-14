// Momentum Smart V2 (tightened market-supported-raise ratio + post-raise
// cooldown) went live at this deploy -- the git commit timestamp of
// "Momentum Smart V2: tighten the raise gate, don't abandon the strategy"
// (a10fb14), converted to UTC. There is no per-row historical flag that
// distinguishes "was this specific decision/raise/sale evaluated under V1 or
// V2 rules" -- smart_profile has said MOMENTUM_SMART the whole time, and the
// preset's actual field values are re-applied fresh from _presets.ts on
// every evaluation in repricer-ai-evaluate (see its "APPLY SMART PROFILE
// PRESETS" step), never read back from what's stored on the rule row. A
// day-level cutover against each row's own day/timestamp is the best
// available split.
//
// Shared by repricer-rule-performance and repricer-matched-cohort so the two
// features can't drift on which side of the line a given day falls.
export const MOMENTUM_SMART_V2_CUTOVER = '2026-08-14T02:34:20.000Z';

export function splitMomentumSmart(baseProfile: string, atIso: string): string {
  if (baseProfile !== 'MOMENTUM_SMART') return baseProfile;
  return atIso >= MOMENTUM_SMART_V2_CUTOVER ? 'MOMENTUM_SMART_V2' : 'MOMENTUM_SMART_V1';
}
