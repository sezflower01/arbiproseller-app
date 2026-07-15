// Private-Label Risk + Amazon Competition Risk scoring.
// Pure functions, no DOM/chrome.* dependencies — same pattern as
// decisionSignal.js — so this file can be loaded standalone in Node for
// unit tests (see plRisk.test.js) as well as in the extension panel.
//
// Data contract (produced by supabase/functions/mobile-scan-price-history):
//   sellerHistory: {
//     windowDays, points:[{t,v}], currentCount, avg, min, max,
//     trend: "increasing"|"stable"|"declining"|"unknown",
//     pointsCount, sufficient, rich,
//   }
//   buyBoxOwnership: {
//     windowDays, sellers:[{sellerId,percentageWon,isFBA}],
//     distinctThirdPartyWinners, topThirdPartyPct, topThirdPartySellerId,
//     topSellerContinuityPct, continuityWindowDays, continuitySingleEvent,
//     sufficient, rich,
//   }
//
// state can be "scored", "limited_history", or "insufficient":
//   - "scored": at least one dataset is sufficient — a real Low/Medium/High
//     percentage is returned.
//   - "limited_history": neither dataset is "sufficient", but there IS some
//     real (if thin) evidence — e.g. a single Buy Box event only a few days
//     old. Never Low/Medium/High; normalizedScore is null.
//   - "insufficient": no usable evidence at all. Never silently treated as
//     Low — normalizedScore is null and level is "unknown".
//
// Phase 1 explicitly excludes any brand-name-match signal (removed per
// review — seller display names aren't reliably available without an
// extra Keepa /seller call, which we're not adding this phase) and does
// NOT score the offer-count trend (informational only — a decline can be
// a temporary stock blip, not evidence of PL risk, until we've observed
// real results).

