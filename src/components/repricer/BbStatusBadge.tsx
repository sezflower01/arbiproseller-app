import { Badge } from "@/components/ui/badge";
import { Trophy, HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type BbDisplayStatus =
  | "winning"
  | "not_owner"
  | "rotating"
  | "suppressed"
  | "unknown";

interface BbStatusInfo {
  status: BbDisplayStatus;
  label: string;
  tooltip: string;
}

/**
 * Derives a nuanced BB display status from raw data.
 * - winning: SP-API confirms ownership
 * - rotating: my price matches BB but SP-API says not owner (Amazon rotation)
 * - not_owner: SP-API says not owner and prices differ
 * - suppressed: BB is suppressed / missing
 */
export function deriveBbDisplayStatus(opts: {
  rawStatus?: string | null;   // 'winning' | 'losing' | 'owned' | 'competitor' | 'suppressed' | etc
  myPrice?: number | null;
  buyboxPrice?: number | null;
}): BbStatusInfo {
  const { rawStatus, myPrice, buyboxPrice } = opts;

  if (!rawStatus || rawStatus === "unknown") {
    return { status: "unknown", label: "—", tooltip: "No BB data available" };
  }

  if (rawStatus === "winning" || rawStatus === "owned") {
    return { status: "winning", label: "BB Owner", tooltip: "SP-API confirms you own the Buy Box" };
  }

  if (rawStatus === "suppressed") {
    return { status: "suppressed", label: "Suppressed", tooltip: "Buy Box is suppressed or missing for this listing" };
  }

  // rawStatus is 'losing' or 'competitor' — check for price match (rotation)
  if (
    myPrice != null &&
    buyboxPrice != null &&
    buyboxPrice > 0 &&
    Math.abs(myPrice - buyboxPrice) < 0.02
  ) {
    return {
      status: "rotating",
      label: "Rotating",
      tooltip: "Your price matches the Buy Box but SP-API snapshot shows another seller as owner. Amazon may be rotating the featured offer.",
    };
  }

  return {
    status: "not_owner",
    label: "Not Owner",
    tooltip: "SP-API snapshot says another seller owns the Buy Box. This is a point-in-time check — Amazon may rotate offers.",
  };
}

interface BbStatusBadgeProps {
  rawStatus?: string | null;
  myPrice?: number | null;
  buyboxPrice?: number | null;
  /** compact mode: smaller badge, no tooltip */
  compact?: boolean;
}

export default function BbStatusBadge({ rawStatus, myPrice, buyboxPrice, compact }: BbStatusBadgeProps) {
  const info = deriveBbDisplayStatus({ rawStatus, myPrice, buyboxPrice });

  const badge = (() => {
    switch (info.status) {
      case "winning":
        return (
          <Badge variant="outline" className="text-[10px] bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400 border-green-300 dark:border-green-800">
            <Trophy className="h-2.5 w-2.5 mr-0.5" />
            {info.label}
          </Badge>
        );
      case "rotating":
        return (
          <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 border-amber-300 dark:border-amber-800">
            🔄 {info.label}
          </Badge>
        );
      case "not_owner":
        return (
          <Badge variant="outline" className="text-[10px] bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-400 border-orange-300 dark:border-orange-800">
            📡 {info.label}
          </Badge>
        );
      case "suppressed":
        return (
          <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400 border-red-300 dark:border-red-800">
            🚫 {info.label}
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-[10px]">—</Badge>
        );
    }
  })();

  if (compact) return badge;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-0.5 cursor-help">
            {badge}
            <HelpCircle className="h-2.5 w-2.5 text-muted-foreground" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px] text-xs">
          {info.tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
