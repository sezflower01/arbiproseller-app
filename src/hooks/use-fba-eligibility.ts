import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface FbaEligibilityIssue {
  code: string;
  severity: "block" | "warn" | "info";
  message: string;
  remediation?: string;
  affected_skus?: string[];
}

export type FbaStageKey =
  | "sellability"
  | "listing_creation"
  | "fba_eligibility"
  | "hazmat"
  | "prep"
  | "inbound_dry_run";

export interface FbaStageStatus {
  stage: FbaStageKey;
  status: "ok" | "warn" | "blocked" | "unknown";
  reason?: string;
}

export interface FbaEligibility {
  eligible: boolean;
  blockingIssues: FbaEligibilityIssue[];
  warnings: FbaEligibilityIssue[];
  infos?: FbaEligibilityIssue[];
  fba_block_reason: string | null;
  cached?: boolean;
  checked_at?: string;
  /** 6-stage view of the eligibility response (Phase B: real backend data). */
  stageStatuses?: FbaStageStatus[];
}

interface Args {
  asin?: string | null;
  marketplace?: string;
  marketplaceId?: string;
  condition?: string;
  enabled?: boolean;
}

/**
 * Local fallback: derive sellability + listing_creation from the legacy
 * blocking_issues / warnings payload when the backend response doesn't yet
 * include `stageStatuses` (e.g. older cached row).
 */
function deriveStageStatuses(resp: FbaEligibility | null): FbaStageStatus[] {
  if (!resp) return [];
  const blocks = resp.blockingIssues || [];
  const warns = resp.warnings || [];
  const codeIn = (set: FbaEligibilityIssue[], codes: string[]) =>
    set.find(i => codes.includes((i.code || "").toUpperCase()));

  const sellBlock = codeIn(blocks, ["RESTRICTED", "NOT_ELIGIBLE", "APPROVAL_REQUIRED"]);
  const sellability: FbaStageStatus = sellBlock
    ? { stage: "sellability", status: "blocked", reason: sellBlock.message }
    : { stage: "sellability", status: "warn", reason: "Sellability not verified. Check Seller Central before sourcing this ASIN." };

  const barcodeBlock = codeIn(blocks, ["MANUFACTURER_BARCODE_MODE"]);
  const fnskuWarn = codeIn(warns, ["INVALID_FNSKU"]);
  const fnskuPending = (resp.infos || []).find(
    i => (i.code || "").toUpperCase() === "FNSKU_PENDING_LISTING_CREATION",
  );
  const listingCreation: FbaStageStatus = barcodeBlock
    ? { stage: "listing_creation", status: "blocked", reason: barcodeBlock.message }
    : fnskuWarn
      ? { stage: "listing_creation", status: "warn", reason: fnskuWarn.message }
      : fnskuPending
        ? { stage: "listing_creation", status: "ok", reason: "Listing not created yet — Amazon will assign the FNSKU on creation." }
        : { stage: "listing_creation", status: "ok", reason: "No listing-creation blocks detected." };

  return [
    sellability,
    listingCreation,
    { stage: "fba_eligibility", status: "unknown", reason: "Not verified yet." },
    { stage: "hazmat",          status: "unknown", reason: "Not verified yet." },
    { stage: "prep",            status: "unknown", reason: "Not verified yet." },
    { stage: "inbound_dry_run", status: "unknown", reason: "Shipment precheck not run yet. Run it only after Amazon creates the listing and assigns an FNSKU." },
  ];
}

export function useFbaEligibility({ asin, marketplace = "US", marketplaceId, condition = "new_new", enabled = true }: Args) {
  const [data, setData] = useState<FbaEligibility | null>(null);
  const [loading, setLoading] = useState(false);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastKey = useRef<string>("");

  const run = useCallback(async (force = false) => {
    if (!asin || !/^[A-Z0-9]{10}$/i.test(asin)) {
      setData(null);
      return null;
    }
    setLoading(true);
    setError(null);
    try {
      const { data: resp, error: err } = await supabase.functions.invoke("check-fba-listing-eligibility", {
        body: { asin: asin.toUpperCase(), marketplace, marketplaceId, condition, force },
      });
      if (err) throw err;
      const r = resp as FbaEligibility;
      // Prefer backend stageStatuses (Phase B). Fall back to local derivation.
      const stages =
        Array.isArray(r?.stageStatuses) && r.stageStatuses.length === 6
          ? r.stageStatuses
          : deriveStageStatuses(r);
      const enriched: FbaEligibility = { ...r, stageStatuses: stages };
      setData(enriched);
      return enriched;
    } catch (e: any) {
      setError(e?.message || "Eligibility check failed");
      return null;
    } finally {
      setLoading(false);
    }
  }, [asin, marketplace, marketplaceId, condition]);

  /**
   * Phase B Stage 6 — on-demand dry-run. Never auto-fires. Updates the
   * inbound_dry_run row in stageStatuses on completion.
   */
  const runDryRun = useCallback(async () => {
    if (!asin || !/^[A-Z0-9]{10}$/i.test(asin)) return null;
    setDryRunLoading(true);
    try {
      const { data: resp, error: err } = await supabase.functions.invoke("dry-run-inbound-plan", {
        body: { asin: asin.toUpperCase(), marketplace, marketplaceId },
      });
      if (err) throw err;
      const stage = resp as FbaStageStatus;
      setData(prev => {
        if (!prev) return prev;
        const stages = (prev.stageStatuses || []).map(s =>
          s.stage === "inbound_dry_run" ? { ...s, ...stage, stage: "inbound_dry_run" as const } : s,
        );
        return { ...prev, stageStatuses: stages };
      });
      return stage;
    } catch (e: any) {
      setError(e?.message || "Dry-run failed");
      return null;
    } finally {
      setDryRunLoading(false);
    }
  }, [asin, marketplace, marketplaceId]);

  useEffect(() => {
    if (!enabled || !asin) return;
    const key = `${asin}|${marketplace}|${marketplaceId || ""}|${condition}`;
    if (lastKey.current === key) return;
    lastKey.current = key;
    void run(false);
  }, [asin, marketplace, marketplaceId, condition, enabled, run]);

  return {
    data,
    loading,
    dryRunLoading,
    error,
    recheck: () => run(true),
    runDryRun,
  };
}
