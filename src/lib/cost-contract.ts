/**
 * ============================================================================
 * COST CONTRACT — Contract A (LOCKED)
 * ============================================================================
 *
 * This module is the single source of truth for interpreting the meaning of
 * the `cost`, `amount`, and `units` columns across the two main tables that
 * carry per-item economic data. Ledger audit (99.98% of 6,229 rows) confirms
 * Contract A as the canonical interpretation.
 *
 * created_listings (purchase / acquisition record)
 * ------------------------------------------------
 *   units   = number of units purchased in this listing/batch
 *   cost    = TOTAL batch cost (what the seller paid for ALL units combined)
 *   amount  = UNIT cost (cost of ONE unit)
 *
 *   Invariant (when both populated): cost ≈ amount * units
 *
 * inventory (current FBA stock valuation)
 * ---------------------------------------
 *   units   = current stock quantity (available + reserved + inbound view)
 *   cost    = UNIT cost (what each unit in stock cost the seller)
 *   amount  = TOTAL inventory value at unit cost (cost * units)
 *
 *   Invariant (when both populated): amount ≈ cost * units
 *
 * NOTE: The two tables INVERT the meaning of `cost` and `amount`. This is a
 * historical schema reality — DO NOT "harmonize" by swapping columns. Use
 * these helpers everywhere instead.
 *
 * Phase 1–2 status: helpers only. No writer or reader has been changed yet.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface CreatedListingCostRow {
  /** Number of units purchased in this listing/batch. */
  units?: number | null;
  /** TOTAL batch cost (Contract A). */
  cost?: number | null;
  /** UNIT cost (Contract A). */
  amount?: number | null;
}

export interface InventoryCostRow {
  /** Current stock quantity. */
  units?: number | null;
  /** UNIT cost (Contract A). */
  cost?: number | null;
  /** TOTAL inventory value (Contract A). */
  amount?: number | null;
}

// ----------------------------------------------------------------------------
// Internal utilities
// ----------------------------------------------------------------------------

const isPositiveFinite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

const toNumberOrNull = (n: unknown): number | null => {
  if (n === null || n === undefined) return null;
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : null;
};

// ============================================================================
// created_listings helpers
// ============================================================================

/**
 * Returns the UNIT cost for a created_listings row under Contract A.
 *
 * Preference order:
 *   1. positive `amount` (already the unit cost in Contract A)
 *   2. `cost / units`   (derive unit cost from the total)
 *   3. `null`           (insufficient data — DO NOT fall back to `cost`)
 *
 * Falling back to the raw `cost` column is the bug we are fixing — it returns
 * a TOTAL where a UNIT was expected, causing per-unit inflation.
 */
export function getListingUnitCost(row: CreatedListingCostRow): number | null {
  const amount = toNumberOrNull(row.amount);
  if (amount !== null && amount > 0) return amount;

  const cost = toNumberOrNull(row.cost);
  const units = toNumberOrNull(row.units);
  if (cost !== null && cost > 0 && isPositiveFinite(units)) {
    return cost / units;
  }

  return null;
}

/**
 * Returns the TOTAL batch cost for a created_listings row under Contract A.
 *
 * Preference order:
 *   1. `cost` (already the total in Contract A)
 *   2. `amount * units` (derive total from unit cost)
 *   3. `null`
 */
export function getListingTotalCost(row: CreatedListingCostRow): number | null {
  const cost = toNumberOrNull(row.cost);
  if (cost !== null && cost >= 0) return cost;

  const amount = toNumberOrNull(row.amount);
  const units = toNumberOrNull(row.units);
  if (amount !== null && amount >= 0 && isPositiveFinite(units)) {
    return amount * units;
  }

  return null;
}

/**
 * Self-consistency check: does `cost ≈ amount * units` within tolerance?
 *
 * Tolerance: max(0.01, 0.5% of expected total). Returns true when at least
 * one side is missing (we cannot disprove consistency).
 */
export function isListingRowConsistent(
  row: CreatedListingCostRow,
  toleranceAbs = 0.01,
  tolerancePct = 0.005,
): boolean {
  const cost = toNumberOrNull(row.cost);
  const amount = toNumberOrNull(row.amount);
  const units = toNumberOrNull(row.units);
  if (cost === null || amount === null || units === null) return true;
  if (units <= 0) return true;
  const expected = amount * units;
  const tol = Math.max(toleranceAbs, Math.abs(expected) * tolerancePct);
  return Math.abs(cost - expected) <= tol;
}

// ============================================================================
// inventory helpers
// ============================================================================

/**
 * Returns the UNIT cost for an inventory row under Contract A.
 *
 * Preference order:
 *   1. `cost` (already the unit cost in Contract A)
 *   2. `amount / units` (derive unit cost from total value)
 *   3. `null`
 */
export function getInventoryUnitCost(row: InventoryCostRow): number | null {
  const cost = toNumberOrNull(row.cost);
  if (cost !== null && cost >= 0) return cost;

  const amount = toNumberOrNull(row.amount);
  const units = toNumberOrNull(row.units);
  if (amount !== null && amount >= 0 && isPositiveFinite(units)) {
    return amount / units;
  }

  return null;
}

