/**
 * Deterministic mapping from engine decision context → big, human-friendly headline.
 *
 * Principle: explain like a human first, then prove like a system.
 *
 * NEVER call an LLM here — these strings must be:
 *  - instant (no async)
 *  - consistent (same input → same output)
 *  - free (no per-event cost)
 *
 * The detailed reasoning blocks (Situation / Decision / Why) remain underneath
 * for power users. This is the headline only.
 */

export type AiInsightTone = "success" | "info" | "warning" | "neutral";

export interface AiInsightHeadline {
  /** Short, bold, human sentence. Keep under ~80 chars. */
  text: string;
  /** Optional one-line subtext for extra context. */
  subtext?: string;
  /** Visual tone — drives color/border. */
  tone: AiInsightTone;
  /** Emoji prefix to make scanning faster. */
  emoji: string;
}

interface HeadlineInput {
  event_type?: string | null;       // bb_loss | raised | constrained | winner | null
  action_type?: string | null;      // price_changed | no_change | blocked_* | ...
  was_bb_owner?: boolean | null;
  was_price_changed?: boolean | null;
  current_price?: number | null;
  target_price?: number | null;
  buy_box_price?: number | null;
  constraints_json?: string[] | null;
}

const fmt = (n: number | null | undefined) =>
  n != null && Number.isFinite(n) ? `$${n.toFixed(2)}` : null;

export function getAiInsightHeadline(input: HeadlineInput): AiInsightHeadline {
  const constraints = input.constraints_json ?? [];
  const hasFloor = constraints.some(
    (c) => c.includes("min_price") || c.includes("effective_floor") || c.includes("universal_floor")
  );
  const hasRoi = constraints.some((c) => c.includes("roi") || c.includes("profit_guard"));
  const hasOscillation = constraints.some((c) => c.includes("oscillation"));
  const hasCooldown = constraints.some((c) => c.includes("cooldown"));
  const hasAnomaly =
    constraints.includes("data_low_confidence") || constraints.includes("market_inconsistent");
  const hasRecovery = constraints.some((c) => c.startsWith("underpriced_recovery"));

  const cur = input.current_price ?? null;
  const tgt = input.target_price ?? null;
  const bb = input.buy_box_price ?? null;
  const moved =
    !!input.was_price_changed && tgt != null && cur != null && Math.abs(tgt - cur) >= 0.005;
  const wentUp = moved && (tgt as number) > (cur as number);

  // ── Underpriced recovery (raise toward market) ───────────────────────────
  if (hasRecovery) {
    const to = fmt(tgt ?? cur);
    return {
      text: to
        ? `Price raised to ${to} to recover lost margin.`
        : "Price raised to recover lost margin.",
      subtext: bb != null ? `You were below the market cluster (Buy Box ${fmt(bb)}).` : undefined,
      tone: "success",
      emoji: "📈",
    };
  }

  // ── Anomaly / low-confidence data ────────────────────────────────────────
  if (hasAnomaly) {
    return {
      text: "Holding — market data looks unreliable right now.",
      subtext: "AI is waiting for cleaner signals before acting.",
      tone: "warning",
      emoji: "⚠️",
    };
  }

  // ── Buy Box lost ─────────────────────────────────────────────────────────
  if (input.event_type === "bb_loss") {
    if (moved) {
      const to = fmt(tgt);
      return {
        text: to
          ? `Price reduced to ${to} to win back the Buy Box.`
          : "Price reduced to win back the Buy Box.",
        subtext: bb != null ? `Competitor undercut to ${fmt(bb)}.` : undefined,
        tone: "info",
        emoji: "🎯",
      };
    }
    if (hasFloor || hasRoi) {
      return {
        text: "Price NOT lowered — protected by your minimum profit rule.",
        subtext: "Matching the competitor would breach your floor.",
        tone: "warning",
        emoji: "🛡️",
      };
    }
    if (hasOscillation || hasCooldown) {
      return {
        text: "Holding — waiting for the market to settle before reacting.",
        tone: "neutral",
        emoji: "⏳",
      };
    }
    return {
      text: "Holding — no safe move available right now.",
      subtext: "All available price moves would breach safety guardrails.",
      tone: "warning",
      emoji: "🛡️",
    };
  }

  // ── Raised ───────────────────────────────────────────────────────────────
  if (input.event_type === "raised") {
    const to = fmt(tgt ?? cur);
    return {
      text: to
        ? `Price increased to ${to} to capture more profit safely.`
        : "Price increased to capture more profit safely.",
      subtext: input.was_bb_owner ? "You own the Buy Box — low-risk margin extraction." : undefined,
      tone: "success",
      emoji: "💰",
    };
  }

  // ── Constrained / blocked ────────────────────────────────────────────────
  if (input.event_type === "constrained") {
    if (hasFloor || hasRoi) {
      return {
        text: "Price NOT lowered — protected by your minimum profit rule.",
        subtext: "AI saw a better price but your safety floor blocked it.",
        tone: "warning",
        emoji: "🛡️",
      };
    }
    if (hasOscillation) {
      return {
        text: "Holding — preventing rapid back-and-forth price swings.",
        tone: "neutral",
        emoji: "⏳",
      };
    }
    if (hasCooldown) {
      return {
        text: "Holding — cooldown window still active.",
        tone: "neutral",
        emoji: "⏳",
      };
    }
    return {
      text: "Price held — safety guardrails blocked the change.",
      tone: "warning",
      emoji: "🛡️",
    };
  }

  // ── Winner with a real move ──────────────────────────────────────────────
  if (moved) {
    const to = fmt(tgt);
    if (wentUp) {
      return {
        text: to
          ? `Price nudged up to ${to} while keeping the Buy Box.`
          : "Price nudged up while keeping the Buy Box.",
        tone: "success",
        emoji: "💰",
      };
    }
    return {
      text: to
        ? `Price micro-adjusted to ${to} to defend the Buy Box.`
        : "Price micro-adjusted to defend the Buy Box.",
      tone: "info",
      emoji: "🎯",
    };
  }

  // ── Winner / monitor / default ───────────────────────────────────────────
  if (input.was_bb_owner) {
    return {
      text: "No change — you already own the Buy Box at the best price.",
      tone: "success",
      emoji: "🏆",
    };
  }

  return {
    text: "Monitoring — no action needed right now.",
    subtext: "AI will react instantly if market conditions change.",
    tone: "neutral",
    emoji: "👀",
  };
}

/** Tailwind classes for each tone — keeps usage consistent across components. */
export const insightToneClasses: Record<AiInsightTone, { box: string; text: string }> = {
  success: {
    box: "border-emerald-500/30 bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  info: {
    box: "border-primary/30 bg-primary/10",
    text: "text-primary",
  },
  warning: {
    box: "border-amber-500/30 bg-amber-500/10",
    text: "text-amber-700 dark:text-amber-300",
  },
  neutral: {
    box: "border-border/60 bg-muted/40",
    text: "text-foreground",
  },
};
