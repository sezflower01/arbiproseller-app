import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Send, CheckCircle, AlertTriangle, ShieldAlert, Ban } from "lucide-react";
import type { MonitorData } from "@/hooks/use-monitor-data";

interface Props {
  data: MonitorData;
}

function StatusDot({ status }: { status: "green" | "yellow" | "red" }) {
  const colors = {
    green: "bg-green-500",
    yellow: "bg-yellow-500",
    red: "bg-red-500",
  };
  return <span className={`inline-block w-3 h-3 rounded-full ${colors[status]}`} />;
}

type StatusColor = "green" | "yellow" | "red";

export default function HealthSummaryCards({ data }: Props) {
  const schedulerStatus: StatusColor = data.schedulerHealthy ? "green" : data.lastRunTime ? "yellow" : "red";
  const feedCompStatus: StatusColor = data.feedCompletionRate >= 90 ? "green" : data.feedCompletionRate >= 70 ? "yellow" : "red";
  // Verification is spot-check (3 samples per feed). Success = all samples confirmed. 
  const verifySuccessRate = data.verifiedCount + data.mismatchCount > 0
    ? Math.round((data.verifiedCount / (data.verifiedCount + data.mismatchCount)) * 100)
    : 100;
  const verifyStatus: StatusColor = verifySuccessRate >= 95 ? "green" : verifySuccessRate >= 80 ? "yellow" : "red";
  const mismatchStatus: StatusColor = data.mismatchCount === 0 ? "green" : data.mismatchCount <= 10 ? "yellow" : "red";
  const profitGuardStatus: StatusColor = data.profitGuardBlocks === 0 ? "green" : data.profitGuardBlocks <= 5 ? "yellow" : "red";

  const cards = [
    {
      title: "Amazon Price Updates (Scheduler Runs)",
      icon: <Clock className="h-5 w-5 text-primary" />,
      status: schedulerStatus,
      value: data.schedulerRuns.toString(),
      detail: data.lastRunTime ? `Last: ${data.lastRunTime}` : "Never run",
      explain: "How many times the repricer evaluated your items today. Direct PATCH writes (Listings API) are the live channel — feeds are not used for normal repricing.",
    },
    {
      title: "Feeds Submitted (legacy)",
      icon: <Send className="h-5 w-5 text-primary" />,
      status: "green" as "green" | "yellow" | "red",
      value: data.feedsSubmitted.toString(),
      detail: data.feedsSubmitted === 0
        ? "Not used for direct repricing"
        : (data.lastFeedTime ? `Last: ${data.lastFeedTime}` : "No feeds today"),
      explain: "Legacy bulk-feed channel. Direct PATCH is the live path for price updates — 0 here is expected and does NOT mean the repricer is idle.",
    },
    {
      title: "Feed Completion Rate",
      icon: <CheckCircle className="h-5 w-5 text-primary" />,
      status: feedCompStatus,
      value: `${data.feedCompletionRate}%`,
      detail: `${data.feedsCompleted} / ${data.feedsSubmitted} completed`,
      explain: "Percentage of price feeds Amazon successfully processed. Below 90% may indicate listing issues.",
    },
    {
      title: "Spot-Check Verification",
      icon: <CheckCircle className="h-5 w-5 text-primary" />,
      status: verifyStatus,
      value: `${verifySuccessRate}%`,
      detail: `${data.verifiedCount} sampled & confirmed, ${data.mismatchCount} mismatched (${data.completedCount} total feed actions)`,
      explain: "After updating prices, the system re-checks a sample to confirm Amazon accepted the change.",
    },
    {
      title: "Unverified SKUs",
      icon: <AlertTriangle className="h-5 w-5 text-primary" />,
      status: mismatchStatus,
      value: data.mismatchCount.toString(),
      detail: data.topMismatchAsins.length > 0
        ? `Top: ${data.topMismatchAsins.slice(0, 2).join(", ")}`
        : "All verified ✓",
      explain: data.mismatchCount === 0
        ? "All spot-checked prices match what was submitted. Everything looks good."
        : "These items show a different price than what was submitted. Amazon may have rejected the update.",
    },
    {
      title: "Profit Guard Blocks",
      icon: <Ban className="h-5 w-5 text-primary" />,
      status: profitGuardStatus,
      value: data.profitGuardBlocks.toString(),
      detail: data.topProfitGuardAsins.length > 0
        ? `Top: ${data.topProfitGuardAsins.slice(0, 2).join(", ")}`
        : "No blocks today",
      explain: data.profitGuardBlocks === 0
        ? "No price changes were blocked today. All updates stayed within your profit rules."
        : "The system wanted to lower prices but stopped to protect your profit margin. This is your safety net working.",
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {cards.map((card) => (
        <Card key={card.title} className="relative overflow-hidden">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {card.icon}
                <span className="font-medium text-sm text-foreground">{card.title}</span>
              </div>
              <StatusDot status={card.status} />
            </div>
            <div className="text-3xl font-bold text-foreground mb-1">{card.value}</div>
            <p className="text-xs text-muted-foreground truncate">{card.detail}</p>
            <p className="text-[10px] text-muted-foreground/80 mt-1 leading-tight line-clamp-2">{card.explain}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
