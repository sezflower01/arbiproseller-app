// ============================================================================
// Match Intelligence Engine v11
// ----------------------------------------------------------------------------
// Deterministic, explainable supplier-↔-Amazon matcher modeled after the
// repricer engine philosophy: hard rules first, AI only as fallback when
// structured evidence is unresolved (mid-band 60-85).
//
// Decision flow (do not reorder):
//   1. Detect HARD CONFLICTS  → if severe, return not_match (confidence 95+)
//   2. Detect HARD IDENTIFIERS → UPC/EAN/GTIN/ISBN match → exact_match
//   3. Detect MPN/Model dominance → brand + MPN match → exact_match
//   4. Compute weighted structured score (0-100)
//   5. Apply verdict ladder + caps:
//        - no identifier → cannot exceed Likely Match
//        - score >= 85 → exact (only if structured + no conflicts)
//        - 60-84 → mid band → AI fallback eligible
//        - 40-59 → review_needed
//        - <40 → not_match
//
// Output: full evidence object for admin diagnostics + QA logs.
// ============================================================================

import type { AmazonDetails } from "./_amazon-catalog.ts";
import type { SupplierDetails } from "./_supplier-details.ts";

export const ENGINE_VERSION = 11;

export type EngineVerdict =
  | "exact_match"
  | "likely_match"
  | "same_base_product_different_pack"
  | "review_needed"
  | "not_match";

export type EngineDecisionPath =
  | "hard_conflict"
  | "identifier_match"
  | "mpn_dominance"
  | "structured_score_high"
  | "structured_score_mid_needs_ai"
  | "structured_score_low"
  | "insufficient_data";

export interface EngineSignals {
  brand_match: boolean;
  manufacturer_match: boolean;
  identifier_confirmed: boolean;       // UPC/EAN/GTIN/ISBN
  model_mpn_confirmed: boolean;        // MPN/Model token
  product_type_match: boolean | null;
  pack_count_match: boolean | null;
  size_match: boolean | null;
  color_match: boolean | null;
  material_match: boolean | null;
  strong_attribute_alignment: boolean; // ≥3 structured attrs aligned
  title_similarity_score: number;      // 0-1
  category_alignment: boolean | null;
}

export interface EngineConflicts {
  brand_conflict: boolean;
  model_conflict: boolean;
  identifier_conflict: boolean;
  pack_conflict: boolean;
  size_conflict: boolean;
  color_conflict: boolean;
  product_type_conflict: boolean;
  variation_conflict: boolean;
}

export interface EngineResult {
  verdict: EngineVerdict;
  confidence: number;
  score: number;                     // 0-100 raw weighted score
  decision_path: EngineDecisionPath;
  needs_ai_fallback: boolean;        // true → router should call AI
  reasons: string[];
  upgrade_reason: string | null;
  downgrade_reason: string | null;
  signals: EngineSignals;
  conflicts: EngineConflicts;
  matched_attributes: string[];
  missing_attributes: string[];
  matched_token: string | null;
  matched_identifier_type: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization helpers
// ─────────────────────────────────────────────────────────────────────────────

const STOP_TOKENS = new Set([
  "amazon", "store", "visit", "search", "page", "stars", "this", "with", "from",
  "shop", "all", "view", "more", "free", "ships", "in", "stock", "out", "sold",
  "next", "business", "day", "each", "pack", "count", "set", "new", "used",
  "model", "brand", "color", "size", "white", "black", "blue", "red", "green",
  "plastic", "metal", "alloy", "steel", "wood", "glass", "rubber",
  "kitchen", "timer", "digital", "display", "water", "resistant",
  "sku", "mpn", "asin", "upc", "ean", "gtin", "isbn", "fnsku",
]);
const MODEL_TOKEN_RE = /\b([A-Z0-9][A-Z0-9-]{2,11}[A-Z0-9])\b/gi;
const PURE_NUMBER_RE = /^\d{4,8}$/;

const PACK_RE = /\b(\d{1,3})\s*[- ]?\s*(?:pack|pk|count|ct|pieces|pcs|bundle|set)\b/i;
const SIZE_RE = /\b(\d{1,4}(?:\.\d{1,2})?)\s*(oz|ounce|ml|fl\s*oz|l|liter|lb|lbs|kg|g|gram|gallon|gal|qt|pt)\b/i;

export function extractModelTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const upper = text.toUpperCase();
  let m: RegExpExecArray | null;
  MODEL_TOKEN_RE.lastIndex = 0;
  while ((m = MODEL_TOKEN_RE.exec(upper)) !== null) {
    const tok = m[1];
    if (!tok || tok.length < 4) continue;
    if (STOP_TOKENS.has(tok.toLowerCase())) continue;
    if (/^\d+$/.test(tok)) {
      if (!PURE_NUMBER_RE.test(tok)) continue;
      const n = parseInt(tok, 10);
      if (n >= 1900 && n <= 2099) continue;
      out.add(tok);
      continue;
    }
    if (!/\d/.test(tok)) continue;
    out.add(tok);
  }
  return out;
}

