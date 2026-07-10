import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, RefreshCw, ExternalLink, Bookmark, BookmarkCheck, Trophy,
  AlertTriangle, ShieldQuestion, Lightbulb, ShieldCheck,
} from "lucide-react";
import {
  Candidate, computeMargin, fmtPrice, marginGuardLabel,
  RESOLUTION_LABELS, toneClass, bestCandidateWarnings,
  IdentityForScoring, BestCandidateGate, DEFAULT_GATE,
  noReliableSourceReasons, noReliableSourceSuggestions,
  effectiveMatchScore, domainTier, domainTierLabel,
  TrustContext, EMPTY_TRUST_CONTEXT, isUserTrusted, effectivePriceForCandidate,
  SupplierContext, EMPTY_SUPPLIER_CONTEXT, findSupplierForCandidate,
  supplierBadgeLabel, supplierBadgeTone, supplierBoostBreakdown,
} from "./shared";
import { useLiveRoi } from "./useLiveRoi";

interface Props {
  best: Candidate | null;
  amazonPrice: number | null;
  candidates?: Candidate[];
  identity?: IdentityForScoring;
  gate?: BestCandidateGate;
  trust?: TrustContext;
  suppliers?: SupplierContext;
  saved: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onSave: () => void;
  onUnsave: () => void;
}

