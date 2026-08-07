// Shared Keepa-series shaping for Private-Label Risk scoring.
// Pure functions — only transform already-fetched Keepa data, never make
// network calls. Used by both mobile-scan-price-history (extension) and
// analyzer-product-snapshot (web Analyzer) so the two surfaces score PL
// risk identically off the same Keepa response shape.
//
// Moved out of mobile-scan-price-history/index.ts (2026-08-07) so a second
// caller could reuse it without duplicating the logic — see plRisk.ts for
// the scoring function these summaries feed into.

export const KEEPA_EPOCH_MIN = 21564000; // minutes from unix epoch -> keepa minutes
export const KEEPA_EPOCH_MS_CONST = KEEPA_EPOCH_MIN * 60_000; // same epoch, in ms — derived so the two can never drift apart

export function keepaMinToIso(km: number): string {
  return new Date((km + KEEPA_EPOCH_MIN) * 60_000).toISOString();
}

export type SellerHistorySummary = {
  windowDays: number;
  points: { t: string; v: number }[];
  currentCount: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  pointsCount: number;
  trend: 'increasing' | 'stable' | 'declining' | 'unknown';
  sufficient: boolean;
  rich: boolean;
};

// Summarize Keepa's COUNT_NEW series (csv[11]) — active new-condition offer
// count over time. `-1` ("no data") points must already be dropped by the
// caller's CSV parsing. Trend compares the most recent ~30 days against the
// prior ~30 days; informational only (never scored), since a decline can be
// a temporary stock/restock blip.
export function summarizeCountSeries(rawPoints: { t: number; v: number }[], windowDays: number): SellerHistorySummary {
  const points = rawPoints
    .slice()
    .sort((a, b) => a.t - b.t)
    .map(p => ({ t: keepaMinToIso(p.t), v: p.v }));
  const pointsCount = points.length;
  const SUFFICIENT_MIN = 5;
  const RICH_MIN = 20;

  if (pointsCount === 0) {
    return {
      windowDays, points: [], currentCount: null, avg: null, min: null, max: null,
      pointsCount: 0, trend: 'unknown', sufficient: false, rich: false,
    };
  }

  const values = points.map(p => p.v);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const currentCount = values[values.length - 1];

  // Trend: last ~30 days average vs. the ~30 days before that.
  const nowMin = Math.floor(Date.now() / 60_000) - KEEPA_EPOCH_MIN;
  const THIRTY_D_MIN = 30 * 24 * 60;
  const recent = rawPoints.filter(p => p.t >= nowMin - THIRTY_D_MIN);
  const prior = rawPoints.filter(p => p.t >= nowMin - THIRTY_D_MIN * 2 && p.t < nowMin - THIRTY_D_MIN);
  let trend: SellerHistorySummary['trend'] = 'unknown';
  if (recent.length >= 2 && prior.length >= 2) {
    const recentAvg = recent.reduce((s, p) => s + p.v, 0) / recent.length;
    const priorAvg = prior.reduce((s, p) => s + p.v, 0) / prior.length;
    if (priorAvg > 0) {
      const deltaPct = ((recentAvg - priorAvg) / priorAvg) * 100;
      trend = deltaPct >= 15 ? 'increasing' : deltaPct <= -15 ? 'declining' : 'stable';
    }
  }

  return {
    windowDays, points, currentCount, avg, min, max, pointsCount,
    trend,
    sufficient: pointsCount >= SUFFICIENT_MIN,
    rich: pointsCount >= RICH_MIN,
  };
}

export type BuyBoxOwnershipSummary = {
  windowDays: number;
  sellers: { sellerId: string; percentageWon: number; isFBA: boolean }[];
  distinctThirdPartyWinners: number | null;
  topThirdPartyPct: number | null;
  topThirdPartySellerId: string | null;
  topSellerContinuityPct: number | null;
  continuityWindowDays: number | null;
  continuitySingleEvent: boolean;
  sufficient: boolean;
  rich: boolean;
};

