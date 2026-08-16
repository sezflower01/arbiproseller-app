import { Loader2, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";

/**
 * Listing-eligibility badge for the statuses returned by the
 * `check-product-eligibility` edge function (SP-API Listings Restrictions).
 *
 * The function lowercases its status before returning, so consumers compare
 * against lowercase values -- see check-product-eligibility/index.ts, where
 * `approval_status: result.status.toLowerCase()` is what actually ships.
 *
 * Extracted from MobileScan's inline renderer, which six tools had already
 * copied between them (Sourcer, MobileScanDetail, KeepaProductFinder,
 * MyDatabaseProducts, UserStoreScan). Those copies are deliberately left in
 * place for now: replacing six working renderers is a separate change with
 * its own verification. This exists so the seventh consumer is a reuse
 * instead of a seventh copy.
 *
 * Colours differ from that original in one respect. MobileScan renders on a
 * dark surface and uses `text-emerald-300`-style values, which wash out on the
 * light cards used elsewhere. These pick a readable shade per theme instead of
 * assuming the background.
 */
export type EligibilityStatus =
  | "checking"
  | "approved"
  | "approval_required"
  | "restricted"
  | "error";

interface Props {
  status: EligibilityStatus | null | undefined;
  size?: "sm" | "md";
  className?: string;
}

export default function EligibilityBadge({ status, size = "sm", className = "" }: Props) {
  if (!status) return null;

  const base =
    size === "sm"
      ? "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md border whitespace-nowrap"
      : "inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md border whitespace-nowrap";
  const icon = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  const cls = (tone: string) => `${base} ${tone} ${className}`;

  switch (status) {
    case "checking":
      return (
        <span className={cls("bg-muted border-border text-muted-foreground")}>
          <Loader2 className={`${icon} animate-spin`} /> Checking
        </span>
      );
    case "approved":
      return (
        <span className={cls("bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300")}>
          <ShieldCheck className={icon} /> Approved
        </span>
      );
    case "approval_required":
      return (
        <span className={cls("bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300")}>
          <ShieldAlert className={icon} /> Needs Approval
        </span>
      );
    case "restricted":
      return (
        <span className={cls("bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300")}>
          <ShieldX className={icon} /> Restricted
        </span>
      );
    case "error":
      // Deliberately "N/A" rather than an error tone: a failed gating check
      // says nothing about the ASIN, and colouring it red would read as
      // "restricted" -- the most costly possible misreading here.
      return (
        <span className={cls("bg-muted border-border text-muted-foreground")}>
          Eligibility N/A
        </span>
      );
    default:
      return null;
  }
}
