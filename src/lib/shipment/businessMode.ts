// Business mode for the Shipment Builder.
// OA = default and matches the existing workflow exactly.
// Other modes layer optional UI/optimization hints — they NEVER modify OA behavior.

export type ShipmentBusinessMode = "oa" | "wholesale" | "hybrid" | "prep_center";

export interface BusinessModeConfig {
  id: ShipmentBusinessMode;
  label: string;
  shortLabel: string;
  tagline: string;
  description: string;
  bullets: string[];
  // Feature flags consumed by the builder UI
  showCasePackInput: boolean;
  showLtlToggle: boolean;
  showTemplatesPanel: boolean;
  showClientTag: boolean;
  headerHint: string;
}

export const BUSINESS_MODES: BusinessModeConfig[] = [
  {
    id: "oa",
    label: "OA Seller",
    shortLabel: "OA",
    tagline: "Online Arbitrage — mixed SKUs, fast turnover",
    description: "Optimized for mixed inventory, identical-box strategies, and placement-fee avoidance. This is the default Inventory S.P.R.I.N.T. workflow.",
    bullets: [
      "Mixed ASINs & low quantities",
      "Identical-box / SPD strategy",
      "Placement-fee minimisation",
      "Manual carton packing",
    ],
    showCasePackInput: false,
    showLtlToggle: false,
    showTemplatesPanel: false,
    showClientTag: false,
    headerHint: "Mixed-SKU optimization",
  },
  {
    id: "wholesale",
    label: "Wholesale Seller",
    shortLabel: "Wholesale",
    tagline: "Case packs, pallets, repeat replenishment",
    description: "Optimized for case-pack quantities, LTL planning, and shipment templates for stable replenishment.",
    bullets: [
      "Case-pack quantities (units × cases)",
      "SPD or LTL toggle",
      "Shipment templates / repeat orders",
      "Minimal boxing effort",
    ],
    showCasePackInput: true,
    showLtlToggle: true,
    showTemplatesPanel: true,
    showClientTag: false,
    headerHint: "Replenishment optimization",
  },
  {
    id: "hybrid",
    label: "Hybrid Seller",
    shortLabel: "Hybrid",
    tagline: "OA + wholesale on the same shipment",
    description: "Blend mixed OA inventory with repeat wholesale replenishment. Per-row controls for case packs.",
    bullets: [
      "Per-row case-pack toggle",
      "SPD primary, LTL optional",
      "Templates for repeat SKUs",
      "Mixed-SKU + bulk in one builder",
    ],
    showCasePackInput: true,
    showLtlToggle: true,
    showTemplatesPanel: true,
    showClientTag: false,
    headerHint: "OA + repeat SKUs",
  },
  {
    id: "prep_center",
    label: "Prep Center",
    shortLabel: "Prep Center",
    tagline: "Prep & ship on behalf of multiple clients",
    description: "Tag every shipment with a client so cost and units roll up per client.",
    bullets: [
      "Per-shipment client tag",
      "Multi-client workspace",
      "SPD-first workflow",
      "Per-client reporting (coming soon)",
    ],
    showCasePackInput: false,
    showLtlToggle: false,
    showTemplatesPanel: true,
    showClientTag: true,
    headerHint: "Multi-client prep",
  },
];

export function getModeConfig(mode: ShipmentBusinessMode | null | undefined): BusinessModeConfig {
  return BUSINESS_MODES.find((m) => m.id === mode) ?? BUSINESS_MODES[0];
}

export function isOaMode(mode: ShipmentBusinessMode | null | undefined): boolean {
  return !mode || mode === "oa";
}