// Time-weighted Buy Box continuity: what % of the MEASURED period did the
// top third-party seller actually hold the Buy Box, vs. simply "appears in
// the earliest and latest entries" (which proves nothing about the middle).
// `historyRaw` is Keepa's buyBoxSellerIdHistory — a FLAT array of alternating
// [keepaMinuteTimestamp, sellerId, keepaMinuteTimestamp, sellerId, ...],
// both encoded as strings.
//
// The final entry's held-duration runs from its own timestamp to
// `referenceEndMs` (real wall-clock "now" at call time, NOT the entry's own
// timestamp) — otherwise the most recent seller would incorrectly show a
// zero-duration hold just because there's no "next" event yet.
export function computeTopSellerContinuity(
  historyRaw: unknown,
  referenceEndMs: number,
  amazonSellerIds: Set<string>,
): { topSellerId: string | null; topSellerContinuityPct: number | null; continuityWindowDays: number | null; singleEvent: boolean } {
  const empty = { topSellerId: null, topSellerContinuityPct: null, continuityWindowDays: null, singleEvent: false };
  if (!Array.isArray(historyRaw) || historyRaw.length < 2) return empty;

  const events: { ms: number; sellerId: string }[] = [];
  for (let i = 0; i + 1 < historyRaw.length; i += 2) {
    const tRaw = Number(historyRaw[i]);
    const sellerId = String(historyRaw[i + 1] ?? '').trim();
    if (!Number.isFinite(tRaw) || !sellerId) continue;
    events.push({ ms: KEEPA_EPOCH_MS_CONST + tRaw * 60_000, sellerId });
  }
  events.sort((a, b) => a.ms - b.ms);
  if (events.length === 0) return empty;

  // A SINGLE recorded event means the Buy Box has never changed hands since
  // Keepa started tracking it for this ASIN — that's real evidence of
  // continuous control, not "not enough data". Duration = from that one
  // event to referenceEndMs.
  if (events.length === 1) {
    const ev = events[0];
    if (amazonSellerIds.has(ev.sellerId)) return empty; // third-party continuity only
    const coverageMs = referenceEndMs - ev.ms;
    if (coverageMs <= 0) return empty; // invalid/future timestamp
    return {
      topSellerId: ev.sellerId,
      topSellerContinuityPct: 100,
      continuityWindowDays: Math.round(coverageMs / (24 * 60 * 60 * 1000)),
      singleEvent: true,
    };
  }

  const startMs = events[0].ms;
  const totalDurationMs = referenceEndMs - startMs;
  if (totalDurationMs <= 0) return empty;

  const durationBySeller = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const segmentEndMs = i + 1 < events.length ? events[i + 1].ms : referenceEndMs;
    const segmentDurationMs = Math.max(0, segmentEndMs - events[i].ms);
    durationBySeller.set(events[i].sellerId, (durationBySeller.get(events[i].sellerId) || 0) + segmentDurationMs);
  }

  let topSellerId: string | null = null;
  let topDurationMs = 0;
  for (const [sellerId, durationMs] of durationBySeller) {
    if (amazonSellerIds.has(sellerId)) continue; // "third-party" continuity only
    if (durationMs > topDurationMs) { topDurationMs = durationMs; topSellerId = sellerId; }
  }
  if (!topSellerId) return empty;

  return {
    topSellerId,
    topSellerContinuityPct: (topDurationMs / totalDurationMs) * 100,
    continuityWindowDays: Math.round(totalDurationMs / (24 * 60 * 60 * 1000)),
    singleEvent: false,
  };
}

// Combines Keepa's own pre-computed per-seller Buy Box win stats
// (stats.buyBoxStats — { sellerId: { percentageWon, ... } } for the
// requested `stats` window) with the time-weighted continuity above.
export function computeBuyBoxOwnership(
  buyBoxStats: Record<string, { percentageWon?: number; isFBA?: boolean }> | null | undefined,
  buyBoxSellerIdHistoryRaw: unknown,
  windowDays: number,
  amazonSellerIds: Set<string>,
  referenceEndMs: number,
): BuyBoxOwnershipSummary {
  const entries = buyBoxStats && typeof buyBoxStats === 'object' ? Object.entries(buyBoxStats) : [];
  const sellers = entries
    .map(([sellerId, info]) => ({
      sellerId,
      percentageWon: Number(info?.percentageWon),
      isFBA: !!info?.isFBA,
    }))
    .filter(s => Number.isFinite(s.percentageWon));

  const thirdParty = sellers.filter(s => !amazonSellerIds.has(s.sellerId));
  const distinctThirdPartyWinners = entries.length > 0 ? thirdParty.length : null;
  const topThirdParty = thirdParty.length
    ? thirdParty.reduce((best, s) => (s.percentageWon > best.percentageWon ? s : best))
    : null;

  const continuity = computeTopSellerContinuity(buyBoxSellerIdHistoryRaw, referenceEndMs, amazonSellerIds);

  // "Sufficient" = we have at least some real BB-stats AND at least a
  // couple weeks of continuity history to compute a meaningful percentage
  // (this bar applies equally to the single-event case — a 3-day-old lone
  // event is real evidence, but still too thin to trust on its own).
  // "Rich" = a healthier amount of both, used only to gate High confidence.
  const sufficient = entries.length > 0 && continuity.continuityWindowDays != null && continuity.continuityWindowDays >= 14;
  const rich = entries.length >= 3 && (continuity.continuityWindowDays || 0) >= 60;

  return {
    windowDays,
    sellers,
    distinctThirdPartyWinners,
    topThirdPartyPct: topThirdParty ? topThirdParty.percentageWon : null,
    topThirdPartySellerId: topThirdParty ? topThirdParty.sellerId : null,
    topSellerContinuityPct: continuity.topSellerContinuityPct,
    continuityWindowDays: continuity.continuityWindowDays,
    continuitySingleEvent: continuity.singleEvent,
    sufficient,
    rich,
  };
}
