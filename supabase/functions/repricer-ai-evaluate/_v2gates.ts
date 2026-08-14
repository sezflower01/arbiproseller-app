// Momentum Smart V2 raise-safety gates — extracted so they can be
// unit-tested directly (same reason as _recovery.ts: index.ts is too heavy
// to import in a Deno test runner — Supabase imports, serve(), etc.).
//
// IMPORTANT: index.ts must IMPORT these helpers (not re-declare them). Any
// drift means the tests no longer prove engine behavior. A divergence test
// in `v2gates_test.ts` enforces this contractually (same pattern as
// _recovery.ts / recovery_test.ts).

// ═══════════════════════════════════════════════════════════════════
// POST-RAISE COOLDOWN — blocks another raise attempt on the same
// assignment for postRaiseCooldownHours after ANY raise, regardless of
// outcome, so a string of raises can't stack before there's evidence the
// last one held. null postRaiseCooldownHours = feature off (every preset
// except MOMENTUM_SMART V2's default behavior, unchanged).
// ═══════════════════════════════════════════════════════════════════
export interface PostRaiseCooldownInput {
  lastRaiseAt: string | null;
  postRaiseCooldownHours: number | null;
  /** Injectable for tests; defaults to Date.now() in production. */
  nowMs?: number;
}
export interface PostRaiseCooldownResult {
  active: boolean;
  remainingMinutes: number | null;
}
export function evaluatePostRaiseCooldown(i: PostRaiseCooldownInput): PostRaiseCooldownResult {
  if (i.postRaiseCooldownHours == null || !i.lastRaiseAt) {
    return { active: false, remainingMinutes: null };
  }
  const now = i.nowMs ?? Date.now();
  const cooldownMs = i.postRaiseCooldownHours * 3600000;
  const elapsedMs = now - new Date(i.lastRaiseAt).getTime();
  if (elapsedMs >= cooldownMs) return { active: false, remainingMinutes: null };
  return { active: true, remainingMinutes: Math.ceil((cooldownMs - elapsedMs) / 60000) };
}

// ═══════════════════════════════════════════════════════════════════
// MARKET-SUPPORTED RAISE — a Buy Box price rise only counts as a real
// market move if the underlying competitor floor (lowest FBA) rose
// alongside it at the SAME reference point, not just the Buy Box price
// drifting with nobody actually following.
//
// V1 behavior (minFloorSupportRatio = null): floor just needs to have
// risen at all (floorIncrease > 0).
// V2 behavior (minFloorSupportRatio set, e.g. 0.5): the floor's rise must
// cover at least that fraction of the Buy Box's rise — "did the market
// actually move, or just the Buy Box price."
//
// Missing floor data (no floor reference price, or no current lowest FBA
// price) is always treated as UNsupported, never as a free pass.
// ═══════════════════════════════════════════════════════════════════
export interface MarketSupportedRaiseInput {
  buyboxPrice: number;
  /** The historical reference price (previous_snapshot / 30min / 2hr / 6hr) this Buy Box rise is being measured against. */
  refPrice: number;
  /** Current lowest FBA (competitor floor) price. */
  lowestFbaPrice: number | null;
  /** The competitor floor at the SAME reference point as refPrice. */
  floorRefPrice: number | null;
  /** null = V1 "any rise" behavior. Set = V2 minimum-ratio behavior. */
  minFloorSupportRatio: number | null;
}
export interface MarketSupportedRaiseResult {
  supported: boolean;
  hasFloorData: boolean;
  bbIncrease: number;
  floorIncrease: number;
  requiredFloorIncrease: number;
  reason: string;
}
export function evaluateMarketSupportedRaise(i: MarketSupportedRaiseInput): MarketSupportedRaiseResult {
  const hasFloorData = Boolean(
    i.lowestFbaPrice != null && i.lowestFbaPrice > 0 && i.floorRefPrice != null && i.floorRefPrice > 0,
  );
  const floorIncrease = hasFloorData ? i.lowestFbaPrice! - i.floorRefPrice! : 0;
  const bbIncrease = i.buyboxPrice - i.refPrice;

  if (i.minFloorSupportRatio != null) {
    const requiredFloorIncrease = bbIncrease * i.minFloorSupportRatio;
    const supported = hasFloorData && floorIncrease >= requiredFloorIncrease;
    return {
      supported, hasFloorData, bbIncrease, floorIncrease, requiredFloorIncrease,
      reason: supported
        ? `floor +$${floorIncrease.toFixed(2)} covers >=${(i.minFloorSupportRatio * 100).toFixed(0)}% of BB +$${bbIncrease.toFixed(2)}`
        : `BB +$${bbIncrease.toFixed(2)} but floor only rose $${floorIncrease.toFixed(2)} (need >=$${requiredFloorIncrease.toFixed(2)}, floor_ref=${i.floorRefPrice ?? 'null'}, floor_now=${i.lowestFbaPrice ?? 'null'})`,
    };
  }

  const supported = hasFloorData && floorIncrease > 0;
  return {
    supported, hasFloorData, bbIncrease, floorIncrease, requiredFloorIncrease: 0,
    reason: supported
      ? `floor rose $${floorIncrease.toFixed(2)} alongside BB +$${bbIncrease.toFixed(2)}`
      : `BB +$${bbIncrease.toFixed(2)} but competitor floor unsupported (floor_ref=${i.floorRefPrice ?? 'null'}, floor_now=${i.lowestFbaPrice ?? 'null'})`,
  };
}
