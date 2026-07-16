// Unit tests for the Private-Label Risk data-shaping helpers in
// mobile-scan-price-history/index.ts (summarizeCountSeries,
// computeTopSellerContinuity, computeBuyBoxOwnership).
//
// index.ts calls Deno.serve(...) at module scope, so importing it directly
// would start an HTTP listener as a side effect of running these tests —
// same reason sync-sales-orders/pending-price-resolution_test.ts re-expresses
// its target logic locally instead of importing the production file. These
// three functions are mirrored here VERBATIM. If they change in index.ts,
// update both places so they stay in sync.
import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const KEEPA_EPOCH_MIN = 21564000;
const KEEPA_EPOCH_MS_CONST = KEEPA_EPOCH_MIN * 60_000;

function keepaMinToIso(km: number): string {
  return new Date((km + KEEPA_EPOCH_MIN) * 60_000).toISOString();
}

function parseSeries(csv: number[] | null | undefined, daysBack: number, isPrice = true) {
  if (!csv || csv.length < 2) return [] as { t: number; v: number }[];
  const cutoffMin = Math.floor(Date.now() / 60_000) - KEEPA_EPOCH_MIN - daysBack * 24 * 60;
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < csv.length; i += 2) {
    const t = csv[i];
    const v = csv[i + 1];
    if (typeof t !== 'number' || typeof v !== 'number') continue;
    if (v === -1) continue;
    if (t < cutoffMin) continue;
    out.push({ t, v: isPrice ? v / 100 : v });
  }
  return out;
}