/**
 * Returns the TOTAL inventory value for an inventory row under Contract A.
 *
 * Preference order:
 *   1. `amount` (already the total in Contract A)
 *   2. `cost * units` (derive total from unit cost)
 *   3. `null`
 */
export function getInventoryTotalValue(row: InventoryCostRow): number | null {
  const amount = toNumberOrNull(row.amount);
  if (amount !== null && amount >= 0) return amount;

  const cost = toNumberOrNull(row.cost);
  const units = toNumberOrNull(row.units);
  if (cost !== null && cost >= 0 && units !== null && units >= 0) {
    return cost * units;
  }

  return null;
}

/**
 * Self-consistency check: does `amount ≈ cost * units`?
 */
export function isInventoryRowConsistent(
  row: InventoryCostRow,
  toleranceAbs = 0.01,
  tolerancePct = 0.005,
): boolean {
  const cost = toNumberOrNull(row.cost);
  const amount = toNumberOrNull(row.amount);
  const units = toNumberOrNull(row.units);
  if (cost === null || amount === null || units === null) return true;
  if (units < 0) return true;
  const expected = cost * units;
  const tol = Math.max(toleranceAbs, Math.abs(expected) * tolerancePct);
  return Math.abs(amount - expected) <= tol;
}

// ============================================================================
// Cross-table conversion (used by inventory writers — Phase 3)
// ============================================================================

/**
 * Convert a created_listings row into the values an inventory row should
 * carry for a given current stock quantity.
 *
 *   inventory.cost   = listing UNIT cost
 *   inventory.amount = listing UNIT cost * stockQuantity
 *
 * Returns null fields when the listing does not provide a usable unit cost.
 *
 * THIS HELPER IS NOT WIRED INTO ANY WRITER YET (Phase 1–2). It exists so the
 * Phase 3 writer fix has a single, tested entry point.
 */
export function listingToInventoryCost(
  listing: CreatedListingCostRow,
  stockQuantity: number,
): { cost: number | null; amount: number | null } {
  const unit = getListingUnitCost(listing);
  if (unit === null) return { cost: null, amount: null };
  const qty = Math.max(0, Number(stockQuantity) || 0);
  return { cost: unit, amount: unit * qty };
}

// ============================================================================
// Phase 7: Operational Cost Override Layer
// ============================================================================
//
// inventory.cost stays the single "effective unit cost" used by every reader
// (repricer, valuation, P&L). The boolean flag `unit_cost_manual` tells us
// whether that value came from a user override or was derived from the
// purchase record (created_listings). When `unit_cost_manual = true`, the
// audit columns `manual_cost_updated_at` and `manual_cost_source` describe
// when and by whom the override was last set.
//
// The helpers below let UI and business logic answer two questions cleanly,
// without poking at boolean columns directly:
//   1. Is this row's cost an override or from the purchase record?
//   2. What unit cost should I actually use right now?

export type CostSource =
  | "manual"
  | "manual_no_purchase_record"
  | "purchase"
  | "unknown";

export interface InventoryOverrideRow extends InventoryCostRow {
  unit_cost_manual?: boolean | null;
  manual_cost_updated_at?: string | null;
  manual_cost_source?: string | null;
  /** Phase 7: optional short text describing why the cost was overridden. */
  manual_cost_reason?: string | null;
}

/**
 * Returns true when the inventory row carries a user-set cost override.
 * Phase 7: equivalent to `unit_cost_manual === true`, but goes through this
 * helper so the underlying flag can evolve without touching every caller.
 */
export function isManualCostOverride(row: InventoryOverrideRow): boolean {
  return row.unit_cost_manual === true;
}

/**
 * Classifies where the unit cost on this inventory row came from.
 *   - "manual"                     → user explicitly set it AND a Created Listing exists
 *   - "manual_no_purchase_record"  → user set cost operationally, no purchase record yet
 *                                    (typical for new sellers who synced Amazon first)
 *   - "purchase"                   → derived from created_listings via sync
 *   - "unknown"                    → no usable cost on the row at all
 *
 * `hasPurchaseRecord` is optional. When omitted, manual overrides classify as
 * plain "manual" — callers that know whether a Created Listing exists for
 * the ASIN should pass the flag so the UI can show the more specific label.
 */
export function getCostSource(
  row: InventoryOverrideRow,
  hasPurchaseRecord?: boolean,
): CostSource {
  if (isManualCostOverride(row)) {
    if (hasPurchaseRecord === false) return "manual_no_purchase_record";
    if (
      hasPurchaseRecord === undefined &&
      row.manual_cost_source === "manual_no_purchase_record"
    ) {
      return "manual_no_purchase_record";
    }
    return "manual";
  }
  const unit = getInventoryUnitCost(row);
  return unit !== null && unit > 0 ? "purchase" : "unknown";
}

