export interface ReconciliationMetricRow {
  reconciliation_status: string | null;
  reconciliation_reason?: string | null;
  intended_price?: number | null;
  new_price?: number | null;
  verified_live_price?: number | null;
  recon_root_cause?: string | null;
}

export const RECONCILIATION_ROUNDING_TOLERANCE = 0.15;
const RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Root causes that represent market dynamics OR external (Amazon-side) rules,
// NOT system failures. These should not degrade system accuracy metrics.
const MARKET_DRIVEN_CAUSES = new Set([
  'COMPETITOR_UNDERCUT',
  'COMPETITOR_REACTION',
  'EXTERNAL_PRICE_CHANGE',
  'AMAZON_PRICE_FLOOR',
  'AMAZON_STEP_ENFORCEMENT',
  'AMAZON_MIN_PRICE_BLOCK',
  'AMAZON_MAX_PRICE_BLOCK',
]);

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getReconciliationWindowStartIso(now = Date.now()): string {
  return new Date(now - RECONCILIATION_WINDOW_MS).toISOString();
}

export function getReconciliationIntendedPrice(row: ReconciliationMetricRow): number | null {
  return toFiniteNumber(row.intended_price) ?? toFiniteNumber(row.new_price);
}

export function getReconciliationLivePrice(row: ReconciliationMetricRow): number | null {
  return toFiniteNumber(row.verified_live_price);
}

export function getReconciliationAbsoluteDelta(row: ReconciliationMetricRow): number | null {
  const intended = getReconciliationIntendedPrice(row);
  const live = getReconciliationLivePrice(row);

  if (intended === null || live === null) return null;
  return Math.abs(live - intended);
}

/** Extract root cause from recon_root_cause column or parse from reason text */
export function extractRootCause(row: ReconciliationMetricRow): string | null {
  if (row.recon_root_cause) return row.recon_root_cause;
  // Parse from reason text: "... [FEED_DELAY] ..."
  const match = row.reconciliation_reason?.match(/\[([A-Z_]+)\]/);
  return match ? match[1] : null;
}

/** Check if a mismatch is caused by market dynamics (not a system error) */
export function isMarketDrivenMismatch(row: ReconciliationMetricRow): boolean {
  const cause = extractRootCause(row);
  return cause !== null && MARKET_DRIVEN_CAUSES.has(cause);
}

export function isEffectiveReconciliationMatch(row: ReconciliationMetricRow): boolean {
  if (row.reconciliation_status === "matched") return true;
  if (row.reconciliation_status !== "mismatch") return false;

  const reason = row.reconciliation_reason?.toLowerCase() ?? "";
  if (reason.includes("rounding match") || reason.includes(", rounding") || reason.includes("fx rounding")) {
    return true;
  }

  const absDelta = getReconciliationAbsoluteDelta(row);
  if (absDelta === null) return false;
  
  // For international marketplaces, use percentage-based tolerance
  const intended = getReconciliationIntendedPrice(row);
  if (intended && intended > 10) {
    const pctDiff = (absDelta / intended) * 100;
    if (pctDiff < 3.0) return true; // 3% tolerance for FX rounding
  }
  
  return absDelta < RECONCILIATION_ROUNDING_TOLERANCE;
}

export function getEffectiveReconciliationStatus(row: ReconciliationMetricRow): string | null {
  if (isEffectiveReconciliationMatch(row)) return "matched";
  return row.reconciliation_status;
}

export function isDisplayableReconciliationMismatch(row: ReconciliationMetricRow): boolean {
  return getEffectiveReconciliationStatus(row) === "mismatch";
}

export function summarizeReconciliation(rows: ReconciliationMetricRow[]) {
  let matched = 0;
  let mismatch = 0;
  let failed = 0;
  let pending = 0;
  let pendingTimeout = 0;
  let nonReconcilable = 0;
  let recheck = 0;
  let marketDriven = 0; // mismatches caused by market dynamics

  for (const row of rows) {
    const effectiveStatus = getEffectiveReconciliationStatus(row);

    switch (effectiveStatus) {
      case "matched":
        matched++;
        break;
      case "mismatch":
        mismatch++;
        if (isMarketDrivenMismatch(row)) marketDriven++;
        break;
      case "failed":
        failed++;
        break;
      case "pending":
        pending++;
        break;
      case "pending_timeout":
        pendingTimeout++;
        break;
      case "non_reconcilable":
        nonReconcilable++;
        break;
      case "recheck":
        recheck++;
        break;
      default:
        break;
    }
  }

  // Match rate denominator: only matched + mismatch (failed = couldn't verify, not wrong)
  const verifiedTotal = matched + mismatch;
  const countedTotal = matched + mismatch + failed;
  const systemMismatch = mismatch - marketDriven; // actual system errors

  return {
    matched,
    mismatch,
    failed,
    pending,
    pendingTimeout,
    nonReconcilable,
    recheck,
    countedTotal,
    verifiedTotal,
    matchRate: verifiedTotal > 0 ? Math.round((matched / verifiedTotal) * 100) : 100,
    // System accuracy excludes market-driven mismatches from the denominator
    marketDriven,
    systemMismatch,
    systemAccuracy: (countedTotal - marketDriven) > 0
      ? Math.round((matched / (countedTotal - marketDriven)) * 100)
      : 100,
  };
}
