import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  ShieldCheck,
  Hash,
  Layers,
  ShieldAlert,
  Info,
  Loader2,
  ImageIcon,
} from "lucide-react";

export type MatchVerdict =
  | "exact_match"
  | "likely_match"
  | "same_base_product_different_pack"
  | "not_match"
  | null;

export interface MatchEvidence {
  _identifier_confirmed?: boolean;
  _model_mpn_confirmed?: boolean;
  _strong_attribute_alignment?: boolean;
  _exact_match_eligible?: boolean;
  _unsafe_exact_downgraded?: boolean;
  _soft_conflict_downgraded?: boolean;
  _downgrade_reason?: string;
  _soft_conflict_reason?: string;
  _ai_raw_confidence?: number;
  _confidence_cap_applied?: number;
  _conflict_explicit_count?: number;
  _conflict_soft_count?: number;
  // Engine v11 diagnostics
  _engine_version?: number;
  _engine_decision_path?: string;
  _engine_score?: number;
  _engine_reasons?: string[];
  _matched_token?: string | null;
  _matched_identifier_type?: string | null;
  _title_similarity?: number;
  _upgrade_reason?: string | null;
  _ai_fallback_invoked?: boolean;
  _ai_fallback_failed?: string;
  _signals?: Record<string, unknown>;
  _conflicts_detail?: Record<string, boolean>;
  // Image-similarity layer (v12)
  _image_compare?: {
    similarity: number;
    verdict: "strong_match" | "likely_match" | "uncertain" | "likely_different" | "different" | "unavailable";
    phash_similarity: number | null;
    ai_verdict: "same_product" | "same_franchise_diff_item" | "different_product" | null;
    ai_confidence: number | null;
    reason: string;
    used_ai: boolean;
  } | null;
  _image_signal_applied?: "boost_strong" | "boost_light" | "demote_light" | "demote_strong";
  _image_mismatch_warning?: boolean;
  matched_attributes?: string[];
  missing_attributes?: string[];
  conflicts?: string[];
  [k: string]: unknown;
}

const VERDICT_META: Record<
  Exclude<MatchVerdict, null>,
  { label: string; icon: typeof CheckCircle2; tone: string }
> = {
  exact_match: {
    // Default label; overridden at render-time based on verification source
    label: "Exact Match",
    icon: ShieldCheck,
    tone: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
  },
  same_base_product_different_pack: {
    label: "Pack Conversion",
    icon: CheckCircle2,
    tone: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  },
  likely_match: {
    label: "Likely Match",
    icon: AlertTriangle,
    tone: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  },
  not_match: {
    label: "Not Match",
    icon: XCircle,
    tone: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  },
};

const UNVERIFIED_META = {
  label: "Unverified",
  icon: HelpCircle,
  tone: "bg-muted text-muted-foreground border-border",
};

// Identity match has been confirmed (ASIN locked) but the live Amazon price
// hasn't returned yet. We show this instead of "Unverified" so users don't
// confuse a price-fetch delay with a verification failure.
const AWAITING_PRICE_META = {
  label: "Match Pending Price",
  icon: Loader2,
  tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
};

// Identity match succeeded, but Amazon did not return a usable live price.
// This is different from "still fetching" and should not show a spinner.
const PRICE_UNAVAILABLE_META = {
  label: "Match Found · Price Unavailable",
  icon: Info,
  tone: "bg-muted text-muted-foreground border-border",
};

interface Props {
  verdict: MatchVerdict;
  confidence: number | null;
  reason?: string;
  evidence?: MatchEvidence | null;
  size?: "sm" | "xs";
  /** When true, shows admin-only "Why this verdict?" diagnostics panel. */
  isAdmin?: boolean;
  /**
   * True when the row is a confirmed identity match awaiting the live Amazon
   * price (server-side `match_confidence === "needs_price"`). Suppresses the
   * generic "Unverified" pill and shows a pending-price indicator instead.
   */
  awaitingPrice?: boolean;
  /** True when live price lookup completed but Amazon returned no usable price. */
  priceUnavailable?: boolean;
}

