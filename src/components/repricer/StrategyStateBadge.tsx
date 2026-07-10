import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { strategyMeta, strategyToneClasses, type StrategyState } from "@/lib/strategyMeta";

interface Props {
  state?: string | null;
  variant?: "short" | "full";
  showTooltip?: boolean;
}

export function StrategyStateBadge({ state, variant = "short", showTooltip = true }: Props) {
  const meta = strategyMeta(state as StrategyState | null);
  const classes = strategyToneClasses(meta.tone);
  const text = variant === "short" ? meta.short : meta.label;

  const badge = (
    <Badge variant="outline" className={`${classes} font-medium`}>
      {text}
    </Badge>
  );

  if (!showTooltip) return badge;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-1">
            <div className="font-semibold">{meta.label}</div>
            <div className="text-xs text-muted-foreground">{meta.description}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
