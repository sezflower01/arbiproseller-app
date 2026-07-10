/**
 * Translates technical repricer reason strings into simple, human-friendly language.
 * Written for non-technical users who just want to understand what happened.
 */

// ── Individual token → simple human mapping ──────────────────────
const TOKEN_MAP: Record<string, string> = {
  // Buy Box ownership
  "above_bb_not_owner_no_raise": "Your price is higher than the Buy Box — can't raise further right now",
  "above_bb_not_owner": "Your price is above the Buy Box — you're not winning it",
  "below_bb_owner": "You're winning the Buy Box at a lower price",
  "bb_owner_hold": "You're winning the Buy Box — keeping your price steady",
  "bb_owner_raise": "You're winning the Buy Box — raising price to earn more",
  "bb_owner_smart_raise": "You're winning — slowly raising your price for more profit",
  "fbm_gap_recapture_raise": "Lower competitor gone — snapping price up to next seller",
  "fbm_gap_recapture": "Lower competitor gone — recapturing margin immediately",
  "fbm_offers_ignored_fba_only_rule": "FBM offers ignored — your rule competes against FBA sellers only",
  "fbm_owns_buybox_competing": "FBM owns the Buy Box — competing against FBM offers",
  "fbm_mode_explicit_anchor": "FBM offer used as anchor — your rule is set to compete with FBM sellers",
  "cluster_override_skipped_user_fbm_mode": "Cluster outlier filter skipped — you chose to compete with FBM sellers",
  "not_bb_owner": "You're not winning the Buy Box right now",
  "bb_owner": "You're winning the Buy Box",
  "no_bb_data": "No Buy Box info available right now",
  "bb_untrusted": "Buy Box info looks unreliable — using the next best price instead",
  "bb_missing": "Buy Box price is not available",
  "bb_stale": "Buy Box info is outdated — may not reflect the current market",

  // Intelligence multipliers
  "intel_1.25x": "Added a small competitive buffer to your price",
  "intel_1.5x": "Added a moderate competitive buffer to your price",
  "intel_2x": "Added a large competitive buffer to your price",

  // Profit protection
  "profit_guard_warn": "Warning — your price is getting close to losing money",
  "profit_guard_block": "Blocked — this price would make too little profit",
  "profit_guard": "Checked that you'd still make a profit at this price",
  "profit_floor": "Price was adjusted up to keep you profitable",

  // Min / Max limits
  "effective_floor": "Price can't go any lower — it's at your minimum",
  "floor_block": "Blocked — price would go below your minimum",
  "floor_clamp": "Price was raised to your minimum",
  "ceiling_clamp": "Price was lowered to your maximum",
  "constrained_by_floor": "Can't go lower — already at your minimum price",
  "constrained_by_ceiling": "Can't go higher — already at your maximum price",
  "min_floor": "Hit the absolute lowest price allowed",
  "max_ceiling": "Hit the absolute highest price allowed",

  // Smart Raise (profit extraction)
  "smart_raise": "Raising price a little to earn more profit",
  "smart_raise_triggered": "Started raising your price to maximize profit",
  "smart_raise_skipped": "Didn't raise price — conditions aren't right",
  "smart_raise_capped": "Wanted to raise higher, but hit your max price",

  // Only seller
  "monopoly": "You're the only seller — set to the best profitable price",
  "monopoly_mode": "No competition — you're the only seller",
  "monopoly_skipped": "Other sellers exist — normal competition applies",
  "monopoly_hold": "You're the only seller — holding at best price",

  // Price stability
  "oscillation_detected": "Prices are bouncing back and forth — slowing down to avoid a price war",
  "price_war": "Price war detected — protecting your minimum price",
  "volatile": "Market is unstable — being cautious with price changes",
  "stable": "Market is calm — competing normally",

  // Action types
  "price_change": "Price was updated",
  "no_change": "No change needed",
  "skip": "Skipped this product",
  "error": "Something went wrong during repricing",

  // Safety limits
  "max_step_guard": "Price change was limited — can't jump too much at once",
  "daily_change_guard": "Too many price changes today — waiting until tomorrow",
  "global_floor_guard": "Hit the absolute minimum safety price",
  "cost_guard": "Price must stay above what you paid for it",
  "step_guard": "Price change was kept small for safety",

  // Method
  "PATCH": "Updated via direct API call",
  "FEED": "Updated via bulk feed",

  // Other
  "no_competitors": "No other sellers found — you may be the only one",
  "no_eligible_offers": "No real competitors after filtering out bad sellers",
  "filtered_out": "Competitor was ignored (unreliable seller)",
  "too_small": "Price difference too tiny to bother updating (less than 1¢)",
  "price_change_too_small": "Price difference too tiny to bother updating (less than 1¢)",
  "MIN_PRICE_SUGGESTION": "Suggesting a new minimum price based on the market",
  "min_price_suggestion": "Suggesting a new minimum price based on the market",
  "auto_floor_lower": "Automatically lowered your minimum to stay competitive",
  "soft_floor": "Using a flexible minimum based on current market prices",
  "held_at_floor": "Holding at your minimum price — can't go lower",
  "stale_bb_override": "Buy Box info is old — overriding to use current market data",

  // Oscillation specific
  "oscillation_guard": "Oscillation guard activated — pausing to avoid a price war",
  "oscillation_paused_after_bb_loss": "You lost the Buy Box, but competitors are rapidly changing prices. Holding steady to avoid joining a race to the bottom",
  "rapid_price_instability": "Multiple competitors are changing prices very quickly — market is unstable",

  // Cluster match protection
  "cluster_match_override": "Cluster protection — matching instead of undercutting (BB is rotating among similar prices)",
  "cluster_rotating_bb_protection": "Cluster protection — matching price to preserve margin in a rotating Buy Box",

  // BB eligibility bypass
  "bb_eligibility_bypass": "Not Buy Box eligible — but aggressive/liquidation strategy is forcing controlled price descent instead of holding",
};