(function (root) {
  function classifyAmazonCompetitionRisk(amazonPresencePct) {
    if (amazonPresencePct == null) {
      return { level: "unknown", text: "Unknown", detail: "No Amazon-presence data available." };
    }
    const p = amazonPresencePct;
    if (p < 5) return { level: "good", text: "Low", detail: `Amazon rarely sells this listing (${Math.round(p)}% of the last 90 days).` };
    if (p < 30) return { level: "caution", text: "Medium", detail: `Amazon occasionally sells this listing (${Math.round(p)}% of the last 90 days).` };
    if (p < 70) return { level: "caution", text: "Medium", detail: `Amazon frequently sells this listing (${Math.round(p)}% of the last 90 days).` };
    return { level: "bad", text: "High", detail: `Amazon dominates this listing (${Math.round(p)}% of the last 90 days).` };
  }

  function scoreDominance(pct) {
    if (pct == null) return 0;
    if (pct >= 85) return 35;
    if (pct >= 70) return 22;
    if (pct >= 50) return 10;
    return 0;
  }
  function scoreDistinctWinners(n) {
    if (n == null) return 0;
    if (n <= 1) return 25;
    if (n <= 3) return 17;
    if (n <= 5) return 8;
    return 0;
  }
  function scoreActiveOfferLevel(avg) {
    if (avg == null) return 0;
    if (avg <= 2) return 20;
    if (avg <= 4) return 12;
    if (avg <= 8) return 5;
    return 0;
  }
  // A single never-changed Buy Box event reports 100% continuity by
  // construction (see mobile-scan-price-history/index.ts), so percentage
  // alone can't distinguish "one seller for 3 days" from "one seller for
  // 2 years" — gate points on the actual measured coverage instead. A
  // genuine multi-event turnover history keeps using the percentage, since
  // there the percentage itself reflects real variation over time.
  function scoreContinuity(buyBoxOwnership) {
    if (!buyBoxOwnership) return 0;
    const days = buyBoxOwnership.continuityWindowDays;
    if (buyBoxOwnership.continuitySingleEvent) {
      if (days == null || days < 14) return 0;
      if (days < 60) return 3;
      if (days < 90) return 6;
      return 10;
    }
    const pct = buyBoxOwnership.topSellerContinuityPct;
    if (pct == null) return 0;
    if (pct >= 85) return 10;
    if (pct >= 70) return 6;
    if (pct >= 50) return 3;
    return 0;
  }

  // sellerHistory / buyBoxOwnership are considered "sufficient" (usable at
  // all) vs. "rich" (enough coverage to count toward High confidence) by
  // the edge function — see mobile-scan-price-history/index.ts. This
  // module only reads those two booleans; it never guesses at coverage
  // itself, so the threshold definitions live in exactly one place.
  function computePrivateLabelRisk({ sellerHistory, buyBoxOwnership, productAgeDays } = {}) {
    const sellerOk = !!(sellerHistory && sellerHistory.sufficient);
    const bbOk = !!(buyBoxOwnership && buyBoxOwnership.sufficient);
    const trend = (sellerHistory && sellerHistory.trend) || "unknown";

    if (!sellerOk && !bbOk) {
      // Neither dataset clears its "sufficient" bar — but that's not the
      // same as having ZERO evidence. A single Buy Box event 3 days old, or
      // a couple of active-offer history points, is real (if thin) signal:
      // showing "Not Enough Data" for that would be as misleading as
      // silently scoring it. "Limited History" is the honest middle state.
      const bbHasAnyEvidence = !!(buyBoxOwnership && buyBoxOwnership.continuityWindowDays != null);
      const sellerHasAnyEvidence = !!(sellerHistory && sellerHistory.pointsCount > 0);

      if (bbHasAnyEvidence || sellerHasAnyEvidence) {
        let limitedReason;
        if (bbHasAnyEvidence) {
          const d = buyBoxOwnership.continuityWindowDays;
          limitedReason = `Only a short Buy Box history is available (${d} day${d === 1 ? "" : "s"} measured so far) — not enough yet to reliably classify Private-Label Risk.`;
        } else {
          const n = sellerHistory.pointsCount;
          limitedReason = `Only ${n} historical active-offer data point${n === 1 ? "" : "s"} available so far — not enough yet to reliably classify Private-Label Risk.`;
        }
        return {
          state: "limited_history",
          level: "unknown",
          score: null, maxAvailable: 0, normalizedScore: null,
          confidence: "low",
          coverage: "minimal",
          text: limitedReason,
          reasons: [], missing: ["Buy Box ownership history", "historical active-offer data"],
          trend,
        };
      }

      return {
        state: "insufficient",
        level: "unknown",
        score: null, maxAvailable: 0, normalizedScore: null,
        confidence: "low",
        // "PL History Coverage" — a user-facing label for how much Keepa
        // historical data backs this verdict. Deliberately separate from
        // "Decision Confidence" (panel.js) which reflects the overall
        // BUY/SKIP verdict and DOES depend on cost/ROI. This field must
        // never be influenced by cost — it's a pure function of Keepa data.
        coverage: "insufficient",
        text: "Insufficient Historical Data",
        explanation: "Keepa did not provide enough seller history to determine the risk reliably.",
        reasons: [], missing: ["Buy Box ownership history", "historical active-offer data"],
        trend,
      };
    }

    let rawScore = 0;
    let maxAvailable = 0;
    const reasons = [];
    const missing = [];

    if (bbOk) {
      maxAvailable += 35 + 25 + 10;

      const pct = buyBoxOwnership.topThirdPartyPct;
      const dominancePts = scoreDominance(pct);
      rawScore += dominancePts;
      if (dominancePts > 0 && pct != null) {
        reasons.push(`one seller won ${Math.round(pct)}% of the Buy Box during the last ${buyBoxOwnership.windowDays} days`);
      }

      const n = buyBoxOwnership.distinctThirdPartyWinners;
      const winnersPts = scoreDistinctWinners(n);
      rawScore += winnersPts;
      if (n != null && n <= 3) {
        reasons.push(`only ${n} different seller${n === 1 ? "" : "s"} won the Buy Box during the last ${buyBoxOwnership.windowDays} days`);
      }

      const cont = buyBoxOwnership.topSellerContinuityPct;
      const contDays = buyBoxOwnership.continuityWindowDays;
      const contPts = scoreContinuity(buyBoxOwnership);
      rawScore += contPts;
      if (contPts > 0 && cont != null) {
        // Always name the actual measured period — never "ever held the
        // Buy Box" or other lifetime-ownership phrasing we can't back up.
        reasons.push(`the same seller controlled the Buy Box for approximately ${Math.round(cont)}% of the measured ${contDays}-day period`);
      }
    } else {
      missing.push("Buy Box ownership history");
    }

    if (sellerOk) {
      maxAvailable += 20 + 5;

      const avg = sellerHistory.avg;
      const levelPts = scoreActiveOfferLevel(avg);
      rawScore += levelPts;
      if (levelPts > 0 && avg != null) {
        reasons.push(`the listing averaged ${avg.toFixed(1)} active new-condition offers during the last ${sellerHistory.windowDays} days`);
      }

      if (productAgeDays != null && productAgeDays > 365 && avg != null && avg <= 4) {
        rawScore += 5;
        reasons.push("it's been listed for over a year with persistently few active offers");
      }
    } else {
      missing.push("historical active-offer data");
    }

    const normalizedScore = maxAvailable > 0 ? Math.round((rawScore / maxAvailable) * 100) : null;
    const level = normalizedScore == null ? "unknown"
      : normalizedScore >= 60 ? "High"
      : normalizedScore >= 30 ? "Medium"
      : "Low";

    const isPartial = !(sellerOk && bbOk);
    const isRich = (sellerHistory && sellerHistory.rich) && (buyBoxOwnership && buyBoxOwnership.rich);
    // Never present a partial score as High confidence, per review.
    const confidence = isPartial ? "medium" : (isRich ? "high" : "medium");
    // "Partial" (one dataset entirely missing) and "Limited" (both datasets
    // present but neither is rich yet) used to collapse into the same
    // "medium" confidence bucket, which hid a real distinction from users.
    const coverage = isPartial ? "partial" : (isRich ? "strong" : "limited");

    // Lead with the percentage — plain Low/Medium/High alone was harder for
    // a regular seller to calibrate than "18% Private-Label Risk (Low)".
    // The data-basis caveat (partial/limited) is folded into this same
    // sentence instead of living in a separate "coverage" row, since a
    // standalone "PL History Coverage" label didn't mean anything to users
    // on its own.
    const reasonsText = reasons.length ? `: ${reasons.slice(0, 2).join(", and ")}.` : " — signals were mixed.";
    let explanation;
    if (isPartial) {
      explanation = `${normalizedScore}% Private-Label Risk (${level}) — based on partial historical data: `
        + (bbOk
          ? "Buy Box ownership history was available, but historical active-offer data was missing."
          : "Historical active-offer data was available, but Buy Box ownership history was missing.");
    } else if (coverage === "limited") {
      explanation = `${normalizedScore}% Private-Label Risk (${level}) — based on limited historical data so far, treat as an early estimate`
        + reasonsText;
    } else {
      explanation = `${normalizedScore}% Private-Label Risk (${level})` + reasonsText;
    }

    return {
      state: "scored",
      level, score: rawScore, maxAvailable, normalizedScore,
      confidence,
      coverage,
      text: explanation,
      reasons, missing,
      trend,
    };
  }

  root.computeAmazonCompetitionRisk = classifyAmazonCompetitionRisk;
  root.computePrivateLabelRisk = computePrivateLabelRisk;
})(typeof self !== "undefined" ? self : globalThis);
