import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CheckCircle2, PencilLine, FileQuestion } from "lucide-react";
import {
  describeCostSource,
  getCostSource,
  type InventoryOverrideRow,
} from "@/lib/cost-contract";
import { cn } from "@/lib/utils";

interface CostSourceBadgeProps {
  /**
   * Inventory row carrying cost + override flags.
   * Pass either the full row or a minimal subset — only the cost-related
   * fields are read.
   */
  row: InventoryOverrideRow;
  /**
   * Optional. When the caller knows whether a Created Listing exists for
   * this ASIN, pass it so manual overrides can be labeled
   * "Manual / No Purchase Record" instead of just "Overridden".
   */
  hasPurchaseRecord?: boolean;
  /** Compact mode renders just an icon with a tooltip (good for tables). */
  compact?: boolean;
  className?: string;
}

/**
 * Phase 7 UI indicator — shows whether the unit cost on this row is the
 * "From Purchase" value (synced from created_listings), an "Overridden"
 * value (manually set with a Created Listing in place), or
 * "Manual / No Purchase Record" (manually set with no purchase history yet
 * — typical for new sellers who connected Amazon first).
 *
 * This is read-only. Editing happens in the cost editor; this badge just
 * tells the user what the currently displayed cost represents.
 */
export function CostSourceBadge({
  row,
  hasPurchaseRecord,
  compact = false,
  className,
}: CostSourceBadgeProps) {
  const source = getCostSource(row, hasPurchaseRecord);
  if (source === "unknown") return null;

  const isOverride = source === "manual";
  const isManualNoRecord = source === "manual_no_purchase_record";
  const isManualish = isOverride || isManualNoRecord;
  const label = describeCostSource(source);

  const updatedAt = row.manual_cost_updated_at
    ? new Date(row.manual_cost_updated_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  const reason = isManualish && row.manual_cost_reason ? row.manual_cost_reason.trim() : null;
  let tooltipText: string;
  if (isManualNoRecord) {
    tooltipText = `Operational cost set manually${updatedAt ? ` on ${updatedAt}` : ""}. No Created Listing / purchase record exists for this ASIN yet.${reason ? ` Reason: ${reason}.` : ""}`;
  } else if (isOverride) {
    tooltipText = `Manually overridden${updatedAt ? ` on ${updatedAt}` : ""}.${reason ? ` Reason: ${reason}.` : ""} Sync will not change this value.`;
  } else {
    tooltipText = "Synced from your purchase record (Created Listings).";
  }

  const Icon = isManualNoRecord ? FileQuestion : isOverride ? PencilLine : CheckCircle2;

  // Color tokens — semantic only, no raw hex
  const compactToneClass = isManualNoRecord
    ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
    : isOverride
      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
      : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";

  const fullToneClass = isManualNoRecord
    ? "border-sky-500/40 text-sky-600 dark:text-sky-400 bg-sky-500/5"
    : isOverride
      ? "border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/5"
      : "border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5";

  if (compact) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center rounded-full",
                compactToneClass,
                className,
              )}
              aria-label={label}
            >
              <Icon className="h-2.5 w-2.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[240px] text-xs">
            <div className="font-medium">{label}</div>
            <div className="text-muted-foreground">{tooltipText}</div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "gap-1 text-[10px] font-medium px-1.5 py-0",
              fullToneClass,
              className,
            )}
          >
            <Icon className="h-2.5 w-2.5" />
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[240px] text-xs">
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
