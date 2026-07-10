// Market volatility scoring — distinguishes external competitive churn from
// internal self-chasing oscillation. Pure function, no side effects.
//
// Reads recent `repricer_competitor_snapshots` rows (caller fetches them) and
// returns a 0–10 score plus a coarse market_state classification.
//
// Signals (weighted):
//   - competitor BB price changes per hour       (churn)
//   - distinct BB owners per hour                (rotation)
//   - lowest_fba absolute movement per hour      (drift)
//   - spread (lowest_fba .. lowest_overall) variance
//
// Score → state:
//   0–2  calm     (default thresholds apply)
//   3–5  active   (slight oscillation tolerance)
//   6–10 chaotic  (strong oscillation tolerance — many fast repricers)

export interface CompetitorSnapshotRow {
  fetched_at: string;
  buybox_price: number | null;
  buybox_seller_id: string | null;
  lowest_fba_price: number | null;
  lowest_overall_price: number | null;
  offers_count: number | null;
}

export interface MarketVolatilityResult {
  score: number;                  // 0–10
  state: 'calm' | 'active' | 'chaotic';
  competitorChurnRate: number;    // BB price changes per hour
  bbRotationRate: number;         // distinct BB owners per hour
  lowestFbaDriftPerHour: number;  // mean absolute change in lowestFBA per hour ($)
  spreadVariance: number;         // variance of (lowestFba .. lowestOverall) gap
  signals: Record<string, number | string>;
  windowMinutes: number;
  sampleCount: number;
}

const EMPTY: MarketVolatilityResult = {
  score: 0, state: 'calm',
  competitorChurnRate: 0, bbRotationRate: 0,
  lowestFbaDriftPerHour: 0, spreadVariance: 0,
  signals: {}, windowMinutes: 0, sampleCount: 0,
};

export function scoreMarketVolatility(
  snapshots: CompetitorSnapshotRow[],
  windowMinutes = 60,
): MarketVolatilityResult {
  if (!snapshots || snapshots.length < 2) return { ...EMPTY, windowMinutes, sampleCount: snapshots?.length ?? 0 };

  // Sort ascending by time (defensive — caller may pass either order)
  const rows = [...snapshots].sort(
    (a, b) => new Date(a.fetched_at).getTime() - new Date(b.fetched_at).getTime(),
  );
  const spanMs = new Date(rows[rows.length - 1].fetched_at).getTime() - new Date(rows[0].fetched_at).getTime();
  const spanHours = Math.max(spanMs / 3_600_000, 1 / 60); // floor at 1 min to avoid div-by-zero spikes

  // 1. Competitor churn — count BB price changes >= 1¢
  let bbChanges = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].buybox_price;
    const cur = rows[i].buybox_price;
    if (prev != null && cur != null && Math.abs(cur - prev) >= 0.01) bbChanges++;
  }
  const competitorChurnRate = bbChanges / spanHours;

  // 2. BB rotation — distinct BB owners observed
  const owners = new Set<string>();
  for (const r of rows) if (r.buybox_seller_id) owners.add(r.buybox_seller_id);
  const bbRotationRate = Math.max(0, owners.size - 1) / spanHours;

  // 3. Lowest FBA drift — mean |Δ| per hour
  let lowestFbaDeltas = 0;
  let lowestFbaDeltaCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].lowest_fba_price;
    const cur = rows[i].lowest_fba_price;
    if (prev != null && cur != null) {
      lowestFbaDeltas += Math.abs(cur - prev);
      lowestFbaDeltaCount++;
    }
  }
  const lowestFbaDriftPerHour = lowestFbaDeltaCount > 0 ? (lowestFbaDeltas / lowestFbaDeltaCount) * (lowestFbaDeltaCount / spanHours) : 0;

  // 4. Spread variance — how much the (lowest_fba − lowest_overall) gap fluctuates
  const spreads: number[] = [];
  for (const r of rows) {
    if (r.lowest_fba_price != null && r.lowest_overall_price != null) {
      spreads.push(r.lowest_fba_price - r.lowest_overall_price);
    }
  }
  let spreadVariance = 0;
  if (spreads.length >= 2) {
    const mean = spreads.reduce((s, v) => s + v, 0) / spreads.length;
    spreadVariance = spreads.reduce((s, v) => s + (v - mean) ** 2, 0) / spreads.length;
  }

  // Score (cap each component, sum to 0–10)
  let score = 0;
  if (competitorChurnRate >= 6) score += 3;
  else if (competitorChurnRate >= 3) score += 2;
  else if (competitorChurnRate >= 1) score += 1;

  if (bbRotationRate >= 3) score += 3;
  else if (bbRotationRate >= 1.5) score += 2;
  else if (bbRotationRate >= 0.5) score += 1;

  if (lowestFbaDriftPerHour >= 1.0) score += 2;
  else if (lowestFbaDriftPerHour >= 0.30) score += 1;

  if (spreadVariance >= 1.0) score += 2;
  else if (spreadVariance >= 0.25) score += 1;

  score = Math.min(10, score);

  const state: MarketVolatilityResult['state'] = score >= 6 ? 'chaotic' : score >= 3 ? 'active' : 'calm';

  return {
    score, state,
    competitorChurnRate: Math.round(competitorChurnRate * 100) / 100,
    bbRotationRate: Math.round(bbRotationRate * 100) / 100,
    lowestFbaDriftPerHour: Math.round(lowestFbaDriftPerHour * 100) / 100,
    spreadVariance: Math.round(spreadVariance * 1000) / 1000,
    signals: {
      bb_changes: bbChanges,
      distinct_owners: owners.size,
      lowest_fba_samples: lowestFbaDeltaCount,
      spread_samples: spreads.length,
    },
    windowMinutes,
    sampleCount: rows.length,
  };
}

// Productivity check — did our last move improve our position vs the BB?
// Returns true if the gap to BB narrowed by at least 1¢, OR we now own/match it.
export function wasMoveProductive(
  prevGapCents: number | null,
  currentPriceCents: number | null,
  buyboxPriceCents: number | null,
  isBuyboxOwner: boolean,
): boolean {
  if (isBuyboxOwner) return true;
  if (currentPriceCents == null || buyboxPriceCents == null) return false;
  const curGap = Math.max(0, currentPriceCents - buyboxPriceCents);
  if (prevGapCents == null) return false;
  return curGap < prevGapCents - 0;
}
