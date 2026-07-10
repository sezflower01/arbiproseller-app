import { AlertTriangle, RefreshCw, ShieldAlert, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FbaEligibility } from "@/hooks/use-fba-eligibility";

interface Props {
  eligibility: FbaEligibility | null;
  loading?: boolean;
  onRecheck?: () => void;
  className?: string;
  /** When true, also show even if only warnings (no blocking issues). */
  showWarnings?: boolean;
}

/**
 * Shared red banner shown by every FBA action entry point when the central
 * eligibility check returns blocking issues. Users see the same message
 * everywhere — listing creation, Add Purchase, label print, shipment builder,
 * and the Chrome extension (which renders its own equivalent inline).
 */
export function FbaEligibilityBanner({ eligibility, loading, onRecheck, className, showWarnings = true }: Props) {
  if (!eligibility) return null;
  const { eligible, blockingIssues, warnings, infos = [] } = eligibility;
  const hasBlock = !eligible && blockingIssues.length > 0;
  const hasWarn = warnings.length > 0;
  const hasInfo = infos.length > 0;
  if (!hasBlock && !(showWarnings && hasWarn) && !hasInfo) return null;

  const tone = hasBlock
    ? "border-red-500/60 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200"
    : hasWarn
      ? "border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      : "border-sky-500/60 bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200";

  const Icon = hasBlock ? ShieldAlert : hasWarn ? AlertTriangle : Info;
  const heading = hasBlock
    ? "Amazon may reject this ASIN for FBA"
    : hasWarn
      ? "FBA eligibility warning"
      : "FBA listing not created yet";

  return (
    <div className={cn("rounded-md border p-3 text-sm space-y-2", tone, className)}>
      <div className="flex items-start gap-2">
        <Icon className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">{heading}</div>
          {hasBlock && (
            <p className="mt-1 text-xs leading-relaxed">
              This listing appears to use a manufacturer barcode instead of an Amazon FNSKU.
              Do not buy or ship this item for FBA until you switch the listing to
              Amazon barcode/FNSKU in Seller Central, or confirm it is FBM only.
            </p>
          )}
          <ul className="mt-2 space-y-1 text-xs">
            {blockingIssues.map((i, idx) => (
              <li key={`b${idx}`}>
                <span className="font-mono text-[10px] uppercase opacity-70">[{i.code}]</span>{" "}
                {i.message}
                {i.remediation ? <div className="opacity-80 mt-0.5">→ {i.remediation}</div> : null}
              </li>
            ))}
            {showWarnings && warnings.map((w, idx) => (
              <li key={`w${idx}`} className="opacity-90">
                <span className="font-mono text-[10px] uppercase opacity-70">[{w.code}]</span>{" "}
                {w.message}
              </li>
            ))}
            {!hasBlock && infos.map((info, idx) => (
              <li key={`i${idx}`} className="opacity-90">
                {info.message}
              </li>
            ))}
          </ul>
        </div>
        {onRecheck && (
          <Button size="sm" variant="outline" onClick={onRecheck} disabled={loading} type="button">
            <RefreshCw className={cn("h-3 w-3 mr-1", loading && "animate-spin")} />
            Re-check
          </Button>
        )}
      </div>
    </div>
  );
}
