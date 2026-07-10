// Mirror of extension/panel.js Final Decision engine.
// Produces ONE synthesized verdict + confidence + human explanation
// + supporting attribute pills, matching the analyzer UI 1:1.
//
// v2: compliance overlay (hazmat/prep/ip) as pre-check (never silently
// folded into the caution-counter), offerCounts as single source of truth
// for seller count, and simOverride labeling so a "buy" verdict is
// always tagged with which profit assumption it was computed from.

export type Level = "good" | "caution" | "bad" | "unknown";

export type Pill = { level: Level; text: string; reason?: string | null };

export type FinalAction = {
  action: string;
  cls: "" | "buy" | "test" | "watch" | "avoid";
  level: "good" | "caution" | "bad" | "unknown";
  emoji: string;
  why: string;
};

export type ComplianceInput = {
  hazmat?: "yes" | "caution" | "no" | "unknown";
  prep?: "required" | "caution" | "none" | "unknown";
  // NOTE: ipRisk removed 2026-07-06. No live data source was ever wired —
  // the "IP Analysis" alert in analyzer-product-snapshot is hardcoded to
  // "good", and the extension had `ipRisk: "unknown"` hardcoded on the
  // context object. The overlay branch was unreachable in production, so
  // it and its unit tests were deleted rather than kept as false-positive
  // coverage. See .lovable/architecture-audit.md → "IP risk overlay".
};


export type SimOverride = {
  active: boolean;
  profit?: number | null;
  roi?: number | null;
  salePrice?: number | null;
  fulfillment?: "FBA" | "FBM";
};

export type FinalDecisionInput = {
  profit: number | null;
  roi: number | null;
  hasCost: boolean;
  eligibility?: string | null;
  intel?: {
    amazon_presence_pct?: number | null;
    sellers_fba?: number | null;
    sellers_fbm?: number | null;
    third_party_buybox_pct?: number | null;
    product_age_days?: number | null;
    bsr_current?: number | null;
    est_monthly_sales?: number | null;
  } | null;
  swingPct?: number | null;
  slopePct?: number | null;
  rangeLabel?: string;
  /** Actual offer-list counts from the same query that renders the competitor table.
   *  When present, these win over `intel.sellers_*` (see doc block above). */
  offerCounts?: { fba: number; fbm: number } | null;
  /** Sellability/hazmat/prep/IP inputs. Never counted in the caution/bad tally —
   *  applied as a prefix/downgrade overlay after the base action is chosen. */
  compliance?: ComplianceInput | null;
  /** When active, verdict is recomputed from the user's Sim inputs and the
   *  sentence is prefixed "(Sim — your inputs) ". */
  simOverride?: SimOverride | null;
  /** Buy Box price used to produce profit/roi. Rendered in the detail line
   *  as "Based on Buy Box $X.XX". */
  buyBoxPrice?: number | null;
};

export type FinalDecisionResult = {
  final: FinalAction;
  confidence: "High" | "Medium" | "Low" | "—";
  scorePct: number | null;
  profit: Pill;
  trend: Pill;
  competition: Pill;
  eligibility: Pill;
  salesVelocity: Pill & { value: number | null };
  explanation: string;
  /** Machine-readable flags for UI decorations (red dots on verdict card). */
  complianceFlags: string[];
  /** How the seller count was derived. */
  sellerCountSource: "offers_list" | "keepa_intel" | "none";
  /** Total sellers actually used by the classifier. */
  sellerCountUsed: number;
  /** When simOverride.active, the delta between Buy Box and Sim assumptions. */
  simDelta?: { bbRoi: number | null; bbProfit: number | null; simRoi: number | null; simProfit: number | null };
  /** Which profit/ROI assumption drove the verdict. */
  priceBasis: "buy_box" | "sim";
};

