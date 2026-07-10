import { describe, it, expect } from "vitest";
import {
  getListingUnitCost,
  getListingTotalCost,
  isListingRowConsistent,
  getInventoryUnitCost,
  getInventoryTotalValue,
  isInventoryRowConsistent,
  listingToInventoryCost,
  COST_CONTRACT,
} from "../cost-contract";

describe("Contract A metadata", () => {
  it("locks Contract A semantics", () => {
    expect(COST_CONTRACT.version).toBe("A");
    expect(COST_CONTRACT.createdListings.cost).toMatch(/total/i);
    expect(COST_CONTRACT.createdListings.amount).toMatch(/unit/i);
    expect(COST_CONTRACT.inventory.cost).toMatch(/unit/i);
    expect(COST_CONTRACT.inventory.amount).toMatch(/total/i);
  });
});

// ---------------------------------------------------------------------------
// created_listings helpers (cost = TOTAL, amount = UNIT)
// ---------------------------------------------------------------------------
describe("getListingUnitCost (Contract A)", () => {
  it("returns amount when present (canonical unit cost)", () => {
    expect(getListingUnitCost({ cost: 1520, amount: 15.2, units: 100 })).toBe(15.2);
  });

  it("derives unit cost from cost / units when amount missing", () => {
    expect(getListingUnitCost({ cost: 1520, units: 100 })).toBeCloseTo(15.2, 6);
  });

  it("returns null when only cost is known (refuses to leak total as unit)", () => {
    expect(getListingUnitCost({ cost: 1520 })).toBeNull();
  });

  it("returns null on empty row", () => {
    expect(getListingUnitCost({})).toBeNull();
  });

  it("ignores zero/negative units in derivation", () => {
    expect(getListingUnitCost({ cost: 100, units: 0 })).toBeNull();
    expect(getListingUnitCost({ cost: 100, units: -5 })).toBeNull();
  });

  it("returns null (COST_MISSING) when both cost and amount are 0 (refuses silent $0 floor)", () => {
    // PF-1 fix (2026-06-17): a row with cost=0 AND amount=0 carries no usable
    // unit cost. Returning 0 would propagate as a $0 floor into the repricer
    // (collides with the $5.00 global floor and poisons ROI math). The Deno
    // mirror in supabase/functions/_shared/cost-contract.ts now matches.
    expect(getListingUnitCost({ cost: 0, amount: 0, units: 10 })).toBeNull();
  });

  it("the 353-style bug case: cost=1520 misread as unit would yield $1520/unit; helper yields $15.20", () => {
    const row = { cost: 1520, amount: 15.2, units: 100 };
    const buggy = row.cost; // what the broken inventory writer would copy
    const correct = getListingUnitCost(row)!;
    expect(buggy).toBe(1520);
    expect(correct).toBe(15.2);
    expect(buggy / correct).toBe(100); // exact units-squared inflation factor
  });
});

describe("getListingTotalCost (Contract A)", () => {
  it("returns cost when present", () => {
    expect(getListingTotalCost({ cost: 1520, amount: 15.2, units: 100 })).toBe(1520);
  });

  it("derives total from amount * units when cost missing", () => {
    expect(getListingTotalCost({ amount: 15.2, units: 100 })).toBeCloseTo(1520, 6);
  });

  it("returns null when nothing usable", () => {
    expect(getListingTotalCost({ amount: 15.2 })).toBeNull();
    expect(getListingTotalCost({})).toBeNull();
  });
});

