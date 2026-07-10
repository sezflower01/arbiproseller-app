import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Activity, Shield, TrendingUp, ShoppingCart, Zap } from "lucide-react";
import type { MonitorData } from "@/hooks/use-monitor-data";

interface ScoreItem {
  label: string;
  value: number; // 0-100
  icon: React.ReactNode;
  hint: string;
}

function scoreColor(v: number) {
  if (v >= 85) return "text-[hsl(var(--status-healthy))]";
  if (v >= 65) return "text-[hsl(var(--status-info))]";
  if (v >= 40) return "text-[hsl(var(--status-review))]";
  return "text-[hsl(var(--status-urgent))]";
}

export default function BusinessHealthScore({ data }: { data: MonitorData }) {
  const q = data.quotaHealth;

  const pricingHealth = Math.round(data.feedCompletionRate ?? 0);
  const automation = Math.round(q.eligibleCoveragePercent ?? 0);
  const profitSafety = (() => {
    const active = Math.max(1, q.activeAssignments);
    const blocked = data.profitGuardBlocks || 0;
    return Math.max(0, Math.round(100 - (blocked / active) * 100));
  })();
  const apiHealth = (() => {
    const total = q.totalSnapshots || 1;
    const bad = (q.emptySnapshots || 0) + (q.quotaErrors24h || 0);
    return Math.max(0, Math.round(100 - (bad / total) * 100));
  })();
  const verification = Math.round(data.verificationRate ?? 0);

  const items: ScoreItem[] = [
    { label: "Pricing Health", value: pricingHealth, icon: <Activity className="h-4 w-4" />, hint: "How reliably your prices are reaching Amazon." },
    { label: "Buy Box Control", value: verification, icon: <ShoppingCart className="h-4 w-4" />, hint: "How often your submitted prices match what's live." },
    { label: "Profit Safety", value: profitSafety, icon: <Shield className="h-4 w-4" />, hint: "How well your minimum-price rules are protecting margin." },
    { label: "Automation Efficiency", value: automation, icon: <Zap className="h-4 w-4" />, hint: "Share of eligible listings checked today." },
    { label: "Market Data Quality", value: apiHealth, icon: <TrendingUp className="h-4 w-4" />, hint: "Health of competitor data feeds." },
  ];

  const overall = Math.round(items.reduce((s, i) => s + i.value, 0) / items.length);
  const overallLabel = overall >= 85 ? "Excellent" : overall >= 65 ? "Healthy" : overall >= 40 ? "Needs attention" : "Critical";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Business Health</CardTitle>
          <div className="text-right">
            <div className={`text-3xl font-bold ${scoreColor(overall)}`}>{overall}</div>
            <div className="text-xs text-muted-foreground">{overallLabel}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((it) => (
          <div key={it.label} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className={`flex items-center gap-2 ${scoreColor(it.value)}`}>
                {it.icon}
                <span className="text-foreground font-medium">{it.label}</span>
              </span>
              <span className={`font-mono text-sm ${scoreColor(it.value)}`}>{it.value}</span>
            </div>
            <Progress value={it.value} className="h-1.5" />
            <p className="text-[11px] text-muted-foreground leading-tight">{it.hint}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