const estimateMonthlySales = (intel: FinalDecisionInput["intel"]): number | null => {
  if (!intel) return null;
  const backend = Number(intel.est_monthly_sales);
  if (Number.isFinite(backend) && backend > 0) return Math.round(backend);
  const bsr = Number(intel.bsr_current);
  return Number.isFinite(bsr) && bsr > 0 ? Math.max(1, Math.round(100000 * Math.pow(bsr, -0.6))) : null;
};

function classifyEligibility(elig: string | null | undefined): Pill {
  const e = String(elig || "").toLowerCase();
  if (e === "approved" || e === "eligible") return { level: "good", text: "Yes" };
  if (e === "restricted" || e === "not_eligible" || e === "ineligible") return { level: "bad", text: "No" };
  if (e === "approval_required" || e === "needs_approval" || e === "gated") return { level: "caution", text: "Approval" };
  if (e === "unconfirmed" || e === "checking") return { level: "caution", text: "Verify" };
  return { level: "unknown", text: "—" };
}

function classifyAmazonShare(pct: number | null | undefined): Pill {
  if (pct == null) return { level: "unknown", text: "Unknown" };
  if (pct < 5) return { level: "good", text: "Never on listing" };
  if (pct < 30) return { level: "caution", text: `Occasionally (${Math.round(pct)}%)` };
  if (pct < 70) return { level: "caution", text: `Frequently (${Math.round(pct)}%)` };
  return { level: "bad", text: `Dominant (${Math.round(pct)}%)` };
}

function classifyPLRisk(
  intel: FinalDecisionInput["intel"],
  totalSellers: number,
): Pill & { reasons: string[] } {
  const i = intel || {};
  const top3p = i.third_party_buybox_pct ?? 0;
  const ageDays = i.product_age_days ?? null;
  let score = 0;
  const reasons: string[] = [];
  if (totalSellers > 0 && totalSellers <= 3) { score += 2; reasons.push(`Only ${totalSellers} sellers`); }
  if (top3p >= 80) { score += 2; reasons.push(`1 seller wins BB ${Math.round(top3p)}%`); }
  if (ageDays != null && ageDays > 365 && totalSellers <= 3) { score += 1; reasons.push("Long-listed, few sellers"); }
  if (score >= 3) return { level: "bad", text: "High", reasons };
  if (score >= 2) return { level: "caution", text: "Possible", reasons };
  return { level: "good", text: "Low", reasons };
}

function classifyProfit(roi: number | null, profit: number | null, eligLevel: Level): Pill {
  if (eligLevel === "bad") return { level: "bad", text: "Blocked", reason: "Not eligible to sell" };
  if (roi == null || profit == null) return { level: "unknown", text: "Enter cost", reason: null };
  if (profit < 1 || roi < 0)    return { level: "bad",     text: "Bad",   reason: `Profit $${profit.toFixed(2)} · ROI ${roi.toFixed(0)}%` };
  if (profit < 3 || roi < 20)   return { level: "caution", text: "Weak",  reason: `Profit $${profit.toFixed(2)} · ROI ${roi.toFixed(0)}%` };
  if (roi >= 30 && profit >= 3) return { level: "good",    text: "Good",  reason: `Profit $${profit.toFixed(2)} · ROI ${roi.toFixed(0)}%` };
  return { level: "caution", text: "Okay", reason: `Profit $${profit.toFixed(2)} · ROI ${roi.toFixed(0)}%` };
}

function classifyTrend(swing: number | null | undefined, slope: number | null | undefined, rangeLbl = "3M"): Pill {
  if (swing == null && slope == null) return { level: "unknown", text: "No history", reason: null };
  if (slope != null && slope <= -8) return { level: "bad", text: "Falling", reason: `${rangeLbl} BB price down ${Math.abs(slope).toFixed(0)}%` };
  if (swing != null && swing > 25)  return { level: "caution", text: "Volatile", reason: `${rangeLbl} swing ${swing.toFixed(0)}%` };
  if (slope != null && slope >= 8)  return { level: "good", text: "Rising", reason: `${rangeLbl} BB price up ${slope.toFixed(0)}%` };
  if (swing != null && swing <= 10) return { level: "good", text: "Stable", reason: `${rangeLbl} swing ${swing.toFixed(0)}%` };
  return { level: "caution", text: "Mixed", reason: `${rangeLbl} swing ${swing != null ? swing.toFixed(0)+"%" : "?"}` };
}

