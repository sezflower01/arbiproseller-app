// Shared, pure resolver for FBM fallback unit cost.
//
// CONTRACT (verified against production 2026-06-17, 6,857 comparable rows in
// `created_listings`, 6,844 of which satisfy `amount = cost/units`):
//   - `created_listings.amount` is the PER-UNIT cost.
//   - `created_listings.cost`   is (in the canonical 99.81% of rows) the BATCH
//                               TOTAL paid for `units` units.
//   - 13 anomalous rows (0.19%) store the per-unit cost in BOTH columns
//     simultaneously. The resolver remains correct for them because it
//     prefers `amount` first.
//
// Resolution order:
//   1. amount               (preferred — always per-unit by contract)
//   2. cost / units         (safe derived per-unit cost)
//   3. raw cost             (only when units is unknown or 1)
//
// Returns the resolved unit cost and which path was taken, so callers can
// emit a telemetry log to detect upstream regressions (e.g. a writer that
// stops populating `amount` and silently forces the system onto path 2 or 3
// forever — that is exactly how the original bug class was born).

export type FbmCostPath = 'amount' | 'cost_div_units' | 'raw_cost' | 'none';

export interface FbmCostRow {
  cost?: number | string | null;
  amount?: number | string | null;
  units?: number | string | null;
}

export interface FbmCostResolution {
  unitCost: number | null;
  path: FbmCostPath;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function resolveFbmUnitCost(row: FbmCostRow): FbmCostResolution {
  const amt = toNum(row.amount);
  const cst = toNum(row.cost);
  const units = toNum(row.units);

  if (amt !== null && amt > 0) return { unitCost: amt, path: 'amount' };
  if (cst !== null && cst > 0 && units !== null && units > 0) {
    return { unitCost: cst / units, path: 'cost_div_units' };
  }
  if (cst !== null && cst > 0) return { unitCost: cst, path: 'raw_cost' };
  return { unitCost: null, path: 'none' };
}
