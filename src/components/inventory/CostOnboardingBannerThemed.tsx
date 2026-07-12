import { Rocket, DollarSign, ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";

interface CostOnboardingBannerProps {
  missingCostCount: number;
  missingUnitsCount: number;
  onAddCostClick: () => void;
}

export function CostOnboardingBannerThemed({
  missingCostCount,
  missingUnitsCount,
  onAddCostClick,
}: CostOnboardingBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || missingCostCount === 0) return null;

  return (
    <div className="relative mb-5 overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-r from-primary/10 via-primary/5 to-accent/10 p-5 shadow-lg shadow-primary/5">
      {/* Decorative glow */}
      <div className="absolute -top-10 -right-10 h-32 w-32 rounded-full bg-primary/15 blur-3xl" />
      <div className="absolute -bottom-8 -left-8 h-24 w-24 rounded-full bg-accent/15 blur-2xl" />

      {/* Dismiss button */}
      <button
        onClick={() => setDismissed(true)}
        className="absolute top-3 right-3 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="relative flex items-start gap-4">
        {/* Icon */}
        <div className="flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-xl bg-primary/15 border border-primary/20">
          <Rocket className="h-6 w-6 text-primary" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
            You're Almost Ready
          </h3>
          <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
            Your Amazon inventory has been successfully synced.
            To activate the repricer and start automated pricing, add cost to your products.
            <span className="font-medium text-foreground">
              {" "}{missingCostCount} item{missingCostCount !== 1 ? "s" : ""} ({missingUnitsCount.toLocaleString()} units)
            </span>{" "}
            still need a cost — items without cost won't be included in repricing.
          </p>

          {/* CTA */}
          <Button
            onClick={onAddCostClick}
            size="sm"
            className="mt-3 gap-2"
          >
            <DollarSign className="h-4 w-4" />
            Add Cost Now
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