function normalizeBrand(b: string | null | undefined): string {
  return (b || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeText(t: string | null | undefined): string {
  return (t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(t: string | null | undefined): Set<string> {
  const norm = normalizeText(t);
  if (!norm) return new Set();
  return new Set(norm.split(/\s+/).filter((tok) => tok.length >= 3 && !STOP_TOKENS.has(tok)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function extractPack(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(PACK_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 && n < 500 ? n : null;
}

function extractSize(text: string | null | undefined): { value: number; unit: string } | null {
  if (!text) return null;
  const m = text.match(SIZE_RE);
  if (!m) return null;
  const value = parseFloat(m[1]);
  let unit = m[2].toLowerCase().replace(/\s+/g, "");
  if (unit === "ounce") unit = "oz";
  if (unit === "floz") unit = "floz";
  if (unit === "liter") unit = "l";
  if (unit === "lbs") unit = "lb";
  if (unit === "gram") unit = "g";
  if (unit === "gal") unit = "gallon";
  if (!Number.isFinite(value)) return null;
  return { value, unit };
}

function brandsAgree(
  supBrand: string | null | undefined,
  amzBrand: string | null | undefined,
  supTitle?: string | null,
  amzTitle?: string | null,
): boolean {
  const s = normalizeBrand(supBrand);
  const a = normalizeBrand(amzBrand);
  if (s && a) {
    if (s === a) return true;
    const sTok = new Set(s.split(/\s+/).filter((t) => t.length >= 3));
    const aTok = new Set(a.split(/\s+/).filter((t) => t.length >= 3));
    for (const t of sTok) if (aTok.has(t)) return true;
  }
  const present = s || a;
  if (present) {
    const tokens = present.split(/\s+/).filter((t) => t.length >= 3);
    const supT = (supTitle || "").toLowerCase();
    const amzT = (amzTitle || "").toLowerCase();
    if (tokens.length > 0 && tokens.every((t) => supT.includes(t)) && tokens.every((t) => amzT.includes(t))) {
      return true;
    }
  }
  return false;
}

function brandsConflict(
  supBrand: string | null | undefined,
  amzBrand: string | null | undefined,
): boolean {
  const s = normalizeBrand(supBrand);
  const a = normalizeBrand(amzBrand);
  if (!s || !a) return false; // missing ≠ conflict
  if (s === a) return false;
  const sTok = new Set(s.split(/\s+/).filter((t) => t.length >= 3));
  const aTok = new Set(a.split(/\s+/).filter((t) => t.length >= 3));
  for (const t of sTok) if (aTok.has(t)) return false; // any overlap = no conflict
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identifier comparison (UPC/EAN/GTIN/ISBN)
// ─────────────────────────────────────────────────────────────────────────────

interface IdCheck {
  match: boolean;
  conflict: boolean;
  matched?: string;
  supVal?: string;
  amzVal?: string;
}

function compareIdentifiers(sup?: SupplierDetails, amz?: AmazonDetails): IdCheck {
  if (!sup?.identifiers?.length || !amz?.identifiers?.length) return { match: false, conflict: false };
  const norm = (s: string) => s.replace(/\D/g, "");
  const supMap = new Map<string, string>();
  for (const i of sup.identifiers) {
    if (/^(UPC|EAN|GTIN|ISBN|JAN)$/.test(i.type)) supMap.set(i.type, norm(i.value));
  }
  const amzMap = new Map<string, string>();
  for (const i of amz.identifiers) {
    if (/^(UPC|EAN|GTIN|ISBN|JAN)$/.test(i.type)) amzMap.set(i.type, norm(i.value));
  }
  for (const [t, v] of supMap) {
    const av = amzMap.get(t);
    if (av && v && av === v) return { match: true, conflict: false, matched: t, supVal: v, amzVal: av };
  }
  for (const [t, v] of supMap) {
    const av = amzMap.get(t);
    if (av && v && av !== v) return { match: false, conflict: true, matched: t, supVal: v, amzVal: av };
  }
  return { match: false, conflict: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// MPN / Model comparison (structured + title-derived)
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelMatchResult {
  match: boolean;
  matchedToken: string | null;
  supplierSource: "structured" | "title" | null;
  amazonSource: "structured" | "title" | null;
}

export function compareModelMpn(
  sup: SupplierDetails | undefined,
  amz: AmazonDetails | undefined,
  supTitle: string | null | undefined,
  amzTitle: string | null | undefined,
): ModelMatchResult {
  const supCandidates = new Map<string, "structured" | "title">();
  if (sup?.model) {
    for (const tok of extractModelTokens(sup.model)) supCandidates.set(tok, "structured");
    const raw = sup.model.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (raw.length >= 4) supCandidates.set(raw, "structured");
  }
  for (const id of sup?.identifiers || []) {
    if (/^(MPN|MODEL|PART)/i.test(id.type)) {
      for (const tok of extractModelTokens(id.value)) supCandidates.set(tok, "structured");
      const raw = id.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
      if (raw.length >= 4) supCandidates.set(raw, "structured");
    }
  }
  if (supCandidates.size === 0) {
    for (const tok of extractModelTokens(supTitle)) supCandidates.set(tok, "title");
  }

  const amzCandidates = new Map<string, "structured" | "title">();
  if (amz?.model_number) {
    for (const tok of extractModelTokens(amz.model_number)) amzCandidates.set(tok, "structured");
    const raw = amz.model_number.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (raw.length >= 4) amzCandidates.set(raw, "structured");
  }
  if (amz?.part_number) {
    for (const tok of extractModelTokens(amz.part_number)) amzCandidates.set(tok, "structured");
    const raw = amz.part_number.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (raw.length >= 4) amzCandidates.set(raw, "structured");
  }
  for (const id of amz?.identifiers || []) {
    if (/^(MPN|MODEL|PART)/i.test(id.type)) {
      for (const tok of extractModelTokens(id.value)) amzCandidates.set(tok, "structured");
    }
  }
  for (const tok of extractModelTokens(amzTitle)) {
    if (!amzCandidates.has(tok)) amzCandidates.set(tok, "title");
  }

  let best: ModelMatchResult = { match: false, matchedToken: null, supplierSource: null, amazonSource: null };
  for (const [tok, supSrc] of supCandidates) {
    const amzSrc = amzCandidates.get(tok);
    if (!amzSrc) continue;
    if (!best.match || (supSrc === "structured" && amzSrc === "structured")) {
      best = { match: true, matchedToken: tok, supplierSource: supSrc, amazonSource: amzSrc };
      if (supSrc === "structured" && amzSrc === "structured") break;
    }
  }
  return best;
}

// Detect numeric model-token CONFLICT — both sides have structured model tokens
// but none agree → likely different SKU (e.g. 90218 vs 90219).
function detectModelConflict(sup: SupplierDetails | undefined, amz: AmazonDetails | undefined): boolean {
  const supTokens = new Set<string>();
  if (sup?.model) {
    for (const t of extractModelTokens(sup.model)) supTokens.add(t);
  }
  for (const id of sup?.identifiers || []) {
    if (/^(MPN|MODEL|PART)/i.test(id.type)) {
      for (const t of extractModelTokens(id.value)) supTokens.add(t);
    }
  }
  const amzTokens = new Set<string>();
  if (amz?.model_number) for (const t of extractModelTokens(amz.model_number)) amzTokens.add(t);
  if (amz?.part_number) for (const t of extractModelTokens(amz.part_number)) amzTokens.add(t);
  for (const id of amz?.identifiers || []) {
    if (/^(MPN|MODEL|PART)/i.test(id.type)) {
      for (const t of extractModelTokens(id.value)) amzTokens.add(t);
    }
  }
  if (supTokens.size === 0 || amzTokens.size === 0) return false;
  for (const t of supTokens) if (amzTokens.has(t)) return false;
  return true; // both have structured tokens, none overlap
}

// ─────────────────────────────────────────────────────────────────────────────
// Product family conflict (title-derived)
// ─────────────────────────────────────────────────────────────────────────────
// Catches incompatible product families even when structured product_type is
// missing — e.g. supplier title says "timer" but Amazon title is a "measuring
// cup". Without this guard, theme/brand overlap (Joie + Meow + Cat) can cause
// a wildly wrong listing to win on title similarity alone.
//
// Each family lists its identifying tokens AND a set of incompatible families.
// Two families are in conflict if they appear on opposite sides AND neither
// title contains any token from the other family (no overlap = clean conflict).

type FamilyKey =
  | "timer" | "measuring_cup" | "scale" | "knife" | "knife_sharpener"
  | "cutting_board" | "thermometer" | "blender" | "mixer" | "grater"
  | "peeler" | "can_opener" | "strainer" | "whisk" | "spatula"
  | "tongs" | "lamp" | "bulb" | "battery" | "charger"
  | "case" | "screen_protector" | "cable" | "headphones" | "speaker";

const FAMILY_TOKENS: Record<FamilyKey, RegExp> = {
  timer: /\btimers?\b|\bcountdown\b/i,
  measuring_cup: /\bmeasuring\s+cups?\b|\bmeasure\s+cups?\b|\bcup\s+set\b/i,
  scale: /\bkitchen\s+scale\b|\bdigital\s+scale\b|\bweighing\s+scale\b/i,
  knife: /\bchef'?s?\s+knife\b|\bparing\s+knife\b|\bsteak\s+knife\b|\bknives\b/i,
  knife_sharpener: /\bknife\s+sharpener\b|\bsharpener\b|\bsharpening\s+stone\b/i,
  cutting_board: /\bcutting\s+board\b|\bchopping\s+board\b/i,
  thermometer: /\bthermometers?\b|\bmeat\s+thermometer\b/i,
  blender: /\bblenders?\b|\bsmoothie\s+maker\b/i,
  mixer: /\bstand\s+mixer\b|\bhand\s+mixer\b/i,
  grater: /\bgraters?\b|\bzester\b/i,
  peeler: /\bpeelers?\b/i,
  can_opener: /\bcan\s+openers?\b/i,
  strainer: /\bstrainers?\b|\bcolander\b|\bsieve\b/i,
  whisk: /\bwhisks?\b/i,
  spatula: /\bspatulas?\b|\bturner\b/i,
  tongs: /\btongs\b/i,
  lamp: /\blamps?\b|\bdesk\s+lamp\b|\btable\s+lamp\b/i,
  bulb: /\b(?:light\s+)?bulbs?\b|\bled\s+bulb\b/i,
  battery: /\bbatter(?:y|ies)\b/i,
  charger: /\bchargers?\b|\bcharging\s+(?:cable|dock|station)\b/i,
  case: /\bphone\s+case\b|\bprotective\s+case\b/i,
  screen_protector: /\bscreen\s+protectors?\b|\btempered\s+glass\b/i,
  cable: /\bcables?\b|\bcords?\b/i,
  headphones: /\bheadphones?\b|\bearbuds?\b|\bearphones?\b/i,
  speaker: /\bspeakers?\b/i,
};

// Incompatibility groups — items in the same group are mutually exclusive
// (a title that is one cannot also be the other).
const INCOMPATIBLE_GROUPS: FamilyKey[][] = [
  // Kitchen tools — each is a distinct product type
  ["timer", "measuring_cup", "scale", "knife", "knife_sharpener", "cutting_board",
   "thermometer", "blender", "mixer", "grater", "peeler", "can_opener",
   "strainer", "whisk", "spatula", "tongs"],
  // Lighting — lamp and bulb are bought separately
  ["lamp", "bulb"],
  // Phone accessories — case ≠ screen protector ≠ cable ≠ charger
  ["case", "screen_protector", "cable", "charger", "headphones", "speaker", "battery"],
];

function detectFamilies(text: string | null | undefined): Set<FamilyKey> {
  const out = new Set<FamilyKey>();
  if (!text) return out;
  for (const [key, re] of Object.entries(FAMILY_TOKENS) as [FamilyKey, RegExp][]) {
    if (re.test(text)) out.add(key);
  }
  return out;
}

interface ProductFamilyConflict {
  conflict: boolean;
  supFamily?: FamilyKey;
  amzFamily?: FamilyKey;
}

function detectProductFamilyConflict(
  supTitle: string | null | undefined,
  amzTitle: string | null | undefined,
): ProductFamilyConflict {
  const supFamilies = detectFamilies(supTitle);
  const amzFamilies = detectFamilies(amzTitle);
  if (supFamilies.size === 0 || amzFamilies.size === 0) return { conflict: false };

  // If any family overlaps, no conflict (e.g. both contain "timer")
  for (const f of supFamilies) if (amzFamilies.has(f)) return { conflict: false };

  // Walk incompatibility groups — if sup and amz fall on different members
  // of the same group with no overlap, that's a conflict.
  for (const group of INCOMPATIBLE_GROUPS) {
    const supInGroup = [...supFamilies].filter((f) => group.includes(f));
    const amzInGroup = [...amzFamilies].filter((f) => group.includes(f));
    if (supInGroup.length > 0 && amzInGroup.length > 0) {
      return { conflict: true, supFamily: supInGroup[0], amzFamily: amzInGroup[0] };
    }
  }
  return { conflict: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineInput {
  source_title?: string | null;
  amz_title?: string | null;
  sup?: SupplierDetails;
  amz?: AmazonDetails;
}

export function runMatchEngine(input: EngineInput): EngineResult {
  const { sup, amz } = input;
  const supTitle = input.source_title || sup?.variant || null;
  const amzTitle = amz?.title || input.amz_title || null;

  const result: EngineResult = {
    verdict: "review_needed",
    confidence: 50,
    score: 0,
    decision_path: "insufficient_data",
    needs_ai_fallback: false,
    reasons: [],
    upgrade_reason: null,
    downgrade_reason: null,
    signals: {
      brand_match: false,
      manufacturer_match: false,
      identifier_confirmed: false,
      model_mpn_confirmed: false,
      product_type_match: null,
      pack_count_match: null,
      size_match: null,
      color_match: null,
      material_match: null,
      strong_attribute_alignment: false,
      title_similarity_score: 0,
      category_alignment: null,
    },
    conflicts: {
      brand_conflict: false,
      model_conflict: false,
      identifier_conflict: false,
      pack_conflict: false,
      size_conflict: false,
      color_conflict: false,
      product_type_conflict: false,
      variation_conflict: false,
    },
    matched_attributes: [],
    missing_attributes: [],
    matched_token: null,
    matched_identifier_type: null,
  };

  // ── STEP 1: HARD CONFLICTS ────────────────────────────────────────────────
  // Check identifier conflict first — strongest negative signal.
  const idCheck = compareIdentifiers(sup, amz);
  if (idCheck.conflict) {
    result.verdict = "not_match";
    result.confidence = 98;
    result.decision_path = "hard_conflict";
    result.conflicts.identifier_conflict = true;
    result.downgrade_reason = `${idCheck.matched} conflict: ${idCheck.supVal} vs ${idCheck.amzVal}`;
    result.reasons.push(`Hard conflict: ${idCheck.matched} ${idCheck.supVal} ≠ ${idCheck.amzVal}`);
    return result;
  }

  // Brand conflict (both sides have brand and they don't overlap)
  if (brandsConflict(sup?.brand, amz?.brand)) {
    result.verdict = "not_match";
    result.confidence = 92;
    result.decision_path = "hard_conflict";
    result.conflicts.brand_conflict = true;
    result.downgrade_reason = `Brand conflict: ${sup?.brand} vs ${amz?.brand}`;
    result.reasons.push(`Brand mismatch: ${sup?.brand} vs ${amz?.brand}`);
    return result;
  }

  // Pack-count conflict (both sides explicit, different)
  const supPack = sup?.pack_count ?? extractPack(supTitle);
  const amzPack = amz?.pack_count ?? extractPack(amzTitle);
  if (supPack && amzPack && supPack !== amzPack) {
    result.conflicts.pack_conflict = true;
    // Pack difference alone is NOT not_match — handled as same_base_product_different_pack later.
  } else if (supPack && amzPack && supPack === amzPack) {
    result.signals.pack_count_match = true;
    result.matched_attributes.push(`pack: ${supPack}`);
  }

  // Size conflict (same unit, different value)
  const supSize = extractSize(supTitle) || (sup?.size ? extractSize(sup.size) : null);
  const amzSize = extractSize(amzTitle) || (amz?.size ? extractSize(amz.size) : null);
  if (supSize && amzSize && supSize.unit === amzSize.unit) {
    if (supSize.value !== amzSize.value) {
      result.conflicts.size_conflict = true;
      result.verdict = "not_match";
      result.confidence = 90;
      result.decision_path = "hard_conflict";
      result.downgrade_reason = `Size conflict: ${supSize.value}${supSize.unit} vs ${amzSize.value}${amzSize.unit}`;
      result.reasons.push(`Size mismatch: ${supSize.value}${supSize.unit} vs ${amzSize.value}${amzSize.unit}`);
      return result;
    } else {
      result.signals.size_match = true;
      result.matched_attributes.push(`size: ${supSize.value}${supSize.unit}`);
    }
  }

  // Model conflict — both have structured tokens, none overlap
  if (detectModelConflict(sup, amz)) {
    result.verdict = "not_match";
    result.confidence = 90;
    result.decision_path = "hard_conflict";
    result.conflicts.model_conflict = true;
    result.downgrade_reason = `Model/MPN conflict: ${sup?.model} vs ${amz?.model_number || amz?.part_number}`;
    result.reasons.push(`Model conflict: ${sup?.model} ≠ ${amz?.model_number || amz?.part_number}`);
    return result;
  }

  // Product family conflict — title-derived. Catches "timer vs measuring cup",
  // "lamp vs bulb", "case vs cable", etc., even when structured product_type
  // is missing from both sides. This is critical to prevent theme/brand
  // overlap (e.g. Joie + Meow + Cat) from picking a wildly wrong family.
  const familyConflict = detectProductFamilyConflict(supTitle, amzTitle);
  if (familyConflict.conflict) {
    result.verdict = "not_match";
    result.confidence = 94;
    result.decision_path = "hard_conflict";
    result.conflicts.product_type_conflict = true;
    result.downgrade_reason = `Product family conflict: supplier=${familyConflict.supFamily} vs amazon=${familyConflict.amzFamily}`;
    result.reasons.push(`Product family mismatch: ${familyConflict.supFamily} ≠ ${familyConflict.amzFamily}`);
    return result;
  }

  // ── STEP 2: HARD IDENTIFIERS — UPC/EAN/GTIN match → exact ─────────────────
  if (idCheck.match) {
    result.verdict = "exact_match";
    result.confidence = 99;
    result.score = 100;
    result.decision_path = "identifier_match";
    result.signals.identifier_confirmed = true;
    result.signals.strong_attribute_alignment = true;
    result.matched_identifier_type = idCheck.matched ?? null;
    result.matched_token = idCheck.supVal ?? null;
    result.upgrade_reason = `${idCheck.matched} identifier match`;
    result.matched_attributes.push(`${idCheck.matched}: ${idCheck.supVal}`);
    result.reasons.push(`${idCheck.matched} identifier confirmed: ${idCheck.supVal}`);
    return result;
  }

  // ── STEP 3: BRAND + MPN dominance → exact ────────────────────────────────
  const mm = compareModelMpn(sup, amz, supTitle, amzTitle);
  const brandsOk = brandsAgree(sup?.brand, amz?.brand, supTitle, amzTitle);

  if (brandsOk) {
    result.signals.brand_match = true;
    result.matched_attributes.push(`brand: ${sup?.brand || amz?.brand || "(title-derived)"}`);
  }

  if (mm.match) {
    result.signals.model_mpn_confirmed = true;
    result.matched_token = mm.matchedToken;
    result.matched_attributes.push(`model/MPN: ${mm.matchedToken}`);
  }

  if (brandsOk && mm.match && mm.matchedToken && !result.conflicts.pack_conflict && !result.conflicts.size_conflict) {
    const bothStructured = mm.supplierSource === "structured" && mm.amazonSource === "structured";
    result.verdict = "exact_match";
    result.confidence = bothStructured ? 99 : 92;
    result.score = bothStructured ? 100 : 90;
    result.decision_path = "mpn_dominance";
    result.signals.strong_attribute_alignment = true;
    result.upgrade_reason = `Brand + Model/MPN exact match: "${mm.matchedToken}" (sup:${mm.supplierSource}, amz:${mm.amazonSource})`;
    result.reasons.push(`Brand matches: ${sup?.brand || amz?.brand}`);
    result.reasons.push(`MPN/Model matches: ${mm.matchedToken}`);
    result.reasons.push(`No hard conflicts detected`);
    return result;
  }

  // ── STEP 4: WEIGHTED STRUCTURED SCORE ────────────────────────────────────
  let score = 0;
  const reasons: string[] = [];

  if (brandsOk) {
    score += 20;
    reasons.push(`Brand match (+20)`);
  } else {
    result.missing_attributes.push("brand");
  }

  if (mm.match) {
    score += 25; // partial credit when only one side is structured
    reasons.push(`MPN token match: ${mm.matchedToken} (+25)`);
  } else {
    result.missing_attributes.push("model/MPN");
  }

  // Manufacturer match
  if (sup?.brand && amz?.manufacturer) {
    const mfn = normalizeBrand(amz.manufacturer);
    const sb = normalizeBrand(sup.brand);
    if (mfn && sb && (mfn === sb || mfn.includes(sb) || sb.includes(mfn))) {
      score += 8;
      result.signals.manufacturer_match = true;
      result.matched_attributes.push(`manufacturer: ${amz.manufacturer}`);
      reasons.push(`Manufacturer match (+8)`);
    }
  }

  // Product type
  if (sup?.product_type && amz?.product_type) {
    const a = normalizeText(sup.product_type);
    const b = normalizeText(amz.product_type);
    if (a && b && (a === b || a.includes(b) || b.includes(a))) {
      score += 10;
      result.signals.product_type_match = true;
      result.matched_attributes.push(`product_type: ${sup.product_type}`);
      reasons.push(`Product type match (+10)`);
    } else {
      result.signals.product_type_match = false;
      result.conflicts.product_type_conflict = true;
      score -= 15;
      reasons.push(`Product type differs (-15)`);
    }
  } else {
    result.missing_attributes.push("product_type");
  }

  // Pack
  if (result.signals.pack_count_match) {
    score += 12;
    reasons.push(`Pack count match (+12)`);
  } else if (result.conflicts.pack_conflict) {
    score -= 8; // soft deduction (might be pack-conversion case)
    reasons.push(`Pack count differs (-8)`);
  }

  // Size
  if (result.signals.size_match) {
    score += 10;
    reasons.push(`Size match (+10)`);
  }

  // Color
  if (sup?.color && amz?.color) {
    const a = normalizeText(sup.color);
    const b = normalizeText(amz.color);
    if (a === b) {
      score += 6;
      result.signals.color_match = true;
      result.matched_attributes.push(`color: ${sup.color}`);
      reasons.push(`Color match (+6)`);
    } else {
      result.signals.color_match = false;
      result.conflicts.color_conflict = true;
      score -= 12;
      reasons.push(`Color differs (-12)`);
    }
  }

  // Title similarity (jaccard token overlap)
  const titleSim = jaccard(tokenSet(supTitle), tokenSet(amzTitle));
  result.signals.title_similarity_score = Math.round(titleSim * 100) / 100;
  if (titleSim >= 0.4) {
    score += Math.round(titleSim * 12);
    reasons.push(`Title similarity ${(titleSim * 100).toFixed(0)}% (+${Math.round(titleSim * 12)})`);
  }

  // Strong attribute alignment flag
  result.signals.strong_attribute_alignment = result.matched_attributes.length >= 3;

  score = Math.max(0, Math.min(100, score));
  result.score = score;
  result.reasons.push(...reasons);

  // ── STEP 5: VERDICT LADDER + CAPS ────────────────────────────────────────
  // Cap rule: no strong identifier → cannot exceed Likely Match (max 80%)
  const hasStrongIdentifier = result.signals.identifier_confirmed || result.signals.model_mpn_confirmed;

  // Pack-conversion path: strong base match + pack mismatch only
  const packOnlyDiff =
    brandsOk &&
    result.conflicts.pack_conflict &&
    !result.conflicts.size_conflict &&
    !result.conflicts.color_conflict &&
    !result.conflicts.product_type_conflict &&
    titleSim >= 0.3;
  if (packOnlyDiff && supPack && amzPack) {
    result.verdict = "same_base_product_different_pack";
    result.confidence = 85;
    result.decision_path = "structured_score_high";
    result.upgrade_reason = `Same base product, different pack (sup:${supPack}, amz:${amzPack})`;
    return result;
  }

  if (score >= 85 && hasStrongIdentifier && !hasAnyHardConflict(result.conflicts)) {
    result.verdict = "exact_match";
    result.confidence = Math.min(95, score);
    result.decision_path = "structured_score_high";
    result.upgrade_reason = "High structured score + identifier confirmed";
    return result;
  }

  if (score >= 60 && score < 85) {
    // Mid-band: needs AI fallback
    result.verdict = hasStrongIdentifier ? "likely_match" : "review_needed";
    result.confidence = Math.min(hasStrongIdentifier ? 80 : 70, score);
    result.decision_path = "structured_score_mid_needs_ai";
    result.needs_ai_fallback = true;
    return result;
  }

  if (score >= 40) {
    result.verdict = "review_needed";
    result.confidence = Math.max(40, score);
    result.decision_path = "structured_score_low";
    return result;
  }

  // < 40
  result.verdict = "not_match";
  result.confidence = 100 - score; // higher reject-confidence as score drops
  result.decision_path = "structured_score_low";
  result.downgrade_reason = `Low structured score (${score}) — insufficient evidence`;
  return result;
}

function hasAnyHardConflict(c: EngineConflicts): boolean {
  return (
    c.brand_conflict ||
    c.model_conflict ||
    c.identifier_conflict ||
    c.size_conflict ||
    c.color_conflict ||
    c.product_type_conflict ||
    c.variation_conflict
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine evidence → cache evidence (matches the existing Verdict.evidence shape)
// ─────────────────────────────────────────────────────────────────────────────

export function engineToEvidence(r: EngineResult): Record<string, unknown> {
  return {
    base_product_match: r.signals.brand_match && r.signals.product_type_match !== false,
    pack_difference_only: r.verdict === "same_base_product_different_pack",
    matched_attributes: r.matched_attributes,
    missing_attributes: r.missing_attributes,
    conflicts: collectConflictStrings(r.conflicts),
    // Engine-specific evidence (Policy A taxonomy + diagnostics)
    _engine_version: ENGINE_VERSION,
    _engine_decision_path: r.decision_path,
    _engine_score: r.score,
    _engine_reasons: r.reasons,
    _identifier_confirmed: r.signals.identifier_confirmed,
    _model_mpn_confirmed: r.signals.model_mpn_confirmed,
    _strong_attribute_alignment: r.signals.strong_attribute_alignment,
    _exact_match_eligible: r.signals.identifier_confirmed || (r.signals.model_mpn_confirmed && r.signals.brand_match),
    _matched_token: r.matched_token,
    _matched_identifier_type: r.matched_identifier_type,
    _title_similarity: r.signals.title_similarity_score,
    _upgrade_reason: r.upgrade_reason,
    _downgrade_reason: r.downgrade_reason,
    _signals: r.signals,
    _conflicts_detail: r.conflicts,
  };
}

function collectConflictStrings(c: EngineConflicts): string[] {
  const out: string[] = [];
  if (c.identifier_conflict) out.push("identifier: conflict detected");
  if (c.brand_conflict) out.push("brand: conflict detected");
  if (c.model_conflict) out.push("model: conflict detected");
  if (c.pack_conflict) out.push("pack: differs");
  if (c.size_conflict) out.push("size: conflict detected");
  if (c.color_conflict) out.push("color: conflict detected");
  if (c.product_type_conflict) out.push("product_type: conflict detected");
  return out;
}
