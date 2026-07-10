// Phase 1B – Self-Learning Proof: deterministic control-group assignment.
//
// Used by smart-engine-auto-review (and any future "apply tuning" path) to split
// a tuning action's scope ASINs into a treatment group and a holdout control
// group. The split is:
//
//   1. DETERMINISTIC — same (user_id, tuning_action_id, asin) always maps to
//      the same bucket. Re-running the same action will not move ASINs between
//      groups. A different tuning_action_id naturally produces a fresh split.
//
//   2. GUARDED BY MIN-SAMPLE THRESHOLD — if the candidate ASIN list is smaller
//      than MIN_CAUSAL_SAMPLE_SIZE, no holdout is created and the action is
//      flagged as `is_observational = true`. Dashboards must NOT advertise
//      these as causal results.
//
//   3. REPRODUCIBLE — the salt fed into the hash is returned so it can be
//      stored on the tuning action row (`control_assignment_seed`).
//
// Reason for the deterministic hash design (per stakeholder requirements):
//   hash(user_id + tuning_action_id + asin) → uniform 0..1
//   if value < control_pct → control, else treatment

import { createHash } from "node:crypto";

export const MIN_CAUSAL_SAMPLE_SIZE = 20;       // hard floor for causal claim
export const DEFAULT_CONTROL_PCT     = 0.10;    // 10% holdout
export const ABSOLUTE_MIN_TREATMENT  = 5;       // never empty the treatment arm

export interface ControlGroupSplit {
  treatment_asins: string[];
  control_asins: string[];
  is_observational: boolean;
  min_sample_size: number;       // the threshold that was applied
  control_assignment_seed: string;
  control_group_pct: number;
  reason?: string;               // why observational, when applicable
}

/**
 * Stable bucket value in [0, 1) for a given ASIN under a given action.
 */
function bucketValue(seed: string, asin: string): number {
  const h = createHash("sha1").update(`${seed}::${asin}`).digest();
  // Take first 4 bytes → uint32 → divide by 2^32
  const n = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
  // >>> 0 to coerce to unsigned, then normalize
  return ((n >>> 0) % 1_000_000) / 1_000_000;
}

/**
 * Produce a treatment/control split for a tuning action.
 *
 * @param userId        user_id the action belongs to
 * @param tuningActionId the tuning_action_id (must be stable for the lifetime
 *                       of the experiment — pre-generate it BEFORE calling
 *                       this so we can use it in the hash AND store it on the
 *                       inserted row)
 * @param scopeAsins    the candidate ASIN universe for this tuning action
 * @param opts          optional overrides for control percentage & threshold
 */
export function splitControlGroup(
  userId: string,
  tuningActionId: string,
  scopeAsins: string[],
  opts: {
    controlPct?: number;
    minSampleSize?: number;
  } = {},
): ControlGroupSplit {
  const controlPct   = opts.controlPct   ?? DEFAULT_CONTROL_PCT;
  const minSampleSize = opts.minSampleSize ?? MIN_CAUSAL_SAMPLE_SIZE;
  const seed = `${userId}::${tuningActionId}`;

  const unique = Array.from(new Set(scopeAsins.filter(Boolean)));

  // GUARDRAIL: too few ASINs for a defensible causal claim.
  if (unique.length < minSampleSize) {
    return {
      treatment_asins: unique,
      control_asins: [],
      is_observational: true,
      min_sample_size: minSampleSize,
      control_assignment_seed: seed,
      control_group_pct: 0,
      reason: `Sample size ${unique.length} < min ${minSampleSize} — observational only`,
    };
  }

  const treatment: string[] = [];
  const control: string[] = [];
  for (const asin of unique) {
    if (bucketValue(seed, asin) < controlPct) control.push(asin);
    else treatment.push(asin);
  }

  // GUARDRAIL: never end up with an empty treatment arm. If the random split
  // accidentally pushed almost everything into control, fall back to obs mode.
  if (treatment.length < ABSOLUTE_MIN_TREATMENT) {
    return {
      treatment_asins: unique,
      control_asins: [],
      is_observational: true,
      min_sample_size: minSampleSize,
      control_assignment_seed: seed,
      control_group_pct: 0,
      reason: `Treatment arm too small after split (${treatment.length}) — observational only`,
    };
  }

  return {
    treatment_asins: treatment,
    control_asins: control,
    is_observational: false,
    min_sample_size: minSampleSize,
    control_assignment_seed: seed,
    control_group_pct: controlPct,
  };
}