export default function BestCandidateCard({
  best, amazonPrice, candidates = [], identity = {}, gate = DEFAULT_GATE,
  trust = EMPTY_TRUST_CONTEXT, suppliers = EMPTY_SUPPLIER_CONTEXT,
  saved, refreshing, onRefresh, onSave, onUnsave,
}: Props) {
  const id = { ...identity, amazonPrice: identity.amazonPrice ?? amazonPrice };

  // Live ROI for the Best Candidate — calls SAME edge function as Created Listings/RoiCalculator.
  // Returns live Amazon price + REAL Amazon SP-API fees (referral + FBA + closing).
  // Hook must be called unconditionally (Rules of Hooks); we pass null when no best.
  const bestEffective = best ? effectivePriceForCandidate(best, trust) : null;
  const liveRoi = useLiveRoi(
    best?.asin ?? null,
    bestEffective?.price ?? null,
    "US",
  );

  // ─── Empty state: no candidate passed the gate ───
  if (!best) {
    const hasAnyExtracted = candidates.some(
      (c) => (c.current_price != null && c.current_price > 0 && c.final_resolution === "price_extracted")
        || trust.manualCosts.has(c.source_url)
    );
    const reasons = hasAnyExtracted ? noReliableSourceReasons(candidates, id, gate, trust) : [];
    const suggestions = hasAnyExtracted ? noReliableSourceSuggestions(candidates, id, gate, trust) : [];
    return (
      <Card className="p-5 bg-card/50 backdrop-blur border-amber-500/30 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <ShieldQuestion className="h-4 w-4 text-amber-300" />
          <h2 className="text-sm font-semibold text-amber-200">
            {hasAnyExtracted ? "No reliable source found" : "No best candidate yet"}
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">
          {hasAnyExtracted
            ? "Extracted prices exist, but none meet the trust thresholds. Visible rows below are shown for inspection only — verify product, pack count, and size before buying."
            : "Waiting for a successful price extraction. Try refreshing blocked candidates or adjusting the identity overrides."}
        </p>
        {reasons.length > 0 && (
          <div className="mt-3">
            <div className="text-xs text-muted-foreground mb-1">Top reasons candidates were rejected:</div>
            <div className="flex flex-wrap gap-1.5">
              {reasons.map((r, i) => (
                <Badge key={i} variant="outline" className={toneClass("ai") + " text-[11px]"}>{r}</Badge>
              ))}
            </div>
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="mt-3 rounded border border-sky-500/30 bg-sky-500/10 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-sky-200 mb-1.5">
              <Lightbulb className="h-3.5 w-3.5" /> Try this next
            </div>
            <ul className="space-y-1 text-xs text-sky-100/90">
              {suggestions.map((s, i) => (
                <li key={i} className="flex gap-2"><span className="text-sky-400">•</span><span>{s}</span></li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    );
  }

  const m = computeMargin(best.current_price, amazonPrice, best.confidence_score);
  const guard = marginGuardLabel(m.guard);
  const res = best.final_resolution ? RESOLUTION_LABELS[best.final_resolution] : null;
  const warnings = bestCandidateWarnings(best, amazonPrice, candidates, id);
  const eff = effectiveMatchScore(best, id);
  const baseScore = best.match_score || 0;
  const tier = domainTier(best.domain);
  const tierMeta = domainTierLabel(tier);
  const supplierMatch = findSupplierForCandidate(best, suppliers);
  const supplierBoost = supplierBoostBreakdown(supplierMatch);

  return (
    <Card className="p-5 bg-gradient-to-br from-emerald-500/10 via-card/50 to-card/50 backdrop-blur border-emerald-500/30 mb-6">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Trophy className="h-4 w-4 text-emerald-300" />
        <h2 className="text-sm font-semibold text-emerald-200">Best candidate</h2>
        {res && <Badge variant="outline" className={toneClass(res.tone)}>{res.label}</Badge>}
        {guard && <Badge variant="outline" className={toneClass(guard.tone)}>{guard.label}</Badge>}
        <Badge variant="outline" className={toneClass(tierMeta.tone) + " text-[10px]"}>{tierMeta.label}</Badge>
        {supplierMatch && (
          <Badge
            variant="outline"
            className={`${toneClass(supplierBadgeTone(supplierMatch))} text-[10px]`}
            title={supplierBoost ? `Supplier boost +${supplierBoost.total} (${supplierBoost.originLabel}${supplierBoost.trustBoost > 0 ? ` · ${supplierBoost.trustLabel}` : ""})` : undefined}
          >
            <ShieldCheck className="h-2.5 w-2.5 mr-1" />
            {supplierBadgeLabel(supplierMatch)}
            {supplierBoost && <span className="ml-1 opacity-80">+{supplierBoost.total}</span>}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <a
            href={best.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white hover:text-primary text-base font-medium line-clamp-2 break-all"
          >
            {best.source_title || best.source_url}
          </a>
          <div className="text-xs text-muted-foreground mt-1">
            {best.domain}{best.source_type ? ` · ${best.source_type}` : ""}
            {best.confidence_score != null && ` · confidence ${Math.round(best.confidence_score * 100)}%`}
            {` · match ${eff}${eff !== baseScore ? ` (raw ${baseScore})` : ""}`}
          </div>
        </div>

        <div className="flex items-center gap-4 text-right">
          <div>
            <div className="text-xs text-muted-foreground">Source</div>
            <div className="font-mono text-white">{fmtPrice(best.current_price, best.currency)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Amazon</div>
            <div className="font-mono text-muted-foreground">{fmtPrice(amazonPrice, "USD")}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Margin</div>
            <div className={`font-mono ${
              m.margin == null ? "text-muted-foreground"
              : m.margin < 0 ? "text-rose-400"
              : "text-emerald-300"
            }`}>
              {m.margin == null ? "—"
                : `${fmtPrice(m.margin, "USD")}${m.marginPct != null ? ` (${m.marginPct.toFixed(0)}%)` : ""}`}
            </div>
          </div>
        </div>
      </div>

      {/* Live ROI from Amazon SP-API (same engine as Created Listings / RoiCalculator) */}
      <div className="mt-4 rounded border border-border bg-background/40 p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-muted-foreground inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
            Live ROI · Amazon SP-API fees
          </div>
          {liveRoi.priceSource && (
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
              price: {liveRoi.priceSource}
            </span>
          )}
        </div>

        {/* Amazon product preview (image + title) — same as Created Listings ASIN fetch */}
        {(liveRoi.imageUrl || liveRoi.title) && (
          <div className="flex items-start gap-3 mb-3 pb-3 border-b border-border/40">
            {liveRoi.imageUrl && (
              <img
                src={liveRoi.imageUrl}
                alt={liveRoi.title || best.asin}
                className="h-16 w-16 rounded border border-border object-contain bg-white/5 flex-shrink-0"
                loading="lazy"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            )}
            <div className="min-w-0 flex-1">
              <a
                href={liveRoi.link || `https://www.amazon.com/dp/${best.asin}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-white hover:text-primary line-clamp-2"
                title={liveRoi.title || ""}
              >
                {liveRoi.title || best.asin}
              </a>
              <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                ASIN: {best.asin}
              </div>
            </div>
          </div>
        )}

        {liveRoi.loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Fetching live Amazon price &amp; fees…
          </div>
        ) : liveRoi.error || liveRoi.roi == null || liveRoi.totalFees == null ? (
          <div className="flex items-center gap-2 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            ROI unavailable — Amazon fee data could not be retrieved for this ASIN. The margin shown above is a price spread only, not a true ROI.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground">Amazon price</div>
              <div className="font-mono text-white">{fmtPrice(liveRoi.amazonPrice, "USD")}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Amazon fees</div>
              <div
                className="font-mono text-rose-300"
                title={`Referral ${fmtPrice(liveRoi.referralFee, "USD")} · FBA ${fmtPrice(liveRoi.fbaFee, "USD")}${
                  liveRoi.variableClosingFee ? ` · Closing ${fmtPrice(liveRoi.variableClosingFee, "USD")}` : ""
                }${liveRoi.otherFees ? ` · Other ${fmtPrice(liveRoi.otherFees, "USD")}` : ""}`}
              >
                −{fmtPrice(liveRoi.totalFees, "USD")}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Cost</div>
              <div className="font-mono text-white">
                {fmtPrice(liveRoi.cost, bestEffective?.currency || "USD")}
                {bestEffective?.isManual && (
                  <span className="ml-1 text-[10px] text-sky-300">(manual)</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Net profit</div>
              <div className={`font-mono ${liveRoi.profit != null && liveRoi.profit < 0 ? "text-rose-400" : "text-emerald-300"}`}>
                {fmtPrice(liveRoi.profit, "USD")}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">ROI</div>
              <div className={`font-mono font-semibold ${
                liveRoi.roi == null ? "text-muted-foreground"
                : liveRoi.roi < 0 ? "text-rose-400"
                : liveRoi.roi < (gate.minRoiPct || 0) ? "text-amber-300"
                : "text-emerald-300"
              }`}>
                {liveRoi.roi.toFixed(1)}%
              </div>
            </div>
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {warnings.map((w, i) => (
            <div key={`${w.kind}-${i}`} className={`flex items-center gap-2 px-3 py-1.5 rounded border ${toneClass(w.tone)}`}>
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="text-xs">{w.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" variant="outline" asChild>
          <a href={best.source_url} target="_blank" rel="noopener noreferrer">
            Open <ExternalLink className="h-3 w-3 ml-1" />
          </a>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => (saved ? onUnsave() : onSave())}
        >
          {saved
            ? <><BookmarkCheck className="h-3 w-3 mr-1 text-emerald-400" /> Saved</>
            : <><Bookmark className="h-3 w-3 mr-1" /> Save source</>}
        </Button>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          Refresh
        </Button>
      </div>
    </Card>
  );
}
