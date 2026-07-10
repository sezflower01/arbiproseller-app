import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Brain, TrendingUp, BarChart3, CheckCircle2, AlertTriangle,
  Clock, Zap, RotateCcw, ThumbsUp, ThumbsDown, Eye, Shield
} from "lucide-react";
import { toast } from "sonner";
import { format, subDays } from "date-fns";

interface LearningSignal {
  id: string;
  signal_key: string;
  signal_label: string;
  occurrence_count: number;
  affected_asin_count: number;
  avg_margin_gap: number | null;
  avg_bb_gap: number | null;
  recommendation_status: string;
  confidence_score: number | null;
  first_seen_at: string;
  last_seen_at: string;
  marketplace: string;
}

interface TuningRecommendation {
  id: string;
  recommendation_type: string;
  parameter_key: string;
  current_value: string | null;
  suggested_value: string | null;
  reason: string;
  supporting_signal_count: number;
  confidence_score: number | null;
  status: string;
  safety_bound_json: any;
  created_at: string;
}

interface TuningAction {
  id: string;
  parameter_key: string;
  old_value: string | null;
  new_value: string | null;
  applied_at: string;
  applied_by: string;
  rolled_back_at: string | null;
  outcome_summary: string | null;
}

export default function SmartEngineLearning() {
  const { user } = useAuth();
  const [signals, setSignals] = useState<LearningSignal[]>([]);
  const [recommendations, setRecommendations] = useState<TuningRecommendation[]>([]);
  const [actions, setActions] = useState<TuningAction[]>([]);
  const [stats, setStats] = useState({ batches14d: 0, signalsTracked: 0, activeRecs: 0, appliedActions: 0 });
  const [healthStats, setHealthStats] = useState({
    totalEvents: 0,
    deduplicatedEvents: 0,
    aiReviewedCases: 0,
    avgAiConfidence: "—",
    recsBlockedByThreshold: 0,
    recsDraft: 0,
    reviewRatio7d: "—",
    reviewRatio14d: "—",
    topCategories: [] as { label: string; count: number }[],
  });
  const [loading, setLoading] = useState(true);
  const [aggregating, setAggregating] = useState(false);

  const loadData = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);

    try {
      const since14d = subDays(new Date(), 14).toISOString();
      const since7d = subDays(new Date(), 7).toISOString();

      const [batchRes, signalRes, recRes, actionRes, activityCountRes, aiReviewRes, activity7dRes] = await Promise.all([
        supabase.from("smart_engine_review_batches").select("id", { count: "exact" }).gte("created_at", since14d),
        supabase.from("smart_engine_learning_signals").select("*").order("occurrence_count", { ascending: false }).limit(50),
        supabase.from("smart_engine_tuning_recommendations").select("*").order("created_at", { ascending: false }).limit(20),
        supabase.from("smart_engine_tuning_actions").select("*").order("applied_at", { ascending: false }).limit(20),
        supabase.from("smart_engine_activity_events").select("id", { count: "exact" }).gte("created_at", since14d),
        supabase.from("smart_engine_ai_reviews").select("ai_confidence, ai_judgment").gte("created_at", since14d),
        supabase.from("smart_engine_activity_events").select("event_type, tuning_signal").gte("created_at", since7d).limit(500),
      ]);

      const sigs = (signalRes.data || []) as LearningSignal[];
      const recs = (recRes.data || []) as TuningRecommendation[];
      setSignals(sigs);
      setRecommendations(recs);
      setActions((actionRes.data || []) as TuningAction[]);
      setStats({
        batches14d: batchRes.count || 0,
        signalsTracked: sigs.length,
        activeRecs: recs.filter(r => r.status === "draft" || r.status === "approved").length,
        appliedActions: (actionRes.data || []).filter(a => !a.rolled_back_at).length,
      });

      // Build health stats
      const aiReviews = aiReviewRes.data || [];
      const confMap: Record<string, number> = { high: 3, medium: 2, low: 1 };
      const avgConf = aiReviews.length > 0
        ? (aiReviews.reduce((s, r) => s + (confMap[r.ai_confidence as string] || 2), 0) / aiReviews.length)
        : 0;
      const avgLabel = avgConf >= 2.5 ? "High" : avgConf >= 1.5 ? "Medium" : avgConf > 0 ? "Low" : "—";

      // Count signals that are "watch" but have enough count but not enough evidence for recommendation
      const blockedByThreshold = sigs.filter(s =>
        s.occurrence_count >= 5 && s.occurrence_count < 10 && s.recommendation_status === "watch"
      ).length;

      // Review ratio from judgments metadata
      const calcReviewRatio = (windowSignals: LearningSignal[]) => {
        let totalJ = 0, reviewJ = 0;
        for (const s of windowSignals) {
          const meta = (s as any).metadata_json || {};
          const j = meta.judgments || {};
          totalJ += (j.correct || 0) + (j.contextual || 0) + (j.needs_review || 0);
          reviewJ += j.needs_review || 0;
        }
        return totalJ > 0 ? `${Math.round((reviewJ / totalJ) * 100)}%` : "—";
      };

      // Top event categories from 7d activity
      const catCounts = new Map<string, number>();
      for (const e of (activity7dRes.data || [])) {
        const label = (e.event_type as string) || "unknown";
        catCounts.set(label, (catCounts.get(label) || 0) + 1);
      }
      const topCats = Array.from(catCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([label, count]) => ({ label, count }));

      setHealthStats({
        totalEvents: activityCountRes.count || 0,
        deduplicatedEvents: activityCountRes.count || 0,
        aiReviewedCases: aiReviews.length,
        avgAiConfidence: avgLabel,
        recsBlockedByThreshold: blockedByThreshold,
        recsDraft: recs.filter(r => r.status === "draft").length,
        reviewRatio7d: calcReviewRatio(sigs.filter(s => s.last_seen_at >= since7d)),
        reviewRatio14d: calcReviewRatio(sigs),
        topCategories: topCats,
      });
    } catch (err) {
      console.error("Learning load error:", err);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { loadData(); }, [loadData]);

  // Aggregate signals from recent review items
  const runAggregation = useCallback(async () => {
    if (!user?.id) return;
    setAggregating(true);

    try {
      const since14d = subDays(new Date(), 14).toISOString();
      const since7d = subDays(new Date(), 7).toISOString();

      // Fetch from both activity events AND review items
      const [activityRes, reviewRes] = await Promise.all([
        supabase
          .from("smart_engine_activity_events")
          .select("*")
          .gte("created_at", since14d)
          .limit(1000),
        supabase
          .from("smart_engine_review_items")
          .select("*")
          .gte("created_at", since14d)
          .limit(1000),
      ]);

      // Merge both sources - activity events take priority
      const activityItems = (activityRes.data || []).map((e: any) => ({
        asin: e.asin,
        marketplace: e.marketplace,
        created_at: e.created_at,
        tuning_signals: [e.tuning_signal].filter(Boolean),
        judgment_reason: e.decision_label,
        current_price: e.current_price,
        next_competitor_price: e.next_competitor_price,
        buy_box_price: e.buy_box_price,
      }));
      const reviewItems2 = (reviewRes.data || []).map((r: any) => ({
        asin: r.asin,
        marketplace: r.marketplace,
        created_at: r.created_at,
        tuning_signals: r.tuning_signals || [],
        judgment_reason: r.judgment_reason,
        current_price: r.current_price,
        next_competitor_price: r.next_competitor_price,
        buy_box_price: r.buy_box_price,
      }));

      // Deduplicate by asin+marketplace+signal within 2h windows
      const allRaw = [...activityItems, ...reviewItems2];
      const dedupeMap = new Map<string, typeof allRaw[0]>();
      for (const item of allRaw) {
        for (const sig of (item.tuning_signals || [])) {
          const hourBucket = Math.floor(new Date(item.created_at).getTime() / (2 * 3600000));
          const key = `${item.asin}::${item.marketplace}::${sig}::${hourBucket}`;
          if (!dedupeMap.has(key)) {
            dedupeMap.set(key, item);
          }
        }
      }
      const items = Array.from(dedupeMap.values());

      if (items.length === 0) {
        toast.info("No learning data in the last 14 days. Run Smart Engine Review batches first.");
        setAggregating(false);
        return;
      }

      // Aggregate signals
      const signalMap = new Map<string, {
        label: string;
        count: number;
        count7d: number;
        asins: Set<string>;
        marginGaps: number[];
        bbGaps: number[];
        marketplace: string;
        firstSeen: string;
        lastSeen: string;
        judgments: { correct: number; contextual: number; needs_review: number };
      }>();

      for (const item of items) {
        const sigs = item.tuning_signals || [];
        const isRecent7d = item.created_at >= since7d;
        const judgmentType = (item.judgment_reason || "").toLowerCase();
        const jCategory = judgmentType.includes("hold:") || judgmentType.includes("contextual")
          ? "contextual" : judgmentType.includes("needs review") ? "needs_review" : "correct";

        for (const sig of sigs) {
          const key = sig.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").substring(0, 100);
          const existing = signalMap.get(key);
          const marginGap = item.next_competitor_price && item.current_price
            ? Number(item.next_competitor_price) - Number(item.current_price) : null;
          const bbGap = item.buy_box_price && item.current_price
            ? Number(item.current_price) - Number(item.buy_box_price) : null;

          if (existing) {
            existing.count++;
            if (isRecent7d) existing.count7d++;
            existing.asins.add(item.asin);
            if (marginGap != null) existing.marginGaps.push(marginGap);
            if (bbGap != null) existing.bbGaps.push(bbGap);
            if (item.created_at < existing.firstSeen) existing.firstSeen = item.created_at;
            if (item.created_at > existing.lastSeen) existing.lastSeen = item.created_at;
            existing.judgments[jCategory]++;
          } else {
            signalMap.set(key, {
              label: sig,
              count: 1,
              count7d: isRecent7d ? 1 : 0,
              asins: new Set([item.asin]),
              marginGaps: marginGap != null ? [marginGap] : [],
              bbGaps: bbGap != null ? [bbGap] : [],
              marketplace: item.marketplace || "US",
              firstSeen: item.created_at,
              lastSeen: item.created_at,
              judgments: { correct: jCategory === "correct" ? 1 : 0, contextual: jCategory === "contextual" ? 1 : 0, needs_review: jCategory === "needs_review" ? 1 : 0 },
            });
          }
        }
      }

      // Upsert signals with enriched metadata
      for (const [key, data] of signalMap) {
        const avgMargin = data.marginGaps.length > 0
          ? data.marginGaps.reduce((a, b) => a + b, 0) / data.marginGaps.length : null;
        const avgBb = data.bbGaps.length > 0
          ? data.bbGaps.reduce((a, b) => a + b, 0) / data.bbGaps.length : null;

        const confidence = Math.min(100, (data.count / 10) * 50 + (data.asins.size / 5) * 50);
        const status = confidence >= 80 && data.count >= 10 && data.asins.size >= 5
          ? "suggest" : confidence >= 50 ? "watch" : "watch";

        await supabase.from("smart_engine_learning_signals").upsert({
          user_id: user.id,
          marketplace: data.marketplace,
          signal_key: key,
          signal_label: data.label,
          occurrence_count: data.count,
          affected_asin_count: data.asins.size,
          avg_margin_gap: avgMargin ? Math.round(avgMargin * 100) / 100 : null,
          avg_bb_gap: avgBb ? Math.round(avgBb * 100) / 100 : null,
          recommendation_status: status,
          confidence_score: Math.round(confidence),
          first_seen_at: data.firstSeen,
          last_seen_at: data.lastSeen,
          metadata_json: {
            count_7d: data.count7d,
            count_14d: data.count,
            judgments: data.judgments,
          },
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,marketplace,signal_key" });
      }

      // Generate recommendations gated by internal evidence thresholds
      // Requirements: ≥10 occurrences, ≥5 distinct ASINs, seen in last 7d, ≥60% non-review judgments
      const highConfidence = Array.from(signalMap.entries())
        .filter(([_, d]) => {
          if (d.count < 10 || d.asins.size < 5) return false;
          if (d.count7d === 0) return false; // must be recent
          const jTotal = d.judgments.correct + d.judgments.contextual + d.judgments.needs_review;
          const reviewRatio = jTotal > 0 ? d.judgments.needs_review / jTotal : 0;
          // Only recommend if review signals are meaningful (≥20%) OR pattern is very consistent
          return reviewRatio >= 0.2 || (d.count >= 20 && d.asins.size >= 8);
        });

      for (const [key, data] of highConfidence) {
        const rec = generateRecommendation(key, data);
        if (rec) {
          const { data: existing } = await supabase
            .from("smart_engine_tuning_recommendations")
            .select("id")
            .eq("parameter_key", rec.parameter_key)
            .eq("recommendation_type", rec.recommendation_type)
            .in("status", ["draft", "approved"])
            .limit(1);

          if (!existing || existing.length === 0) {
            const { data: sigRow } = await supabase
              .from("smart_engine_learning_signals")
              .select("id")
              .eq("signal_key", key)
              .eq("user_id", user.id)
              .limit(1);

            await supabase.from("smart_engine_tuning_recommendations").insert({
              user_id: user.id,
              signal_id: sigRow?.[0]?.id || null,
              recommendation_type: rec.recommendation_type,
              parameter_key: rec.parameter_key,
              current_value: rec.current_value,
              suggested_value: rec.suggested_value,
              reason: `${rec.reason} (Evidence: ${data.count} events, ${data.asins.size} ASINs, ${data.count7d} in last 7d)`,
              supporting_signal_count: data.count,
              confidence_score: Math.min(100, (data.count / 10) * 50 + (data.asins.size / 5) * 50),
              status: "draft",
              safety_bound_json: rec.safety_bound,
            });
          }
        }
      }

      toast.success(`Aggregated ${signalMap.size} signals from ${items.length} reviews`);
      await loadData();
    } catch (err) {
      console.error("Aggregation error:", err);
      toast.error("Failed to aggregate signals");
    } finally {
      setAggregating(false);
    }
  }, [user?.id, loadData]);

  const updateRecStatus = useCallback(async (id: string, status: string) => {
    await supabase.from("smart_engine_tuning_recommendations")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    toast.success(`Recommendation ${status}`);
    loadData();
  }, [loadData]);

  const launchExperiment = useCallback(async (id: string) => {
    const t = toast.loading("Launching experiment…");
    try {
      const { data, error } = await supabase.functions.invoke("smart-engine-apply-tuning", {
        body: { recommendation_id: id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error(JSON.stringify((data as any).error));
      const d = data as {
        treatment_size: number; control_size: number;
        is_observational: boolean; reason?: string | null;
      };
      toast.success(
        d.is_observational
          ? `Applied (observational): ${d.treatment_size} ASINs — ${d.reason ?? "below min sample"}`
          : `Experiment live: ${d.treatment_size} treatment / ${d.control_size} control`,
        { id: t },
      );
      loadData();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`, { id: t });
    }
  }, [loadData]);

  const statusColor = (s: string) => {
    if (s === "suggest") return "text-amber-600";
    if (s === "approved" || s === "applied") return "text-green-600";
    if (s === "rejected" || s === "dismissed") return "text-muted-foreground";
    return "text-blue-600";
  };

  const confidenceBadge = (score: number | null) => {
    if (score == null) return <Badge variant="outline" className="text-[10px]">—</Badge>;
    if (score >= 80) return <Badge className="bg-green-100 text-green-800 text-[10px]">{score}%</Badge>;
    if (score >= 50) return <Badge className="bg-amber-100 text-amber-800 text-[10px]">{score}%</Badge>;
    return <Badge variant="outline" className="text-[10px]">{score}%</Badge>;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Brain className="h-5 w-5 text-primary" />
            Smart Engine Learning
          </h2>
          <p className="text-sm text-muted-foreground">
            Activity-driven learning from all repricer decisions — AI-enhanced analysis available
          </p>
        </div>
        <Button onClick={runAggregation} disabled={aggregating} size="sm">
          <Zap className={`h-3.5 w-3.5 mr-1 ${aggregating ? "animate-pulse" : ""}`} />
          {aggregating ? "Aggregating..." : "Run Aggregation"}
        </Button>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<BarChart3 className="h-4 w-4" />} label="Reviews (14d)" value={stats.batches14d} />
        <StatCard icon={<Eye className="h-4 w-4" />} label="Signals Tracked" value={stats.signalsTracked} />
        <StatCard icon={<Zap className="h-4 w-4" />} label="Active Recommendations" value={stats.activeRecs} />
        <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="Applied Actions" value={stats.appliedActions} />
      </div>

      <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
        <Shield className="h-4 w-4 text-amber-600 shrink-0" />
        <span className="text-xs text-amber-800 dark:text-amber-200">
          <strong>Safety mode:</strong> Manual approval only. Auto-tuning is disabled. Recommendations never change min/max price, cost, or user safety settings.
        </span>
      </div>

      {/* Learning Quality Panel */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="h-4 w-4" /> Learning Quality
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
            <div>
              <p className="text-muted-foreground mb-0.5">Total Events (14d)</p>
              <p className="text-lg font-bold">{healthStats.totalEvents}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">AI-Observed Cases</p>
              <p className="text-lg font-bold">{healthStats.aiReviewedCases}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Avg AI Confidence</p>
              <p className="text-lg font-bold">{healthStats.avgAiConfidence}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Draft Recommendations</p>
              <p className="text-lg font-bold">{healthStats.recsDraft}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Blocked by Threshold</p>
              <p className="text-lg font-bold">{healthStats.recsBlockedByThreshold}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Review Ratio (7d)</p>
              <p className="text-lg font-bold">{healthStats.reviewRatio7d}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Review Ratio (14d)</p>
              <p className="text-lg font-bold">{healthStats.reviewRatio14d}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Top Signal Categories</p>
              {healthStats.topCategories.length > 0 ? (
                <div className="space-y-0.5 mt-0.5">
                  {healthStats.topCategories.map(c => (
                    <div key={c.label} className="flex justify-between">
                      <span className="truncate mr-2">{c.label}</span>
                      <span className="font-medium">{c.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">—</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> Repeated Patterns
          </CardTitle>
        </CardHeader>
        <CardContent>
          {signals.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No signals yet. Run Smart Engine Review batches, then aggregate.
            </p>
          ) : (
            <ScrollArea className="max-h-[500px]">
              <div className="space-y-3">
                {signals.map(sig => {
                  const meta = (sig as any).metadata_json || {};
                  const count7d = meta.count_7d ?? 0;
                  const count14d = meta.count_14d ?? sig.occurrence_count;
                  const judgments = meta.judgments || {};
                  const jTotal = (judgments.correct || 0) + (judgments.contextual || 0) + (judgments.needs_review || 0);
                  const correctPct = jTotal > 0 ? Math.round(((judgments.correct || 0) / jTotal) * 100) : 0;
                  const contextPct = jTotal > 0 ? Math.round(((judgments.contextual || 0) / jTotal) * 100) : 0;
                  const reviewPct = jTotal > 0 ? Math.round(((judgments.needs_review || 0) / jTotal) * 100) : 0;

                  // Status label
                  const patternLabel = sig.occurrence_count >= 10 && sig.affected_asin_count >= 5
                    ? "Recommendation candidate"
                    : sig.occurrence_count >= 5
                    ? "Emerging pattern"
                    : count7d > 0
                    ? "Watch pattern"
                    : "Healthy pattern";
                  const labelColor = patternLabel === "Recommendation candidate"
                    ? "text-primary"
                    : patternLabel === "Emerging pattern"
                    ? "text-amber-600"
                    : patternLabel === "Watch pattern"
                    ? "text-blue-500"
                    : "text-green-600";

                  return (
                    <div key={sig.id} className="px-3 py-3 bg-muted/30 rounded-lg text-xs space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{sig.signal_label}</p>
                          <p className="text-muted-foreground">
                            {sig.occurrence_count} occurrences · {sig.affected_asin_count} ASINs · {sig.marketplace}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {sig.avg_bb_gap != null && (
                            <span className="text-muted-foreground">BB gap: ${sig.avg_bb_gap.toFixed(2)}</span>
                          )}
                          {confidenceBadge(sig.confidence_score)}
                          <Badge variant="outline" className={`text-[10px] ${statusColor(sig.recommendation_status)}`}>
                            {sig.recommendation_status}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 flex-wrap text-muted-foreground">
                        <span>7d: <strong className="text-foreground">{count7d}</strong></span>
                        <span>14d: <strong className="text-foreground">{count14d}</strong></span>
                        <span>Last seen: <strong className="text-foreground">{format(new Date(sig.last_seen_at), "MMM d, h:mm a")}</strong></span>
                        <span className={`font-semibold ${labelColor}`}>{patternLabel}</span>
                      </div>
                      {jTotal > 0 && (
                        <div className="flex items-center gap-3">
                          <span className="text-green-600">✓ {correctPct}% correct</span>
                          <span className="text-amber-600">◐ {contextPct}% contextual</span>
                          {reviewPct > 0 && <span className="text-red-500">⚠ {reviewPct}% needs review</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Recommendations */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="h-4 w-4" /> Tuning Recommendations
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recommendations.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No recommendations yet. Signals need ≥10 occurrences across ≥5 ASINs.
            </p>
          ) : (
            <div className="space-y-3">
              {recommendations.map(rec => (
                <div key={rec.id} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{rec.recommendation_type}</Badge>
                      <span className="text-sm font-medium font-mono">{rec.parameter_key}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {confidenceBadge(rec.confidence_score)}
                      <Badge variant={rec.status === "draft" ? "secondary" : rec.status === "applied" ? "default" : "outline"} className="text-[10px]">
                        {rec.status}
                      </Badge>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{rec.reason}</p>
                  <div className="flex items-center gap-4 text-xs">
                    <span>Current: <code className="bg-muted px-1 rounded">{rec.current_value ?? "—"}</code></span>
                    <span>→</span>
                    <span>Suggested: <code className="bg-primary/10 text-primary px-1 rounded">{rec.suggested_value ?? "—"}</code></span>
                    <span className="text-muted-foreground">{rec.supporting_signal_count} signals</span>
                  </div>
                  {rec.safety_bound_json && (
                    <p className="text-[10px] text-muted-foreground">
                      Safety bounds: {JSON.stringify(rec.safety_bound_json)}
                    </p>
                  )}
                  {(rec.status === "draft" || rec.status === "approved") && (
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" className="h-7 text-xs" onClick={() => launchExperiment(rec.id)}>
                        <Zap className="h-3 w-3 mr-1" /> Launch experiment
                      </Button>
                      {rec.status === "draft" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateRecStatus(rec.id, "approved")}>
                          <ThumbsUp className="h-3 w-3 mr-1" /> Approve only
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => updateRecStatus(rec.id, "dismissed")}>
                        <ThumbsDown className="h-3 w-3 mr-1" /> Dismiss
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Applied Changes */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" /> Applied Changes
          </CardTitle>
        </CardHeader>
        <CardContent>
          {actions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No tuning actions applied yet.
            </p>
          ) : (
            <div className="space-y-2">
              {actions.map(act => (
                <div key={act.id} className="flex items-center justify-between px-3 py-2 bg-muted/30 rounded-lg text-xs">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-medium">{act.parameter_key}</span>
                    <span><code>{act.old_value}</code> → <code>{act.new_value}</code></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{format(new Date(act.applied_at), "PP")}</span>
                    {act.rolled_back_at ? (
                      <Badge variant="outline" className="text-[10px] text-red-500">rolled back</Badge>
                    ) : (
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2">
                        <RotateCcw className="h-3 w-3 mr-1" /> Rollback
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">{icon} {label}</div>
        <p className="text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}

// Generate bounded recommendations from signal patterns
function generateRecommendation(signalKey: string, data: { label: string; count: number; asins: Set<string>; marginGaps: number[]; bbGaps: number[] }) {
  const avgMargin = data.marginGaps.length > 0
    ? data.marginGaps.reduce((a, b) => a + b, 0) / data.marginGaps.length : 0;

  // Raise too conservative
  if (signalKey.includes("raise_progressing") || signalKey.includes("moderate_gap")) {
    return {
      recommendation_type: "raise_step",
      parameter_key: "raise_micro_step_pct",
      current_value: "1%",
      suggested_value: "2%",
      reason: `${data.count} reviews show raise is progressing but gap remains (avg $${avgMargin.toFixed(2)}). Increasing raise step could capture margin faster.`,
      safety_bound: { min: 0.5, max: 3, unit: "%" },
    };
  }

  // Recapture slow
  if (signalKey.includes("recapture_slow") || signalKey.includes("no_competitive_moves")) {
    return {
      recommendation_type: "urgency",
      parameter_key: "bb_rotation_patience",
      current_value: "5",
      suggested_value: "3",
      reason: `${data.count} reviews show slow recapture with no competitive moves. Reducing patience could speed BB recovery.`,
      safety_bound: { min: 1, max: 10, unit: "cycles" },
    };
  }

  // Floor prevents recapture (many times)
  if (signalKey.includes("floor_prevents") || signalKey.includes("unprofitable_market")) {
    return {
      recommendation_type: "floor_review",
      parameter_key: "auto_floor_aggressiveness",
      current_value: "moderate",
      suggested_value: "conservative",
      reason: `${data.count} ASINs are permanently blocked by floor. Consider reviewing auto-floor restore speed.`,
      safety_bound: { options: ["conservative", "moderate", "aggressive"] },
    };
  }

  // Filtered competitor holding well
  if (signalKey.includes("filtered_competitor") || signalKey.includes("not_worth_chasing")) {
    // No change needed — this is healthy
    return null;
  }

  return null;
}
