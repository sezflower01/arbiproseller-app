import { describe, it, expect } from "vitest";
import { deriveAssignmentStatus } from "../assignmentStatus";

describe("deriveAssignmentStatus — Phase 1 invariants", () => {
  it("never labels a non-manual disable as 'Paused'", () => {
    const s = deriveAssignmentStatus({
      manual_paused: false,
      is_enabled: false,
      rule_id: "r1",
      auto_suspended_reason: "NO_STOCK",
    });
    expect(s.kind).not.toBe("manually_paused");
    expect(s.label).not.toBe("Paused");
    expect(s.kind).toBe("auto_suspended_no_stock");
  });

  it("labels manual_paused=true as Paused", () => {
    const s = deriveAssignmentStatus({
      manual_paused: true,
      is_enabled: false,
      rule_id: "r1",
    });
    expect(s.kind).toBe("manually_paused");
    expect(s.label).toBe("Paused");
  });

  it("flags B0G4BQ42W3-style row as inbound-only / inactive (not 'no inventory')", () => {
    const s = deriveAssignmentStatus({
      is_enabled: false,
      manual_paused: false,
      rule_id: "r1",
      available: 0,
      reserved: 0,
      inbound: 70,
      amazon_listing_state: "INACTIVE",
    });
    expect(s.kind).toBe("auto_suspended_inbound_only_inactive");
    expect(s.label).toMatch(/Inbound/i);
  });

  it("falls back to needs_review when listing state is UNKNOWN and nothing else fired", () => {
    const s = deriveAssignmentStatus({
      is_enabled: false,
      manual_paused: false,
      rule_id: "r1",
      amazon_listing_state: "UNKNOWN",
    });
    expect(s.kind).toBe("needs_review");
  });

  it("explains legacy unaudited disables instead of silent", () => {
    const s = deriveAssignmentStatus({
      is_enabled: false,
      manual_paused: false,
      rule_id: "r1",
      auto_suspended_reason: "LEGACY_UNAUDITED",
    });
    expect(s.kind).toBe("needs_review");
    expect(s.label).toMatch(/legacy/i);

  });

  it("stays active when is_enabled=true", () => {
    const s = deriveAssignmentStatus({ is_enabled: true, rule_id: "r1" });
    expect(s.kind).toBe("active");
  });
});
