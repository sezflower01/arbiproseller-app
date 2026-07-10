import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, ShieldCheck, PlayCircle } from "lucide-react";
import { useFbaEligibility, type FbaStageKey, type FbaStageStatus } from "@/hooks/use-fba-eligibility";

const STAGE_LABEL: Record<FbaStageKey, string> = {
  sellability: "Sellable on Amazon",
  listing_creation: "Listing Creation Allowed",
  fba_eligibility: "FBA Eligible",
  hazmat: "Hazmat / Dangerous Goods",
  prep: "Prep Required",
  inbound_dry_run: "Inbound Dry-Run Tested",
};

const STAGE_HINT: Record<FbaStageKey, string> = {
  sellability: "Restrictions, gating, approval requirements",
  listing_creation: "Barcode mode, FNSKU readiness",
  fba_eligibility: "Item Preview eligibility for FBA",
  hazmat: "Dangerous goods classification & meltable flag",
  prep: "Polybag, bubble wrap, taping, labeling",
  inbound_dry_run: "Simulated shipment plan (on-demand only)",
};

/**
 * Direct YES/NO answer per stage. Some stages invert polarity: e.g. for
 * "Hazmat / Dangerous Goods", `ok` (no hazmat detected) must read NO — never
 * YES, otherwise sellers misread it as "yes, this IS hazmat".
 *
 * Returned tuple: [text, tone] where tone drives the badge color.
 */
type Tone = "good" | "bad" | "warn" | "unknown";
function stageAnswer(stage: FbaStageKey, status: FbaStageStatus["status"]): { text: string; tone: Tone } {
  if (status === "unknown") {
    // Dry-run "unknown" really means "not yet tested" — say that, never "UNKNOWN".
    if (stage === "inbound_dry_run") return { text: "NOT TESTED", tone: "unknown" };
    return { text: "NOT CHECKED", tone: "unknown" };
  }
  // Stages where presence (ok) of the trait is BAD for the seller — answer flips.
  const inverted = stage === "hazmat";
  if (inverted) {
    if (status === "ok") return { text: "NO", tone: "good" };       // no hazmat detected
    if (status === "warn") return { text: "CAUTION", tone: "warn" };
    return { text: "YES", tone: "bad" };                              // hazmat confirmed
  }
  // Standard polarity: ok = YES (capability available), blocked = NO.
  if (status === "ok") return { text: "YES", tone: "good" };
  if (status === "warn") return { text: "CAUTION", tone: "warn" };
  return { text: "NO", tone: "bad" };
}

function statusBadge(stage: FbaStageKey, status: FbaStageStatus["status"]) {
  const { text, tone } = stageAnswer(stage, status);
  const map: Record<Tone, string> = {
    good: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    bad: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
    unknown: "bg-muted text-muted-foreground border-border",
  };
  return <Badge variant="outline" className={`${map[tone]} font-semibold tracking-wide`}>{text}</Badge>;
}

export default function FbaCompliancePanel({ asin, marketplace }: { asin: string; marketplace: string }) {
  const { data, loading, dryRunLoading, error, recheck, runDryRun } = useFbaEligibility({
    asin,
    marketplace,
    enabled: true,
  });

  const stages = data?.stageStatuses ?? [];

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            FBA Compliance & Hazmat
          </CardTitle>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline" className="text-[10px] bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30">
              Source: Amazon SP-API
            </Badge>
            {data?.cached && data?.checked_at && (
              <span className="text-[10px] text-muted-foreground">
                Cached · {new Date(data.checked_at).toLocaleString()}
              </span>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => recheck()} disabled={loading} className="h-7">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          <span className="ml-1 text-xs">Recheck</span>
        </Button>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        {error && (
          <div className="text-xs text-rose-600 dark:text-rose-400 mb-2">
            Amazon check unavailable: {error}
          </div>
        )}
        {!data && loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking Amazon…
          </div>
        )}
        {!data && !loading && !error && (
          <div className="text-sm text-muted-foreground py-3">Run an FBA check to verify hazmat & eligibility.</div>
        )}

        {/* Fix 2: friendly status banner — never panic-inducing for non-blocks */}
        {data && (() => {
          const propagating = (data.infos || []).find((i: any) => String(i.code).toUpperCase() === "FNSKU_PROPAGATING");
          const pending = (data.infos || []).find((i: any) => String(i.code).toUpperCase() === "FNSKU_PENDING_LISTING_CREATION");
          const hardBlock = (data.blockingIssues || []).length > 0;
          if (hardBlock) {
            return (
              <div className="mb-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-700 dark:text-rose-300">
                <strong>Amazon will reject this ASIN for FBA.</strong> Resolve the blocking item(s) below before sending inventory.
              </div>
            );
          }
          if (propagating) {
            return (
              <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                <strong>Waiting for Amazon FNSKU propagation.</strong> {propagating.message} You can continue sourcing — labels & shipments will work once Amazon assigns it.
              </div>
            );
          }
          if (pending) {
            return (
              <div className="mb-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-2 text-xs text-sky-700 dark:text-sky-300">
                <strong>FNSKU pending.</strong> Amazon will mint the FNSKU after you create the FBA listing.
              </div>
            );
          }
          if (data.eligible) {
            return (
              <div className="mb-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-300">
                <strong>Approved by Amazon.</strong> No restrictions, no manufacturer-barcode block, FNSKU on file.
              </div>
            );
          }
          return null;
        })()}

        {stages.length > 0 && (
          <ul className="divide-y">
            {stages.map((s) => (
              <li key={s.stage} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{STAGE_LABEL[s.stage]}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{STAGE_HINT[s.stage]}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {statusBadge(s.stage, s.status)}
                    {s.stage === "inbound_dry_run" && s.status === "unknown" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => runDryRun()}
                        disabled={dryRunLoading}
                      >
                        {dryRunLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayCircle className="h-3 w-3" />}
                        <span className="ml-1">Run</span>
                      </Button>
                    )}
                  </div>
                </div>
                {s.reason && (
                  <div className="text-[11px] text-muted-foreground mt-1">{s.reason}</div>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Only show raw issue list when there is a true block. Suppress the
            redundant amber wall of warnings — the banner + per-stage rows already
            communicate them. */}
        {data && data.blockingIssues?.length > 0 && (
          <div className="mt-3 pt-3 border-t space-y-1">
            {data.blockingIssues.map((i, idx) => (
              <div key={`b${idx}`} className="text-[11px] text-rose-600 dark:text-rose-400">
                <strong>{i.code}:</strong> {i.message}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