function classifyCompetition(
  amz: Pill,
  pl: Pill,
  totalSellers: number,
  bsr: number | null | undefined,
  sellerCountSource: "offers_list" | "keepa_intel" | "none",
): Pill {
  const reasons: string[] = [];
  let score = 0;
  if (amz.level === "bad") { score += 3; reasons.push("Amazon dominates listing"); }
  else if (amz.level === "caution") { score += 1; reasons.push("Amazon present"); }
  if (pl.level === "bad") { score += 2; reasons.push("Private-label risk"); }
  else if (pl.level === "caution") { score += 1; reasons.push("Possible PL"); }
  if (totalSellers >= 15) { score += 2; reasons.push(`${totalSellers} sellers`); }
  else if (totalSellers >= 8) { score += 1; reasons.push(`${totalSellers} sellers`); }
  if (bsr != null && bsr > 500000) { score += 1; reasons.push(`Slow BSR #${bsr.toLocaleString()}`); }
  if (score >= 4) return { level: "bad", text: "High", reason: reasons.slice(0,2).join(" · ") };
  if (score >= 2) return { level: "caution", text: "Medium", reason: reasons.slice(0,2).join(" · ") };
  // Null-guard: never silently default to "Low" when we couldn't get a seller count
  // from either the offers list or Keepa. This is the mobile-scan bug — Keepa can
  // return offerCountFBA/FBM null the same way sellers_fba/fbm did.
  if (sellerCountSource === "none") {
    return { level: "unknown", text: "Unknown", reason: "seller count unavailable — verify manually" };
  }
  return { level: "good", text: "Low", reason: reasons.slice(0,2).join(" · ") || "Clean competitive landscape" };
}

function classifySalesVelocity(sales: number | null): Pill & { value: number | null } {
  if (sales == null) return { level: "unknown", text: "—", value: null };
  if (sales >= 30) return { level: "good",    text: `${sales}/mo`, value: sales };
  if (sales >= 5)  return { level: "caution", text: `${sales}/mo`, value: sales };
  return { level: "bad", text: `${sales}/mo`, value: sales };
}