// ── Full-sentence pattern matching ───────────────────────────────
const PATTERN_TRANSLATIONS: [RegExp, string][] = [
  [/price change too small.*<\$?0\.01/i, "Price difference too tiny to update (less than 1¢)"],
  [/constrained_by:\s*(.+)/i, "Limited by: $1"],
  [/clamped to (?:min|floor)/i, "Adjusted up to your minimum price"],
  [/clamped to (?:max|ceiling)/i, "Adjusted down to your maximum price"],
  [/smart raise.*\$?([\d.]+)\s*(?:→|->)\s*\$?([\d.]+)/i, "Raised price from $$1 to $$2 for more profit"],
  [/monopoly.*hold/i, "You're the only seller — holding at best price"],
  [/bb owner.*hold/i, "Winning the Buy Box — keeping your price steady"],
  [/no fba competitors/i, "No FBA competition — you have a pricing advantage"],
  [/below effective floor/i, "Can't go that low — it's below your minimum"],
  [/above effective ceiling/i, "Can't go that high — it's above your maximum"],
  [/profit guard blocked/i, "Blocked — you'd lose money at that price"],
  [/step.*guard.*(\d+)%/i, "Limited to a $1% price change for safety"],
  [/daily.*limit.*reached/i, "Daily update limit reached — trying again tomorrow"],
  [/oscillat/i, "Prices are bouncing — slowing down to avoid a price war"],
  [/price war/i, "Price war detected — protecting your minimum"],
  [/stock-?gated.*avail\s*=\s*0/i, "Out of stock — not changing price until inventory returns"],
  [/no safe recovery target/i, "No safe price to recover to — holding current price"],
  [/blocked lower/i, "Blocked from going lower — protecting your profit"],
  [/keeping \$?([\d.]+)/i, "Keeping price at $$1"],
  [/oscillation_paused_after_bb_loss/i, "You lost the Buy Box, but competitors are rapidly changing prices — holding steady to avoid a price war"],
  [/market_stable/i, "Market is stable — no price change needed right now"],
];

/**
 * Translate a single technical token/tag into human language.
 */
function translateToken(token: string): string {
  const clean = token.trim().toLowerCase();
  return TOKEN_MAP[clean] || formatUnknownToken(clean);
}

/**
 * Make unknown tokens readable by converting underscores to spaces
 * and capitalizing.
 */
