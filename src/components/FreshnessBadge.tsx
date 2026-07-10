import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Clock } from "lucide-react";

interface FreshnessBadgeProps {
  /** ISO timestamp of the last successful scan, or null/undefined */
  lastScannedAt?: string | null;
  className?: string;
  showIcon?: boolean;
}

function classify(daysOld: number) {
  if (daysOld <= 2) {
    return {
      label: daysOld === 0 ? "Fresh · today" : daysOld === 1 ? "Fresh · 1d" : `Fresh · ${daysOld}d`,
      cls: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
    };
  }
  if (daysOld <= 7) {
    return {
      label: `Aging · ${daysOld}d`,
      cls: "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400",
    };
  }
  return {
    label: `Stale · ${daysOld}d`,
    cls: "bg-rose-500/15 text-rose-600 border-rose-500/30 dark:text-rose-400",
  };
}

export default function FreshnessBadge({ lastScannedAt, className = "", showIcon = true }: FreshnessBadgeProps) {
  if (!lastScannedAt) {
    return (
      <Badge variant="outline" className={`text-[10px] gap-1 ${className}`}>
        {showIcon && <Clock className="h-3 w-3" />}
        Not scanned yet
      </Badge>
    );
  }

  const ts = new Date(lastScannedAt);
  const daysOld = Math.max(0, Math.floor((Date.now() - ts.getTime()) / 86_400_000));
  const { label, cls } = classify(daysOld);
  const tooltip = ts.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={`text-[10px] gap-1 ${cls} ${className}`}>
            {showIcon && <Clock className="h-3 w-3" />}
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Last scanned: {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