function deriveFinalAction(
  profit: Pill,
  trend: Pill,
  comp: Pill,
  scorePct: number | null,
  ctx: { roi: number | null; profit: number | null; sales: number | null; elig: Pill },
): FinalAction {
  if (profit.level === "unknown") {
    return { action: "Enter cost", cls: "", level: "unknown", emoji: "💲", why: "Add your unit cost so we can evaluate the deal end-to-end." };
  }
  if (profit.level === "bad") {
    return { action: "AVOID", cls: "avoid", level: "bad", emoji: "❌", why: "Profit is too low to justify the buy at the current price." };
  }
  const bad = [trend.level, comp.level].filter(l => l === "bad").length;
  const caution = [trend.level, comp.level].filter(l => l === "caution").length;
  const strong = profit.level === "good" && trend.level === "good" && comp.level === "good" && (scorePct == null || scorePct >= 80);

  const roi = ctx.roi ?? 0;
  const prof = ctx.profit ?? 0;
  const sales = ctx.sales ?? 0;
  const eligOk = ctx.elig.level !== "bad";
  const strongCushion =
    roi >= 50 && prof >= 5 && sales >= 50 && comp.level !== "bad" && eligOk;

  if (bad >= 1) {
    if (strongCushion && comp.level !== "bad" && trend.level === "bad") {
      const approvalNote = ctx.elig.level === "caution" ? " Confirm approval before scaling." : "";
      return {
        action: "BUY CAUTIOUSLY",
        cls: "buy",
        level: "good",
        emoji: "🟢",
        why: `ROI ${roi.toFixed(0)}% on $${prof.toFixed(2)} profit with ~${sales}/mo velocity gives enough cushion to absorb the falling trend — buy a small-to-medium lot and monitor.${approvalNote}`,
      };
    }
    if (profit.level === "good") return { action: "TEST ONLY", cls: "test", level: "caution", emoji: "🟨", why: "Strong current profit, but the market or competition is risky enough that deep inventory exposure is unsafe — buy shallow and monitor." };
    return { action: "AVOID", cls: "avoid", level: "bad", emoji: "❌", why: "Thin profit combined with a risky market or heavy competition — skip this one." };
  }
  if (caution >= 2) {
    if (strongCushion) {
      return { action: "BUY CAUTIOUSLY", cls: "buy", level: "good", emoji: "🟢", why: `ROI ${roi.toFixed(0)}% and ~${sales}/mo velocity outweigh the mixed market/competition signals — buy a measured lot.` };
    }
    return { action: "WATCH", cls: "watch", level: "caution", emoji: "👀", why: "Mixed signals across market and competition — re-check before committing units." };
  }
  if (caution === 1) {
    if (profit.level === "good") return { action: "BUY (Cautious)", cls: "buy", level: "good", emoji: "🟢", why: "Profit is solid and most signals are clean — one risk is worth monitoring before scaling." };
    return { action: "TEST ONLY", cls: "test", level: "caution", emoji: "🟨", why: "Margin is thin and there is one risk flag — small lot only." };
  }
  if (strong) return { action: "STRONG BUY", cls: "buy", level: "good", emoji: "🔥", why: "Profitable today with a stable market, low competition, and high overall confidence — a clean opportunity to scale." };
  if (profit.level === "good") return { action: "BUY", cls: "buy", level: "good", emoji: "✅", why: "Profitable today with a stable market and manageable competition." };
  return { action: "TEST ONLY", cls: "test", level: "caution", emoji: "🟨", why: "Margins are thin even though market and competition are fine — start with a small test." };
}

/**
 * Compliance overlay — applied AFTER deriveFinalAction. Compliance risk is a
 * different class from market/competition risk: it is never counted in the
 * caution/bad tally (that's how the lithium flag was silently dropped in v1).
 * Instead, it prepends a fixed clause and, only when a signal is `yes`/`high`,
 * may downgrade the action tier.
 *
 * Prefix order when multiple fire: IP → Hazmat → base sentence → Prep suffix.
 */
function applyComplianceOverlay(
  base: FinalAction,
  compliance: ComplianceInput | null | undefined,
): { final: FinalAction; flags: string[] } {
  const flags: string[] = [];
  if (!compliance) return { final: base, flags };

  const hazmat = compliance.hazmat ?? "unknown";
  const prep = compliance.prep ?? "unknown";

  let action = base.action;
  let cls = base.cls;
  let level = base.level;
  let emoji = base.emoji;
  let why = base.why;

  const downgradeStrongToCautious = () => {
    if (action === "STRONG BUY" || action === "BUY") {
      action = "BUY (Cautious)";
      cls = "buy";
      level = "good";
      emoji = "🟢";
    }
  };

  const prefixes: string[] = [];


  if (hazmat === "yes") {
    flags.push("hazmat");
    // Only downgrade if IP didn't already downgrade further.
    downgradeStrongToCautious();
    prefixes.push("Hazmat flagged (verify DG classification before shipping)");
  } else if (hazmat === "caution") {
    flags.push("hazmat_caution");
    prefixes.push("Possible hazmat/meltable — confirm before shipping");
  }

  if (prefixes.length) {
    why = `${prefixes.join(" · ")} — ${why}`;
  }

  if (prep === "required") {
    flags.push("prep");
    why = `${why} Prep required (factor prep cost into ROI).`;
  } else if (prep === "caution") {
    flags.push("prep_caution");
    why = `${why} Confirm prep requirements at shipment-plan time.`;
  }

  return { final: { action, cls, level, emoji, why }, flags };
}