/**
 * Returns the effective unit cost everything in the app should use.
 *
 * Phase 7: this is intentionally a thin wrapper around getInventoryUnitCost.
 * Because inventory.cost IS the effective unit cost (override OR purchase-
 * derived), we don't need a separate manual_unit_cost column. The wrapper
 * exists so future logic (blended cost, time-weighted cost, etc.) can be
 * introduced in one place.
 */
export function getEffectiveUnitCost(row: InventoryOverrideRow): number | null {
  return getInventoryUnitCost(row);
}

/**
 * Human-readable label for cost-source UI badges.
 */
export function describeCostSource(source: CostSource): string {
  switch (source) {
    case "manual":
      return "Overridden";
    case "manual_no_purchase_record":
      return "Manual / No Purchase Record";
    case "purchase":
      return "From Purchase";
    default:
      return "No cost";
  }
}

// ============================================================================
// Phase 7 wiring notes (as of 2026-04-24) — READ BEFORE TOUCHING SHIPMENTS
// ============================================================================
//
// Reorder flow (ReplenishmentOrderPanel and friends):
//   ✅ Uses the Phase 7 effective inventory cost via getEffectiveUnitCost(row).
//   ✅ Renders <CostSourceBadge /> wherever the unit cost is shown so users
//      can tell "Overridden" vs "From Purchase" at a glance.
//
// Shipment Builder (ShipmentBuilder, NeedBuyAgainDialog,
// ReplenishmentShipmentBuilder):
//   ⚠️  Currently does NOT read or display unit cost. No wiring needed today.
//
// IF you later add ANY of the following to the Shipment Builder surface:
//   - shipment value / total cost
//   - per-line or aggregate ROI preview
//   - shipment profitability estimates
//   - reorder-cost summaries inside the builder
// THEN it MUST:
//   1. Resolve unit cost through getEffectiveUnitCost(inventoryRow)
//      — never read inventory.cost, created_listings.cost, or
//        created_listings.amount directly.
//   2. Render <CostSourceBadge /> next to any visible unit cost so override
//      provenance stays transparent.
//
// Bulk override tooling is intentionally NOT built yet. Do not add it as a
// side-effect of shipment work.
//
// ============================================================================
// Contract metadata (for diagnostics / future schema discriminator)
// ============================================================================

export const COST_CONTRACT = {
  version: "A",
  lockedAt: "2026-04-23",
  ledgerConfirmation: "6228/6229 rows (99.98%)",
  createdListings: {
    cost: "TOTAL batch cost",
    amount: "UNIT cost",
    units: "purchase quantity",
  },
  inventory: {
    cost: "UNIT cost",
    amount: "TOTAL inventory value",
    units: "stock quantity",
  },
} as const;

// ---------------- SAFE variants (cost sanity guard, v2) ----------------
// Mirror of supabase/functions/_shared/cost-contract.ts.
// v1 (DEPRECATED) rejected any row with units<=0 — that conflated stock
// quantity with purchase quantity and discarded valid unit costs for
// depleted SKUs. v2 trusts the canonical UNIT field (inventory.cost,
// created_listings.amount) when present and only requires units>0 when
// DERIVING unit cost from the TOTAL field.

const _SAFE_TOL_ABS = 0.01;
const _SAFE_TOL_PCT = 0.005;

export function getListingUnitCostSafe(row: CreatedListingCostRow): number | null {
  const amount = toNumberOrNull(row.amount);
  const cost = toNumberOrNull(row.cost);
  const units = toNumberOrNull(row.units);

  if (amount !== null && amount > 0) {
    if (cost !== null && cost > 0 && units !== null && units > 0) {
      const expectedTotal = amount * units;
      const tol = Math.max(_SAFE_TOL_ABS, Math.abs(expectedTotal) * _SAFE_TOL_PCT);
      if (Math.abs(cost - expectedTotal) > tol) {
        const derivedUnit = cost / units;
        if (derivedUnit > 0 && derivedUnit < amount) return derivedUnit;
        return null;
      }
    }
    return amount;
  }
  if (cost !== null && cost > 0 && units !== null && units > 0) {
    return cost / units;
  }
  return null;
}

export function getInventoryUnitCostSafe(row: InventoryCostRow): number | null {
  const cost = toNumberOrNull(row.cost);
  const amount = toNumberOrNull(row.amount);
  const units = toNumberOrNull(row.units);

  if (cost !== null && cost > 0) {
    if (amount !== null && amount > 0 && units !== null && units > 0) {
      const expectedTotal = cost * units;
      const tol = Math.max(_SAFE_TOL_ABS, Math.abs(expectedTotal) * _SAFE_TOL_PCT);
      if (Math.abs(amount - expectedTotal) > tol) {
        const derivedUnit = amount / units;
        if (derivedUnit > 0 && derivedUnit < cost) return derivedUnit;
        return null;
      }
    }
    return cost;
  }
  if (amount !== null && amount > 0 && units !== null && units > 0) {
    return amount / units;
  }
  return null;
}
