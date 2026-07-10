import { CheckCircle2, XCircle, HelpCircle, AlertTriangle, RefreshCw, ShieldAlert, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FbaEligibility, FbaStageStatus } from "@/hooks/use-fba-eligibility";

interface Props {
  eligibility: FbaEligibility | null;
  loading?: boolean;
  onRecheck?: () => void;
  /** Phase B Stage 6 — on-demand dry-run. */
  onRunDryRun?: () => void;
  dryRunLoading?: boolean;
  sellabilityApproved?: boolean;
  className?: string;
}

const STAGE_DEFS: { key: FbaStageStatus["stage"]; label: string }[] = [
  { key: "sellability",        label: "1. Approved to sell" },
  { key: "listing_creation",   label: "2. Listing can be created" },
  { key: "fba_eligibility",    label: "3. FBA inbound eligibility" },
  { key: "hazmat",             label: "4. Hazmat / Dangerous Goods" },
  { key: "prep",               label: "5. Prep & labeling" },
  { key: "inbound_dry_run",    label: "6. Shipment plan precheck" },
];

function StatusIcon({ status }: { status: FbaStageStatus["status"] }) {
  if (status === "ok")      return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  if (status === "blocked") return <XCircle className="h-4 w-4 text-red-600" />;
  if (status === "warn")    return <AlertTriangle className="h-4 w-4 text-amber-600" />;
  return <HelpCircle className="h-4 w-4 text-muted-foreground" />;
}

function statusLabel(s: FbaStageStatus["status"]) {
  return s === "ok" ? "OK"
       : s === "blocked" ? "Blocked"
       : s === "warn" ? "Warning"
       : "Not verified yet";
}

/**
 * Phase A: 6-stage readiness tracker. Replaces the single FBA banner.
 * Stages 3–6 are intentionally "Not verified yet" until Phase B wires up
 * the real Amazon endpoints (itemPreview, hazmat, prepDetails, inbound dry-run).
 *
 * Honest wording rule: never display "Safe to ship" unless stages 1, 3, 5 are
 * green AND stage 4 is not "blocked" AND stage 6 is "ok".
 */
export function FbaReadinessTracker({ eligibility, loading, onRecheck, onRunDryRun, dryRunLoading, sellabilityApproved, className }: Props) {
  if (!eligibility) return null;
  const stages = (eligibility.stageStatuses || []).map(stage =>
    sellabilityApproved && stage.stage === "sellability" && stage.status !== "blocked"
      ? { ...stage, status: "ok" as const, reason: "Approved for New condition in the selected marketplace." }
      : stage,
  );
  const byKey = new Map(stages.map(s => [s.stage, s]));

  const ok = (k: FbaStageStatus["stage"]) => byKey.get(k)?.status === "ok";
  const blocked = (k: FbaStageStatus["stage"]) => byKey.get(k)?.status === "blocked";

  const safeToShip =
    ok("sellability") &&
    ok("fba_eligibility") &&
    ok("prep") &&
    !blocked("hazmat") &&
    ok("inbound_dry_run");

  const anyBlock = stages.some(s => s.status === "blocked");

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm space-y-3",
        anyBlock
          ? "border-red-500/60 bg-red-50 dark:bg-red-950/30"
          : "border-border bg-muted/30",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className={cn("h-4 w-4 mt-0.5 shrink-0", anyBlock ? "text-red-600" : "text-muted-foreground")} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">FBA readiness</div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Approved to sell does not guarantee Amazon will accept this item into FBA.
            FBA shipment eligibility, hazmat/prep rules, and inbound plan acceptance
            still need verification.
          </p>
        </div>
        {onRecheck && (
          <Button size="sm" variant="outline" onClick={onRecheck} disabled={loading} type="button">
            <RefreshCw className={cn("h-3 w-3 mr-1", loading && "animate-spin")} />
            Re-check
          </Button>
        )}
      </div>

      <ul className="space-y-1.5">
        {STAGE_DEFS.map(def => {
          const s = byKey.get(def.key);
          const status = s?.status ?? "unknown";
          return (
            <li key={def.key} className="flex items-start gap-2 text-xs">
              <StatusIcon status={status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{def.label}</span>
                  <span className={cn(
                    "text-[10px] uppercase tracking-wide",
                    status === "ok" && "text-emerald-700",
                    status === "blocked" && "text-red-700",
                    status === "warn" && "text-amber-700",
                    status === "unknown" && "text-muted-foreground",
                  )}>
                    {statusLabel(status)}
                  </span>
                </div>
                {s?.reason && <div className="text-muted-foreground mt-0.5">{s.reason}</div>}
                {def.key === "inbound_dry_run" && (
                  <div className="text-muted-foreground mt-0.5 italic">
                    Precheck only — full inbound plan validation requires ship-from address
                    setup. Current check verifies FNSKU and FBA eligibility only.
                  </div>
                )}
                {def.key === "inbound_dry_run" && onRunDryRun && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-1.5 h-7 px-2 text-xs"
                    onClick={onRunDryRun}
                    disabled={dryRunLoading}
                  >
                    <PlayCircle className={cn("h-3 w-3 mr-1", dryRunLoading && "animate-pulse")} />
                    {dryRunLoading ? "Running precheck…" : "Run shipment precheck"}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="pt-2 border-t border-border/60 text-xs">
        <span className="font-medium">Overall: </span>
        {anyBlock ? (
          <span className="text-red-700">Blocked — resolve red items above before continuing.</span>
        ) : safeToShip ? (
          <span className="text-emerald-700">Safe to ship.</span>
        ) : (
          <span className="text-muted-foreground">
            Not yet verified — "Safe to ship" remains unavailable until a real Amazon
            createInboundPlan dry-run confirms shipment acceptance. Current Stage 6 is a
            precheck only.
          </span>
        )}
      </div>
    </div>
  );
}
