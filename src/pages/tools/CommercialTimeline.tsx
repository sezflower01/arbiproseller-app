// Commercial Timeline — per-ASIN unified history view.
// Joins price actions, BB transitions, adaptations, operator actions,
// outcome labels, and sales into a single chronological feed.

import { useEffect, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  TrendingDown,
  TrendingUp,
  Brain,
  ShoppingCart,
  CheckCircle2,
  XCircle,
  Repeat,
  AlertCircle,
  User,
} from "lucide-react";

type Event = {
  ts: string;
  kind:
    | "price_change"
    | "adaptation"
    | "operator_action"
    | "outcome"
    | "sale";
  title: string;
  detail?: string;
  meta?: Record<string, any>;
  tone?: "good" | "bad" | "neutral" | "info";
};

const fmt$ = (n?: number | null) =>
  n == null ? "—" : `$${Number(n).toFixed(2)}`;

const outcomeIcon = (label?: string) => {
  if (label === "successful") return CheckCircle2;
  if (label === "failed") return XCircle;
  if (label === "reversed") return Repeat;
  if (label === "partial") return AlertCircle;
  return AlertCircle;
};
const outcomeTone = (label?: string): Event["tone"] =>
  label === "successful"
    ? "good"
    : label === "failed" || label === "reversed"
      ? "bad"
      : "neutral";

