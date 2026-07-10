import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  Zap,
  ArrowUpRight,
  ListChecks,
  RefreshCw,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  Undo2,
  TrendingUp,
} from "lucide-react";
import { useUiMode } from "@/contexts/UiModeContext";

interface QueueItem {
  asin: string;
  marketplace: string;
  sku: string | null;
  score: number;
  priority_bucket: "urgent" | "high" | "medium" | "routine";
  business_reason: string;
  suggested_action: string;
  expected_impact_usd: number;
  confidence: string;
  title?: string;
  image_url?: string;
  my_price?: number;
  min_price?: number | null;
}

const bucketStyle: Record<QueueItem["priority_bucket"], string> = {
  // Calm, low-alarm tones
  urgent: "bg-amber-500/12 text-amber-300 border-amber-500/30",
  high: "bg-blue-500/12 text-blue-300 border-blue-500/30",
  medium: "bg-muted/60 text-foreground border-border",
  routine: "bg-muted/40 text-muted-foreground border-border/60",
};

const bucketLabel: Record<QueueItem["priority_bucket"], string> = {
  urgent: "Act today",
  high: "Act this week",
  medium: "Worth a look",
  routine: "Routine",
};

const fmt$ = (n: number | undefined | null) =>
  n == null
    ? "—"
    : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

interface Props {
  limit?: number;
  compact?: boolean;
  title?: string;
}

type BucketFilter = "all" | "urgent" | "high" | "medium" | "routine";
type SortMode = "priority" | "impact";

// Map raw confidence text to a calm safe / balanced / bold label
function confidenceTier(raw: string | null | undefined): {
  label: string;
  tone: string;
  desc: string;
} {
  const c = (raw || "").toLowerCase();
  if (c.includes("high") || c.includes("strong"))
    return {
      label: "Safe recommendation",
      tone: "bg-emerald-500/12 text-emerald-300 border-emerald-500/30",
      desc: "Strong evidence — the system is highly confident this is the right move.",
    };
  if (c.includes("low") || c.includes("weak"))
    return {
      label: "Bold recommendation",
      tone: "bg-amber-500/12 text-amber-300 border-amber-500/30",
      desc: "Lower certainty — review before approving. You can roll back any time.",
    };
  return {
    label: "Balanced recommendation",
    tone: "bg-blue-500/12 text-blue-300 border-blue-500/30",
    desc: "Solid signal with normal market noise. Reversible at any time.",
  };
}

