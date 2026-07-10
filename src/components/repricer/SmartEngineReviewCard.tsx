import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, HelpCircle, TrendingUp, TrendingDown, Minus, Brain, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import { formatPrice } from "@/lib/marketplaceCurrency";
import type { ReviewAsin } from "./SmartEngineReview";

interface SmartEngineReviewCardProps {
  item: ReviewAsin;
}

const categoryLabel: Record<string, string> = {
  bb_loss: "BB Loss",
  raised: "Price Raised",
  constrained: "Held/Constrained",
  floor_hit: "Floor Protection",
  winner: "BB Winner",
};

const categoryStyles: Record<string, string> = {
  bb_loss: "bg-destructive/10 text-destructive border-destructive/20",
  raised: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  constrained: "bg-muted text-muted-foreground border-border",
  floor_hit: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  winner: "bg-primary/10 text-primary border-primary/20",
};

function judgmentIcon(j: string) {
  if (j === "correct") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (j === "contextual_correct") return <CheckCircle2 className="h-4 w-4 text-yellow-500" />;
  return <AlertTriangle className="h-4 w-4 text-red-500" />;
}

function actionIcon(cat: string) {
  if (cat === "raised") return <TrendingUp className="h-3.5 w-3.5" />;
  if (cat === "bb_loss") return <TrendingDown className="h-3.5 w-3.5" />;
  return <Minus className="h-3.5 w-3.5" />;
}

function DeltaIndicator({ oldPrice, newPrice, marketplace }: { oldPrice: number | null; newPrice: number | null; marketplace: string }) {
  if (oldPrice == null || newPrice == null) return null;
  const delta = newPrice - oldPrice;
  if (Math.abs(delta) < 0.005) return <Badge variant="secondary" className="text-[10px] py-0">Held</Badge>;
  const isUp = delta > 0;
  return (
    <Badge className={`text-[10px] py-0 ${isUp ? "bg-green-500/10 text-green-700 dark:text-green-400" : "bg-red-500/10 text-red-700 dark:text-red-400"}`}>
      {isUp ? <TrendingUp className="h-3 w-3 mr-0.5" /> : <TrendingDown className="h-3 w-3 mr-0.5" />}
      {isUp ? "+" : ""}{formatPrice(delta, marketplace)}
    </Badge>
  );
}

function PriceValue({ value, marketplace, unavailableReason }: { value: number | null; marketplace: string; unavailableReason?: string }) {
  if (value != null) return <span className="font-mono font-medium">{formatPrice(value, marketplace)}</span>;
  return <span className="text-muted-foreground italic text-[10px]">{unavailableReason || "No data"}</span>;
}

