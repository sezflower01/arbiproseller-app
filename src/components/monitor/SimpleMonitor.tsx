import { useMonitorData, type QuotaTimeWindow } from "@/hooks/use-monitor-data";
import { useState } from "react";
import MonitorActionNeeded from "@/components/monitor/MonitorActionNeeded";
import BusinessHealthScore from "@/components/monitor/BusinessHealthScore";
import TodayPerformance from "@/components/monitor/TodayPerformance";
import StrategyDistributionCard from "@/components/monitor/StrategyDistributionCard";
import ExecutiveSummaryCard from "@/components/monitor/ExecutiveSummaryCard";
import ActionCenterCard from "@/components/monitor/ActionCenterCard";
import OperatorQueueCard from "@/components/monitor/OperatorQueueCard";
import AutomationTierCard from "@/components/monitor/AutomationTierCard";
import BusinessAdvisorCard from "@/components/monitor/BusinessAdvisorCard";
import StrategicKPICard from "@/components/monitor/StrategicKPICard";
import AutomationTrustBadge from "@/components/monitor/AutomationTrustBadge";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkles, Info } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * Simple Mode — business-focused dashboard.
 * Shows only Action Required, Business Health, and Today's Performance.
 * No engineering internals.
 */
export default function SimpleMonitor() {
  const data = useMonitorData();
  const [timeWindow, setTimeWindow] = useState<QuotaTimeWindow>("24h");

  if (data.loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/tools/executive" className="text-sm text-primary hover:underline">
          Open Executive view →
        </Link>
        <AutomationTrustBadge compact />
      </div>
      <ActionCenterCard />
      <StrategicKPICard />
      <BusinessAdvisorCard />
      <ExecutiveSummaryCard />
      <OperatorQueueCard limit={8} title="What to focus on" />
      <AutomationTierCard />

      <Card className="bg-primary/5 border-primary/20">
        <CardContent className="p-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Sparkles className="h-4 w-4 text-primary shrink-0" />
          <span>
            Simple Mode shows only what needs your attention. Switch to
            <strong className="text-foreground"> Advanced Mode</strong> in the header for a deeper view.
          </span>
        </CardContent>
      </Card>

      {/* Action Required — most important */}
      <MonitorActionNeeded
        data={data}
        timeWindow={timeWindow}
        onTimeWindowChange={setTimeWindow}
        onRefresh={() => window.location.reload()}
      />

      {/* Side-by-side health + today */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BusinessHealthScore data={data} />
        <TodayPerformance data={data} />
      </div>

      <StrategyDistributionCard />

      <Card className="bg-muted/30">
        <CardContent className="p-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" />
          Business Health blends pricing reliability, Buy Box control, profit-rule activity,
          and how fresh your market data is. 85+ means everything is running cleanly.
        </CardContent>
      </Card>
    </div>
  );
}
