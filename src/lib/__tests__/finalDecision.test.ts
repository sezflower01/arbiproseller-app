import { describe, it, expect } from "vitest";
import { computeFinalDecision } from "@/lib/finalDecision";

const baseInput = {
  profit: 15,
  roi: 90,
  hasCost: true,
  eligibility: "approved" as const,
  intel: {
    amazon_presence_pct: 2,
    bsr_current: 25000,
    est_monthly_sales: 200,
    third_party_buybox_pct: 30,
  },
  swingPct: 8, // stable
  rangeLabel: "3M",
  offerCounts: { fba: 4, fbm: 0 },
  buyBoxPrice: 44.94,
};

describe("computeFinalDecision — compliance overlay", () => {
  it("prepends hazmat clause and downgrades STRONG BUY to BUY (Cautious)", () => {
    const fd = computeFinalDecision({
      ...baseInput,
      compliance: { hazmat: "yes", prep: "none" },
    });
    expect(fd.final.why.toLowerCase()).toContain("hazmat flagged");
    expect(fd.final.action === "BUY (Cautious)" || fd.final.action === "BUY CAUTIOUSLY").toBe(true);
    expect(fd.complianceFlags).toContain("hazmat");
  });

  // NOTE: The former "high IP risk downgrades any BUY* to TEST ONLY" test
  // was removed 2026-07-06 along with the ipRisk overlay branch. No live
  // data source was wired (the analyzer-product-snapshot IP alert was
  // hardcoded to "good"), so the test asserted logic that was unreachable
  // in production. See .lovable/architecture-audit.md → "IP risk overlay".

  it("caution hazmat prefixes without downgrading", () => {
    const fd = computeFinalDecision({
      ...baseInput,
      compliance: { hazmat: "caution", prep: "none" },
    });
    expect(fd.final.why.toLowerCase()).toContain("possible hazmat");
    // Action tier untouched
    expect(fd.complianceFlags).toContain("hazmat_caution");
  });
});


describe("computeFinalDecision — seller count reconciliation", () => {
  it("offerCounts wins over null intel.sellers_*", () => {
    const fd = computeFinalDecision({
      ...baseInput,
      intel: { ...baseInput.intel, bsr_current: 200000 } as any,
      offerCounts: { fba: 18, fbm: 2 },
    });
    expect(fd.sellerCountSource).toBe("offers_list");
    expect(fd.sellerCountUsed).toBe(20);
    // 20 sellers should force competition to at least Medium (not "Low")
    expect(fd.competition.text).not.toBe("Low");
  });

  it("falls back to intel.sellers_* when offerCounts empty", () => {
    const fd = computeFinalDecision({
      ...baseInput,
      offerCounts: null,
      intel: { ...baseInput.intel, sellers_fba: 3, sellers_fbm: 1 },
    });
    expect(fd.sellerCountSource).toBe("keepa_intel");
    expect(fd.sellerCountUsed).toBe(4);
  });
});

describe("computeFinalDecision — Sim override labeling", () => {
  it("labels Sim inputs and recomputes verdict from sim profit/roi", () => {
    const fd = computeFinalDecision({
      ...baseInput,
      simOverride: { active: true, profit: 0.5, roi: 3 },
    });
    expect(fd.priceBasis).toBe("sim");
    expect(fd.final.why.startsWith("(Sim — your inputs)")).toBe(true);
    // Sim profit $0.50 < $1 → AVOID
    expect(fd.final.action).toBe("AVOID");
    expect(fd.simDelta?.bbRoi).toBe(90);
    expect(fd.simDelta?.simRoi).toBe(3);
  });

  it("labels Buy Box price when Sim inactive", () => {
    const fd = computeFinalDecision(baseInput);
    expect(fd.priceBasis).toBe("buy_box");
    expect(fd.final.why.startsWith("(Buy Box price)")).toBe(true);
    expect(fd.explanation).toContain("Based on Buy Box $44.94");
  });
});

describe("computeFinalDecision — regression guard", () => {
  it("no compliance passed behaves like v1 baseline (basis prefix aside)", () => {
    const fd = computeFinalDecision(baseInput);
    expect(fd.complianceFlags).toEqual([]);
    // Baseline strong path should still fire.
    expect(["STRONG BUY", "BUY", "BUY (Cautious)"]).toContain(fd.final.action);
  });
});

/**
 * Branch-matrix: prove the compliance overlay fires on every base branch
 * that deriveFinalAction can produce, not just STRONG BUY. Each row builds
 * an input tuned to land on one specific base action, then asserts hazmat=yes
 * prefixes the sentence AND (where applicable) downgrades the tier.
 */
