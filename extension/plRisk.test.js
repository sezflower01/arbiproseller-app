// Unit tests for extension/plRisk.js. Run with: node --test extension/plRisk.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

global.self = global; // plRisk.js attaches to `self`; Node has no window/self by default
require('./plRisk.js');

const { computePrivateLabelRisk, computeAmazonCompetitionRisk } = global;

function sellerHistory(overrides) {
  return { windowDays: 365, avg: 5, min: 1, max: 10, currentCount: 5, trend: 'stable', sufficient: true, rich: true, ...overrides };
}
function buyBoxOwnership(overrides) {
  return {
    windowDays: 90, distinctThirdPartyWinners: 4, topThirdPartyPct: 40,
    topSellerContinuityPct: 40, continuityWindowDays: 90, sufficient: true, rich: true,
    ...overrides,
  };
}
// A single, never-displaced Buy Box event — dominance/winners zeroed out so
// tests can isolate exactly what the day-tiered continuity scoring awards.
function bbSingleEvent(days, overrides) {
  return {
    windowDays: 90, distinctThirdPartyWinners: 10, topThirdPartyPct: 0,
    topSellerContinuityPct: 100, continuityWindowDays: days, continuitySingleEvent: true,
    sufficient: days >= 14, rich: false,
    ...overrides,
  };
}

test('Dominant seller with few active offers => High', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: sellerHistory({ avg: 2 }),
    buyBoxOwnership: buyBoxOwnership({ distinctThirdPartyWinners: 1, topThirdPartyPct: 91, topSellerContinuityPct: 90 }),
    productAgeDays: 500,
  });
  assert.equal(result.level, 'High');
  assert.equal(result.state, 'scored');
  assert.equal(result.confidence, 'high');
});

test('Many Buy Box winners and many active offers => Low', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: sellerHistory({ avg: 9 }),
    buyBoxOwnership: buyBoxOwnership({ distinctThirdPartyWinners: 8, topThirdPartyPct: 12, topSellerContinuityPct: 10 }),
    productAgeDays: 100,
  });
  assert.equal(result.level, 'Low');
});

test('Temporary current-offer drop but high historical average does not increase PL risk', () => {
  const base = { sellerHistory: sellerHistory({ avg: 9, currentCount: 9 }), buyBoxOwnership: buyBoxOwnership({ distinctThirdPartyWinners: 8, topThirdPartyPct: 12 }), productAgeDays: 100 };
  const dropped = { ...base, sellerHistory: { ...base.sellerHistory, currentCount: 1 } }; // avg unchanged, only currentCount drops
  const r1 = computePrivateLabelRisk(base);
  const r2 = computePrivateLabelRisk(dropped);
  assert.equal(r1.normalizedScore, r2.normalizedScore, 'currentCount must not affect the score at all');
  assert.equal(r1.level, r2.level);
});

test('Amazon dominates => Amazon Competition Risk changes, PL score does not', () => {
  const inputs = { sellerHistory: sellerHistory(), buyBoxOwnership: buyBoxOwnership(), productAgeDays: 200 };
  const plBefore = computePrivateLabelRisk(inputs);
  const plAfter = computePrivateLabelRisk(inputs); // PL function doesn't even take Amazon % as an input
  assert.equal(plBefore.normalizedScore, plAfter.normalizedScore);

  const amzLow = computeAmazonCompetitionRisk(2);
  const amzHigh = computeAmazonCompetitionRisk(85);
  assert.equal(amzLow.text, 'Low');
  assert.equal(amzHigh.text, 'High');
  assert.notEqual(amzLow.text, amzHigh.text);
});

test('Missing Buy Box history => partial result, capped at Medium confidence', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: sellerHistory({ avg: 2 }),
    buyBoxOwnership: { sufficient: false },
    productAgeDays: 500,
  });
  assert.equal(result.state, 'scored');
  assert.notEqual(result.confidence, 'high');
  assert.ok(result.missing.includes('Buy Box ownership history'));
});

