import { describe, it, expect } from "vitest";
import { calculateOptimizedSettings } from "../repricerOptimizer";

describe("calculateOptimizedSettings", () => {
  // ── Tier 1: ≤ 500 ASINs ──
  it("returns batch=100, ttl=60, interval=10 for 50 ASINs", () => {
    const r = calculateOptimizedSettings(50);
    expect(r.batchSize).toBe(100);
    expect(r.snapshotTtl).toBe(60);
    expect(r.interval).toBe(10);
  });

  it("returns batch=100, ttl=60 for 500 ASINs (upper boundary)", () => {
    const r = calculateOptimizedSettings(500);
    expect(r.batchSize).toBe(100);
    expect(r.snapshotTtl).toBe(60);
    expect(r.fullCycleMinutes).toBe(50); // ceil(500/100)*10
  });

  // ── Tier 2: 501–1000 ASINs ──
  it("returns batch=200, ttl=45 for 600 ASINs", () => {
    const r = calculateOptimizedSettings(600);
    expect(r.batchSize).toBe(200);
    expect(r.snapshotTtl).toBe(45);
    expect(r.fullCycleMinutes).toBe(30); // ceil(600/200)*10
  });

  it("returns batch=200, ttl=45 for 1000 ASINs (upper boundary)", () => {
    const r = calculateOptimizedSettings(1000);
    expect(r.batchSize).toBe(200);
    expect(r.snapshotTtl).toBe(45);
    expect(r.fullCycleMinutes).toBe(50); // ceil(1000/200)*10
  });

  // ── Tier 3: 1001–2000 ASINs ──
  it("returns batch=300, ttl=30 for 1500 ASINs", () => {
    const r = calculateOptimizedSettings(1500);
    expect(r.batchSize).toBe(300);
    expect(r.snapshotTtl).toBe(30);
    expect(r.fullCycleMinutes).toBe(50); // ceil(1500/300)*10
  });

  // ── Tier 4: 2001–4000 ASINs ──
  it("returns batch=400, ttl=20 for 3000 ASINs", () => {
    const r = calculateOptimizedSettings(3000);
    expect(r.batchSize).toBe(400);
    expect(r.snapshotTtl).toBe(20);
    expect(r.fullCycleMinutes).toBe(80); // ceil(3000/400)*10
  });

  // ── Tier 5: 4001+ ASINs ──
  it("returns batch=500, ttl=15 for 5000 ASINs", () => {
    const r = calculateOptimizedSettings(5000);
    expect(r.batchSize).toBe(500);
    expect(r.snapshotTtl).toBe(15);
    expect(r.fullCycleMinutes).toBe(100); // ceil(5000/500)*10
  });

  it("returns batch=500, ttl=15 for 6000 ASINs (slider max)", () => {
    const r = calculateOptimizedSettings(6000);
    expect(r.batchSize).toBe(500);
    expect(r.snapshotTtl).toBe(15);
    expect(r.fullCycleMinutes).toBe(120); // ceil(6000/500)*10
  });

  // ── Cycle label formatting ──
  it("formats cycle label as minutes when < 60", () => {
    const r = calculateOptimizedSettings(200);
    expect(r.cycleLabel).toBe("~20 min");
  });

  it("formats cycle label as hours when >= 60", () => {
    const r = calculateOptimizedSettings(3000);
    expect(r.cycleLabel).toBe("~1.3 hrs");
  });

  // ── Repricings per day ──
  it("calculates correct repricings per day", () => {
    const r = calculateOptimizedSettings(500);
    // full cycle = 50 min → 1440/50 = 28
    expect(r.repricingsPerDay).toBe(28);
  });

  // ── Interval is always 10 ──
  it("always sets interval to 10 minutes", () => {
    for (const count of [50, 500, 501, 1000, 2000, 4000, 6000]) {
      expect(calculateOptimizedSettings(count).interval).toBe(10);
    }
  });

  // ── Snapshot TTL decreases as ASINs increase ──
  it("TTL decreases monotonically across tiers", () => {
    const ttls = [100, 600, 1500, 3000, 5000].map(
      (c) => calculateOptimizedSettings(c).snapshotTtl
    );
    for (let i = 1; i < ttls.length; i++) {
      expect(ttls[i]).toBeLessThanOrEqual(ttls[i - 1]);
    }
  });
});
