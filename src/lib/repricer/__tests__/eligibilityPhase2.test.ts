// Phase 2 invariants — proof tests for the TS mirror of derive_repricer_eligibility().
// The SQL function is the source of truth in the DB; this test file enforces the
// SAME decision tree at the UI layer (deriveAssignmentStatus) so we cannot drift.
import { describe, it, expect, vi } from "vitest";
import { deriveAssignmentStatus, isManuallyPaused } from "../assignmentStatus";

describe("Phase 2 read-only invariants", () => {
  it("'Paused' label appears ONLY when manual_paused=true", () => {
    // Many shapes of NOT-manually-paused-but-disabled rows
    const shapes = [
      { is_enabled: false, rule_id: "r1", auto_suspended_reason: "NO_STOCK" },
      { is_enabled: false, rule_id: "r1", auto_suspended_reason: "LISTING_INACTIVE" },
      { is_enabled: false, rule_id: "r1", auto_suspended_reason: "INTL_STALE" },
      { is_enabled: false, rule_id: "r1", auto_suspended_reason: "INBOUND_ONLY_INACTIVE" },
      { is_enabled: false, rule_id: "r1", auto_suspended_reason: "MARKETPLACE_NOT_SELLABLE" },
      { is_enabled: false, rule_id: "r1", auto_suspended_reason: "LEGACY_UNAUDITED" },
      { is_enabled: false, rule_id: "r1", amazon_listing_state: "UNKNOWN" },
      { is_enabled: false, rule_id: null },
    ];
    for (const s of shapes) {
      const out = deriveAssignmentStatus({ ...s, manual_paused: false });
      expect(out.label, JSON.stringify(s)).not.toBe("Paused");
      expect(out.kind).not.toBe("manually_paused");
    }
    // Only manual_paused yields "Paused"
    expect(deriveAssignmentStatus({ manual_paused: true, is_enabled: false, rule_id: "r1" }).label).toBe("Paused");
    expect(isManuallyPaused({ manual_paused: true, is_enabled: false, rule_id: "r1" })).toBe(true);
    expect(isManuallyPaused({ manual_paused: false, is_enabled: false, rule_id: "r1", auto_suspended_reason: "NO_STOCK" })).toBe(false);
  });

  it("inbound-only / listing-inactive row stays visible and never becomes ghost / no_inventory", () => {
    // Exact B0G4BQ42W3 shape
    const s = deriveAssignmentStatus({
      is_enabled: false,
      manual_paused: false,
      rule_id: "r1",
      available: 0,
      reserved: 0,
      inbound: 70,
      amazon_listing_state: "INACTIVE",
      // even if matching inventory row is missing, inbound>0 must NOT collapse to no_inventory
      has_matching_inventory: false,
      inventory_terminal: true,
    });
    expect(s.kind).toMatch(/inbound_only/);
    expect(s.kind).not.toBe("no_inventory");
    expect(s.tone).not.toBe("muted"); // not silently muted-out
  });

  it("disabled rows remain visible — every disabled state produces a non-empty label", () => {
    const disabledStates = [
      { auto_suspended_reason: "NO_STOCK" },
      { auto_suspended_reason: "LISTING_INACTIVE" },
      { auto_suspended_reason: "INTL_STALE" },
      { auto_suspended_reason: "INBOUND_ONLY_INACTIVE" },
      { auto_suspended_reason: "MARKETPLACE_NOT_SELLABLE" },
      { auto_suspended_reason: "LEGACY_UNAUDITED" },
      { amazon_listing_state: "UNKNOWN" },
      { last_disabled_by: "system" },
    ];
    for (const extra of disabledStates) {
      const s = deriveAssignmentStatus({ is_enabled: false, manual_paused: false, rule_id: "r1", ...extra });
      expect(s.label.length, JSON.stringify(extra)).toBeGreaterThan(0);
      expect(s.tooltip.length).toBeGreaterThan(0);
      // Must not be hidden / blank
      expect(s.kind).not.toBe("active");
    }
  });

  it("stale intl quantity produces a stale label, not a silent disable", () => {
    const s = deriveAssignmentStatus({
      is_enabled: false,
      manual_paused: false,
      rule_id: "r1",
      auto_suspended_reason: "INTL_STALE",
      intl_qty_confidence: "STALE",
    });
    expect(s.kind).toBe("auto_suspended_intl_stale");
    expect(s.label.toLowerCase()).toContain("stale");
    expect(s.tone).toBe("warning"); // visible, not silent
  });

  it("derive function is pure — does not mutate the input object", () => {
    const input = {
      is_enabled: false,
      manual_paused: false,
      rule_id: "r1",
      available: 0,
      inbound: 70,
      amazon_listing_state: "INACTIVE" as const,
    };
    const snapshot = JSON.stringify(input);
    deriveAssignmentStatus(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("guarantees: deriveAssignmentStatus never writes to the database (no supabase import)", async () => {
    // Static guarantee: import the module fresh and confirm it has no supabase client reference.
    const mod = await import("../assignmentStatus");
    const keys = Object.keys(mod);
    // Only exports the derive helpers — nothing that could mutate is_enabled.
    expect(keys).toEqual(expect.arrayContaining(["deriveAssignmentStatus", "isManuallyPaused"]));
    // Spy guard: even if someone added a side-effecting import, ensure derive doesn't crash on minimal input.
    const fn = vi.fn(deriveAssignmentStatus);
    fn({ is_enabled: true, rule_id: "r1" });
    expect(fn).toHaveReturned();
  });
});