export default function SmartEngineReviewCard({ item }: SmartEngineReviewCardProps) {
  const [whyHeldOpen, setWhyHeldOpen] = useState(false);

  const mp = item.marketplace;
  const delta = item.lastAction ? (item.lastAction.new_price ?? 0) - (item.lastAction.old_price ?? 0) : null;
  const gap = item.nextCompetitor != null && item.currentPrice != null 
    ? item.nextCompetitor - item.currentPrice 
    : null;

  const bbUnavailableReason = item.bbPrice == null
    ? (item.lastAction?.intelligence_factors?.position_proof?.buybox_price == null ? "Not available" : "Filtered out")
    : undefined;
  const fbaUnavailableReason = item.lowestFba == null
    ? (item.lastAction?.intelligence_factors?.price_trace?.lowest_fba == null ? "Not available" : "Filtered out")
    : undefined;

  return (
    <Card>
      <CardHeader className="pb-2">
        {/* Top bar: category badge + judgment + AI */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            {item.imageUrl && <img src={item.imageUrl} alt="" className="h-8 w-8 rounded object-cover" />}
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm font-mono">{item.asin}</CardTitle>
                <Badge className={`text-[10px] gap-1 ${categoryStyles[item.category]}`}>
                  {actionIcon(item.category)} {categoryLabel[item.category]}
                </Badge>
                <DeltaIndicator 
                  oldPrice={item.lastAction?.old_price} 
                  newPrice={item.lastAction?.new_price} 
                  marketplace={mp} 
                />
              </div>
              <p className="text-xs text-muted-foreground truncate max-w-[500px]">
                {item.title} {item.sku ? `· ${item.sku}` : ""} · {mp}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {judgmentIcon(item.judgment)}
            {item.aiJudgment && (
              <Badge className={`text-[10px] ${
                item.aiJudgment === "optimal" ? "bg-green-500/10 text-green-700 dark:text-green-400" :
                item.aiJudgment === "needs_review" ? "bg-red-500/10 text-red-700 dark:text-red-400" :
                "bg-amber-500/10 text-amber-700 dark:text-amber-400"
              }`}>
                🤖 {item.aiJudgment}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Decision summary row */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
          <div className="bg-muted/30 rounded px-2 py-1.5">
            <span className="text-muted-foreground block">My Price</span>
            <PriceValue value={item.currentPrice} marketplace={mp} />
          </div>
          <div className="bg-muted/30 rounded px-2 py-1.5">
            <span className="text-muted-foreground block">Buy Box</span>
            <PriceValue value={item.bbPrice} marketplace={mp} unavailableReason={bbUnavailableReason} />
          </div>
          <div className="bg-muted/30 rounded px-2 py-1.5">
            <span className="text-muted-foreground block">Lowest FBA</span>
            <PriceValue value={item.lowestFba} marketplace={mp} unavailableReason={fbaUnavailableReason} />
          </div>
          <div className="bg-muted/30 rounded px-2 py-1.5">
            <span className="text-muted-foreground block">Floor</span>
            <PriceValue value={item.minPrice} marketplace={mp} />
          </div>
          <div className="bg-muted/30 rounded px-2 py-1.5">
            <span className="text-muted-foreground block">Gap</span>
            <span className="font-mono font-medium">
              {gap != null ? formatPrice(gap, mp) : <span className="text-muted-foreground italic text-[10px]">—</span>}
            </span>
          </div>
          <div className="bg-muted/30 rounded px-2 py-1.5">
            <span className="text-muted-foreground block">Last Action</span>
            <span className="font-medium text-[10px]">
              {item.lastAction ? (
                Math.abs(delta ?? 0) < 0.005 ? "Held" : delta! > 0 ? "Raised" : "Lowered"
              ) : "—"}
            </span>
          </div>
        </div>

        {/* BB status badge */}
        <div className="flex items-center gap-2 text-xs">
          <Badge variant={item.bbOwner ? "default" : "secondary"} className="text-[10px]">
            {item.bbOwner ? "BB Owner" : "Not BB Owner"}
          </Badge>
          {item.bbOwner && item.currentPrice != null && item.bbPrice != null && Math.abs(item.currentPrice - item.bbPrice) > 0.50 && (
            <span className="text-muted-foreground text-[10px] italic">
              BB ownership from latest offer snapshot — displayed price reflects pending update
            </span>
          )}
        </div>

        <Separator />

        {/* What happened - only the narrative, not the judgment reason */}
        <div>
          <h5 className="text-xs font-semibold text-muted-foreground uppercase mb-1">What happened</h5>
          <p className="text-sm bg-primary/5 p-3 rounded-md border border-primary/10 leading-relaxed">
            {item.explanation}
          </p>
        </div>

        {/* AI Analysis */}
        {item.aiReasoning && (
          <div>
            <h5 className="text-xs font-semibold text-muted-foreground uppercase mb-1 flex items-center gap-1">
              <Brain className="h-3 w-3" /> AI Analysis
            </h5>
            <div className="bg-primary/5 p-3 rounded-md border border-primary/10 space-y-1">
              <p className="text-sm leading-relaxed">{item.aiReasoning}</p>
              {item.aiSuggestion && item.aiSuggestion !== "No change needed." && (
                <p className="text-xs text-primary font-medium">💡 {item.aiSuggestion}</p>
              )}
              {item.aiConfidence && (
                <Badge variant="outline" className="text-[9px]">confidence: {item.aiConfidence}</Badge>
              )}
            </div>
          </div>
        )}

        {/* Why held? - expandable blocker section */}
        {item.blockers && item.blockers.length > 0 && (
          <div>
            <button
              onClick={() => setWhyHeldOpen(!whyHeldOpen)}
              className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase hover:text-foreground transition-colors"
            >
              {whyHeldOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Why held? · {item.blockers.length} blocker{item.blockers.length > 1 ? "s" : ""}
            </button>
            {whyHeldOpen && (
              <div className="mt-2 space-y-1">
                {item.blockers.map((b, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-1 px-2 bg-amber-500/5 border border-amber-500/10 rounded">
                    <span className="text-amber-600 dark:text-amber-400">🛡️</span>
                    <span>{b}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Latest action context - always show */}
        {item.lastAction && (
          <div>
            <h5 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Latest Action</h5>
            <div className="space-y-1">
              {(item.recentActions.length > 0 ? item.recentActions.slice(0, 5) : [item.lastAction]).map((a: any, i: number) => {
                const isNoChange = a.action_type === "no_change" || Math.abs((a.new_price ?? 0) - (a.old_price ?? 0)) < 0.005;
                const d = (a.new_price ?? 0) - (a.old_price ?? 0);
                return (
                  <div key={a.id || i} className="flex items-center justify-between text-xs py-1 px-2 bg-muted/30 rounded">
                    <span className="text-muted-foreground">{format(new Date(a.created_at), "HH:mm")}</span>
                    {isNoChange ? (
                      <span className="font-mono text-muted-foreground">Held at {formatPrice(a.old_price, mp)}</span>
                    ) : (
                      <span className="font-mono">{formatPrice(a.old_price, mp)} → {formatPrice(a.new_price, mp)}</span>
                    )}
                    <span className={isNoChange ? "text-muted-foreground" : d > 0 ? "text-green-600" : "text-red-500"}>
                      {isNoChange ? "—" : `${d > 0 ? "+" : ""}${formatPrice(d, mp)}`}
                    </span>
                    <Badge variant="outline" className="text-[9px]">{isNoChange ? "hold" : a.action_type}</Badge>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <Separator />

        {/* Tuning Signals */}
        <div>
          <h5 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Tuning Signals</h5>
          <div className="space-y-1">
            {item.tuningSignals.map((s, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className="mt-0.5">
                  {s.includes("No issues") || s.includes("Stable") ? (
                    <CheckCircle2 className="h-3 w-3 text-green-500" />
                  ) : s.includes("Needs review") || s.includes("too slow") || s.includes("too conservative") ? (
                    <AlertTriangle className="h-3 w-3 text-red-500" />
                  ) : (
                    <HelpCircle className="h-3 w-3 text-yellow-500" />
                  )}
                </span>
                <span>{s}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
