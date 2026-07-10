import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Layers, Info, CheckCircle, AlertTriangle } from "lucide-react";
import type { QuotaHealthData } from "@/hooks/use-monitor-data";

interface Props {
  data: QuotaHealthData;
}

interface Bucket {
  label: string;
  count: number;
  color: string;
  tooltip: string;
}

export default function UniverseSegmentationPanel({ data }: Props) {
  const inactiveCount = data.totalAssignments - data.activeAssignments;

  // Strict exclusive priority buckets — computed in use-monitor-data.ts
  // Priority: Inactive → Disabled → Orphan Intl → No Rule → Eligible
  const buckets: Bucket[] = [
    {
      label: "Eligible",
      count: data.eligibleAssignments,
      color: "bg-green-500",
      tooltip: "Active + Enabled + Has rule + Has min_price. These are actively repriced by the scheduler.",
    },
    {
      label: "Disabled",
      count: data.disabledCount,
      color: "bg-slate-400",
      tooltip: "Active but is_enabled = false. Typically auto-disabled at 0 stock.",
    },
    {
      label: "Orphan / Discovery Intl",
      count: data.noUsListingCount,
      color: "bg-purple-400",
      tooltip: "Active + enabled intl assignments where no US listing exists. Cannot inherit a rule.",
    },
    {
      label: "No Rule Assigned",
      count: data.noRuleCount,
      color: "bg-amber-400",
      tooltip: "Active + enabled but no rule (direct or inherited). Assign a rule to make eligible.",
    },
    {
      label: "Inactive",
      count: inactiveCount,
      color: "bg-red-400",
      tooltip: "Assignments with status ≠ 'active'. Not part of the operational universe.",
    },
  ].filter(b => b.count > 0);

  const bucketSum = data.eligibleAssignments + data.disabledCount + data.noUsListingCount + data.noRuleCount + inactiveCount;
  const totalBar = Math.max(bucketSum, 1);
  const sumsMatch = bucketSum === data.totalAssignments;

  return (
    <Card className="border-primary/30 bg-background/95 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg text-primary">
          <Layers className="h-5 w-5 text-primary" />
          Universe Segmentation
          <Badge variant="outline" className="ml-auto border-primary/30 bg-primary/10 text-primary text-xs">{data.totalAssignments} total</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Mutually exclusive buckets — strict priority classification (inactive → disabled → orphan → no rule → eligible)
        </p>
        <p className="text-[10px] text-muted-foreground/70 italic">
          Each assignment appears in its primary status bucket only. Some may have secondary attributes (e.g. a disabled orphan shows as "Disabled").
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex h-6 rounded-md overflow-hidden border border-primary/20 bg-primary/10">
          {buckets.map(b => (
            <Tooltip key={b.label}>
              <TooltipTrigger asChild>
                <div
                  className={`${b.color} transition-all`}
                  style={{ width: `${(b.count / totalBar) * 100}%`, minWidth: b.count > 0 ? '2px' : 0 }}
                />
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                {b.label}: {b.count.toLocaleString()} ({Math.round((b.count / totalBar) * 100)}%)
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {buckets.map(b => (
            <Tooltip key={b.label}>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2 p-2 rounded-lg border border-primary/15 bg-primary/5 cursor-help">
                  <span className={`w-3 h-3 rounded-sm shrink-0 ${b.color}`} />
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground truncate">{b.label}</div>
                    <div className="text-sm font-bold text-foreground">{b.count.toLocaleString()}</div>
                  </div>
                  <Info className="h-3 w-3 text-primary/50 shrink-0 ml-auto" />
                </div>
              </TooltipTrigger>
              <TooltipContent className="text-xs max-w-[260px]">{b.tooltip}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        {/* Hard validation: bucket sum must equal total */}
        <div className={`flex items-center gap-2 text-xs rounded-lg p-2 border ${
          sumsMatch 
            ? "bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400" 
            : "bg-destructive/10 border-destructive/20 text-destructive"
        }`}>
          {sumsMatch ? (
            <CheckCircle className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          )}
          {sumsMatch
            ? `✓ Bucket sum = ${bucketSum} matches total ${data.totalAssignments}`
            : `✗ Bucket sum ${bucketSum} ≠ total ${data.totalAssignments} — classification overlap detected`
          }
        </div>
      </CardContent>
    </Card>
  );
}
