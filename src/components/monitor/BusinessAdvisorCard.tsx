import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sparkles, RefreshCw, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

type Insight = {
  id: string;
  generated_at: string;
  category: string;
  severity: "info" | "watch" | "important";
  headline: string;
  body: string;
  affected_asins: number | null;
  marketplace: string | null;
  acknowledged_at: string | null;
};

const sevColor: Record<Insight["severity"], string> = {
  info: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  watch: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  important: "bg-red-500/15 text-red-300 border-red-500/30",
};

export default function BusinessAdvisorCard() {
  const { user } = useAuth();
  const [items, setItems] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("repricer_strategic_insights")
      .select("*")
      .eq("user_id", user.id)
      .eq("suppressed", false)
      .is("acknowledged_at", null)
      .in("impact_tier", ["high", "medium"])
      .order("impact_tier", { ascending: true }) // high first via custom order below
      .order("generated_at", { ascending: false })
      .limit(10);
    // Sort high → medium and de-duplicate by normalized headline so we never
    // show two cards saying the same thing.
    const sorted = (data as Insight[] | null ?? []).slice().sort((a: any, b: any) => {
      const order = { high: 0, medium: 1, low: 2 } as Record<string, number>;
      return (order[a.impact_tier ?? "medium"] ?? 1) - (order[b.impact_tier ?? "medium"] ?? 1);
    });
    const seen = new Set<string>();
    const deduped = sorted.filter((i) => {
      const key = (i.headline || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setItems(deduped);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [user]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const { error } = await supabase.functions.invoke(
        "repricer-business-advisor",
      );
      if (error) throw error;
      await load();
      toast.success("Advice updated");
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't refresh advice");
    } finally {
      setRefreshing(false);
    }
  };

  const dismiss = async (id: string) => {
    await supabase
      .from("repricer_strategic_insights")
      .update({ acknowledged_at: new Date().toISOString() })
      .eq("id", id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Business advisor
          {items.length > 0 && (
            <Badge variant="outline">{items.length}</Badge>
          )}
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={refreshing}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 mr-1 ${refreshing ? "animate-spin" : ""}`}
          />
          {refreshing ? "Thinking…" : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex justify-center py-4">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No new advice this week. We'll surface guidance once there's a meaningful pattern.
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <div
                key={it.id}
                className={`rounded-lg border p-3 ${sevColor[it.severity]}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-sm font-semibold">
                        {it.headline}
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[10px] capitalize"
                      >
                        {it.category}
                      </Badge>
                      {it.marketplace && (
                        <Badge variant="outline" className="text-[10px]">
                          {it.marketplace}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs leading-relaxed text-foreground/90">
                      {it.body}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => dismiss(it.id)}
                    title="Acknowledge"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
