/**
 * ============================================================================
 * COST CONTRACT — Contract A (LOCKED) — Edge / Deno mirror
 * ============================================================================
 *
 * This file MUST stay in lock-step with src/lib/cost-contract.ts.
 * Both files share identical semantics; only the runtime differs.
 *
 * created_listings:  cost = TOTAL,  amount = UNIT,  units = purchase qty
 * inventory:         cost = UNIT,   amount = TOTAL, units = stock qty
 *
 * Phase 1–2 status: helpers only. No edge writer or sync path has been
 * changed yet. Do not import these helpers into any writer/reader until
 * Phase 3 begins.
 * ============================================================================
 */

export interface CreatedListingCostRow {
  units?: number | null;
  cost?: number | null;
  amount?: number | null;
}

export interface InventoryCostRow {
  units?: number | null;
  cost?: number | null;
  amount?: number | null;
}

const isPositiveFinite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

const toNumberOrNull = (n: unknown): number | null => {
  if (n === null || n === undefined) return null;
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : null;
};

// ---------------- created_listings ----------------

export function getListingUnitCost(row: CreatedListingCostRow): number | null {
  // Mirrors src/lib/cost-contract.ts exactly:
  //   1. positive amount  -> return (UNIT cost by contract)
  //   2. cost>0 && units>0 -> derive cost/units
  //   3. null              -> COST_MISSING (callers must handle)
  //
  // The previous `>= 0` branches silently returned 0 for the cost=0 AND
  // amount=0 row class (1,389 created_listings rows in production, 16 of
  // them enabled+ruled in the repricer at the time of the audit). Returning
  // 0 propagates as a $0 unit cost, which then collides with the global
  // $5.00 floor and can poison ROI floor math. We refuse instead.
  const amount = toNumberOrNull(row.amount);
  if (amount !== null && amount > 0) return amount;

  const cost = toNumberOrNull(row.cost);
  const units = toNumberOrNull(row.units);
  if (cost !== null && cost > 0 && isPositiveFinite(units)) {
    return cost / units;
  }

  // Telemetry: only log when the row was non-empty (someone *tried* to
  // resolve a cost and we refused). Empty {} probes don't get logged.
  const rawAmount = toNumberOrNull(row.amount);
  const rawCost = toNumberOrNull(row.cost);
  if (rawAmount !== null || rawCost !== null) {
    console.warn(
      `[cost-contract] COST_MISSING getListingUnitCost: amount=${rawAmount} cost=${rawCost} units=${toNumberOrNull(row.units)} — returning null (was silent $0 pre-fix)`,
    );
  }
  return null;
}

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

// ---------------- inventory ----------------

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

// ---------------- cross-table ----------------

/**
 * Convert a created_listings row into the values an inventory row should
 * carry for a given current stock quantity. Used by Phase-3 inventory writer
 * fix — currently NOT called from any sync path.
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
//
// Background on the original v1 guard (now superseded):
// v1 rejected ANY row where `units <= 0`. That conflated two unrelated things:
//   * inventory.units      = STOCK quantity (Amazon available; depletes as you sell)
//   * created_listings.units = PURCHASE quantity (units in a sourcing batch)
// inventory.cost (UNIT cost) and created_listings.amount (UNIT cost) do NOT
// depend on the current stock quantity — they reflect what each unit cost
// to acquire. When a SKU sells out (inventory.units=0) the unit cost is
// still trustworthy and should NOT be discarded.
//
// v2 rule (this file):
//   * Trust the canonical UNIT field directly when present and > 0
//     (inventory.cost, created_listings.amount).
//   * Only require units>0 when DERIVING the unit cost from the TOTAL
//     (amount/units for inventory, cost/units for listings) — that's the
//     real divide-by-zero case.
//   * When BOTH the unit field AND the total field are present along with
//     units>0, validate consistency (|total - unit*units| <= tol). If
//     inconsistent, prefer the smaller derived value (defends against the
//     original `inventory{cost=237.49, amount=5.93, units=0}` swap case
//     ONLY when units>0; with units=0 we trust the canonical unit field).

const CONSISTENCY_TOL_ABS = 0.01;
const CONSISTENCY_TOL_PCT = 0.005;

export function getListingUnitCostSafe(row: CreatedListingCostRow): number | null {
  const amount = toNumberOrNull(row.amount); // UNIT cost (per Contract A)
  const cost = toNumberOrNull(row.cost);     // TOTAL batch cost
  const units = toNumberOrNull(row.units);   // purchase qty

  // Path 1: trust UNIT field when present.
  if (amount !== null && amount > 0) {
    // Cross-check against TOTAL/units only when both are usable.
    if (cost !== null && cost > 0 && units !== null && units > 0) {
      const expectedTotal = amount * units;
      const tol = Math.max(CONSISTENCY_TOL_ABS, Math.abs(expectedTotal) * CONSISTENCY_TOL_PCT);
      if (Math.abs(cost - expectedTotal) > tol) {
        const derivedUnit = cost / units;
        // Prefer the smaller value (likely the real per-unit) on disagreement.
        if (derivedUnit > 0 && derivedUnit < amount) return derivedUnit;
        return null; // truly inconsistent — refuse
      }
    }
    return amount;
  }

  // Path 2: derive UNIT from TOTAL / units (needs units>0).
  if (cost !== null && cost > 0 && units !== null && units > 0) {
    return cost / units;
  }
  return null;
}

export function getInventoryUnitCostSafe(row: InventoryCostRow): number | null {
  const cost = toNumberOrNull(row.cost);     // UNIT cost (per Contract A)
  const amount = toNumberOrNull(row.amount); // TOTAL inventory value
  const units = toNumberOrNull(row.units);   // stock qty (NOT purchase qty)

  // Path 1: trust UNIT field when present.
  if (cost !== null && cost > 0) {
    if (amount !== null && amount > 0 && units !== null && units > 0) {
      const expectedTotal = cost * units;
      const tol = Math.max(CONSISTENCY_TOL_ABS, Math.abs(expectedTotal) * CONSISTENCY_TOL_PCT);
      if (Math.abs(amount - expectedTotal) > tol) {
        const derivedUnit = amount / units;
        if (derivedUnit > 0 && derivedUnit < cost) return derivedUnit;
        return null;
      }
    }
    return cost;
  }

  // Path 2: derive from amount / units.
  if (amount !== null && amount > 0 && units !== null && units > 0) {
    return amount / units;
  }
  return null;
}