function buildExplanation(
  final: FinalAction,
  ctx: { roi: number | null; profit: number | null; sales: number | null; elig: Pill },
  trend: Pill,
  comp: Pill,
  sellerCountUsed: number,
  sellerCountSource: "offers_list" | "keepa_intel" | "none",
  priceBasis: "buy_box" | "sim",
  buyBoxPrice: number | null | undefined,
): string {
  const parts: string[] = [final.why];
  const detail: string[] = [];
  const basisLabel =
    priceBasis === "sim"
      ? "Based on your Sim inputs"
      : buyBoxPrice != null && buyBoxPrice > 0
        ? `Based on Buy Box $${buyBoxPrice.toFixed(2)}`
        : "Based on Buy Box price";
  detail.push(basisLabel);
  if (ctx.roi != null && ctx.profit != null) detail.push(`ROI ${ctx.roi.toFixed(0)}% on $${ctx.profit.toFixed(2)} profit`);
  if (ctx.sales) detail.push(`~${ctx.sales.toLocaleString()} sales/mo`);
  if (trend.reason) detail.push(`${trend.text} market (${trend.reason})`);
  if (comp.text && comp.text !== "Low") {
    const suffix =
      sellerCountSource === "offers_list" && sellerCountUsed > 0
        ? ` (${sellerCountUsed} sellers from offer list)`
        : sellerCountSource === "none"
          ? ""
          : "";
    const label =
      comp.level === "unknown"
        ? "Competition Unknown — seller count unavailable, verify manually"
        : `${comp.text} competition${suffix}`;
    detail.push(label);
  }
  if (ctx.elig.text && ctx.elig.level !== "good") detail.push(ctx.elig.text);
  if (detail.length) parts.push(detail.join(" · "));
  return parts.join(" ");
}