describe("computeFinalDecision — compliance branch matrix", () => {
  type Row = {
    name: string;
    input: Parameters<typeof computeFinalDecision>[0];
    baseExpectedActions: string[];
    hazmatShouldDowngrade: boolean;
  };

  const rows: Row[] = [
    {
      name: "STRONG BUY base → BUY (Cautious) with hazmat",
      input: {
        ...baseInput,
        intel: { ...baseInput.intel, bsr_current: 5000, est_monthly_sales: 500, amazon_presence_pct: 1 },
        swingPct: 5,
        offerCounts: { fba: 3, fbm: 0 },
      },
      baseExpectedActions: ["STRONG BUY"],
      hazmatShouldDowngrade: true,
    },
    {
      name: "BUY base → BUY (Cautious) with hazmat",
      input: {
        ...baseInput,
        profit: 5,
        roi: 30, // just at the "good profit" boundary, drops score < 80
        intel: {
          amazon_presence_pct: 20, // occasional → caution (but doesn't tip comp to caution alone)
          bsr_current: 400000, // slower BSR
          est_monthly_sales: 15,
          third_party_buybox_pct: 30,
        },
        swingPct: 5,
        offerCounts: { fba: 5, fbm: 0 },
      },
      baseExpectedActions: ["BUY"],
      hazmatShouldDowngrade: true,
    },
    {
      name: "BUY (Cautious) base → stays BUY (Cautious) with hazmat prefix",
      input: {
        ...baseInput,
        // Two signals push comp to Medium: Amazon occasional (+1) and 8+ sellers (+1)
        intel: { ...baseInput.intel, amazon_presence_pct: 40 },
        offerCounts: { fba: 8, fbm: 0 },
      },
      baseExpectedActions: ["BUY (Cautious)"],
      hazmatShouldDowngrade: false, // already Cautious
    },
    {
      name: "TEST ONLY base (thin margin) → hazmat prefixes, tier unchanged",
      input: {
        ...baseInput,
        profit: 2.5,
        roi: 15,
      },
      baseExpectedActions: ["TEST ONLY"],
      hazmatShouldDowngrade: false,
    },
    {
      name: "WATCH base (two cautions) → hazmat prefixes, tier unchanged",
      input: {
        ...baseInput,
        profit: 4,
        roi: 25,
        intel: { ...baseInput.intel, amazon_presence_pct: 20, bsr_current: 700000 },
        swingPct: 30, // volatile
        offerCounts: { fba: 10, fbm: 0 },
      },
      baseExpectedActions: ["WATCH"],
      hazmatShouldDowngrade: false,
    },
    {
      name: "AVOID base (bad profit) → hazmat prefixes, still AVOID",
      input: {
        ...baseInput,
        profit: 0.5,
        roi: 2,
      },
      baseExpectedActions: ["AVOID"],
      hazmatShouldDowngrade: false,
    },
  ];

  for (const row of rows) {
    it(`hazmat=yes overlay fires on branch: ${row.name}`, () => {
      // 1. Base (no compliance) lands on the expected branch.
      const base = computeFinalDecision(row.input);
      expect(row.baseExpectedActions).toContain(base.final.action);

      // 2. Same input with hazmat=yes: prefix present, flag present.
      const withHazmat = computeFinalDecision({
        ...row.input,
        compliance: { hazmat: "yes", prep: "none" },
      });
      expect(withHazmat.final.why.toLowerCase()).toContain("hazmat flagged");
      expect(withHazmat.complianceFlags).toContain("hazmat");

      // 3. Downgrade contract: STRONG BUY / BUY → BUY (Cautious); everything else
      //    keeps its tier but still shows the prefix.
      if (row.hazmatShouldDowngrade) {
        expect(withHazmat.final.action).toBe("BUY (Cautious)");
      } else {
        expect(withHazmat.final.action).toBe(base.final.action);
      }
    });
  }

  // NOTE: The former "ipRisk=high downgrades every BUY* branch to TEST ONLY"
  // matrix test was removed 2026-07-06. The `ipRisk` field never had a live
  // data source (see architecture-audit.md → "IP risk overlay"), so this
  // test asserted a code path that could not fire in production. Restore it
  // only if a real IP-risk classifier is wired end-to-end.
});


describe("computeFinalDecision — competition null-guard", () => {
  it("returns Unknown competition (not Low) when seller count is unavailable", () => {
    const fd = computeFinalDecision({
      ...baseInput,
      offerCounts: null,
      intel: {
        // No sellers_fba / sellers_fbm at all — the mobile-scan bug.
        amazon_presence_pct: null as any,
        bsr_current: 25000,
        est_monthly_sales: 200,
        third_party_buybox_pct: null as any,
      },
    });
    expect(fd.sellerCountSource).toBe("none");
    expect(fd.competition.level).toBe("unknown");
    expect(fd.competition.text).toBe("Unknown");
    expect(fd.explanation.toLowerCase()).toContain("seller count unavailable");
  });
});
