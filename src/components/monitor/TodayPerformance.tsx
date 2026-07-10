import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MonitorData } from "@/hooks/use-monitor-data";
import { TrendingUp, RefreshCw, ShoppingCart, ShieldCheck, Eye } from "lucide-react";

export default function TodayPerformance({ data }: { data: MonitorData }) {
  const q = data.quotaHealth;

  const stats = [
    { label: "Listings checked today", value: q.checkedToday ?? 0, icon: <Eye className="h-4 w-4" />, color: "text-[hsl(var(--status-info))]" },
    { label: "Price changes", value: q.skusWithPriceChanges ?? 0, icon: <RefreshCw className="h-4 w-4" />, color: "text-[hsl(var(--status-healthy))]" },
    { label: "Verified live updates", value: data.verifiedCount ?? 0, icon: <ShieldCheck className="h-4 w-4" />, color: "text-[hsl(var(--status-healthy))]" },
    { label: "Profit-protected holds", value: data.profitGuardBlocks ?? 0, icon: <ShoppingCart className="h-4 w-4" />, color: "text-[hsl(var(--status-info))]" },
    { label: "Total actions", value: q.totalActions ?? 0, icon: <TrendingUp className="h-4 w-4" />, color: "text-foreground" },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Today's Performance</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg border bg-background p-3">
              <div className={`flex items-center gap-1.5 text-xs ${s.color}`}>
                {s.icon}
                <span className="text-muted-foreground">{s.label}</span>
              </div>
              <div className="text-2xl font-bold mt-1 text-foreground">{s.value.toLocaleString()}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