test('Missing active-offer history => partial result, capped at Medium confidence', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: { sufficient: false },
    buyBoxOwnership: buyBoxOwnership({ distinctThirdPartyWinners: 1, topThirdPartyPct: 91 }),
    productAgeDays: 500,
  });
  assert.equal(result.state, 'scored');
  assert.notEqual(result.confidence, 'high');
  assert.ok(result.missing.includes('historical active-offer data'));
});

test('Both datasets missing (legacy cached response) => Insufficient, never silently Low', () => {
  const result = computePrivateLabelRisk({ sellerHistory: null, buyBoxOwnership: null, productAgeDays: 500 });
  assert.equal(result.state, 'insufficient');
  assert.equal(result.text, 'Insufficient Historical Data');
  assert.notEqual(result.level, 'Low'); // must not be silently scored as Low
});

test('Undefined sellerHistory/buyBoxOwnership (no fields at all on the object) also => Insufficient', () => {
  const result = computePrivateLabelRisk({ productAgeDays: 500 });
  assert.equal(result.state, 'insufficient');
});

test('Explanation text uses "active offers" wording, never calls it a seller count', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: sellerHistory({ avg: 2 }),
    buyBoxOwnership: buyBoxOwnership({ distinctThirdPartyWinners: 1, topThirdPartyPct: 91, topSellerContinuityPct: 90 }),
    productAgeDays: 500,
  });
  const allText = result.reasons.join(' ');
  assert.ok(allText.includes('active') || allText.includes('offers'), 'should describe offer-count signal using "active offers" language');
  assert.ok(!/\bsellers?\b.*\bcount\b/i.test(allText.replace(/Buy Box/g, '')), 'must not describe offer count as a "seller count"');
});

test('Brand-name match is not part of Phase 1 scoring at all', () => {
  const withBrandLikeFields = computePrivateLabelRisk({
    sellerHistory: sellerHistory({ avg: 9 }),
    buyBoxOwnership: buyBoxOwnership({ distinctThirdPartyWinners: 8, topThirdPartyPct: 12 }),
    productAgeDays: 100,
    topSellerName: 'Nike Official Store', // even if passed, must be ignored in Phase 1
    brandName: 'Nike',
  });
  assert.equal(withBrandLikeFields.maxAvailable, 95, 'max available score must be 95 (no brand-match points in Phase 1)');
});

// ── PL History Coverage (renamed from "Data Confidence") ──────────────────
test('Coverage: both datasets rich => Strong', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: sellerHistory({ rich: true }),
    buyBoxOwnership: buyBoxOwnership({ rich: true }),
    productAgeDays: 200,
  });
  assert.equal(result.coverage, 'strong');
});

test('Coverage: one dataset entirely missing => Partial', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: sellerHistory({ avg: 9 }),
    buyBoxOwnership: { sufficient: false },
    productAgeDays: 200,
  });
  assert.equal(result.coverage, 'partial');
});

test('Coverage: both datasets present but neither rich => Limited (distinct from Partial)', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: sellerHistory({ rich: false }),
    buyBoxOwnership: buyBoxOwnership({ rich: false }),
    productAgeDays: 200,
  });
  assert.equal(result.coverage, 'limited');
});

test('Coverage: both datasets missing => Insufficient', () => {
  const result = computePrivateLabelRisk({ sellerHistory: null, buyBoxOwnership: null, productAgeDays: 200 });
  assert.equal(result.coverage, 'insufficient');
});

// ── Regression: cost/ROI/profit must NEVER influence PL Risk or Coverage ──
// This function doesn't even accept a cost/roi/profit parameter, but this
// test locks in that guarantee explicitly so a future refactor that starts
// threading extra fields into this call can't silently start using them.
test('Regression: passing cost/roi/profit-like fields does not change the result at all', () => {
  const inputs = {
    sellerHistory: sellerHistory({ avg: 2 }),
    buyBoxOwnership: buyBoxOwnership({ distinctThirdPartyWinners: 1, topThirdPartyPct: 91, topSellerContinuityPct: 90 }),
    productAgeDays: 500,
  };
  const before = computePrivateLabelRisk(inputs);
  const after = computePrivateLabelRisk({ ...inputs, unitCost: 12.95, roi: 47, profit: 6.09, costMissing: false });
  assert.deepEqual(before, after, 'PL Risk / PL History Coverage must be byte-for-byte identical regardless of cost/ROI/profit inputs');
});

