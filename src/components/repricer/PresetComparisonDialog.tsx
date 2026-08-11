import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { BarChart3 } from "lucide-react";
import { SMART_PROFILES, PROFILE_PRESETS } from "./AiRuleBuilder";

// Tier labels are derived from the SAME salesStars/profitStars that drive the
// star-rating picker (SMART_PROFILES in AiRuleBuilder.tsx) rather than a second,
// separately-maintained set of judgments -- exactly the kind of drift that caused
// the Momentum Builder star inconsistency this whole comparison feature grew out of.
const SALES_TIER_LABELS = ["🔴 Lowest", "🟠 Low", "🟡 Medium", "🟢 High", "🟢 Highest"];
const PROFIT_TIER_LABELS = ["🔴 Lowest", "🟠 Reduced", "🟡 Moderate", "🟢 Protected", "🟢🟢 Best"];

function tierLabel(stars: number, labels: string[]): string {
  const idx = Math.max(0, Math.min(labels.length - 1, stars - 1));
  return labels[idx];
}

export default function PresetComparisonDialog() {
  const [open, setOpen] = useState(false);

  const rows = SMART_PROFILES.map((profile) => {
    const preset = PROFILE_PRESETS[profile.value] || {};
    const undercutAmount = Number(preset.undercut_amount ?? 0);
    const undercuts = undercutAmount > 0
      ? `Yes ($${undercutAmount.toFixed(2)} below)`
      : "No (matches exactly)";
    const raises = preset.enable_smart_raise
      ? `Yes ($${Number(preset.max_raise_step_dollars ?? 0).toFixed(2)} max raise, ${preset.raise_trigger_percent ?? 0}% trigger)`
      : "❌ None — pure parity";
    return {
      key: profile.value,
      icon: profile.icon,
      label: profile.label,
      undercuts,
      winRate: tierLabel(profile.salesStars, SALES_TIER_LABELS),
      margin: tierLabel(profile.profitStars, PROFIT_TIER_LABELS),
      raises,
      bestFor: profile.bestFor,
    };
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors underline-offset-2 hover:underline"
      >
        <BarChart3 className="h-3.5 w-3.5" />
        Compare all 6 presets in detail
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" /> Preset Comparison
            </DialogTitle>
            <DialogDescription>
              The full picture behind the star ratings — how each preset actually behaves.
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm border-separate border-spacing-y-1">
              <thead>
                <tr className="text-muted-foreground text-xs">
                  <th className="px-2 py-1 text-left font-medium">Preset</th>
                  <th className="px-2 py-1 text-left font-medium">Undercuts?</th>
                  <th className="px-2 py-1 text-left font-medium">Win Rate</th>
                  <th className="px-2 py-1 text-left font-medium">Margin Protection</th>
                  <th className="px-2 py-1 text-left font-medium">Raises Price?</th>
                  <th className="px-2 py-1 text-left font-medium">Best For</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="bg-muted/30 align-top">
                    <td className="px-2 py-2 rounded-l-md font-medium whitespace-nowrap">
                      {r.icon} {r.label}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.undercuts}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.winRate}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.margin}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{r.raises}</td>
                    <td className="px-2 py-2 rounded-r-md text-muted-foreground text-xs">{r.bestFor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-2 space-y-2 text-xs text-muted-foreground border-t pt-3">
            <p>
              <strong className="text-foreground">The real tradeoff:</strong> Win Rate vs. Margin is the
              fundamental tension. Only Aggressive Capture actively sacrifices margin for a higher win
              rate — it's the only preset that undercuts at all. Every other preset protects margin by
              never pricing below its match point; the real differences between them are (1) which price
              they match — Buy Box specifically, the lowest offer, or an ownership-aware smart pick — and
              (2) whether they actively raise price to capture more profit once they're winning.
            </p>
            <p className="flex items-center gap-2 flex-wrap font-medium text-foreground/80">
              <span>MORE PROFIT</span>
              <span aria-hidden>←</span>
              <span className="text-muted-foreground font-normal">
                Profit Extractor → Momentum Builder → Match BB / Lowest / Smart → Aggressive Capture
              </span>
              <span aria-hidden>→</span>
              <span>MORE SALES</span>
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