function formatUnknownToken(token: string): string {
  return token
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Translate a full reason string into simple, human-readable language.
 */
export function translateRepricerReason(reason: string | null | undefined): string {
  if (!reason || reason.trim() === "") return "No reason recorded";

  const original = reason.trim();

  // 1. Try full-sentence pattern matches first
  for (const [pattern, translation] of PATTERN_TRANSLATIONS) {
    if (pattern.test(original)) {
      return original.replace(pattern, translation);
    }
  }

  // 2. Extract bracketed constraint list: [constrained_by: a, b, c]
  const bracketMatch = original.match(/\[([^\]]+)\]/);
  const mainText = original.replace(/\[.*\]/, "").trim();

  const parts: string[] = [];

  // Translate the main text before brackets
  if (mainText) {
    let mainTranslated = false;
    for (const [pattern, translation] of PATTERN_TRANSLATIONS) {
      if (pattern.test(mainText)) {
        parts.push(mainText.replace(pattern, translation));
        mainTranslated = true;
        break;
      }
    }
    if (!mainTranslated) {
      const mainLower = mainText.toLowerCase().replace(/[^a-z0-9_.]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
      if (TOKEN_MAP[mainLower]) {
        parts.push(TOKEN_MAP[mainLower]);
      } else {
        parts.push(mainText.replace(/[_]/g, " ").replace(/\s+/g, " "));
      }
    }
  }

  // Translate bracket contents
  if (bracketMatch) {
    const bracketContent = bracketMatch[1];
    const cleaned = bracketContent.replace(/^constrained_by:\s*/i, "");
    const tokens = cleaned.split(",").map((t) => t.trim()).filter(Boolean);
    const translated = tokens.map(translateToken);

    if (translated.length > 0) {
      parts.push("Why: " + translated.join(" · "));
    }
  }

  return parts.join("\n") || original;
}

/**
 * Get a short one-line summary suitable for table cells.
 */
export function translateRepricerReasonShort(reason: string | null | undefined): string {
  const full = translateRepricerReason(reason);
  const firstLine = full.split("\n")[0];
  return firstLine.length > 120 ? firstLine.slice(0, 117) + "…" : firstLine;
}

/**
 * Translate individual guard/constraint badges into friendly labels.
 */
export function translateGuardBadge(guard: string): string {
  return TOKEN_MAP[guard.toLowerCase()] || formatUnknownToken(guard);
}

// ── Narrative builder: creates a full plain-English story ────────

interface NarrativeInput {
  action_type: string;
  reason: string | null;
  old_price: number | null;
  new_price: number | null;
  intended_price: number | null;
  success: boolean | null;
  error_message: string | null;
  intelligence_factors: any;
  rule_name: string | null;
  overlay_tag: string | null;
  old_min_price: number | null;
  old_max_price: number | null;
  effective_floor_cents: number | null;
}

function fmt(v: number | null | undefined): string {
  if (v == null) return "unknown";
  return `$${Number(v).toFixed(2)}`;
}

/**
 * Build a comprehensive, plain-English narrative explaining what happened,
 * why, and what the outcome was. Designed for non-technical Amazon sellers.
 */
export function buildNarrative(input: NarrativeInput): string {
  const lines: string[] = [];
  const intel = input.intelligence_factors || {};
  const trace = intel?.price_trace || {};
  const posProof = intel?.position_proof || {};
  const profitGuard = intel?.profit_guard || {};
  const summary = intel?.intelligence_summary || {};
  const guards = intel?.guards_applied || [];
  const reasonCodes = intel?.reason_codes || {};

  const delta = input.new_price != null && input.old_price != null
    ? input.new_price - input.old_price
    : null;

  // ── 1. What happened (outcome) ──────────────────────────────
  if (input.action_type === "oscillation_guard" || /oscillation/i.test(input.reason || "")) {
    lines.push("⏸️ The repricer paused — it detected a price war and is waiting for the market to calm down before making a move.");
    const score = extractScore(input.reason);
    if (score != null) {
      lines.push(`The instability score is ${score}/100. ${score >= 80 ? "This is very high — competitors are aggressively changing prices." : score >= 50 ? "Moderately unstable — several competitors are adjusting prices." : "Some price movement detected."}`);
    }
    const flags = extractFlags(input.reason);
    if (flags.length > 0) {
      const flagExplanations = flags.map(explainFlag).filter(Boolean);
      if (flagExplanations.length > 0) {
        lines.push("Signals detected: " + flagExplanations.join(". ") + ".");
      }
    }
    if (/bb_loss/i.test(input.reason || "")) {
      lines.push("You lost the Buy Box, but instead of chasing the price down, the system is holding to protect your profit margin.");
    }
    lines.push("Once competitors stop changing prices, the repricer will resume competing normally.");
  } else if (input.action_type === "price_change" && delta != null) {
    if (Math.abs(delta) < 0.005) {
      lines.push("✋ No meaningful price change — the difference was less than 1¢, so it was treated as a hold.");
    } else if (delta < 0) {
      lines.push(`📉 Price was lowered from ${fmt(input.old_price)} to ${fmt(input.new_price)} (${Math.abs(delta).toFixed(2)} decrease).`);
    } else {
      lines.push(`📈 Price was raised from ${fmt(input.old_price)} to ${fmt(input.new_price)} (+$${delta.toFixed(2)} increase).`);
    }
  } else if (input.action_type === "no_change") {
    lines.push("✋ No price change was made — the current price is already the best option right now.");
  } else if (input.action_type === "skip") {
    lines.push("⏭️ This product was skipped in this repricing cycle.");
  } else if (input.action_type === "error") {
    lines.push("❌ Something went wrong during repricing.");
    if (input.error_message) {
      lines.push(`Error: ${input.error_message}`);
    }
  } else {
    lines.push(translateRepricerReason(input.reason));
  }

  // ── 2. Buy Box situation ─────────────────────────────────────
  const bbPrice = trace.buybox_price;
  const isBBOwner = posProof.buy_box_owner_is_me;
  if (isBBOwner === true) {
    lines.push(`🏆 You are winning the Buy Box${bbPrice ? ` at ${fmt(bbPrice)}` : ""}.`);
  } else if (isBBOwner === false) {
    lines.push(`⚠️ You are NOT winning the Buy Box${bbPrice ? ` — the current Buy Box price is ${fmt(bbPrice)}` : ""}.`);
    if (input.old_price != null && bbPrice != null) {
      const gap = input.old_price - bbPrice;
      if (gap > 0) {
        lines.push(`Your price is $${gap.toFixed(2)} higher than the Buy Box winner.`);
      }
    }
  }

  // ── 3. Competition landscape ─────────────────────────────────
  const compCount = posProof.competitor_count_filtered ?? summary.fba_competitors;
  const lowestFba = trace.lowest_fba;
  const lowestOverall = trace.lowest_overall;

  if (compCount === 0 || compCount === "0") {
    lines.push("🔵 No competitors found — you may be the only seller on this listing.");
  } else if (compCount != null) {
    lines.push(`👥 There ${compCount === 1 ? "is 1 competitor" : `are ${compCount} competitors`} on this listing.`);
  }
  if (lowestFba != null) {
    lines.push(`Lowest FBA offer: ${fmt(lowestFba)}.`);
  }
  if (lowestOverall != null && lowestOverall !== lowestFba) {
    lines.push(`Lowest overall offer (including FBM): ${fmt(lowestOverall)}.`);
  }

  // ── 4. Why: constraints and guards ───────────────────────────
  if (guards.length > 0) {
    const guardExplanations = guards.map((g: string) => {
      const translated = TOKEN_MAP[g.toLowerCase()];
      return translated || formatUnknownToken(g);
    });
    lines.push("🛡️ Safety checks applied: " + guardExplanations.join(" · "));
  }

  // ── 5. Profit guard details ──────────────────────────────────
  if (profitGuard.blocked === true) {
    lines.push(`🚫 Profit protection blocked this price — you would lose money. Your unit cost is ${fmt(profitGuard.unit_cost)} and estimated fees are ${fmt(profitGuard.estimated_fees)}.`);
  } else if (profitGuard.profit_floor_price != null) {
    lines.push(`💰 Profit floor: ${fmt(profitGuard.profit_floor_price)} — the lowest price where you still make a profit.`);
  }

  // ── 6. Price boundaries ──────────────────────────────────────
  if (input.old_min_price != null || input.old_max_price != null || input.effective_floor_cents != null) {
    const floorPrice = input.effective_floor_cents != null ? input.effective_floor_cents / 100 : input.old_min_price;
    const parts: string[] = [];
    if (floorPrice != null) parts.push(`min: ${fmt(floorPrice)}`);
    if (input.old_max_price != null) parts.push(`max: ${fmt(input.old_max_price)}`);
    if (parts.length > 0) {
      lines.push(`📏 Your price boundaries: ${parts.join(", ")}.`);
    }
  }

  // ── 7. Strategy context ──────────────────────────────────────
  if (trace.anchor_source || reasonCodes.anchor_source) {
    const anchor = trace.anchor_source || reasonCodes.anchor_source;
    const anchorMap: Record<string, string> = {
      smart: "the AI-recommended best price",
      buybox: "the current Buy Box price",
      lowest_fba: "the lowest FBA competitor",
      lowest_offer: "the lowest overall offer",
    };
    const anchorText = anchorMap[anchor?.toLowerCase()] || anchor;
    lines.push(`🎯 Strategy anchored to: ${anchorText}.`);
  }

  if (trace.mode) {
    const modeMap: Record<string, string> = {
      aggressive: "Competing aggressively — prioritizing Buy Box wins over margin",
      balanced: "Balanced approach — seeking Buy Box wins while protecting profit",
      conservative: "Conservative mode — prioritizing profit protection",
      safe: "Safe mode — minimal price changes to avoid risks",
      war: "War mode — holding steady to avoid a race to the bottom",
    };
    const modeText = modeMap[trace.mode?.toLowerCase()] || trace.mode;
    lines.push(`⚙️ Mode: ${modeText}.`);
  }

  // ── 8. Sales velocity context ────────────────────────────────
  if (summary.velocity != null || summary.days_of_stock != null) {
    const velParts: string[] = [];
    if (summary.velocity != null) {
      velParts.push(summary.velocity > 3 ? "selling well" : summary.velocity > 1 ? "moderate sales" : "slow sales");
    }
    if (summary.days_of_stock != null) {
      velParts.push(`${summary.days_of_stock} days of stock remaining`);
    }
    if (velParts.length > 0) {
      lines.push(`📊 ${velParts.join(", ")}.`);
    }
  }

  // ── 9. BB win rate context ───────────────────────────────────
  if (summary.bb_win_rate != null) {
    // bb_win_rate may arrive as 0-1 fraction OR 0-100 percentage; normalize
    const raw = Number(summary.bb_win_rate);
    const pct = raw > 1 ? raw : raw * 100;
    const display = Math.min(pct, 100).toFixed(0);
    lines.push(`📈 Buy Box win rate: ${display}%${summary.bb_loss_streak ? ` (${summary.bb_loss_streak} consecutive losses)` : ""}.`);
  }

  // ── 10. Intended vs submitted vs accepted ────────────────────
  if (input.intended_price != null && input.new_price != null && Math.abs(input.intended_price - input.new_price) > 0.005) {
    lines.push(`ℹ️ The repricer wanted to set ${fmt(input.intended_price)} but the final price was adjusted to ${fmt(input.new_price)} after safety checks.`);
  }

  // ── 11. Error fallback ───────────────────────────────────────
  if (input.success === false && input.error_message && !lines.some(l => l.includes("Error"))) {
    lines.push(`❌ Error: ${input.error_message}`);
  }

  return lines.join("\n\n");
}

// ── Helpers ──────────────────────────────────────────────────────

function extractScore(reason: string | null): number | null {
  if (!reason) return null;
  const m = reason.match(/score:\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function extractFlags(reason: string | null): string[] {
  if (!reason) return [];
  const m = reason.match(/flags:\s*([A-Z_,\s]+)/i);
  if (!m) return [];
  return m[1].split(",").map(f => f.trim()).filter(Boolean);
}

function explainFlag(flag: string): string {
  const map: Record<string, string> = {
    OSCILLATION_DETECTED: "Price bouncing detected between competitors",
    RAPID_PRICE_INSTABILITY: "Multiple rapid price changes in a short time",
    WAR_GUARD: "Price war protection is active",
    BB_LOSS_STREAK: "You've lost the Buy Box multiple times in a row",
    HIGH_CHURN: "Competitors are frequently changing their prices",
    REVERSAL_DETECTED: "A competitor reversed a recent price change",
  };
  return map[flag.toUpperCase()] || formatUnknownToken(flag);
}
