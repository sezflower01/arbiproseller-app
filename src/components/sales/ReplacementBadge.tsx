import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  isReplacementRow,
  replacementLabel,
  REPLACEMENT_TOOLTIP,
  type ReplacementAwareRow,
} from "@/lib/sales/replacementOrder";

interface Props {
  row: ReplacementAwareRow;
  className?: string;
}

/**
 * Amber badge shown next to any sale row Amazon shipped at $0 revenue
 * (replacement / free shipment). Tooltip explains the COGS impact.
 */
export function ReplacementBadge({ row, className }: Props) {
  if (!isReplacementRow(row)) return null;
  const label = replacementLabel(row);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={
              "border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100 " +
              (className || "")
            }
          >
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          {REPLACEMENT_TOOLTIP}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