// ── Single Buy Box event: day-tiered continuity, not percentage-only ──────
// A single never-displaced event always reports 100% continuity by
// construction, so scoring has to gate on how LONG that one observation
// covers instead of the (trivially maxed-out) percentage.

test('Single event, 180 days coverage => full continuity evidence (10 raw points)', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: { sufficient: false },
    buyBoxOwnership: bbSingleEvent(180),
    productAgeDays: 200,
  });
  assert.equal(result.state, 'scored');
  assert.equal(result.score, 10, 'dominance and distinct-winners were zeroed out — only continuity should score');
});

test('Single event, 30 days coverage => reduced continuity evidence (3 raw points)', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: { sufficient: false },
    buyBoxOwnership: bbSingleEvent(30),
    productAgeDays: 200,
  });
  assert.equal(result.state, 'scored');
  assert.equal(result.score, 3);
});

test('Single event, 75 days coverage => mid continuity evidence (6 raw points)', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: { sufficient: false },
    buyBoxOwnership: bbSingleEvent(75),
    productAgeDays: 200,
  });
  assert.equal(result.state, 'scored');
  assert.equal(result.score, 6);
});

test('Single event, 3 days coverage => Limited History, never High/Medium/Low', () => {
  const result = computePrivateLabelRisk({
    sellerHistory: { sufficient: false, pointsCount: 0 },
    buyBoxOwnership: bbSingleEvent(3),
    productAgeDays: 200,
  });
  assert.equal(result.state, 'limited_history');
  assert.equal(result.level, 'unknown');
  assert.equal(result.normalizedScore, null);
  assert.notEqual(result.level, 'High');
});

test('Single event with invalid/missing timestamp (no real evidence) => Not Enough Data', () => {
  // Simulates what computeTopSellerContinuity() in the edge function returns
  // when the lone raw event fails timestamp parsing entirely: continuityWindowDays
  // stays null rather than some small number.
  const result = computePrivateLabelRisk({
    sellerHistory: { sufficient: false, pointsCount: 0 },
    buyBoxOwnership: { sufficient: false, continuityWindowDays: null, continuitySingleEvent: false },
    productAgeDays: 200,
  });
  assert.equal(result.state, 'insufficient');
  assert.equal(result.text, 'Insufficient Historical Data');
});

test('Single long Buy Box event plus strong active-offer history => full score, high confidence', () => {
  // Unlike bbSingleEvent()'s isolation defaults, this uses realistic dominant
  // values (not zeroed-out) since the point here is the combined full-score
  // outcome, not isolating the continuity tier specifically.
  const result = computePrivateLabelRisk({
    sellerHistory: sellerHistory({ avg: 2, rich: true }),
    buyBoxOwnership: bbSingleEvent(180, { distinctThirdPartyWinners: 1, topThirdPartyPct: 95, rich: true }),
    productAgeDays: 500,
  });
  assert.equal(result.state, 'scored');
  assert.equal(result.confidence, 'high');
  assert.equal(result.level, 'High');
});

test('Regression: none of the new limited/single-event paths silently return Low Risk', () => {
  const scenarios = [
    computePrivateLabelRisk({ sellerHistory: { sufficient: false, pointsCount: 0 }, buyBoxOwnership: bbSingleEvent(3), productAgeDays: 200 }),
    computePrivateLabelRisk({ sellerHistory: { sufficient: false, pointsCount: 0 }, buyBoxOwnership: { sufficient: false, continuityWindowDays: null }, productAgeDays: 200 }),
    computePrivateLabelRisk({ sellerHistory: null, buyBoxOwnership: null, productAgeDays: 200 }),
  ];
  for (const r of scenarios) {
    assert.notEqual(r.level, 'Low', `state=${r.state} must never silently present as Low Risk`);
  }
});