type SellerHistorySummary = {
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

function summarizeCountSeries(rawPoints: { t: number; v: number }[], windowDays: number): SellerHistorySummary {
  const points = rawPoints.slice().sort((a, b) => a.t - b.t).map(p => ({ t: keepaMinToIso(p.t), v: p.v }));
  const pointsCount = points.length;
  const SUFFICIENT_MIN = 5;
  const RICH_MIN = 20;

  if (pointsCount === 0) {
    return { windowDays, points: [], currentCount: null, avg: null, min: null, max: null, pointsCount: 0, trend: 'unknown', sufficient: false, rich: false };
  }

  const values = points.map(p => p.v);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const currentCount = values[values.length - 1];

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

  return { windowDays, points, currentCount, avg, min, max, pointsCount, trend, sufficient: pointsCount >= SUFFICIENT_MIN, rich: pointsCount >= RICH_MIN };
}

function computeTopSellerContinuity(historyRaw: unknown, referenceEndMs: number, amazonSellerIds: Set<string>) {
  const empty = { topSellerId: null as string | null, topSellerContinuityPct: null as number | null, continuityWindowDays: null as number | null, singleEvent: false };
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

  // A single recorded event means the Buy Box has never changed hands since
  // Keepa started tracking it — real evidence of continuous control, not
  // "not enough data". Duration = from that one event to referenceEndMs.
  if (events.length === 1) {
    const ev = events[0];
    if (amazonSellerIds.has(ev.sellerId)) return empty;
    const coverageMs = referenceEndMs - ev.ms;
    if (coverageMs <= 0) return empty;
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
    if (amazonSellerIds.has(sellerId)) continue;
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

function computeBuyBoxOwnership(
  buyBoxStats: Record<string, { percentageWon?: number; isFBA?: boolean }> | null | undefined,
  buyBoxSellerIdHistoryRaw: unknown,
  windowDays: number,
  amazonSellerIds: Set<string>,
  referenceEndMs: number,
) {
  const entries = buyBoxStats && typeof buyBoxStats === 'object' ? Object.entries(buyBoxStats) : [];
  const sellers = entries
    .map(([sellerId, info]) => ({ sellerId, percentageWon: Number(info?.percentageWon), isFBA: !!info?.isFBA }))
    .filter(s => Number.isFinite(s.percentageWon));

  const thirdParty = sellers.filter(s => !amazonSellerIds.has(s.sellerId));
  const distinctThirdPartyWinners = entries.length > 0 ? thirdParty.length : null;
  const topThirdParty = thirdParty.length ? thirdParty.reduce((best, s) => (s.percentageWon > best.percentageWon ? s : best)) : null;

  const continuity = computeTopSellerContinuity(buyBoxSellerIdHistoryRaw, referenceEndMs, amazonSellerIds);

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

function computeSinceListedDays(
  listedSinceKeepaMin: number | null | undefined,
  trackingSinceKeepaMin: number | null | undefined,
  nowMs: number,
  maxDays: number,
): number {
  const listed = Number(listedSinceKeepaMin);
  const tracking = Number(trackingSinceKeepaMin);
  const raw = listed > 0 ? listed : tracking;
  if (!Number.isFinite(raw) || raw <= 0) return maxDays;

  const sinceMs = KEEPA_EPOCH_MS_CONST + raw * 60_000;
  const daysSince = Math.floor((nowMs - sinceMs) / (24 * 60 * 60 * 1000));
  if (!Number.isFinite(daysSince) || daysSince <= 0) return maxDays;

  return Math.min(maxDays, Math.max(1, daysSince));
}

const AMAZON = new Set(['ATVPDKIKX0DER', 'AMAZON']);

// ── Tests ────────────────────────────────────────────────────────────────

Deno.test('summarizeCountSeries: -1 (no-data) points are dropped by parseSeries before summarizing', () => {
  const raw = [21564000, 5, 21564000 + 1440, -1, 21564000 + 2880, 7]; // keepa minutes, includes a -1
  const parsed = parseSeries(raw, 90, false);
  assertEquals(parsed.length, 2); // the -1 point must be gone
  assertEquals(parsed.map(p => p.v), [5, 7]);
});

Deno.test('summarizeCountSeries: fewer than 5 points is insufficient', () => {
  const nowMin = Math.floor(Date.now() / 60_000) - KEEPA_EPOCH_MIN;
  const points = [0, 1, 2, 3].map(i => ({ t: nowMin - i * 10, v: 5 }));
  const summary = summarizeCountSeries(points, 90);
  assertEquals(summary.sufficient, false);
});

Deno.test('summarizeCountSeries: 5+ points is sufficient but not rich until 20+', () => {
  const nowMin = Math.floor(Date.now() / 60_000) - KEEPA_EPOCH_MIN;
  const points5 = Array.from({ length: 5 }, (_, i) => ({ t: nowMin - i * 100, v: 3 }));
  const s5 = summarizeCountSeries(points5, 90);
  assert(s5.sufficient);
  assert(!s5.rich);

  const points20 = Array.from({ length: 20 }, (_, i) => ({ t: nowMin - i * 100, v: 3 }));
  const s20 = summarizeCountSeries(points20, 90);
  assert(s20.rich);
});

Deno.test('computeTopSellerContinuity: final event interval runs to referenceEndMs, not zero', () => {
  // Two events: SellerA at t=1000 keepa-min, SellerB at t=2000 keepa-min.
  // referenceEndMs is 10,000 minutes worth of time after t=2000 — SellerB
  // must accrue that whole span, not show up as a zero-duration hold.
  const t1 = 1_000_000; // arbitrary keepa-minute base
  const t2 = t1 + 1000;
  const referenceEndMs = KEEPA_EPOCH_MS_CONST + (t2 + 10_000) * 60_000;
  const history = [String(t1), 'SELLER_A', String(t2), 'SELLER_B'];
  const result = computeTopSellerContinuity(history, referenceEndMs, AMAZON);
  assertEquals(result.topSellerId, 'SELLER_B');
  // SellerA held for 1000 keepa-min, SellerB held for 10000 keepa-min => ~90.9%
  assert(result.topSellerContinuityPct! > 85 && result.topSellerContinuityPct! < 95);
});

Deno.test('computeTopSellerContinuity: same seller dominant across most events => high pct', () => {
  const base = 1_000_000;
  // SELLER_X holds almost the whole window; SELLER_Y briefly interrupts near the end.
  const history = [
    String(base), 'SELLER_X',
    String(base + 100_000), 'SELLER_Y',
    String(base + 100_100), 'SELLER_X',
  ];
  const referenceEndMs = KEEPA_EPOCH_MS_CONST + (base + 100_200) * 60_000;
  const result = computeTopSellerContinuity(history, referenceEndMs, AMAZON);
  assertEquals(result.topSellerId, 'SELLER_X');
  assert(result.topSellerContinuityPct! > 95);
});

Deno.test('computeTopSellerContinuity: Amazon is excluded from "top third-party" even if dominant', () => {
  const base = 1_000_000;
  const history = [
    String(base), 'ATVPDKIKX0DER',
    String(base + 900_000), 'SELLER_Z',
  ];
  const referenceEndMs = KEEPA_EPOCH_MS_CONST + (base + 1_000_000) * 60_000;
  const result = computeTopSellerContinuity(history, referenceEndMs, AMAZON);
  assertEquals(result.topSellerId, 'SELLER_Z'); // not Amazon, despite Amazon holding longer
});

Deno.test('computeBuyBoxOwnership: dominant single third-party seller, few active offers scenario', () => {
  const buyBoxStats = {
    SELLER_A: { percentageWon: 91, isFBA: true },
    SELLER_B: { percentageWon: 6, isFBA: false },
    ATVPDKIKX0DER: { percentageWon: 3, isFBA: true },
  };
  const base = 1_000_000;
  const history = [String(base), 'SELLER_A', String(base + 1), 'SELLER_A']; // trivial, continuity tested above
  const referenceEndMs = KEEPA_EPOCH_MS_CONST + (base + 20 * 24 * 60) * 60_000; // ~20 days later
  const result = computeBuyBoxOwnership(buyBoxStats, history, 90, AMAZON, referenceEndMs);
  assertEquals(result.distinctThirdPartyWinners, 2); // SELLER_A + SELLER_B, Amazon excluded
  assertEquals(result.topThirdPartyPct, 91);
  assertEquals(result.topThirdPartySellerId, 'SELLER_A');
});

Deno.test('computeBuyBoxOwnership: many distinct winners => low dominance signal', () => {
  const buyBoxStats: Record<string, { percentageWon: number; isFBA: boolean }> = {};
  for (let i = 0; i < 8; i++) buyBoxStats[`SELLER_${i}`] = { percentageWon: 100 / 8, isFBA: i % 2 === 0 };
  const referenceEndMs = Date.now();
  const result = computeBuyBoxOwnership(buyBoxStats, [], 90, AMAZON, referenceEndMs);
  assertEquals(result.distinctThirdPartyWinners, 8);
  assert(result.topThirdPartyPct! < 15);
});

Deno.test('computeBuyBoxOwnership: no buyBoxStats at all => insufficient (distinctThirdPartyWinners null)', () => {
  const result = computeBuyBoxOwnership(null, [], 90, AMAZON, Date.now());
  assertEquals(result.distinctThirdPartyWinners, null);
  assertEquals(result.sufficient, false);
});

Deno.test('computeBuyBoxOwnership: buyBoxStats present but continuity history too short => insufficient', () => {
  const buyBoxStats = { SELLER_A: { percentageWon: 80, isFBA: true } };
  const base = 1_000_000;
  // Only 2 days of history (< the 14-day sufficiency floor)
  const history = [String(base), 'SELLER_A'];
  const referenceEndMs = KEEPA_EPOCH_MS_CONST + (base + 2 * 24 * 60) * 60_000;
  const result = computeBuyBoxOwnership(buyBoxStats, history, 90, AMAZON, referenceEndMs);
  assertEquals(result.sufficient, false);
});

// ── Single-event continuity (one seller, never displaced) ────────────────

Deno.test('computeTopSellerContinuity: single event with 180 days of coverage => 100% continuity, sufficient', () => {
  const base = 1_000_000;
  const history = [String(base), 'SELLER_SOLO'];
  const referenceEndMs = KEEPA_EPOCH_MS_CONST + (base + 180 * 24 * 60) * 60_000;
  const result = computeTopSellerContinuity(history, referenceEndMs, AMAZON);
  assertEquals(result.topSellerId, 'SELLER_SOLO');
  assertEquals(result.topSellerContinuityPct, 100);
  assertEquals(result.continuityWindowDays, 180);
  assertEquals(result.singleEvent, true);
});

Deno.test('computeTopSellerContinuity: single event with only 3 days of coverage is still real evidence, just thin', () => {
  const base = 1_000_000;
  const history = [String(base), 'SELLER_SOLO'];
  const referenceEndMs = KEEPA_EPOCH_MS_CONST + (base + 3 * 24 * 60) * 60_000;
  const result = computeTopSellerContinuity(history, referenceEndMs, AMAZON);
  assertEquals(result.topSellerId, 'SELLER_SOLO');
  assertEquals(result.continuityWindowDays, 3);
  assertEquals(result.singleEvent, true);
});

Deno.test('computeTopSellerContinuity: single event with invalid timestamp produces no evidence at all', () => {
  const history = ['not-a-number', 'SELLER_SOLO'];
  const result = computeTopSellerContinuity(history, Date.now(), AMAZON);
  assertEquals(result.topSellerId, null);
  assertEquals(result.continuityWindowDays, null);
  assertEquals(result.singleEvent, false);
});

Deno.test('computeBuyBoxOwnership: single event, 180 days => sufficient and rich-eligible continuity window', () => {
  const buyBoxStats = { SELLER_SOLO: { percentageWon: 100, isFBA: true } };
  const base = 1_000_000;
  const history = [String(base), 'SELLER_SOLO'];
  const referenceEndMs = KEEPA_EPOCH_MS_CONST + (base + 180 * 24 * 60) * 60_000;
  const result = computeBuyBoxOwnership(buyBoxStats, history, 90, AMAZON, referenceEndMs);
  assertEquals(result.continuitySingleEvent, true);
  assertEquals(result.topSellerContinuityPct, 100);
  assertEquals(result.sufficient, true);
});

Deno.test('computeBuyBoxOwnership: single event, 3 days => real evidence but not sufficient (under the 14-day floor)', () => {
  const buyBoxStats = { SELLER_SOLO: { percentageWon: 100, isFBA: true } };
  const base = 1_000_000;
  const history = [String(base), 'SELLER_SOLO'];
  const referenceEndMs = KEEPA_EPOCH_MS_CONST + (base + 3 * 24 * 60) * 60_000;
  const result = computeBuyBoxOwnership(buyBoxStats, history, 90, AMAZON, referenceEndMs);
  assertEquals(result.continuityWindowDays, 3);
  assertEquals(result.sufficient, false); // too short to trust, but continuityWindowDays is not null — real evidence exists
});

// ── computeSinceListedDays ("Since Listed" range) ──────────────────────────

Deno.test('computeSinceListedDays: listedSince 400 days ago => ~400 days', () => {
  const nowMs = KEEPA_EPOCH_MS_CONST + 10_000_000 * 60_000;
  const listedSinceKeepaMin = 10_000_000 - 400 * 24 * 60;
  const result = computeSinceListedDays(listedSinceKeepaMin, null, nowMs, 3650);
  assertEquals(result, 400);
});

Deno.test('computeSinceListedDays: listedSince missing (0) falls back to trackingSince', () => {
  const nowMs = KEEPA_EPOCH_MS_CONST + 10_000_000 * 60_000;
  const trackingSinceKeepaMin = 10_000_000 - 900 * 24 * 60;
  const result = computeSinceListedDays(0, trackingSinceKeepaMin, nowMs, 3650);
  assertEquals(result, 900);
});

Deno.test('computeSinceListedDays: listedSince takes priority over trackingSince when both present', () => {
  const nowMs = KEEPA_EPOCH_MS_CONST + 10_000_000 * 60_000;
  const listedSinceKeepaMin = 10_000_000 - 200 * 24 * 60; // 200 days ago
  const trackingSinceKeepaMin = 10_000_000 - 900 * 24 * 60; // 900 days ago (Keepa started tracking earlier)
  const result = computeSinceListedDays(listedSinceKeepaMin, trackingSinceKeepaMin, nowMs, 3650);
  assertEquals(result, 200);
});

Deno.test('computeSinceListedDays: neither field usable => falls back to the generously-requested max window', () => {
  const nowMs = Date.now();
  assertEquals(computeSinceListedDays(null, null, nowMs, 3650), 3650);
  assertEquals(computeSinceListedDays(0, 0, nowMs, 3650), 3650);
  assertEquals(computeSinceListedDays(undefined, undefined, nowMs, 3650), 3650);
});

Deno.test('computeSinceListedDays: a computed day count beyond maxDays is clamped down', () => {
  const nowMs = KEEPA_EPOCH_MS_CONST + 10_000_000 * 60_000;
  const listedSinceKeepaMin = 10_000_000 - 5000 * 24 * 60; // 5000 days ago — beyond maxDays
  const result = computeSinceListedDays(listedSinceKeepaMin, null, nowMs, 3650);
  assertEquals(result, 3650);
});

Deno.test('computeSinceListedDays: a future/invalid timestamp is guarded, falls back to maxDays', () => {
  const nowMs = KEEPA_EPOCH_MS_CONST + 10_000_000 * 60_000;
  const listedSinceKeepaMin = 10_000_000 + 1000; // in the future relative to nowMs
  const result = computeSinceListedDays(listedSinceKeepaMin, null, nowMs, 3650);
  assertEquals(result, 3650);
});
