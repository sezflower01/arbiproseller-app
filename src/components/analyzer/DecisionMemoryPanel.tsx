import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ShoppingCart, X, Eye, Check, Brain } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import {
  logAnalyzerDecision,
  recordAnalyzerAction,
  type AnalyzerSource,
  type DecisionSnapshotInput,
} from "@/lib/analyzer/decisionMemory";

interface Props {
  snapshot: DecisionSnapshotInput;
  source?: AnalyzerSource;
  /** When `snapshot.asin` changes, re-arm logging. */
  reArmKey?: string;
}

/**
 * Auto-logs an analyzer scan snapshot (debounced) and shows
 * Buy / Skip / Watch buttons that write to analyzer_decision_action.
 * Phase 1: data capture only. No AI, no rules.
 */
export default function DecisionMemoryPanel({ snapshot, source = "web", reArmKey }: Props) {
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  const lastKey = useRef<string | null>(null);

  // Auto-log on snapshot change (debounced 1.5s so costs/sale price settle).
  useEffect(() => {
    if (!snapshot?.asin) return;
    const key = reArmKey || `${snapshot.asin}:${snapshot.marketplace || "US"}`;
    if (lastKey.current === key) return;
    const t = setTimeout(async () => {
      const { id } = await logAnalyzerDecision({ ...snapshot, source });
      if (id) {
        setDecisionId(id);
        setRecorded(null);
        lastKey.current = key;
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [snapshot, source, reArmKey]);

  const handleAction = async (action: "buy" | "skip" | "watch") => {
    if (!decisionId) {
      // Force a log right now if dedup blocked it
      const { id } = await logAnalyzerDecision({ ...snapshot, source });
      if (!id) {
        toast({ title: "Sign in to save decisions", variant: "destructive" });
        return;
      }
      setDecisionId(id);
    }
    const id = decisionId;
    setPending(action);
    const res = await recordAnalyzerAction({
      decisionId: id!,
      asin: snapshot.asin,
      marketplace: snapshot.marketplace,
      action,
    });
    setPending(null);
    if (res.ok) {
      setRecorded(action);
      toast({ title: `Saved: ${action.toUpperCase()}` });
    } else {
      toast({ title: "Could not save action", description: res.error, variant: "destructive" });
    }
  };

  const btnClass = (a: string) =>
    `flex-1 ${recorded === a ? "ring-2 ring-primary" : ""}`;

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Brain className="w-4 h-4 text-primary" />
          <span>Decision Memory</span>
          {decisionId && <Check className="w-3.5 h-3.5 text-emerald-500" />}
        </div>
        <p className="text-xs text-muted-foreground">
          Every scan is saved. Tell the system what you decided so it can learn over time.
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={recorded === "buy" ? "default" : "outline"}
            className={btnClass("buy")}
            disabled={!!pending}
            onClick={() => handleAction("buy")}
          >
            <ShoppingCart className="w-3.5 h-3.5 mr-1" /> Buy
          </Button>
          <Button
            size="sm"
            variant={recorded === "skip" ? "default" : "outline"}
            className={btnClass("skip")}
            disabled={!!pending}
            onClick={() => handleAction("skip")}
          >
            <X className="w-3.5 h-3.5 mr-1" /> Skip
          </Button>
          <Button
            size="sm"
            variant={recorded === "watch" ? "default" : "outline"}
            className={btnClass("watch")}
            disabled={!!pending}
            onClick={() => handleAction("watch")}
          >
            <Eye className="w-3.5 h-3.5 mr-1" /> Watch
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