export default function OperatorQueueCard({
  limit = 10,
  compact = false,
  title = "Action queue",
}: Props) {
  const { user } = useAuth();
  const { mode } = useUiMode();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAsin, setBusyAsin] = useState<string | null>(null);
  const [bucket, setBucket] = useState<BucketFilter>("all");
  const [marketplace, setMarketplace] = useState<string>("all");
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const PAGE_SIZE = limit;

  const itemKey = (i: { asin: string; marketplace: string }) =>
    `${i.asin}::${i.marketplace}`;

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE;
      let query = supabase
        .from("repricer_opportunity_scores")
        .select("*")
        .eq("user_id", user.id);
      if (bucket !== "all") query = query.eq("priority_bucket", bucket);
      if (marketplace !== "all") query = query.eq("marketplace", marketplace);
      const orderCol = sortMode === "impact" ? "expected_impact_usd" : "score";
      const { data: scores } = await query
        .order(orderCol, { ascending: false })
        .range(from, to);

      const sliced = (scores ?? []).slice(0, PAGE_SIZE);
      setHasMore((scores ?? []).length > PAGE_SIZE);

      const asins = sliced.map((s: any) => s.asin);
      const { data: invRows } = await supabase
        .from("inventory")
        .select("asin,title,image_url,my_price,min_price")
        .eq("user_id", user.id)
        .in("asin", asins.length ? asins : ["__none__"])
        .limit(PAGE_SIZE);
      const invMap = new Map<string, any>();
      for (const r of invRows ?? []) invMap.set(r.asin, r);

      const enriched: QueueItem[] = sliced.map((s: any) => {
        const inv = invMap.get(s.asin) || {};
        return {
          asin: s.asin,
          marketplace: s.marketplace,
          sku: s.sku,
          score: s.score,
          priority_bucket: s.priority_bucket,
          business_reason: s.business_reason,
          suggested_action: s.suggested_action,
          expected_impact_usd: s.expected_impact_usd,
          confidence: s.confidence,
          title: inv.title,
          image_url: inv.image_url,
          my_price: inv.my_price,
          min_price: inv.min_price,
        };
      });
      setItems(enriched);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, [user, PAGE_SIZE, page, bucket, marketplace, sortMode]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPage(0);
  }, [bucket, marketplace, sortMode]);

  const marketplaces = useMemo(() => {
    const set = new Set(items.map((i) => i.marketplace));
    return ["all", ...Array.from(set).sort()];
  }, [items]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await supabase.functions.invoke("repricer-opportunity-score", {
        body: {},
      });
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const recordAction = async (
    item: QueueItem,
    action: "approved" | "ignored" | "escalated" | "auto_fixed",
    extra: { ignore_until?: string; notes?: string } = {},
    silent = false,
  ) => {
    if (!user) return;
    if (!silent) setBusyAsin(item.asin);
    try {
      await supabase.from("repricer_operator_actions").insert({
        user_id: user.id,
        operator_id: user.id,
        asin: item.asin,
        marketplace: item.marketplace,
        action,
        suggested_action: item.suggested_action,
        ignore_until: extra.ignore_until ?? null,
        notes: extra.notes ?? null,
      });

      if (action === "approved" || action === "auto_fixed") {
        try {
          await supabase.functions.invoke("repricer-evaluate", {
            body: {
              asin: item.asin,
              marketplace: item.marketplace,
              source: "operator_queue",
              force: true,
            },
          });
        } catch (e) {
          console.warn("evaluate trigger failed", e);
        }
      }

      setItems((prev) =>
        prev.filter(
          (i) => !(i.asin === item.asin && i.marketplace === item.marketplace),
        ),
      );

      if (!silent) {
        toast.success(
          action === "approved"
            ? "Approved — change is reversible from this queue's history."
            : action === "auto_fixed"
              ? "Auto-fix applied — protected by your safety floor."
              : action === "ignored"
                ? "Snoozed for 24 hours."
                : "Escalated for review.",
        );
      }
    } catch (e: any) {
      if (!silent) toast.error(e?.message ?? "Action failed");
    } finally {
      if (!silent) setBusyAsin(null);
    }
  };

  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allSelected = items.length > 0 && selected.size === items.length;
  const someSelected = selected.size > 0;

  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(items.map(itemKey)));
  };

  const bulkRun = async (action: "approved" | "ignored") => {
    const targets = items.filter((i) => selected.has(itemKey(i)));
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      for (const t of targets) {
        await recordAction(
          t,
          action,
          action === "ignored"
            ? {
                ignore_until: new Date(
                  Date.now() + 24 * 3600 * 1000,
                ).toISOString(),
              }
            : {},
          true,
        );
      }
      toast.success(
        `${targets.length} ${
          action === "approved" ? "approved" : "snoozed for 24h"
        }. Each is reversible.`,
      );
      setSelected(new Set());
    } finally {
      setBulkBusy(false);
    }
  };

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (loading && items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 flex justify-center">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </CardContent>
      </Card>
    );
  }

  const buckets: BucketFilter[] = [
    "all",
    "urgent",
    "high",
    "medium",
    "routine",
  ];

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-primary" />
              {title}
              <Badge variant="outline">
                {items.length}
                {hasMore ? "+" : ""}
              </Badge>
            </CardTitle>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSortMode((m) => (m === "priority" ? "impact" : "priority"))
                }
                title="Toggle sort"
              >
                <TrendingUp className="h-3.5 w-3.5 mr-1" />
                {sortMode === "impact" ? "By impact" : "By priority"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={refresh}
                disabled={refreshing}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 mr-1 ${refreshing ? "animate-spin" : ""}`}
                />
                Refresh
              </Button>
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              {buckets.map((b) => (
                <button
                  key={b}
                  onClick={() => setBucket(b)}
                  className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                    bucket === b
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border/60 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {b === "all" ? "All" : bucketLabel[b as Exclude<BucketFilter, "all">]}
                </button>
              ))}
            </div>
            {marketplaces.length > 2 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] uppercase text-muted-foreground/70">
                  Market
                </span>
                {marketplaces.map((m) => (
                  <button
                    key={m}
                    onClick={() => setMarketplace(m)}
                    className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                      marketplace === m
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border/60 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m === "all" ? "All" : m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Bulk action toolbar */}
          {items.length > 0 && (
            <div className="sticky top-0 z-10 mt-3 -mx-2 px-2 py-2 rounded-md bg-card/80 backdrop-blur border border-border/60 flex items-center gap-2 flex-wrap">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                />
                {someSelected
                  ? `${selected.size} selected`
                  : "Select all on page"}
              </label>
              <div className="flex-1" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      size="sm"
                      variant="default"
                      disabled={!someSelected || bulkBusy}
                      onClick={() => bulkRun("approved")}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                      Approve selected
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Each change is logged and reversible from history.
                </TooltipContent>
              </Tooltip>
              <Button
                size="sm"
                variant="outline"
                disabled={!someSelected || bulkBusy}
                onClick={() => bulkRun("ignored")}
              >
                <Clock className="h-3.5 w-3.5 mr-1" />
                Snooze 24h
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {items.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">
              <CheckCircle2 className="h-6 w-6 mx-auto mb-2 text-emerald-500" />
              <div>Everything looks calm. Nothing needs your attention right now.</div>
              <div className="mt-1.5 flex items-center justify-center gap-2 text-[11px] text-muted-foreground/80">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Reviewed recently across your active listings.
              </div>
            </div>
          ) : (
            items.map((it) => {
              const key = itemKey(it);
              const isOpen = expanded.has(key);
              const conf = confidenceTier(it.confidence);
              const hasFloor = it.min_price != null && it.min_price > 0;
              return (
                <div
                  key={key}
                  className="rounded-lg border border-border/60 bg-card/40 p-3 flex gap-3"
                >
                  <div className="flex flex-col items-center gap-2 pt-1">
                    <Checkbox
                      checked={selected.has(key)}
                      onCheckedChange={() => toggleSelected(key)}
                    />
                  </div>
                  {it.image_url ? (
                    <img
                      src={it.image_url}
                      alt={it.title || it.asin}
                      className="min-w-12 w-12 h-12 object-cover rounded shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <div className="min-w-12 w-12 h-12 rounded bg-muted shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">
                          {it.title || it.asin}
                        </div>
                        <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
                          <span>{it.asin}</span>
                          <span>•</span>
                          <span>{it.marketplace}</span>
                          <span>•</span>
                          <span>My price {fmt$(it.my_price)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${bucketStyle[it.priority_bucket]}`}
                        >
                          {bucketLabel[it.priority_bucket]}
                        </Badge>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${conf.tone}`}
                            >
                              {conf.label}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            {conf.desc}
                          </TooltipContent>
                        </Tooltip>
                        {hasFloor && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="outline"
                                className="text-[10px] bg-emerald-500/10 text-emerald-300 border-emerald-500/30 gap-1"
                              >
                                <ShieldCheck className="h-3 w-3" />
                                Floor protected
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              Your minimum price ({fmt$(it.min_price)}) caps any
                              drop. Profit guard stays active.
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </div>

                    <p className="text-sm text-foreground mt-2">
                      {it.business_reason}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Suggested: {it.suggested_action}
                    </p>

                    {/* Explainability panel */}
                    {isOpen && (
                      <div className="mt-2 rounded-md border border-border/50 bg-muted/20 p-2.5 text-[11px] space-y-1.5">
                        <div>
                          <span className="text-muted-foreground">
                            What happened:{" "}
                          </span>
                          <span className="text-foreground">
                            {it.business_reason}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">
                            Why it matters:{" "}
                          </span>
                          <span className="text-foreground">
                            Estimated value of acting now is{" "}
                            {fmt$(it.expected_impact_usd)}.
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">
                            What we suggest:{" "}
                          </span>
                          <span className="text-foreground">
                            {it.suggested_action}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">
                            Confidence:{" "}
                          </span>
                          <span className="text-foreground">{conf.label}</span>
                        </div>
                        <div className="flex items-start gap-1.5 text-foreground">
                          <ShieldCheck className="h-3 w-3 mt-0.5 text-emerald-400 shrink-0" />
                          <span>
                            Safety active:
                            {hasFloor
                              ? ` price cannot drop below your floor of ${fmt$(it.min_price)}. `
                              : " profit guard and ROI rules stay in effect. "}
                            Every change is logged and reversible.
                          </span>
                        </div>
                      </div>
                    )}

                    <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
                      <div className="text-[11px] text-muted-foreground flex items-center gap-3">
                        <span className="flex items-center gap-1">
                          <ArrowUpRight className="h-3 w-3 text-emerald-400" />
                          Est. impact{" "}
                          <span className="text-emerald-400">
                            {fmt$(it.expected_impact_usd)}
                          </span>
                        </span>
                        <button
                          onClick={() => toggleExpand(key)}
                          className="flex items-center gap-1 hover:text-foreground"
                        >
                          {isOpen ? (
                            <>
                              <ChevronUp className="h-3 w-3" /> Hide details
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-3 w-3" /> Why this
                              matters
                            </>
                          )}
                        </button>
                      </div>
                      <div className="flex gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="default"
                              disabled={busyAsin === it.asin}
                              onClick={() => recordAction(it, "approved")}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                              Approve
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <span className="flex items-center gap-1">
                              <Undo2 className="h-3 w-3" /> Reversible from
                              history.
                            </span>
                          </TooltipContent>
                        </Tooltip>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyAsin === it.asin}
                          onClick={() => recordAction(it, "auto_fixed")}
                        >
                          <Zap className="h-3.5 w-3.5 mr-1" />
                          Auto-fix
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyAsin === it.asin}
                          onClick={() =>
                            recordAction(it, "ignored", {
                              ignore_until: new Date(
                                Date.now() + 24 * 3600 * 1000,
                              ).toISOString(),
                            })
                          }
                        >
                          <Clock className="h-3.5 w-3.5 mr-1" />
                          Snooze 24h
                        </Button>
                        {mode === "advanced" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busyAsin === it.asin}
                            onClick={() => recordAction(it, "escalated")}
                          >
                            <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                            Escalate
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
          {(page > 0 || hasMore) && (
            <div className="flex items-center justify-between pt-2 border-t border-border/40">
              <div className="text-[11px] text-muted-foreground">
                Page {page + 1}
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page === 0 || loading}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Prev
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasMore || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