export default function CommercialTimeline() {
  const { user } = useAuth();
  const { asin: asinParam } = useParams<{ asin: string }>();
  const [search] = useSearchParams();
  const marketplace = search.get("marketplace") || "amazon.com";
  const asin = asinParam || "";

  const [events, setEvents] = useState<Event[]>([]);
  const [memory, setMemory] = useState<any>(null);
  const [meta, setMeta] = useState<{ title?: string; image_url?: string }>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [windowDays, setWindowDays] = useState(30);
  const [hasMore, setHasMore] = useState(true);

  // Per-source page size keeps each query fast even at very long histories.
  const PAGE = 80;

  useEffect(() => {
    const load = async () => {
      if (!user || !asin) return;
      const isFirst = events.length === 0;
      isFirst ? setLoading(true) : setLoadingMore(true);
      const since = new Date(
        Date.now() - windowDays * 24 * 3600 * 1000,
      ).toISOString();

      const [actions, adaptations, opActs, outcomes, sales, mem, inv] =
        await Promise.all([
          supabase
            .from("repricer_price_actions")
            .select("created_at,old_price,new_price,reason")
            .eq("user_id", user.id)
            .eq("asin", asin)
            .eq("marketplace", marketplace)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(PAGE),
          supabase
            .from("repricer_adaptations_log")
            .select(
              "created_at,adaptation_type,before_state,after_state,business_reason,confidence",
            )
            .eq("user_id", user.id)
            .eq("asin", asin)
            .eq("marketplace", marketplace)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(PAGE),
          supabase
            .from("repricer_operator_actions")
            .select("created_at,action,suggested_action,notes")
            .eq("user_id", user.id)
            .eq("asin", asin)
            .eq("marketplace", marketplace)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(PAGE),
          supabase
            .from("repricer_action_outcomes")
            .select(
              "evaluated_at,outcome_label,bb_improved,sales_improved,revenue_delta_usd,margin_delta_pct",
            )
            .eq("user_id", user.id)
            .eq("asin", asin)
            .eq("marketplace", marketplace)
            .gte("evaluated_at", since)
            .order("evaluated_at", { ascending: false })
            .limit(PAGE),
          supabase
            .from("sales_orders")
            .select("order_date,quantity,sold_price")
            .eq("user_id", user.id)
            .eq("asin", asin)
            .gte("order_date", since)
            .order("order_date", { ascending: false })
            .limit(PAGE),
          isFirst
            ? supabase
                .from("repricer_asin_strategy_memory")
                .select("*")
                .eq("user_id", user.id)
                .eq("asin", asin)
                .eq("marketplace", marketplace)
                .maybeSingle()
            : Promise.resolve({ data: memory } as any),
          isFirst
            ? supabase
                .from("inventory")
                .select("title,image_url")
                .eq("user_id", user.id)
                .eq("asin", asin)
                .maybeSingle()
            : Promise.resolve({ data: meta } as any),
        ]);

      const all: Event[] = [];
      for (const a of actions.data ?? []) {
        const dir = Number(a.new_price) < Number(a.old_price);
        all.push({
          ts: a.created_at,
          kind: "price_change",
          title: `Price ${dir ? "lowered" : "raised"} ${fmt$(a.old_price)} → ${fmt$(a.new_price)}`,
          detail: a.reason || undefined,
          tone: dir ? "neutral" : "good",
        });
      }
      for (const ad of adaptations.data ?? []) {
        all.push({
          ts: ad.created_at,
          kind: "adaptation",
          title: `Adaptation: ${ad.adaptation_type.replace(/_/g, " ")}`,
          detail: ad.business_reason,
          meta: { confidence: ad.confidence },
          tone: "info",
        });
      }
      for (const o of opActs.data ?? []) {
        all.push({
          ts: o.created_at,
          kind: "operator_action",
          title: `Operator ${o.action.replace(/_/g, " ")}`,
          detail: o.suggested_action || undefined,
          tone:
            o.action === "approved" || o.action === "auto_fixed"
              ? "good"
              : "neutral",
        });
      }
      for (const oc of outcomes.data ?? []) {
        all.push({
          ts: oc.evaluated_at,
          kind: "outcome",
          title: `Outcome: ${oc.outcome_label}`,
          detail: `BB ${oc.bb_improved == null ? "?" : oc.bb_improved ? "↑" : "↓"} · Sales ${oc.sales_improved == null ? "?" : oc.sales_improved ? "↑" : "↓"} · Rev ${fmt$(oc.revenue_delta_usd)}`,
          tone: outcomeTone(oc.outcome_label),
        });
      }
      for (const s of sales.data ?? []) {
        all.push({
          ts: s.order_date,
          kind: "sale",
          title: `Sale × ${s.quantity ?? 1}`,
          detail: fmt$(s.sold_price),
          tone: "good",
        });
      }
      all.sort((a, b) => b.ts.localeCompare(a.ts));
      setEvents(all);
      // If any source returned a full page, more history likely exists.
      const anyFull =
        (actions.data?.length ?? 0) === PAGE ||
        (adaptations.data?.length ?? 0) === PAGE ||
        (opActs.data?.length ?? 0) === PAGE ||
        (outcomes.data?.length ?? 0) === PAGE ||
        (sales.data?.length ?? 0) === PAGE;
      setHasMore(anyFull && windowDays < 365);
      if (isFirst) {
        setMemory(mem.data);
        setMeta(inv.data ?? {});
      }
      setLoading(false);
      setLoadingMore(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, asin, marketplace, windowDays]);

  const iconFor = (e: Event) => {
    switch (e.kind) {
      case "price_change":
        return e.tone === "good" ? TrendingUp : TrendingDown;
      case "adaptation":
        return Brain;
      case "operator_action":
        return User;
      case "outcome":
        return outcomeIcon(e.title.split(": ")[1]);
      case "sale":
        return ShoppingCart;
    }
  };

  const toneCls = (t?: Event["tone"]) =>
    t === "good"
      ? "text-emerald-400"
      : t === "bad"
        ? "text-red-400"
        : t === "info"
          ? "text-primary"
          : "text-muted-foreground";

  return (
    <>
      <Helmet>
        <title>Timeline {asin} — ArbiPro Seller</title>
      </Helmet>
      <div className="dark min-h-screen flex flex-col bg-[hsl(222,84%,4.9%)] text-white">
        <Navbar />
        <main className="flex-1 container mx-auto px-4 py-8 pt-24 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {meta.image_url && (
                <img
                  src={meta.image_url}
                  alt={meta.title || asin}
                  className="min-w-12 w-12 h-12 object-cover rounded"
                />
              )}
              <div>
                <h1 className="text-2xl font-bold">
                  {meta.title || asin}
                </h1>
                <div className="text-xs text-muted-foreground">
                  {asin} · {marketplace}
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link to="/tools/repricer/operator-queue">
                <ArrowLeft className="h-4 w-4 mr-1" /> Back to Queue
              </Link>
            </Button>
          </div>

          {memory && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Listing personality
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
                <div>
                  <div className="text-[11px] text-muted-foreground">
                    Profile
                  </div>
                  <div className="font-semibold capitalize">
                    {String(memory.personality_profile || "unknown").replace(
                      /_/g,
                      " ",
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">
                    Win rate after reduction
                  </div>
                  <div className="font-semibold">
                    {memory.win_rate_after_reduction == null
                      ? "—"
                      : `${Math.round(memory.win_rate_after_reduction * 100)}%`}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">
                    BB retention after raise
                  </div>
                  <div className="font-semibold">
                    {memory.bb_retention_after_increase == null
                      ? "—"
                      : `${Math.round(memory.bb_retention_after_increase * 100)}%`}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">
                    Recent outcome score
                  </div>
                  <div className="font-semibold">
                    {memory.recent_outcome_score == null
                      ? "—"
                      : `${Math.round(memory.recent_outcome_score * 100)}%`}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex justify-center py-6">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                </div>
              ) : events.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center">
                  No activity in the last 60 days.
                </div>
              ) : (
                <div className="relative pl-6">
                  <div className="absolute left-2 top-0 bottom-0 w-px bg-border" />
                  {events.map((e, i) => {
                    const Icon = iconFor(e);
                    return (
                      <div key={i} className="relative pb-3">
                        <div className="absolute -left-[18px] top-1 h-3 w-3 rounded-full bg-card border border-border" />
                        <div className="flex items-start gap-2">
                          <Icon
                            className={`h-4 w-4 mt-0.5 ${toneCls(e.tone)}`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span
                                className={`text-sm font-medium ${toneCls(e.tone)}`}
                              >
                                {e.title}
                              </span>
                              <Badge variant="outline" className="text-[10px]">
                                {new Date(e.ts).toLocaleString()}
                              </Badge>
                            </div>
                            {e.detail && (
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {e.detail}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {!loading && events.length > 0 && (
                <div className="flex items-center justify-between pt-4 border-t border-border/40 mt-4">
                  <div className="text-[11px] text-muted-foreground">
                    Showing last {windowDays} days · {events.length} events
                  </div>
                  {hasMore ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={loadingMore}
                      onClick={() =>
                        setWindowDays((d) =>
                          d < 60 ? 60 : d < 180 ? 180 : 365,
                        )
                      }
                    >
                      {loadingMore ? "Loading…" : "Load more history"}
                    </Button>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      End of history
                    </span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    </>
  );
}
