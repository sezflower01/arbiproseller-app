import { useMemo, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Loader2, Search, RefreshCw, ExternalLink, ShieldAlert,
  AlertTriangle, Globe, Bookmark, BookmarkCheck, ArrowUpDown, ShieldCheck,
  ShieldX, MoreVertical, DollarSign, Pencil, Sparkles, Link2,
} from "lucide-react";
import {
  Candidate, BLOCK_PROVIDER_LABELS, RESOLUTION_LABELS,
  toneClass, fmtPrice, fmtRelative, MatchScoreBadge,
  classifyCandidate, StatusFilter,
  computeMargin, marginGuardLabel, candidateRankScore,
  freshnessOf, freshnessLabel,
  IdentityForScoring, domainTier, isTrustedDomain, effectiveMatchScore,
  BestCandidateGate, DEFAULT_GATE, evaluateGate,
  TrustContext, EMPTY_TRUST_CONTEXT, isUserTrusted, effectivePriceForCandidate,
  SupplierContext, EMPTY_SUPPLIER_CONTEXT, findSupplierForCandidate,
  supplierBadgeLabel, supplierBadgeTone, supplierBoostBreakdown,
  findRelatedSupplier, RelatedSupplierMatch,
} from "./shared";

type SortKey = "default" | "price" | "confidence" | "match_score" | "last_checked";

export interface CandidatesTableProps {
  candidates: Candidate[];
  savedUrls: Set<string>;
  amazonPrice: number | null;
  identity?: IdentityForScoring;
  gate?: BestCandidateGate;
  trust?: TrustContext;
  suppliers?: SupplierContext;
  refreshingId: string | null;
  onRefresh: (c: Candidate) => void;
  onSave: (c: Candidate) => void;
  onUnsave: (url: string) => void;
  onMarkTrusted?: (c: Candidate) => Promise<void> | void;
  onUnmarkTrusted?: (c: Candidate) => Promise<void> | void;
  onTrustDomain?: (domain: string) => Promise<void> | void;
  onAddRelatedSupplier?: (domain: string, relatedTo: string) => Promise<void> | void;
  onSetManualCost?: (c: Candidate, cost: number | null, note: string) => Promise<void> | void;
  onBulkRefresh?: (which: "extracted" | "blocked_unresolved") => void;
  bulkRefreshing?: "extracted" | "blocked_unresolved" | null;
}