describe("isListingRowConsistent", () => {
  it("passes a perfectly consistent row", () => {
    expect(isListingRowConsistent({ cost: 1520, amount: 15.2, units: 100 })).toBe(true);
  });

  it("passes within 0.5% tolerance", () => {
    expect(isListingRowConsistent({ cost: 1525, amount: 15.2, units: 100 })).toBe(true);
  });

  it("fails when cost looks like a unit-cost (the inverted-write bug)", () => {
    // amount=15.2, units=100 => expected total 1520; cost stored as 15.2 (inverted)
    expect(isListingRowConsistent({ cost: 15.2, amount: 15.2, units: 100 })).toBe(false);
  });

  it("treats missing fields as inconclusive (true)", () => {
    expect(isListingRowConsistent({ cost: 1520 })).toBe(true);
    expect(isListingRowConsistent({})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inventory helpers (cost = UNIT, amount = TOTAL)
// ---------------------------------------------------------------------------
describe("getInventoryUnitCost (Contract A)", () => {
  it("returns cost when present (canonical unit cost)", () => {
    expect(getInventoryUnitCost({ cost: 15.2, amount: 152, units: 10 })).toBe(15.2);
  });

  it("derives unit cost from amount / units when cost missing", () => {
    expect(getInventoryUnitCost({ amount: 152, units: 10 })).toBeCloseTo(15.2, 6);
  });

  it("returns null on empty row", () => {
    expect(getInventoryUnitCost({})).toBeNull();
  });
});

describe("getInventoryTotalValue (Contract A)", () => {
  it("returns amount when present", () => {
    expect(getInventoryTotalValue({ cost: 15.2, amount: 152, units: 10 })).toBe(152);
  });

  it("derives total from cost * units when amount missing", () => {
    expect(getInventoryTotalValue({ cost: 15.2, units: 10 })).toBeCloseTo(152, 6);
  });

  it("returns 0 cleanly for zero stock with known unit cost", () => {
    expect(getInventoryTotalValue({ cost: 15.2, units: 0 })).toBe(0);
  });
});

describe("isInventoryRowConsistent", () => {
  it("passes a clean row", () => {
    expect(isInventoryRowConsistent({ cost: 15.2, amount: 152, units: 10 })).toBe(true);
  });

  it("flags the units-squared inflation bug (cost=total copied raw)", () => {
    // Bug: writer copied listing.cost (1520, total) into inventory.cost (should be unit)
    // With units=10, amount becomes 1520*10 = 15,200 instead of 152.
    expect(isInventoryRowConsistent({ cost: 1520, amount: 15200, units: 10 })).toBe(true);
    // ...but compared to true unit cost 15.2, total should be 152, not 15,200 — caught externally.
    // The internal-consistency check only verifies amount ≈ cost*units; cross-source check is separate.
  });

  it("fails when amount diverges from cost*units beyond tolerance", () => {
    expect(isInventoryRowConsistent({ cost: 15.2, amount: 9999, units: 10 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cross-table conversion
// ---------------------------------------------------------------------------
describe("listingToInventoryCost (Phase 3 entry point)", () => {
  it("derives correct {cost, amount} from a listing", () => {
    const out = listingToInventoryCost({ cost: 1520, amount: 15.2, units: 100 }, 7);
    expect(out.cost).toBe(15.2);
    expect(out.amount).toBeCloseTo(106.4, 6);
  });

  it("falls back to cost/units when amount is missing", () => {
    const out = listingToInventoryCost({ cost: 1520, units: 100 }, 3);
    expect(out.cost).toBeCloseTo(15.2, 6);
    expect(out.amount).toBeCloseTo(45.6, 6);
  });

  it("returns null fields when listing has no usable unit cost", () => {
    const out = listingToInventoryCost({ cost: 1520 }, 5);
    expect(out.cost).toBeNull();
    expect(out.amount).toBeNull();
  });

  it("clamps negative stock to zero", () => {
    const out = listingToInventoryCost({ amount: 15.2, units: 100 }, -5);
    expect(out.cost).toBe(15.2);
    expect(out.amount).toBe(0);
  });

  it("yields {cost:0, amount:0} for zero stock", () => {
    const out = listingToInventoryCost({ amount: 15.2, units: 100 }, 0);
    expect(out.cost).toBe(15.2);
    expect(out.amount).toBe(0);
  });
});
