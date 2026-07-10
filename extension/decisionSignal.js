// Mirror of computeDecisionSignal() from src/pages/tools/MobileScan.tsx
// Kept verbatim so the extension verdict matches the web app 1:1.
self.computeDecisionSignal = function computeDecisionSignal(stab, profitCtx) {
  if (!stab || typeof stab !== "object") {
    return { level: "unknown", label: "Gathering data…", emoji: "⏳", reasons: [] };
  }
  if (!stab.intel) {
    // Request finished but Keepa returned no usable data.
    return {
      level: "unknown",
      label: stab.reason ? "No live data" : "Gathering data…",
      emoji: stab.reason ? "—" : "⏳",
      reasons: stab.reason ? [stab.reason] : [],
    };
  }
  const intel = stab.intel;
  const reasons = [];
  let avoidHits = 0, riskyHits = 0, safeHits = 0;

  if (stab.verdict === "stable") { safeHits++; reasons.push("Stable 90d price"); }
  else if (stab.verdict === "volatile") { riskyHits++; reasons.push("Volatile price swings"); }

  const amzPresence = intel.amazon_presence_pct;
  if (amzPresence != null) {
    if (amzPresence >= 70) { avoidHits++; reasons.push(`Amazon sells ${amzPresence.toFixed(0)}% of time`); }
    else if (amzPresence >= 30) { riskyHits++; reasons.push(`Amazon sells ${amzPresence.toFixed(0)}% of time`); }
    else if (amzPresence < 5) { safeHits++; reasons.push("Amazon rarely sells"); }
  }

  const totalSellers = (intel.sellers_fba ?? 0) + (intel.sellers_fbm ?? 0);
  if (intel.sellers_fba != null) {
    if (totalSellers >= 15) { riskyHits++; reasons.push(`${totalSellers} active sellers`); }
    else if (totalSellers <= 3) { safeHits++; reasons.push(`Low competition (${totalSellers} sellers)`); }
  }

  const bsr = intel.bsr_current;
  if (bsr != null) {
    if (bsr <= 10000) { safeHits++; reasons.push(`Top BSR #${bsr.toLocaleString()}`); }
    else if (bsr > 500000) { riskyHits++; reasons.push(`Slow seller (BSR #${bsr.toLocaleString()})`); }
  }

  let level, label, emoji;
  if (avoidHits >= 1) { level = "avoid"; label = "Avoid"; emoji = "❌"; }
  else if (riskyHits >= 2) { level = "risky"; label = "Risky"; emoji = "⚠️"; }
  else if (safeHits >= 3 && riskyHits === 0) { level = "opportunity"; label = "Opportunity"; emoji = "🔥"; }
  else if (safeHits >= 2 && riskyHits <= 1) { level = "safe"; label = "Safe Buy"; emoji = "✅"; }
  else if (riskyHits >= 1) { level = "risky"; label = "Risky"; emoji = "⚠️"; }
  else { level = "unknown"; label = "Mixed signals"; emoji = "🤔"; }

  if (profitCtx?.hasCost && profitCtx.profit != null) {
    const p = profitCtx.profit;
    const r = profitCtx.roi ?? 0;
    if (p < 1) {
      level = "avoid"; label = "Avoid"; emoji = "❌";
      reasons.unshift(`Profit too low ($${p.toFixed(2)})`);
    } else if (p < 2) {
      level = "risky"; label = "Risky"; emoji = "⚠️";
      reasons.unshift(`Low profit ($${p.toFixed(2)})`);
    } else if (p < 3 || r < 25) {
      if (level === "safe" || level === "opportunity") {
        level = "risky"; label = "Risky"; emoji = "⚠️";
      }
      reasons.unshift(`Thin margin ($${p.toFixed(2)} · ${r.toFixed(0)}% ROI)`);
    }
  }

  return { level, label, emoji, reasons: reasons.slice(0, 4) };
};
