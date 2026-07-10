/**
 * Shared "is this row a ghost?" rule used by every UI module.
 * Mirrors public.is_ghost_inventory_row() in the database AND the inline
 * filter used by the Repricer assignments table (NeedBuyAgain + Repricer parity).
 *
 * A row is GHOST when ANY of:
 *   - listing_status is NOT_IN_CATALOG or DELETED
 *   - listing_status is INACTIVE / INCOMPLETE / SUPPRESSED (or contains INACTIVE)
 *   - sku starts with "amzn.gr." (Amazon-grading auto-relisted SKU)
 *   - total stock = 0 AND listing_status is not "ACTIVE"
 */
export interface GhostCandidate {
  listing_status?: string | null;
  sku?: string | null;
  available?: number | null;
  reserved?: number | null;
  inbound?: number | null;
  unfulfilled?: number | null;
}

export function isGhostRow(row: GhostCandidate | null | undefined): boolean {
  if (!row) return true;
  const ls = (row.listing_status || "").toUpperCase();
  if (ls === "NOT_IN_CATALOG" || ls === "DELETED") return true;
  if (ls === "INACTIVE" || ls.includes("INACTIVE") || ls === "INCOMPLETE" || ls === "SUPPRESSED") return true;
  if ((row.sku || "").toLowerCase().startsWith("amzn.gr.")) return true;
  const total =
    (Number(row.available) || 0) +
    (Number(row.reserved) || 0) +
    (Number(row.inbound) || 0) +
    (Number(row.unfulfilled) || 0);
  if (total <= 0 && ls !== "ACTIVE") return true;
  return false;
}

export function filterActive<T extends GhostCandidate>(rows: T[] | null | undefined): T[] {
  if (!rows) return [];
  return rows.filter((r) => !isGhostRow(r));
}
