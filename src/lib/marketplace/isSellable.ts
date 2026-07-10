// Centralized marketplace sellability rules.
// Used by repricer, create-listing, add-purchase, shipment builder, analyzer.
//
// A non-US listing is "marketplace sellable" only when ALL of:
//   1. intl_listing_status array contains "BUYABLE"
//   2. fba_eligibility_cache (if present) is not blocked by RESTRICTION codes
//   3. Marketplace gating does not require approval
//
// US is always treated as sellable here — the existing US listing_status
// + inventory pipeline already governs US visibility.

export const RESTRICTION_CODES = new Set([
  "RESTRICTED",
  "NOT_ELIGIBLE",
  "APPROVAL_REQUIRED",
  "ASIN_NOT_ELIGIBLE",
  "BRAND_NOT_ELIGIBLE",
  "RESTRICTION",
]);

/** Parse intl_listing_status (stored as text – may be JSON array, CSV, or single word). */
export function parseIntlStatus(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s).toUpperCase());
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((x) => String(x).toUpperCase());
    } catch {
      /* fall through */
    }
  }
  // Fallback: split on common delimiters
  return s
    .split(/[,\s]+/)
    .map((x) => x.replace(/["\[\]]/g, "").toUpperCase())
    .filter(Boolean);
}

export type SellabilityInput = {
  marketplace: string; // e.g. "US", "CA", "MX", "BR", "UK"
  intl_listing_status?: unknown; // raw column value
  eligibility?: {
    eligible?: boolean | null;
    blocking_issues?: any[] | null;
  } | null;
};

export type SellabilityResult = {
  sellable: boolean;
  reason:
    | "us_default"
    | "buyable"
    | "not_buyable"
    | "status_unknown"
    | "restricted"
    | "approval_required";
};

export function evaluateSellability(input: SellabilityInput): SellabilityResult {
  const mkt = (input.marketplace || "").toUpperCase();
  if (mkt === "US") return { sellable: true, reason: "us_default" };

  const statuses = parseIntlStatus(input.intl_listing_status);

  // Status missing/unknown → not safe to show in repricer.
  if (statuses.length === 0 || statuses.includes("UNKNOWN") || statuses.includes("NOT_FOUND")) {
    return { sellable: false, reason: "status_unknown" };
  }

  if (!statuses.includes("BUYABLE")) {
    return { sellable: false, reason: "not_buyable" };
  }

  // Eligibility cache backstop (catches BUYABLE-but-restricted edge cases).
  const elig = input.eligibility;
  if (elig && elig.eligible === false) {
    const issues = Array.isArray(elig.blocking_issues) ? elig.blocking_issues : [];
    const hasApproval = issues.some(
      (it: any) => String(it?.code || "").toUpperCase() === "APPROVAL_REQUIRED"
    );
    if (hasApproval) return { sellable: false, reason: "approval_required" };
    const hasRestriction = issues.some((it: any) =>
      RESTRICTION_CODES.has(String(it?.code || "").toUpperCase())
    );
    if (hasRestriction) return { sellable: false, reason: "restricted" };
  }

  return { sellable: true, reason: "buyable" };
}

export function isMarketplaceSellable(input: SellabilityInput): boolean {
  return evaluateSellability(input).sellable;
}