export function MatchConfidenceBadge({ verdict, confidence, reason, evidence, size = "xs", isAdmin = false, awaitingPrice = false, priceUnavailable = false }: Props) {
  const baseMeta = verdict
    ? VERDICT_META[verdict]
    : (awaitingPrice ? AWAITING_PRICE_META : priceUnavailable ? PRICE_UNAVAILABLE_META : UNVERIFIED_META);

  // ── Verification source resolution (engine vs AI vs hybrid) ──────────────
  // A match is "engine verified" when the deterministic engine produced the
  // verdict via a hard identifier (UPC/EAN/GTIN) or Brand+MPN dominance and
  // AI fallback was NOT invoked. AI-only verdicts keep the "AI Verified"
  // label so users can see when the engine deferred to AI reasoning.
  const identifierConfirmed = !!evidence?._identifier_confirmed;
  const modelMpnConfirmed = !!evidence?._model_mpn_confirmed;
  const aiFallbackInvoked = !!evidence?._ai_fallback_invoked;
  const decisionPath = String(evidence?._engine_decision_path ?? "");
  const engineDecided =
    decisionPath === "identifier_match" ||
    decisionPath === "mpn_dominance" ||
    decisionPath === "hard_conflict" ||
    decisionPath === "score_floor" ||
    (identifierConfirmed && !aiFallbackInvoked);

  let verificationSource: "engine" | "ai" | "hybrid" | "none" = "none";
  if (verdict) {
    if (aiFallbackInvoked && (identifierConfirmed || modelMpnConfirmed)) verificationSource = "hybrid";
    else if (aiFallbackInvoked) verificationSource = "ai";
    else if (engineDecided) verificationSource = "engine";
    else verificationSource = "engine";
  }

  // Override exact_match label by source
  let label = baseMeta.label;
  if (verdict === "exact_match") {
    if (verificationSource === "engine") {
      label = identifierConfirmed ? "Exact Match · Identifier Verified" : "Exact Match · Engine Verified";
    } else if (verificationSource === "hybrid") {
      label = "Exact Match · Engine + AI";
    } else if (verificationSource === "ai") {
      label = "AI Verified";
    }
  }
  const meta = { ...baseMeta, label };
  const Icon = meta.icon;

  // Confidence display: for engine identifier-based matches, boost to 95-99
  // since the verdict was proven by a hard identifier — do not let AI's
  // softer raw confidence (often capped ~92%) under-represent the strength
  // of a deterministic match.
  let displayConfidence = confidence;
  if (verdict === "exact_match" && verificationSource === "engine") {
    if (identifierConfirmed) displayConfidence = 99;
    else if (modelMpnConfirmed) displayConfidence = 97;
    else if (displayConfidence != null) displayConfidence = Math.max(displayConfidence, 95);
  }
  const pct = displayConfidence != null && Number.isFinite(displayConfidence) ? Math.round(displayConfidence) : null;

  const textSize = size === "sm" ? "text-xs" : "text-[10px]";
  const padding = size === "sm" ? "px-2 py-0.5" : "px-2 py-0.5";

  return (
    <div className="inline-flex items-center gap-1">
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`inline-flex items-center gap-1 font-medium rounded border ${meta.tone} ${textSize} ${padding}`}
            >
              <Icon className="h-3 w-3" />
              <span>{meta.label}</span>
              {pct != null && verdict && (
                <span className="opacity-80 font-semibold ml-0.5">
                  · Confidence {pct}%
                </span>
              )}
              {verdict === "exact_match" && (
                <span className="opacity-70 ml-0.5 text-[9px] uppercase tracking-wide">
                  · {verificationSource === "engine" ? "Engine" : verificationSource === "hybrid" ? "Hybrid" : "AI"}
                </span>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs space-y-2">
            {reason && <p className="text-xs leading-relaxed">{reason}</p>}
            <ReasonChips evidence={evidence} verdict={verdict} />
            {evidence?._ai_raw_confidence != null && evidence._ai_raw_confidence !== confidence && (
              <p className="text-[10px] text-muted-foreground">
                Raw AI confidence: {Math.round(Number(evidence._ai_raw_confidence))}% (capped at{" "}
                {evidence._confidence_cap_applied ?? pct}%)
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {isAdmin && evidence && (
        <EngineDiagnosticsPopover evidence={evidence} verdict={verdict} reason={reason} />
      )}
    </div>
  );
}

interface ChipsProps {
  evidence?: MatchEvidence | null;
  verdict: MatchVerdict;
}

export function ReasonChips({ evidence, verdict }: ChipsProps) {
  if (!evidence) return null;
  const chips: { label: string; tone: string; icon: typeof CheckCircle2 }[] = [];

  if (evidence._identifier_confirmed) {
    chips.push({
      label: "UPC/EAN confirmed",
      tone: "border-green-500/40 text-green-700 dark:text-green-400 bg-green-500/5",
      icon: ShieldCheck,
    });
  }
  if (evidence._model_mpn_confirmed) {
    chips.push({
      label: "Model/MPN match",
      tone: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/5",
      icon: Hash,
    });
  }
  if (evidence._strong_attribute_alignment) {
    chips.push({
      label: "Strong attribute alignment",
      tone: "border-sky-500/40 text-sky-700 dark:text-sky-400 bg-sky-500/5",
      icon: Layers,
    });
  }
  if (evidence._unsafe_exact_downgraded) {
    chips.push({
      label: "Downgraded from AI exact",
      tone: "border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-500/5",
      icon: ShieldAlert,
    });
  }
  if (evidence._soft_conflict_downgraded) {
    chips.push({
      label: "Soft conflict — review",
      tone: "border-orange-500/40 text-orange-700 dark:text-orange-400 bg-orange-500/5",
      icon: AlertTriangle,
    });
  }
  if (
    verdict === "likely_match" &&
    !evidence._identifier_confirmed &&
    !evidence._model_mpn_confirmed &&
    !evidence._strong_attribute_alignment &&
    !evidence._unsafe_exact_downgraded &&
    !evidence._soft_conflict_downgraded &&
    !evidence._image_compare
  ) {
    chips.push({
      label: "AI reasoning only",
      tone: "border-muted-foreground/40 text-muted-foreground bg-muted/30",
      icon: HelpCircle,
    });
  }

  // ── Image similarity chip (v12) ──────────────────────────────────────────
  const img = evidence._image_compare;
  if (img && img.verdict !== "unavailable") {
    const pct = Math.round((img.similarity ?? 0) * 100);
    if (img.verdict === "strong_match") {
      chips.push({
        label: `Image match ${pct}%`,
        tone: "border-green-500/40 text-green-700 dark:text-green-400 bg-green-500/5",
        icon: ImageIcon,
      });
    } else if (img.verdict === "likely_match") {
      chips.push({
        label: `Image similar ${pct}%`,
        tone: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/5",
        icon: ImageIcon,
      });
    } else if (img.verdict === "likely_different") {
      chips.push({
        label: `Image differs ${pct}%`,
        tone: "border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-500/5",
        icon: ImageIcon,
      });
    } else if (img.verdict === "different") {
      chips.push({
        label: `Image mismatch ${pct}%`,
        tone: "border-red-500/40 text-red-700 dark:text-red-400 bg-red-500/5",
        icon: ImageIcon,
      });
    }
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <Badge
          key={c.label}
          variant="outline"
          className={`text-[10px] inline-flex items-center gap-1 ${c.tone}`}
        >
          <c.icon className="h-2.5 w-2.5" />
          {c.label}
        </Badge>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin-only engine diagnostics popover ("Why this verdict?")
// ─────────────────────────────────────────────────────────────────────────────

interface DiagProps {
  evidence: MatchEvidence;
  verdict: MatchVerdict;
  reason?: string;
}

function EngineDiagnosticsPopover({ evidence, verdict, reason }: DiagProps) {
  const [open, setOpen] = useState(false);
  const ev = evidence;
  const path = ev._engine_decision_path ?? "(no engine output)";
  const score = ev._engine_score;
  const engineReasons = Array.isArray(ev._engine_reasons) ? ev._engine_reasons : [];
  const matched = Array.isArray(ev.matched_attributes) ? ev.matched_attributes : [];
  const missing = Array.isArray(ev.missing_attributes) ? ev.missing_attributes : [];
  const conflicts = Array.isArray(ev.conflicts) ? ev.conflicts : [];
  const conflictsDetail = (ev._conflicts_detail ?? {}) as Record<string, boolean>;
  const signals = (ev._signals ?? {}) as Record<string, unknown>;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center h-5 w-5 rounded border border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Admin: why this verdict?"
          aria-label="Show engine diagnostics"
        >
          <Info className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 max-h-[500px] overflow-y-auto p-3 text-xs space-y-3" align="end">
        <div className="space-y-1">
          <div className="font-semibold text-sm">Engine Diagnostics</div>
          <div className="text-muted-foreground">
            Verdict: <span className="font-mono">{verdict ?? "(none)"}</span>
          </div>
          {reason && <div className="text-muted-foreground italic">{reason}</div>}
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <DiagRow label="Engine version" value={ev._engine_version ?? "—"} />
          <DiagRow label="Decision path" value={path} mono />
          <DiagRow label="Score" value={score != null ? `${score}/100` : "—"} />
          <DiagRow label="AI fallback" value={ev._ai_fallback_invoked ? "Yes" : "No"} />
          {ev._ai_fallback_failed && (
            <DiagRow label="AI failure" value={String(ev._ai_fallback_failed)} mono />
          )}
          {ev._matched_token && (
            <DiagRow
              label={`Matched ${ev._matched_identifier_type ?? "token"}`}
              value={String(ev._matched_token)}
              mono
            />
          )}
          {ev._title_similarity != null && (
            <DiagRow label="Title similarity" value={`${Math.round(Number(ev._title_similarity) * 100)}%`} />
          )}
        </div>

        {Object.keys(signals).length > 0 && (
          <DiagSection title="Signals">
            <SignalGrid signals={signals} />
          </DiagSection>
        )}

        {matched.length > 0 && (
          <DiagSection title="Matched attributes" tone="green">
            <ul className="space-y-0.5">
              {matched.map((m, i) => <li key={i} className="font-mono text-[11px]">✓ {m}</li>)}
            </ul>
          </DiagSection>
        )}

        {missing.length > 0 && (
          <DiagSection title="Missing attributes" tone="muted">
            <ul className="space-y-0.5">
              {missing.map((m, i) => <li key={i} className="font-mono text-[11px]">— {m}</li>)}
            </ul>
          </DiagSection>
        )}

        {(conflicts.length > 0 || Object.values(conflictsDetail).some(Boolean)) && (
          <DiagSection title="Conflicts" tone="red">
            {conflicts.length > 0 && (
              <ul className="space-y-0.5 mb-1">
                {conflicts.map((c, i) => <li key={i} className="font-mono text-[11px]">✗ {c}</li>)}
              </ul>
            )}
            {Object.entries(conflictsDetail).filter(([_, v]) => v).map(([k]) => (
              <Badge key={k} variant="outline" className="text-[10px] mr-1 border-red-500/40 text-red-700 dark:text-red-400 bg-red-500/5">
                {k.replace(/_/g, " ")}
              </Badge>
            ))}
          </DiagSection>
        )}

        {engineReasons.length > 0 && (
          <DiagSection title="Score breakdown">
            <ul className="space-y-0.5">
              {engineReasons.map((r, i) => <li key={i} className="text-[11px]">{r}</li>)}
            </ul>
          </DiagSection>
        )}

        {(ev._upgrade_reason || ev._downgrade_reason) && (
          <DiagSection title="Verdict driver">
            {ev._upgrade_reason && (
              <p className="text-[11px] text-green-700 dark:text-green-400">↑ {ev._upgrade_reason}</p>
            )}
            {ev._downgrade_reason && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">↓ {ev._downgrade_reason}</p>
            )}
          </DiagSection>
        )}
      </PopoverContent>
    </Popover>
  );
}

function DiagRow({ label, value, mono }: { label: string; value: string | number; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={`text-[11px] ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function DiagSection({ title, children, tone = "default" }: { title: string; children: React.ReactNode; tone?: "default" | "green" | "red" | "muted" }) {
  const toneCls = tone === "green" ? "text-green-700 dark:text-green-400"
    : tone === "red" ? "text-red-700 dark:text-red-400"
    : tone === "muted" ? "text-muted-foreground"
    : "text-foreground";
  return (
    <div className="border-t border-border pt-2">
      <div className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${toneCls}`}>{title}</div>
      {children}
    </div>
  );
}

function SignalGrid({ signals }: { signals: Record<string, unknown> }) {
  const entries = Object.entries(signals).filter(([_, v]) => v !== null && v !== undefined);
  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
      {entries.map(([k, v]) => {
        const display = typeof v === "boolean" ? (v ? "✓" : "✗") : String(v);
        const tone = typeof v === "boolean"
          ? (v ? "text-green-700 dark:text-green-400" : "text-muted-foreground")
          : "";
        return (
          <div key={k} className="flex justify-between gap-1 text-[10px]">
            <span className="text-muted-foreground truncate">{k.replace(/_/g, " ")}</span>
            <span className={`font-mono ${tone}`}>{display}</span>
          </div>
        );
      })}
    </div>
  );
}