export default function CandidatesTable({
  candidates, savedUrls, amazonPrice, identity = {}, gate = DEFAULT_GATE,
  trust = EMPTY_TRUST_CONTEXT, suppliers = EMPTY_SUPPLIER_CONTEXT,
  refreshingId, onRefresh, onSave, onUnsave,
  onMarkTrusted, onUnmarkTrusted, onTrustDomain, onAddRelatedSupplier, onSetManualCost,
  onBulkRefresh, bulkRefreshing,
}: CandidatesTableProps) {
  const id = { ...identity, amazonPrice: identity.amazonPrice ?? amazonPrice };
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [domainFilter, setDomainFilter] = useState<string>("all");
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("default");
  const [search, setSearch] = useState("");
  const [hideBlocked, setHideBlocked] = useState(true);
  const [trustedOnly, setTrustedOnly] = useState(true);
  const [highConfOnly, setHighConfOnly] = useState(false);

  const domains = useMemo(() => {
    const set = new Set<string>();
    candidates.forEach((c) => c.domain && set.add(c.domain));
    return Array.from(set).sort();
  }, [candidates]);

  const sourceTypes = useMemo(() => {
    const set = new Set<string>();
    candidates.forEach((c) => c.source_type && set.add(c.source_type));
    return Array.from(set).sort();
  }, [candidates]);

  // Manual cost dialog state
  const [costDialog, setCostDialog] = useState<{ candidate: Candidate; open: boolean } | null>(null);
  const [costDraft, setCostDraft] = useState<string>("");
  const [costNote, setCostNote] = useState<string>("");

  // Row selection state for "Retry selected"
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [retryingSelected, setRetryingSelected] = useState(false);

  const filtered = useMemo(() => {
    let list = candidates;
    if (hideBlocked) {
      // A candidate counts as "with price" if it has a real extraction OR a manual cost
      list = list.filter((c) => (c.current_price != null && c.current_price > 0) || trust.manualCosts.has(c.source_url));
    }
    if (trustedOnly) {
      // User-trusted sources always pass this filter, regardless of generic tier
      list = list.filter((c) => isTrustedDomain(c.domain) || isUserTrusted(c, trust));
    }
    if (highConfOnly) {
      list = list.filter((c) => {
        if (trust.manualCosts.has(c.source_url)) return true; // manual cost = max confidence
        return (c.confidence_score ?? 0) >= 0.7
          && c.current_price != null && c.current_price > 0
          && c.final_resolution === "price_extracted";
      });
    }
    if (statusFilter !== "all") {
      list = list.filter((c) => {
        const s = classifyCandidate(c);
        return s === statusFilter;
      });
    }
    if (domainFilter !== "all") list = list.filter((c) => c.domain === domainFilter);
    if (sourceTypeFilter !== "all") list = list.filter((c) => c.source_type === sourceTypeFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((c) =>
        (c.source_url || "").toLowerCase().includes(q) ||
        (c.source_title || "").toLowerCase().includes(q) ||
        (c.domain || "").toLowerCase().includes(q)
      );
    }

    const sorted = [...list].sort((a, b) => {
      switch (sortKey) {
        case "price": {
          const ap = effectivePriceForCandidate(a, trust).price ?? -1;
          const bp = effectivePriceForCandidate(b, trust).price ?? -1;
          return bp - ap;
        }
        case "confidence":
          return (b.confidence_score ?? 0) - (a.confidence_score ?? 0);
        case "match_score":
          return (effectiveMatchScore(b, id) || 0) - (effectiveMatchScore(a, id) || 0);
        case "last_checked": {
          const at = a.last_checked_at ? new Date(a.last_checked_at).getTime() : 0;
          const bt = b.last_checked_at ? new Date(b.last_checked_at).getTime() : 0;
          return bt - at;
        }
        default:
          // Identity + trust + supplier aware composite ranking
          return candidateRankScore(b, id, trust, suppliers) - candidateRankScore(a, id, trust, suppliers);
      }
    });
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, hideBlocked, trustedOnly, highConfOnly, statusFilter, domainFilter, sourceTypeFilter, search, sortKey, id.title, id.brand, id.amazonPrice, trust.trustedUrls, trust.trustedDomains, trust.manualCosts, suppliers.byDomain]);

  const openCostDialog = (c: Candidate) => {
    const existing = trust.manualCosts.get(c.source_url);
    setCostDraft(existing ? String(existing.cost) : "");
    setCostNote(existing?.note || "");
    setCostDialog({ candidate: c, open: true });
  };

  const submitCost = async () => {
    if (!costDialog || !onSetManualCost) return;
    const num = costDraft.trim() === "" ? null : Number(costDraft);
    if (num !== null && (!Number.isFinite(num) || num < 0)) return;
    await onSetManualCost(costDialog.candidate, num, costNote.trim());
    setCostDialog(null);
  };

  // Selection helpers (operate on currently-filtered rows)
  const filteredIds = useMemo(() => filtered.map((c) => c.id), [filtered]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const someFilteredSelected = filteredIds.some((id) => selectedIds.has(id)) && !allFilteredSelected;

  // Drop selections that are no longer in the filtered list (filter changed, row removed, etc.)
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filteredIds);
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (visible.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [filteredIds]);

  const toggleRow = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAllFiltered = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) filteredIds.forEach((id) => next.add(id));
      else filteredIds.forEach((id) => next.delete(id));
      return next;
    });
  };

  const selectFailedOnly = () => {
    const failedStatuses = new Set<string>(["blocked", "unresolved", "invalid", "needs_review"]);
    const ids = filtered
      .filter((c) => failedStatuses.has(classifyCandidate(c)))
      .map((c) => c.id);
    setSelectedIds(new Set(ids));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const retrySelected = async () => {
    if (selectedIds.size === 0 || retryingSelected) return;
    setRetryingSelected(true);
    try {
      const targets = filtered.filter((c) => selectedIds.has(c.id));
      // Sequential to respect upstream rate limits and reuse the per-row refresh contract
      for (const c of targets) {
        try {
          await Promise.resolve(onRefresh(c));
        } catch (err) {
          console.error("[CandidatesTable] retry failed for", c.source_url, err);
        }
      }
    } finally {
      setRetryingSelected(false);
    }
  };

  return (
    <div>
      {/* Filters bar */}
      <div className="px-5 py-3 border-b border-border/50 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search url / title / domain"
            className="pl-8 h-8 text-xs"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="h-8 text-xs w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="extracted">Extracted</SelectItem>
            <SelectItem value="blocked">Blocked</SelectItem>
            <SelectItem value="unresolved">Unresolved</SelectItem>
            <SelectItem value="invalid">Invalid</SelectItem>
            <SelectItem value="needs_review">Needs review</SelectItem>
          </SelectContent>
        </Select>
        <Select value={domainFilter} onValueChange={setDomainFilter}>
          <SelectTrigger className="h-8 text-xs w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All domains</SelectItem>
            {domains.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
          </SelectContent>
        </Select>
        {sourceTypes.length > 1 && (
          <Select value={sourceTypeFilter} onValueChange={setSourceTypeFilter}>
            <SelectTrigger className="h-8 text-xs w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {sourceTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
          <SelectTrigger className="h-8 text-xs w-[160px]">
            <ArrowUpDown className="h-3 w-3 mr-1" /><SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Best matches first</SelectItem>
            <SelectItem value="price">Price (high → low)</SelectItem>
            <SelectItem value="match_score">Match score</SelectItem>
            <SelectItem value="confidence">Confidence</SelectItem>
            <SelectItem value="last_checked">Last checked</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <div className="flex items-center gap-1.5">
            <Switch id="hide-blocked" checked={hideBlocked} onCheckedChange={setHideBlocked} />
            <Label htmlFor="hide-blocked" className="text-xs text-muted-foreground cursor-pointer">
              Hide blocked / no-price
            </Label>
          </div>
          <div className="flex items-center gap-1.5">
            <Switch id="trusted-only" checked={trustedOnly} onCheckedChange={setTrustedOnly} />
            <Label htmlFor="trusted-only" className="text-xs text-muted-foreground cursor-pointer inline-flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" /> Trusted only
            </Label>
          </div>
          <div className="flex items-center gap-1.5">
            <Switch id="high-conf-only" checked={highConfOnly} onCheckedChange={setHighConfOnly} />
            <Label htmlFor="high-conf-only" className="text-xs text-muted-foreground cursor-pointer">
              High-confidence
            </Label>
          </div>
          {onBulkRefresh && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => onBulkRefresh("extracted")}
                disabled={!!bulkRefreshing}
              >
                {bulkRefreshing === "extracted"
                  ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  : <RefreshCw className="h-3 w-3 mr-1" />}
                Refresh extracted
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => onBulkRefresh("blocked_unresolved")}
                disabled={!!bulkRefreshing}
              >
                {bulkRefreshing === "blocked_unresolved"
                  ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  : <RefreshCw className="h-3 w-3 mr-1" />}
                Retry blocked
              </Button>
            </>
          )}
          <span className="text-xs text-muted-foreground">
            {filtered.length} of {candidates.length}
          </span>
        </div>
      </div>

      {/* Selection / bulk-retry bar — only visible while at least one row is selected */}
      {selectedIds.size > 0 && (
        <div className="px-5 py-2 border-b border-border/50 bg-primary/5 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {selectedIds.size} selected
          </Badge>
          <Button
            size="sm"
            variant="default"
            className="h-8 text-xs"
            onClick={retrySelected}
            disabled={retryingSelected}
            title="Re-run extraction for the selected rows"
          >
            {retryingSelected
              ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              : <RefreshCw className="h-3 w-3 mr-1" />}
            Retry selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={selectFailedOnly}
            disabled={retryingSelected}
            title="Replace selection with all failed rows currently visible"
          >
            Select failed only
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={clearSelection}
            disabled={retryingSelected}
          >
            Clear
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-table-row">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-table-row-hover text-xs font-medium text-foreground border-b border-border">
            <tr>
              <th className="px-3 py-2.5 w-8">
                <Checkbox
                  checked={allFilteredSelected ? true : someFilteredSelected ? "indeterminate" : false}
                  onCheckedChange={(v) => toggleAllFiltered(v === true)}
                  aria-label="Select all visible rows"
                />
              </th>
              <th className="px-4 py-2.5 text-left">Source</th>
              <th className="px-4 py-2.5 text-left">Match</th>
              <th className="px-4 py-2.5 text-right">Source price</th>
              <th className="px-4 py-2.5 text-right">Amazon price</th>
              <th className="px-4 py-2.5 text-right">Margin</th>
              <th className="px-4 py-2.5 text-left">Status</th>
              <th className="px-4 py-2.5 text-left">Method</th>
              <th className="px-4 py-2.5 text-left">Checked</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c, idx) => {
              const resLabel = c.final_resolution ? RESOLUTION_LABELS[c.final_resolution] : null;
              const isSaved = savedUrls.has(c.source_url);
              const userTrusted = isUserTrusted(c, trust);
              const supplierMatch = findSupplierForCandidate(c, suppliers);
              const relatedMatch: RelatedSupplierMatch | null =
                supplierMatch ? null : findRelatedSupplier(c, suppliers);
              const supplierBoost = supplierBoostBreakdown(supplierMatch);
              const eff = effectivePriceForCandidate(c, trust);
              const m = computeMargin(eff.price, amazonPrice, eff.isManual ? 1 : c.confidence_score);
              const guard = marginGuardLabel(m.guard);
              const marginCls =
                m.margin == null ? "text-muted-foreground"
                : m.margin < 0 ? "text-rose-400"
                : m.guard === "suspicious" ? "text-amber-300"
                : "text-emerald-400";
              const isExtracted = c.current_price != null && c.current_price > 0 && c.final_resolution === "price_extracted";
              const hasManualCost = trust.manualCosts.has(c.source_url);
              const gateRes = (isExtracted || hasManualCost) ? evaluateGate(c, id, gate, trust) : null;
              const rejectedByGate = gateRes != null && !gateRes.passed;
              const trustedByDomainOnly = userTrusted && !trust.trustedUrls.has(c.source_url);
              const isSelected = selectedIds.has(c.id);
              return (
                <tr key={c.id} className={`border-t border-border/50 ${idx % 2 === 0 ? "bg-table-row" : "bg-table-row-alt"} hover:bg-table-row-hover transition-colors ${rejectedByGate ? "opacity-80" : ""} ${isSelected ? "bg-primary/5" : ""}`}>
                  <td className="px-3 py-3 align-top w-8">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(v) => toggleRow(c.id, v === true)}
                      aria-label={`Select ${c.source_title || c.source_url}`}
                    />
                  </td>
                  <td className="px-4 py-3 max-w-md text-foreground">
                    <div className="flex items-start gap-2">
                      <Globe className="h-4 w-4 mt-0.5 text-muted-foreground flex-shrink-0" />
                      <div className="min-w-0">
                        <a href={c.source_url} target="_blank" rel="noopener noreferrer" className="text-foreground font-medium hover:text-primary line-clamp-1 break-all">
                          {c.source_title || c.source_url}
                        </a>
                        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                          <span>{c.domain}</span>
                          {c.source_type && <span>· {c.source_type}</span>}
                          {supplierMatch && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant="outline" className={`${toneClass(supplierBadgeTone(supplierMatch))} text-[10px] cursor-help`}>
                                    <ShieldCheck className="h-2.5 w-2.5 mr-1" />
                                    {supplierBadgeLabel(supplierMatch)}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  <div className="font-medium text-xs mb-1">From your Supplier Registry</div>
                                  <div className="text-xs space-y-0.5">
                                    <div>Origin: <span className="font-mono">{supplierMatch.source_origin}</span></div>
                                    <div>Trust level: <span className="font-mono">{supplierMatch.trust_level}</span></div>
                                    <div>Type: <span className="font-mono">{supplierMatch.supplier_type}</span></div>
                                    {supplierBoost && (
                                      <div className="pt-1 mt-1 border-t border-border/40">
                                        Ranking boost: <span className="font-mono text-emerald-300">+{supplierBoost.total}</span>
                                        <div className="text-[10px] text-muted-foreground">
                                          ({supplierBoost.originLabel} +{supplierBoost.originBoost}
                                          {supplierBoost.trustBoost > 0 ? `, ${supplierBoost.trustLabel} +${supplierBoost.trustBoost}` : ""})
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          {relatedMatch && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant="outline" className={`${toneClass("ai")} text-[10px] cursor-help`}>
                                    <Sparkles className="h-2.5 w-2.5 mr-1" />
                                    Possibly related to {relatedMatch.supplier.domain}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  <div className="font-medium text-xs mb-1">Domain similarity (suggestion only)</div>
                                  <div className="text-xs space-y-0.5">
                                    <div>This domain looks similar to a supplier you already have in your registry.</div>
                                    <div>
                                      Match: <span className="font-mono">{relatedMatch.candidateRoot}</span>
                                      {" ↔ "}
                                      <span className="font-mono">{relatedMatch.supplierRoot}</span>
                                      {" "}
                                      ({Math.round(relatedMatch.similarity * 100)}%)
                                    </div>
                                    <div className="pt-1 mt-1 border-t border-border/40 text-[11px] text-muted-foreground">
                                      No automatic trust or ranking boost is applied. Use the row's "More actions" menu to add it to your registry or trust the domain manually.
                                    </div>
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          {userTrusted && (
                            <Badge variant="outline" className={`${toneClass("good")} text-[10px]`}>
                              <ShieldCheck className="h-2.5 w-2.5 mr-1" />
                              {trustedByDomainOnly ? "Trusted domain" : "User-trusted"}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {(() => {
                      const effScore = effectiveMatchScore(c, id);
                      const base = c.match_score || 0;
                      const reasonText = [
                        c.match_reason,
                        effScore !== base ? `Effective ${effScore} (raw ${base} after penalties)` : null,
                        supplierBoost ? `Supplier boost: +${supplierBoost.total} (${supplierBoost.originLabel}${supplierBoost.trustBoost > 0 ? ` · ${supplierBoost.trustLabel}` : ""})` : null,
                      ].filter(Boolean).join(" · ");
                      return (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div><MatchScoreBadge score={effScore} /></div>
                            </TooltipTrigger>
                            {reasonText && <TooltipContent>{reasonText}</TooltipContent>}
                          </Tooltip>
                        </TooltipProvider>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-white">
                    <div>{fmtPrice(eff.price, eff.currency)}</div>
                    {eff.isManual && (
                      <div className="text-[10px] text-emerald-300 font-sans normal-case mt-0.5">
                        Manual cost
                        {c.current_price != null && c.current_price > 0 && (
                          <span className="text-muted-foreground ml-1">(scraped: {fmtPrice(c.current_price, c.currency)})</span>
                        )}
                      </div>
                    )}
                    {eff.isManual && eff.note && (
                      <div className="text-[10px] text-muted-foreground italic font-sans normal-case mt-0.5 max-w-[220px] line-clamp-2">"{eff.note}"</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                    {fmtPrice(amazonPrice, "USD")}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono ${marginCls}`}>
                    <div>
                      {m.margin == null
                        ? "—"
                        : `${fmtPrice(m.margin, "USD")}${m.marginPct != null ? ` (${m.marginPct.toFixed(0)}%)` : ""}`}
                    </div>
                    {guard && (
                      <Badge variant="outline" className={`${toneClass(guard.tone)} text-[10px] mt-1`}>
                        {guard.label}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1">
                      {resLabel ? (
                        <Badge variant="outline" className={toneClass(resLabel.tone)}>{resLabel.label}</Badge>
                      ) : c.extracted_at ? (
                        <Badge variant="outline" className={toneClass("ok")}>Done</Badge>
                      ) : (
                        <Badge variant="outline" className={toneClass("ok")}>Pending</Badge>
                      )}
                      {rejectedByGate && gateRes && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className={`${toneClass("ai")} cursor-help`}>
                                <ShieldX className="h-3 w-3 mr-1" /> Rejected by gate
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <div className="font-medium text-xs mb-1">Failed gate checks:</div>
                              <ul className="text-xs space-y-0.5">
                                {gateRes.reasons.map((r, i) => (
                                  <li key={i}>• {r}</li>
                                ))}
                              </ul>
                              {!userTrusted && (onMarkTrusted || onTrustDomain) && (
                                <div className="mt-2 pt-2 border-t border-border/40 text-[11px] text-muted-foreground">
                                  Mark this source as Trusted to bypass these checks.
                                </div>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      {c.block_provider && (
                        <Badge variant="outline" className="bg-rose-500/15 text-rose-300 border-rose-500/30">
                          <ShieldAlert className="h-3 w-3 mr-1" />
                          {BLOCK_PROVIDER_LABELS[c.block_provider] || c.block_provider}
                        </Badge>
                      )}
                      {c.needs_review && (
                        <Badge variant="outline" className="bg-muted text-foreground border-border">
                          <AlertTriangle className="h-3 w-3 mr-1" /> Review
                        </Badge>
                      )}
                      {c.confidence_score != null && c.current_price != null && (
                        <span className="text-xs text-muted-foreground">{Math.round(c.confidence_score * 100)}%</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {c.extraction_method || "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {(() => {
                      const f = freshnessOf(c.last_checked_at);
                      const meta = freshnessLabel(f);
                      return (
                        <div className="flex flex-col gap-0.5">
                          <Badge variant="outline" className={`${toneClass(meta.tone)} text-[10px] w-fit`}>{meta.label}</Badge>
                          <span>{fmtRelative(c.last_checked_at)}</span>
                        </div>
                      );
                    })()}
                  </td>

                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-1 items-center">
                      <Button
                        size="sm"
                        variant="ghost"
                        title={isSaved ? "Remove from saved sources" : "Save this source"}
                        onClick={() => isSaved ? onUnsave(c.source_url) : onSave(c)}
                        disabled={!c.current_price && !isSaved && !hasManualCost}
                      >
                        {isSaved
                          ? <BookmarkCheck className="h-3 w-3 text-emerald-400" />
                          : <Bookmark className="h-3 w-3" />}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => onRefresh(c)} disabled={refreshingId === c.id}>
                        {refreshingId === c.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : c.extracted_at ? (
                          <RefreshCw className="h-3 w-3" />
                        ) : (
                          <Search className="h-3 w-3" />
                        )}
                        <span className="ml-1 hidden sm:inline">{c.extracted_at ? "Refresh" : "Check"}</span>
                      </Button>
                      {(onMarkTrusted || onUnmarkTrusted || onTrustDomain || onAddRelatedSupplier || onSetManualCost) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="ghost" title="More actions">
                              <MoreVertical className="h-3 w-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-64">
                            {relatedMatch && onAddRelatedSupplier && c.domain && (
                              <>
                                <DropdownMenuItem
                                  onClick={() => onAddRelatedSupplier(c.domain!, relatedMatch.supplier.domain)}
                                >
                                  <Link2 className="h-3.5 w-3.5 mr-2 text-emerald-400" />
                                  Add {c.domain} to registry
                                  <span className="ml-1 text-[10px] text-muted-foreground">
                                    (related to {relatedMatch.supplier.domain})
                                  </span>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                              </>
                            )}
                            {onMarkTrusted && !trust.trustedUrls.has(c.source_url) && (
                              <DropdownMenuItem onClick={() => onMarkTrusted(c)}>
                                <ShieldCheck className="h-3.5 w-3.5 mr-2 text-emerald-400" />
                                Mark this URL as trusted
                              </DropdownMenuItem>
                            )}
                            {onUnmarkTrusted && trust.trustedUrls.has(c.source_url) && (
                              <DropdownMenuItem onClick={() => onUnmarkTrusted(c)}>
                                <ShieldX className="h-3.5 w-3.5 mr-2" />
                                Remove URL trust
                              </DropdownMenuItem>
                            )}
                            {onTrustDomain && c.domain && !trust.trustedDomains.has(c.domain.toLowerCase().replace(/^www\./, "")) && (
                              <DropdownMenuItem onClick={() => onTrustDomain(c.domain!)}>
                                <ShieldCheck className="h-3.5 w-3.5 mr-2 text-emerald-400" />
                                Trust whole domain ({c.domain})
                              </DropdownMenuItem>
                            )}
                            {onSetManualCost && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => openCostDialog(c)}>
                                  {hasManualCost ? <Pencil className="h-3.5 w-3.5 mr-2" /> : <DollarSign className="h-3.5 w-3.5 mr-2" />}
                                  {hasManualCost ? "Edit manual cost" : "Set manual cost"}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      <Button size="sm" variant="ghost" asChild>
                        <a href={c.source_url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-muted-foreground text-sm">No candidates match your filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Manual cost dialog */}
      <Dialog open={!!costDialog} onOpenChange={(o) => !o && setCostDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set manual cost</DialogTitle>
            <DialogDescription>
              Override the scraped price with your real per-unit cost (e.g. $15.99 from a Costco bulk promo).
              Leave blank and save to clear the override. ROI/margin calculations will use this value.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="cost">Per-unit cost (USD)</Label>
              <Input
                id="cost"
                type="number"
                step="0.01"
                min="0"
                value={costDraft}
                onChange={(e) => setCostDraft(e.target.value)}
                placeholder="15.99"
              />
            </div>
            <div>
              <Label htmlFor="note">Note (optional)</Label>
              <Input
                id="note"
                value={costNote}
                onChange={(e) => setCostNote(e.target.value)}
                placeholder="e.g. Buy only during $50 off 10-units promo"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCostDialog(null)}>Cancel</Button>
            <Button onClick={submitCost}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