export function computeFinalDecision(input: FinalDecisionInput): FinalDecisionResult {
  const intel = input.intel || {};

  // Resolve profit/ROI basis. Sim override recomputes from user inputs.
  const sim = input.simOverride;
  const simActive = !!sim?.active && sim?.profit != null && sim?.roi != null;
  const priceBasis: "buy_box" | "sim" = simActive ? "sim" : "buy_box";
  const usedProfit = simActive ? (sim!.profit ?? null) : input.profit;
  const usedRoi = simActive ? (sim!.roi ?? null) : input.roi;

  // Seller count — single source of truth.
  let sellerCountSource: "offers_list" | "keepa_intel" | "none" = "none";
  let totalSellers = 0;
  if (input.offerCounts && (input.offerCounts.fba > 0 || input.offerCounts.fbm > 0)) {
    totalSellers = (input.offerCounts.fba ?? 0) + (input.offerCounts.fbm ?? 0);
    sellerCountSource = "offers_list";
  } else if (intel.sellers_fba != null || intel.sellers_fbm != null) {
    totalSellers = (intel.sellers_fba ?? 0) + (intel.sellers_fbm ?? 0);
    if (totalSellers > 0) sellerCountSource = "keepa_intel";
  }

  const elig = classifyEligibility(input.eligibility);
  const amz = classifyAmazonShare(intel.amazon_presence_pct ?? null);
  const pl = classifyPLRisk(intel, totalSellers);
  const sales = estimateMonthlySales(intel);
  const profitPill = classifyProfit(usedRoi, usedProfit, elig.level);
  const trend = classifyTrend(input.swingPct ?? null, input.slopePct ?? null, input.rangeLabel || "3M");
  const comp = classifyCompetition(amz, pl, totalSellers, intel.bsr_current ?? null, sellerCountSource);
  const salesVelocity = classifySalesVelocity(sales);

  // Confidence score
  let score = 0, max = 0;
  max += 25;
  const roiForScore = usedRoi;
  if (roiForScore != null) {
    if (roiForScore >= 50) score += 25;
    else if (roiForScore >= 30) score += 20;
    else if (roiForScore >= 15) score += 10;
    else if (roiForScore >= 0) score += 3;
  }
  const w = (weight: number, level: Level) => { max += weight; if (level === "good") score += weight; else if (level === "caution") score += weight * 0.5; };
  w(20, elig.level);
  w(15, amz.level);
  w(10, pl.level);
  max += 10;
  const bsr = intel.bsr_current ?? null;
  if (bsr != null) { if (bsr <= 10000) score += 10; else if (bsr <= 100000) score += 7; else if (bsr <= 500000) score += 3; }
  max += 10;
  if (sales != null) { if (sales >= 100) score += 10; else if (sales >= 30) score += 7; else if (sales >= 5) score += 3; }
  max += 5;
  if (totalSellers > 0) { if (totalSellers <= 5) score += 5; else if (totalSellers <= 15) score += 3; }
  const scorePct = max > 0 ? (score / max) * 100 : null;

  const baseAction = deriveFinalAction(profitPill, trend, comp, scorePct, { roi: usedRoi, profit: usedProfit, sales, elig });

  // Compliance overlay — never counted in caution/bad tally, always visible.
  const overlaid = applyComplianceOverlay(baseAction, input.compliance ?? null);
  let final = overlaid.final;

  // Sim/BuyBox price-basis prefix on the sentence.
  const basisPrefix = simActive ? "(Sim — your inputs) " : "(Buy Box price) ";
  final = { ...final, why: `${basisPrefix}${final.why}` };

  const confidence = scorePct == null ? "—" : scorePct >= 75 ? "High" : scorePct >= 55 ? "Medium" : "Low";
  const explanation = buildExplanation(
    final,
    { roi: usedRoi, profit: usedProfit, sales, elig },
    trend,
    comp,
    totalSellers,
    sellerCountSource,
    priceBasis,
    input.buyBoxPrice ?? null,
  );

  const simDelta = simActive
    ? {
        bbRoi: input.roi,
        bbProfit: input.profit,
        simRoi: sim!.roi ?? null,
        simProfit: sim!.profit ?? null,
      }
    : undefined;

  return {
    final,
    confidence,
    scorePct,
    profit: profitPill,
    trend,
    competition: comp,
    eligibility: elig,
    salesVelocity,
    explanation,
    complianceFlags: overlaid.flags,
    sellerCountSource,
    sellerCountUsed: totalSellers,
    simDelta,
    priceBasis,
  };
}

/**
 * Helper: map a `useFbaEligibility` stageStatuses array into the compliance
 * shape expected by `computeFinalDecision`. Kept here so both web callers
 * (ProductAnalyzer, MobileScan) stay consistent.
 *
 * NOTE: the second `ipAlertLevel` param was removed 2026-07-06 along with
 * the `ipRisk` overlay branch. See `.lovable/architecture-audit.md` →
 * "IP risk overlay". Add it back only when a real brand-restriction / PL
 * classifier is wired end-to-end.
 */
export function complianceFromStageStatuses(
  stages: Array<{ stage: string; status: string }> | null | undefined,
): ComplianceInput {
  const byStage: Record<string, string> = {};
  for (const s of stages || []) byStage[s.stage] = s.status;

  const hazmatStatus = byStage["hazmat"];
  const hazmat: ComplianceInput["hazmat"] =
    hazmatStatus === "blocked" ? "yes"
    : hazmatStatus === "warn" ? "caution"
    : hazmatStatus === "ok" ? "no"
    : "unknown";

  const prepStatus = byStage["prep"];
  const prep: ComplianceInput["prep"] =
    prepStatus === "blocked" ? "required"
    : prepStatus === "warn" ? "caution"
    : prepStatus === "ok" ? "none"
    : "unknown";

  return { hazmat, prep };
}

