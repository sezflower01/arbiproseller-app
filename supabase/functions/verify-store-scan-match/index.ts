// Edge function: verify-store-scan-match
// Layer 4 of the matching architecture.
// Layer 1 = cheap title match (existing scan pipeline)
// Layer 2 = ROI gate (client-side slider)
// Layer 3 = rule-based conflict rejection (free, no AI)
// Layer 4 = AI verification via Lovable AI Gateway (this function)
//
// Cache: store_scan_ai_verifications keyed on (source_url_norm, asin, verification_version, prompt_version)
// Cache stores ONLY product-identity verdicts. No user economics.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fetchAmazonDetailsBatch, type AmazonDetails } from "./_amazon-catalog.ts";
import { fetchSupplierDetailsBatch, type SupplierDetails } from "./_supplier-details.ts";
import {
  runMatchEngine,
  engineToEvidence,
  ENGINE_VERSION,
  type EngineResult,
} from "./_match-engine.ts";
import { compareImages, type ImageCompareResult } from "./_image-compare.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Bump these when prompt or logic materially changes — invalidates cache cleanly.
// v12: Image-similarity layer added on the AI-fallback path. pHash runs free
//      on every borderline candidate; AI vision compare runs only when pHash
//      is in the 0.35–0.86 borderline band. Strong image match boosts
//      confidence (cap raised); strong image mismatch demotes to likely_match
//      with a warning chip. Image alone never produces a hard reject.
// v11: Match Intelligence Engine — deterministic engine runs FIRST. AI is only
//      invoked when the engine returns `needs_ai_fallback=true`.
const VERIFICATION_VERSION = 12;
const PROMPT_VERSION = 9;
const MODEL = "google/gemini-3-flash-preview";

// Confidence ceilings — AI-only reasoning cannot reach 100%. Only hard evidence can.
const AI_REASONING_CONFIDENCE_CAP = 80;       // ai_base_product_reasoning ceiling
const AI_PACK_CONVERSION_CONFIDENCE_CAP = 85; // pack-conversion is reasoning + arithmetic
const AI_REVIEW_CONFIDENCE_CAP = 70;          // likely_match always under review threshold

// Decision signal — exposes WHICH layer/logic produced the verdict, for QA.
type DecisionSignal =
  | "identifier_match"             // UPC/EAN/GTIN/MPN matched (rule-based)
  | "identifier_conflict"          // identifiers conflicted (rule-based)
  | "rule_size_conflict"           // hard size unit conflict (Layer 3)
  | "ai_base_product_reasoning"    // AI confirmed exact / likely from identity reasoning
  | "ai_pack_conversion"           // AI verdict = same_base_product_different_pack
  | "ai_identity_conflict"         // AI verdict = not_match from identity conflict
  | "ai_review_due_to_missing_data"// AI verdict = likely_match due to missing attributes
  | "ai_unsafe_exact_downgraded"   // AI returned exact_match with no hard evidence → downgraded
  | "cache";                       // served from cache

type VerdictKind =
  | "exact_match"
  | "likely_match"
  | "same_base_product_different_pack"
  | "not_match";

interface VerifyItem {
  source_url: string;
  asin: string;
  source_title?: string | null;
  source_image_url?: string | null;
  source_price?: number | null;
  source_currency?: string | null;
  amz_title?: string | null;
  amz_image_url?: string | null;
  amz_price?: number | null;
}

interface VerifyRequest {
  items: VerifyItem[];
  force?: boolean; // user clicked "Reverify"
  // Optional: when called server-to-server with x-internal-secret, the caller
  // can pass the owning user's ID so cache/rate-limit context still applies.
  userId?: string;
  // Optional: when true, the engine runs on every candidate but the AI fallback
  // is skipped. Used by store-scan-run for the bulk classification pass — AI
  // is only fired for review_needed candidates in a follow-up call.
  engineOnly?: boolean;
}

interface Verdict {
  verdict: VerdictKind;
  confidence: number;
  reason: string;
  evidence: Record<string, unknown>;
  rule_block: string | null;
  source: "cache" | "rule" | "ai";
  decision_signal: DecisionSignal;
}

const normalizeUrl = (raw: string): string => {
  if (!raw) return "";
  let v = String(raw).trim().toLowerCase();
  v = v.replace(/#.*$/, "");
  v = v.replace(/^https?:\/\//, "");
  v = v.replace(/^www\./, "");
  v = v.replace(/\?.*$/, "");
  v = v.replace(/\/+$/, "");
  return v;
};

// ---------- Layer 3: rule-based conflict detection (no AI cost) ----------
const PACK_RE = /\b(\d{1,3})\s*[- ]?\s*(?:pack|pk|count|ct|pieces|pcs|bundle|set)\b/i;
const SIZE_RE = /\b(\d{1,4}(?:\.\d{1,2})?)\s*(oz|ounce|ml|fl\s*oz|l|liter|lb|lbs|kg|g|gram|gallon|gal|qt|pt)\b/i;

const extractPack = (text: string | null | undefined): number | null => {
  if (!text) return null;
  const m = text.match(PACK_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 && n < 500 ? n : null;
};

const extractSize = (text: string | null | undefined): { value: number; unit: string } | null => {
  if (!text) return null;
  const m = text.match(SIZE_RE);
  if (!m) return null;
  const value = parseFloat(m[1]);
  let unit = m[2].toLowerCase().replace(/\s+/g, "");
  // normalize aliases
  if (unit === "ounce") unit = "oz";
  if (unit === "floz") unit = "floz";
  if (unit === "liter") unit = "l";
  if (unit === "lbs") unit = "lb";
  if (unit === "gram") unit = "g";
  if (unit === "gal") unit = "gallon";
  if (!Number.isFinite(value)) return null;
  return { value, unit };
};

const detectRuleConflict = (
  src: string | null | undefined,
  amz: string | null | undefined,
): string | null => {
  // NOTE: Pack/count differences are intentionally NOT pre-blocked here.
  // They are handled by the AI as `same_base_product_different_pack` so we can
  // recompute ROI from a per-unit cost. Only block on hard size conflicts when
  // units match exactly (clear different-SKU signal).
  const sSrc = extractSize(src);
  const sAmz = extractSize(amz);
  if (sSrc && sAmz && sSrc.unit === sAmz.unit && sSrc.value !== sAmz.value) {
    return `size_conflict:${sSrc.value}${sSrc.unit}_vs_${sAmz.value}${sAmz.unit}`;
  }
  return null;
};

// ---------- Layer 4: Lovable AI verification ----------
const SYSTEM_PROMPT = `You are a product-identity verifier for an Amazon arbitrage tool. You reason like a careful human shopper, NOT like a literal string-comparator.

Your job: determine whether the SUPPLIER product and the AMAZON product are the SAME BASE ITEM, and if so, whether they ship in the same pack quantity.

=== THE THREE RULES YOU MUST INTERNALIZE ===
RULE A: "Different QUANTITY is not the same as different PRODUCT."
RULE B: "MISSING details are uncertainty, not contradiction."
RULE C: "Strong product IDENTIFIERS (UPC, EAN, GTIN, ISBN, MPN, model number) outweigh title differences. If two sides share a numeric identifier, that is near-proof of identity. If they conflict, that is near-proof of mismatch."

You will be wrong if you forget any of them. Re-read them before deciding.

You will receive STRUCTURED FIELDS for both supplier and Amazon (brand, model, pack count, size, color, identifiers, bullets, dimensions). Use them — do not over-rely on the title.

=== HOW TO REASON (do this in order, every time) ===

STEP 1 — Identify the base product on BOTH sides:
  - brand
  - main product name / character / model
  - product type (game, phone case, toy, supplement, etc.)
  - version / edition / generation (if present)
  - variant (color, flavor, scent, size) IF that variant defines a separate SKU
  - pack/quantity count (explicit or implicit)

STEP 2 — Classify every attribute as ONE of three states:
  - MATCH: both sides clearly state the same value
  - MISSING: one or both sides do not state the value at all
  - CONFLICT: both sides state values, and the values clearly differ

This distinction is the most important thing you do. Treat MISSING and CONFLICT very differently.

STEP 3 — Apply the verdict ladder:

  → "not_match"  (only when there is a TRUE IDENTITY CONFLICT)
     A real conflict exists in at least one of:
       - different model / version / generation (iPhone 14 vs iPhone 15)
       - different character / figure (Optimus vs Bumblebee, Hound vs Hot Rod)
       - different product type (phone case vs screen protector)
       - different edition / class (Deluxe vs Voyager, Standard vs Pro)
       - different flavor / scent / color when those define the SKU
       - different size when size defines the SKU (16oz vs 32oz)
       - different compatibility / fitment (fits Camry 2020 vs 2024)
       - different brand
     Pack-count difference ALONE is NEVER a not_match.

  → "same_base_product_different_pack"
     - Brand matches
     - Core product / character / model matches
     - Product type matches
     - No CONFLICT in any identity attribute above
     - The ONLY meaningful difference is pack / quantity / count
     - You can extract both pack counts (one may be implicitly 1 if the title clearly describes a single unit)
     MUST set evidence.amazon_pack_count, evidence.supplier_pack_count, evidence.pack_conversion_confidence.

  → "exact_match"
     - All identity attributes either MATCH or are MISSING ON BOTH SIDES
     - Same pack count (or both clearly single unit)
     - No CONFLICT anywhere
     - Title, image, and price are mutually consistent

  → "likely_match"
     - No CONFLICT detected
     - At least one identity attribute is MISSING on one side (e.g., supplier title is short and doesn't state size/edition)
     - You believe it is probably the same item but cannot fully confirm
     - Use this when a human should glance before buying

=== KEY DISTINCTIONS — DO NOT CONFUSE THESE ===
- Supplier title is shorter / has less detail → that is MISSING info, not a conflict. Lean "likely_match" or "same_base_product_different_pack", not "not_match".
- Marketing fluff ("premium", "new", "official", "authentic", "best seller", "family game", "challenging & exciting") is NOISE. Ignore it.
- Shared franchise / series / collection words ("Studio Series", "Movie", "Limited Edition" used as a line name) are NOT proof of identity AND NOT proof of conflict.
- A 2× price gap is consistent with a pack-multiplier difference — investigate before calling not_match.
- Images that clearly show different characters / colors / product types are a real CONFLICT and override title similarity.

=== CONFLICT FORMAT (STRICT) ===
Every entry in the conflicts array MUST follow this exact format:
    "<field>: <supplier_value> vs <amazon_value>"
where <field> is one of: character, model, mpn, pack, size, color, flavor, scent, compatibility, variant, edition, class, product_type, material, platform, fit.
Both <supplier_value> and <amazon_value> MUST be concrete strings actually present on each side. Never put "unknown" or "missing".
If you cannot fill all three parts, the item is uncertainty (MISSING) — put it in missing_attributes, NOT in conflicts.
Items in conflicts that don't follow this format will be treated as soft/vague and will NOT cause a not_match.

=== FEW-SHOT EXAMPLES ===

Example 1 — pack conversion:
  Amazon: "Mattel Phase 10 Card Game - 2 Pack"
  Walmart: "Mattel Phase 10 Card Game, Family Game for Adults & Kids"
  Reasoning: brand=Mattel match. Product=Phase 10 Card Game match. Type=card game match. Amazon explicitly says 2 Pack; Walmart describes a single game. No conflict — only quantity differs.
  Verdict: same_base_product_different_pack (amazon_pack_count=2, supplier_pack_count=1, confidence=high)

Example 2 — true identity conflict:
  Amazon: "Transformers Studio Series Deluxe Class Hound"
  Supplier: "Transformers Studio Series Voyager Class Hot Rod"
  Reasoning: same franchise/series, but character CONFLICT (Hound vs Hot Rod) AND class CONFLICT (Deluxe vs Voyager).
  Verdict: not_match

Example 3 — missing detail, not conflict:
  Amazon: "CeraVe Moisturizing Cream 16oz"
  Supplier: "CeraVe Moisturizing Cream"
  Reasoning: brand match, product match, type match. Size MISSING on supplier side — that is uncertainty, not a contradiction. Do NOT reject.
  Verdict: likely_match

Example 4 — flavor conflict:
  Amazon: "Gatorade Thirst Quencher - Lemon Lime, 12 Pack"
  Supplier: "Gatorade Thirst Quencher - Fruit Punch, 12 Pack"
  Reasoning: brand and product match, pack matches, but flavor CONFLICT.
  Verdict: not_match

Example 5 — exact:
  Amazon: "LEGO Classic Creative Bricks 11016"
  Supplier: "LEGO Classic Creative Bricks Set 11016"
  Reasoning: brand, product, model number all match. No conflicts.
  Verdict: exact_match

Example 6 — pack conversion with implicit 1:
  Amazon: "Crest 3D White Toothpaste, 4-Pack"
  Supplier: "Crest 3D White Toothpaste"
  Reasoning: brand+product+type match. Amazon=4, supplier implicitly=1 (title describes a single tube).
  Verdict: same_base_product_different_pack (amazon=4, supplier=1, confidence=high)

Example 7 — subset character name + reseller protector bundle (NOT a conflict):
  Amazon: "Funko Attack on Titan Final Season Reiner Braun Exclusive Pop Vinyl Figure Bundled with Pop Protector"
  Supplier: "Funko POP! Animation: Attack on Titan Reiner 4-in Vinyl Figure GameStop Exclusive"
  Reasoning: brand=Funko match. Franchise=Attack on Titan match. Product type=Pop vinyl figure match. Character: supplier says "Reiner", Amazon says "Reiner Braun" — "Reiner" is a clean SUBSET of "Reiner Braun" (same person, expanded name) → NOT a character conflict. The phrase "Bundled with Pop Protector" is reseller PACKAGING NOISE, not an edition/variant difference. "Final Season" is a franchise descriptor, not an edition that defines a separate SKU. No true identity conflict exists.
  Verdict: likely_match (do NOT put "character: Reiner vs Reiner Braun" in conflicts — that is a name-expansion, not a contradiction)

Example 8 — bundle wording with real character conflict (still not_match):
  Amazon: "Funko Pop Eren Yeager Bundled with Pop Protector"
  Supplier: "Funko POP! Reiner Vinyl Figure"
  Reasoning: bundle wording on Amazon is noise, BUT the characters are different people (Eren ≠ Reiner). Real character conflict survives the noise filter.
  Verdict: not_match (conflicts: ["character: Reiner vs Eren Yeager"])

=== OUTPUT REQUIREMENTS ===
- Return your decision via the verify_match tool.
- Populate matched_attributes, missing_attributes, and conflicts arrays — these reflect your STEP 2 classification.
- Set base_product_match=true if brand + core product + product type all MATCH (no conflicts in those three).
- Set pack_difference_only=true ONLY when the sole non-matching attribute is pack count.
- The "reason" field must name the specific attribute(s) that drove the verdict (e.g., "Same product, Amazon ships 2-pack vs supplier 1-pack" or "Character conflict: Hound vs Hot Rod").`;

const TOOL_DEF = {
  type: "function",
  function: {
    name: "verify_match",
    description: "Return the product-identity verdict.",
    parameters: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: [
            "exact_match",
            "likely_match",
            "same_base_product_different_pack",
            "not_match",
          ],
        },
        confidence: {
          type: "integer",
          description: "0-100 confidence in this verdict",
        },
        reason: {
          type: "string",
          description: "One short sentence explaining the decision.",
        },
        evidence: {
          type: "object",
          properties: {
            brand_match: { type: "string", enum: ["yes", "no", "unknown"] },
            character_match: { type: "string", enum: ["yes", "no", "unknown"] },
            class_match: { type: "string", enum: ["yes", "no", "unknown"] },
            product_type_match: { type: "string", enum: ["yes", "no", "unknown"] },
            pack_match: { type: "string", enum: ["yes", "no", "unknown"] },
            size_match: { type: "string", enum: ["yes", "no", "unknown"] },
            compatibility_match: { type: "string", enum: ["yes", "no", "unknown"] },
            image_signal: {
              type: "string",
              enum: ["supports", "neutral", "conflicts", "unknown"],
            },
            amazon_pack_count: {
              type: "integer",
              description: "Detected pack/quantity for the Amazon listing (≥1). Set when verdict is exact_match or same_base_product_different_pack.",
            },
            supplier_pack_count: {
              type: "integer",
              description: "Detected pack/quantity for the supplier listing (≥1). Set when verdict is exact_match or same_base_product_different_pack.",
            },
            pack_conversion_confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "Confidence in the extracted pack counts. Required when verdict is same_base_product_different_pack.",
            },
            base_product_match: {
              type: "boolean",
              description: "True when brand + core product + product type all match (no conflict in those three).",
            },
            pack_difference_only: {
              type: "boolean",
              description: "True ONLY when the sole non-matching attribute between the two listings is pack/quantity count.",
            },
            matched_attributes: {
              type: "array",
              items: { type: "string" },
              description: "Attributes that clearly MATCH on both sides, e.g. ['brand: Mattel','product: Phase 10 Card Game','type: card game']",
            },
            missing_attributes: {
              type: "array",
              items: { type: "string" },
              description: "Attributes MISSING on one or both sides (uncertainty, NOT conflict), e.g. ['size: missing on supplier','edition: missing on supplier']",
            },
            conflicts: {
              type: "array",
              items: { type: "string" },
              description: "Identity CONFLICTS where both sides state values that clearly differ. Pack-count difference does NOT belong here. e.g. ['character: Hound vs Hot Rod','class: Deluxe vs Voyager','flavor: Lemon vs Fruit Punch']",
            },
          },
          required: [
            "brand_match",
            "character_match",
            "class_match",
            "product_type_match",
            "pack_match",
            "size_match",
            "compatibility_match",
            "image_signal",
            "base_product_match",
            "pack_difference_only",
            "matched_attributes",
            "missing_attributes",
            "conflicts",
          ],
          additionalProperties: false,
        },
      },
      required: ["verdict", "confidence", "reason", "evidence"],
      additionalProperties: false,
    },
  },
};

function fmtIds(ids?: { type: string; value: string }[]): string {
  if (!ids || ids.length === 0) return "(none)";
  return ids.map((i) => `${i.type}:${i.value}`).join(", ");
}

function fmtBullets(b?: string[]): string {
  if (!b || b.length === 0) return "(none)";
  return b.map((x, i) => `    ${i + 1}. ${x}`).join("\n");
}

// Identifier-based hard pre-check (cheap, no AI call needed).
// If supplier and Amazon share a UPC / EAN / GTIN / ISBN → guaranteed exact_match.
// If they both have one and they conflict → guaranteed not_match.
function compareIdentifiers(
  sup?: SupplierDetails,
  amz?: AmazonDetails,
): { match: boolean; conflict: boolean; matched?: string; supVal?: string; amzVal?: string } {
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
  // Match check (any shared type with same value)
  for (const [t, v] of supMap) {
    const av = amzMap.get(t);
    if (av && v && av === v) return { match: true, conflict: false, matched: t, supVal: v, amzVal: av };
  }
  // Conflict check (any shared type with different value)
  for (const [t, v] of supMap) {
    const av = amzMap.get(t);
    if (av && v && av !== v) return { match: false, conflict: true, matched: t, supVal: v, amzVal: av };
  }
  return { match: false, conflict: false };
}

// ───────────────────────────────────────────────────────────────────────────
// MPN / Model dominance rule (v10):
//   When supplier and Amazon agree on BRAND + MODEL/MPN, the match is treated
//   as exact even without a UPC/EAN. The MPN is extracted from THREE places:
//     1. Structured supplier `model` field (e.g. raw_payload.model = "90218")
//     2. Structured Amazon `model_number` / `part_number`
//     3. Title-embedded tokens (e.g. "... Tracking - 90218" or "Chef Master 12444")
//
//   This fixes the common pattern where supplier MPN is in a structured field
//   but Amazon only exposes it inside the title — previously this was missed.
// ───────────────────────────────────────────────────────────────────────────

// Extract candidate model/MPN tokens from free text. We look for:
//   - 4-8 digit pure numbers (e.g. "90218", "12444")
//   - 4-12 char alphanumeric tokens that contain at least one digit and one letter,
//     OR pure alphanumerics with hyphens (e.g. "AB-1234", "X-90218-B")
// We avoid: years (1900-2099), currency, common short words.
const MODEL_TOKEN_RE = /\b([A-Z0-9][A-Z0-9-]{2,11}[A-Z0-9])\b/gi;
const PURE_NUMBER_RE = /^\d{4,8}$/;
const STOP_TOKENS = new Set([
  "amazon", "store", "visit", "search", "page", "stars", "this", "with", "from",
  "shop", "all", "view", "more", "free", "ships", "in", "stock", "out", "sold",
  "next", "business", "day", "each", "pack", "count", "set", "new", "used",
  "model", "brand", "color", "size", "white", "black", "blue", "red", "green",
  "plastic", "metal", "alloy", "steel", "wood", "glass", "rubber",
  "kitchen", "timer", "digital", "display", "water", "resistant",
  "sku", "mpn", "asin", "upc", "ean", "gtin", "isbn", "fnsku",
]);

function extractModelTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const upper = text.toUpperCase();
  let m: RegExpExecArray | null;
  MODEL_TOKEN_RE.lastIndex = 0;
  while ((m = MODEL_TOKEN_RE.exec(upper)) !== null) {
    const tok = m[1];
    if (!tok || tok.length < 4) continue;
    if (STOP_TOKENS.has(tok.toLowerCase())) continue;
    // Pure-number filter: 4-8 digits, exclude obvious years
    if (/^\d+$/.test(tok)) {
      if (!PURE_NUMBER_RE.test(tok)) continue;
      const n = parseInt(tok, 10);
      if (n >= 1900 && n <= 2099) continue; // year
      out.add(tok);
      continue;
    }
    // Mixed alphanumeric: must contain at least one digit (otherwise it's a word)
    if (!/\d/.test(tok)) continue;
    out.add(tok);
  }
  return out;
}

function normalizeBrand(b: string | null | undefined): string {
  return (b || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function brandsAgree(supBrand: string | null | undefined, amzBrand: string | null | undefined, supTitle?: string | null, amzTitle?: string | null): boolean {
  const s = normalizeBrand(supBrand);
  const a = normalizeBrand(amzBrand);
  if (s && a) {
    if (s === a) return true;
    // Token overlap (e.g. "chef master" vs "chef master inc")
    const sTok = new Set(s.split(/\s+/).filter((t) => t.length >= 3));
    const aTok = new Set(a.split(/\s+/).filter((t) => t.length >= 3));
    for (const t of sTok) if (aTok.has(t)) return true;
  }
  // Fallback: if one brand is missing, look for the other inside both titles
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

interface ModelMatchResult {
  match: boolean;
  matchedToken: string | null;
  supplierSource: "structured" | "title" | null;
  amazonSource: "structured" | "title" | null;
}

function compareModelMpn(
  sup: SupplierDetails | undefined,
  amz: AmazonDetails | undefined,
  supTitle: string | null | undefined,
  amzTitle: string | null | undefined,
): ModelMatchResult {
  // Build supplier candidate set
  const supCandidates = new Map<string, "structured" | "title">();
  if (sup?.model) {
    for (const tok of extractModelTokens(sup.model)) supCandidates.set(tok, "structured");
    // Also try the raw model string itself (uppercased, alphanum only)
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
  // Title-embedded fallback (only used if NO structured candidate was found —
  // we don't want to surface random title noise as an "MPN match")
  if (supCandidates.size === 0) {
    for (const tok of extractModelTokens(supTitle)) supCandidates.set(tok, "title");
  }

  // Build Amazon candidate set
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
  // Always include title tokens for Amazon — Amazon listings frequently
  // bury the MPN in the title (e.g. "... - 90218") with no structured field.
  for (const tok of extractModelTokens(amzTitle)) {
    if (!amzCandidates.has(tok)) amzCandidates.set(tok, "title");
  }

  // Find best match — prefer structured-vs-structured, then any
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

// ───────────────────────────────────────────────────────────────────────────
// Soft-conflict policy (v9):
//   `not_match` is only allowed when the AI reports an EXPLICIT field-level
//   contradiction. Vague or weak-wording "conflicts" (e.g. just title differs,
//   one side missing detail) get downgraded to `likely_match` so uncertainty
//   never causes a hard reject.
//
//   An explicit conflict string looks like:
//     "character: Hound vs Hot Rod"
//     "model: 11016 vs 31050"
//     "pack: 2 vs 4"
//     "flavor: Lemon Lime vs Fruit Punch"
//   It must (a) name a structured field we recognise AND (b) contain "vs"
//   (or "≠"/"!=") with both sides present.
// ───────────────────────────────────────────────────────────────────────────
const EXPLICIT_CONFLICT_FIELDS = [
  "character",
  "model",
  "mpn",
  "part",
  "part_number",
  "pack",
  "pack_count",
  "size",
  "dimension",
  "weight",
  "flavor",
  "scent",
  "color",
  "colour",
  "compatibility",
  "variant",
  "edition",
  "class",
  "product_type",
  "type",
  "material",
  "platform",
  "fit",
];

interface ConflictDetail {
  raw: string;
  field: string | null;
  supplier_value: string | null;
  amazon_value: string | null;
  is_explicit: boolean;
  /** When the conflict was downgraded by a soft-policy rule, why. */
  soft_reason?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// FIX A — Subset-name auto-resolver
// ───────────────────────────────────────────────────────────────────────────
// Many retailers truncate character / model names while marketplaces use the
// full name (e.g. GameStop "Reiner" vs Amazon "Reiner Braun"; "Jinx" vs
// "Jinx Vinyl Figure"). When one side's value is a clean token-subset of
// the other AND there is no contradictory token, the field is NOT a true
// identity conflict — it is a name-expansion difference.
// ───────────────────────────────────────────────────────────────────────────
const SUBSET_ELIGIBLE_FIELDS = new Set(["character", "variant", "edition", "model"]);
const SUBSET_NOISE_TOKENS = new Set([
  "vinyl", "figure", "pop", "funko", "exclusive", "edition", "version",
  "the", "and", "of", "with", "for", "a", "an",
  // packaging accessory tokens (treated separately by Fix B but harmless here)
  "bundled", "bundle", "protector", "case", "compatible", "box",
]);

function nameTokens(v: string): string[] {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !SUBSET_NOISE_TOKENS.has(t));
}

/** Returns true when one side's identity tokens are a subset of the other's. */
function isSubsetName(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const longerSet = new Set(longer);
  // Every meaningful token from the shorter side must appear in the longer.
  for (const t of shorter) if (!longerSet.has(t)) return false;
  // Avoid trivial matches like single noise word survivors.
  return shorter.length >= 1;
}

// ───────────────────────────────────────────────────────────────────────────
// FIX B — Bundle / packaging-noise stripper
// ───────────────────────────────────────────────────────────────────────────
// Phrases such as "Bundled with Pop Protector" or "Compatible Box Protector
// Case" are reseller packaging noise, not identity attributes. When BOTH
// values of a conflict reduce to the same content after stripping these
// phrases, the conflict is noise. We never strip meaningful product nouns
// (deluxe, jumbo, mini, bobblehead, keychain, sizes).
// ───────────────────────────────────────────────────────────────────────────
const BUNDLE_NOISE_RE = /\b(?:bundled\s+with[^,]*|with\s+(?:compatible\s+)?(?:pop\s+)?(?:box\s+)?protector(?:\s+case)?|compatible\s+(?:box\s+)?(?:case|protector)|protective\s+case|pop\s+protector|box\s+protector)\b/gi;

function stripBundleNoise(v: string): string {
  return v.replace(BUNDLE_NOISE_RE, " ").replace(/\s+/g, " ").trim();
}

// ───────────────────────────────────────────────────────────────────────────
// ACCESSORY-AS-CORE-PRODUCT detector
// ───────────────────────────────────────────────────────────────────────────
// Some supplier listings ARE the protector / display case / sleeve itself —
// not a figure bundled with one. In that scenario "protector"/"case"/"holder"
// must be treated as the REQUIRED product-type anchor, not bundle noise.
// If the Amazon candidate's title/headline doesn't also belong to the same
// accessory family, the candidate is the wrong product (likely the figure
// the case is meant to hold) and must be force-rejected as a hard family
// conflict, no matter how high the text-similarity score is.
// ───────────────────────────────────────────────────────────────────────────
const ACCESSORY_CORE_NOUNS = [
  "display case", "display cases",
  "pop protector", "box protector", "box protectors", "protector case",
  "protector", "protectors",
  "case", "cases",
  "holder", "holders",
  "sleeve", "sleeves",
  "stand", "stands",
  "shelf", "shelves",
  "mount", "mounts",
];

/** Returns the matching accessory noun if the supplier title's CORE identity
 *  is an accessory (display case / protector / holder / sleeve), else null.
 *  We require the noun to appear OUTSIDE bundle phrasing — i.e. removing the
 *  bundle-noise regex must not also remove this noun. */
function detectSupplierAccessoryCore(title: string): string | null {
  if (!title) return null;
  const lower = title.toLowerCase();
  const stripped = stripBundleNoise(lower);
  for (const noun of ACCESSORY_CORE_NOUNS) {
    // Must remain after bundle-noise removal (otherwise it WAS just bundle noise)
    const re = new RegExp(`\\b${noun.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(stripped)) return noun;
  }
  return null;
}

/** Returns true if Amazon candidate title also belongs to the accessory
 *  family (i.e. it is itself a case/protector/holder, not just a figure
 *  shipped with one). */
function amazonIsSameAccessoryFamily(amazonTitle: string): boolean {
  if (!amazonTitle) return false;
  const lower = amazonTitle.toLowerCase();
  const stripped = stripBundleNoise(lower);
  for (const noun of ACCESSORY_CORE_NOUNS) {
    const re = new RegExp(`\\b${noun.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(stripped)) return true;
  }
  return false;
}

function parseConflict(raw: unknown): ConflictDetail {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { raw: "", field: null, supplier_value: null, amazon_value: null, is_explicit: false };

  let field: string | null = null;
  let body = s;
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0 && colonIdx < 40) {
    field = s.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, "_");
    body = s.slice(colonIdx + 1).trim();
  }

  const vsMatch = body.match(/^(.+?)\s+(?:vs\.?|≠|!=)\s+(.+)$/i);
  let supplier_value: string | null = null;
  let amazon_value: string | null = null;
  if (vsMatch) {
    supplier_value = vsMatch[1].trim().slice(0, 80);
    amazon_value = vsMatch[2].trim().slice(0, 80);
  }

  const fieldRecognised = !!field && EXPLICIT_CONFLICT_FIELDS.some((f) => field === f || field!.includes(f));
  const bothSidesPresent = !!supplier_value && !!amazon_value &&
    supplier_value.toLowerCase() !== "unknown" &&
    amazon_value.toLowerCase() !== "unknown" &&
    supplier_value.toLowerCase() !== "missing" &&
    amazon_value.toLowerCase() !== "missing";

  let is_explicit = fieldRecognised && bothSidesPresent;
  let soft_reason: string | undefined;

  // ── FIX B: bundle-noise neutralization (runs first so subset check sees clean values) ──
  if (is_explicit && supplier_value && amazon_value) {
    const sStripped = stripBundleNoise(supplier_value);
    const aStripped = stripBundleNoise(amazon_value);
    const sChanged = sStripped !== supplier_value;
    const aChanged = aStripped !== amazon_value;
    if (sChanged || aChanged) {
      // If after removing packaging noise the values are equivalent (or one
      // becomes empty), the "conflict" was packaging language only.
      if (
        !sStripped ||
        !aStripped ||
        sStripped.toLowerCase() === aStripped.toLowerCase() ||
        isSubsetName(sStripped, aStripped)
      ) {
        is_explicit = false;
        soft_reason = "bundle_noise_only";
      }
    }
  }

  // ── FIX A: subset-name resolver for character / variant / edition / model ──
  if (is_explicit && field && SUBSET_ELIGIBLE_FIELDS.has(field) && supplier_value && amazon_value) {
    if (isSubsetName(supplier_value, amazon_value)) {
      is_explicit = false;
      soft_reason = `subset_name_${field}`;
    }
  }

  return {
    raw: s,
    field,
    supplier_value,
    amazon_value,
    is_explicit,
    soft_reason,
  };
}

function classifyConflicts(rawConflicts: unknown[]): {
  details: ConflictDetail[];
  explicit: ConflictDetail[];
  soft: ConflictDetail[];
} {
  const details = rawConflicts.map(parseConflict).filter((d) => d.raw.length > 0);
  const explicit = details.filter((d) => d.is_explicit);
  const soft = details.filter((d) => !d.is_explicit);
  return { details, explicit, soft };
}

async function callAI(
  item: VerifyItem,
  apiKey: string,
  amz?: AmazonDetails,
  sup?: SupplierDetails,
): Promise<Verdict> {
  const userMsg = [
    "Compare these two products and return a verdict using the verify_match tool.",
    "",
    "=== SUPPLIER PRODUCT ===",
    `URL: ${item.source_url}`,
    `Title:           ${item.source_title ?? "(none)"}`,
    `Brand:           ${sup?.brand ?? "(unknown)"}`,
    `Model/Part #:    ${sup?.model ?? "(unknown)"}`,
    `Pack count:      ${sup?.pack_count ?? "(unknown)"}`,
    `Unit count:      ${sup?.unit_count ?? "(unknown)"}`,
    `Size:            ${sup?.size ?? "(unknown)"}`,
    `Color:           ${sup?.color ?? "(unknown)"}`,
    `Flavor/scent:    ${sup?.flavor ?? "(unknown)"}`,
    `Variant:         ${sup?.variant ?? "(unknown)"}`,
    `Product type:    ${sup?.product_type ?? "(unknown)"}`,
    `Identifiers:     ${fmtIds(sup?.identifiers)}`,
    `Price:           ${item.source_price ?? "?"} ${item.source_currency ?? ""}`,
    `Image:           ${item.source_image_url ?? "(none)"}`,
    `Bullets:`,
    fmtBullets(sup?.bullets),
    "",
    "=== AMAZON PRODUCT ===",
    `ASIN: ${item.asin}`,
    `Title:           ${amz?.title ?? item.amz_title ?? "(none)"}`,
    `Brand:           ${amz?.brand ?? "(unknown)"}`,
    `Manufacturer:    ${amz?.manufacturer ?? "(unknown)"}`,
    `Model #:         ${amz?.model_number ?? "(unknown)"}`,
    `Part #:          ${amz?.part_number ?? "(unknown)"}`,
    `Pack count:      ${amz?.pack_count ?? "(unknown)"}`,
    `Unit count:      ${amz?.unit_count ?? "(unknown)"}${amz?.unit_count_type ? ` ${amz.unit_count_type}` : ""}`,
    `Size:            ${amz?.size ?? "(unknown)"}`,
    `Color:           ${amz?.color ?? "(unknown)"}`,
    `Flavor:          ${amz?.flavor ?? "(unknown)"}`,
    `Scent:           ${amz?.scent ?? "(unknown)"}`,
    `Item form:       ${amz?.item_form ?? "(unknown)"}`,
    `Product type:    ${amz?.product_type ?? "(unknown)"}`,
    `Dimensions:      ${amz?.item_dimensions ?? "(unknown)"}`,
    `Weight:          ${amz?.item_weight ?? "(unknown)"}`,
    `Identifiers:     ${fmtIds(amz?.identifiers)}`,
    `Price:           ${item.amz_price ?? "?"} USD`,
    `Image:           ${amz?.image_url ?? item.amz_image_url ?? "(none)"}`,
    `Bullets:`,
    fmtBullets(amz?.bullets),
    "",
    "Reminder: MISSING info on either side is uncertainty, NOT a conflict. Only state a CONFLICT when both sides report values that clearly differ.",
  ].join("\n");

  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      tools: [TOOL_DEF],
      tool_choice: { type: "function", function: { name: "verify_match" } },
    }),
  });

  if (resp.status === 429) {
    throw new Error("rate_limited");
  }
  if (resp.status === 402) {
    throw new Error("payment_required");
  }
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`ai_gateway_${resp.status}:${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    throw new Error("ai_no_tool_call");
  }
  const args = JSON.parse(toolCall.function.arguments);
  let verdict = args.verdict as VerdictKind;
  const ev = (args.evidence ?? {}) as Record<string, unknown>;
  const missing = Array.isArray(ev.missing_attributes) ? (ev.missing_attributes as unknown[]) : [];
  const conflicts = Array.isArray(ev.conflicts) ? (ev.conflicts as unknown[]) : [];
  const matched = Array.isArray(ev.matched_attributes) ? (ev.matched_attributes as unknown[]) : [];
  let rawConfidence = Math.max(0, Math.min(100, Number(args.confidence) || 0));

  // ───────────────────────────────────────────────────────────────────────────
  // Policy A evidence taxonomy (replaces the old broad `hard_evidence` flag).
  // We expose specific, unambiguous booleans so QA logs make it obvious WHY a
  // verdict was (or was not) eligible for exact_match.
  //   - identifier_confirmed: matching UPC/EAN/GTIN (rule path only — never set here)
  //   - model_mpn_confirmed:  supplier model/MPN agrees with Amazon model_number/part_number
  //   - strong_attribute_alignment: AI matched ≥3 structured attributes (brand+model+size, etc.)
  //   - exact_match_eligible: ONLY true when identifier_confirmed (rule path)
  //                           AI-reasoned rows are NEVER eligible for exact_match under Policy A.
  // ───────────────────────────────────────────────────────────────────────────
  // Use the same MPN extractor as the rule path so the AI evidence flag agrees
  // with the rule path (and doesn't under-report when MPN lives in the title).
  const mmAi = compareModelMpn(sup, amz, item.source_title, amz?.title || item.amz_title);
  const modelMpnConfirmed = mmAi.match;

  const strongAttributeAlignment = matched.length >= 3;
  // identifier_confirmed is owned by the rule path (identifier_match) — not this AI function.
  const identifierConfirmed = false;
  // Under Policy A, only identifier_confirmed makes a row exact_match-eligible.
  const exactMatchEligible = identifierConfirmed;

  let unsafeDowngraded = false;
  let downgradeReason: string | null = null;
  // POLICY A — STRICT: AI-only reasoning can NEVER produce exact_match.
  // Only rule-based identifier_match (UPC/EAN/GTIN agreement) earns exact_match.
  // AI exact_match → downgrade to likely_match regardless of attribute count.
  if (verdict === "exact_match") {
    verdict = "likely_match";
    unsafeDowngraded = true;
    const reasons: string[] = ["no_identifier_match", "not_exact_match_eligible_under_policy_A"];
    if (!modelMpnConfirmed) reasons.push("no_model_mpn_confirmation");
    if (!strongAttributeAlignment) reasons.push("no_strong_attribute_alignment");
    downgradeReason = reasons.join(",");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // v9 — Soft-conflict policy:
  //   `not_match` is only allowed when AI reports an EXPLICIT field-level
  //   contradiction. Vague "conflicts" → downgrade to likely_match (or review)
  //   so uncertainty never causes a hard reject.
  // ───────────────────────────────────────────────────────────────────────────
  const conflictAnalysis = classifyConflicts(conflicts);
  const hasExplicitConflict = conflictAnalysis.explicit.length > 0;
  const hasOnlySoftConflicts = conflictAnalysis.details.length > 0 && !hasExplicitConflict;
  let softConflictDowngraded = false;
  let softConflictReason: string | null = null;
  if (verdict === "not_match" && !hasExplicitConflict) {
    // No explicit field-level contradiction → don't reject, route to likely_match.
    // If we also have weak/no attribute alignment, stays at likely_match (review-tier confidence).
    softConflictDowngraded = true;
    if (conflictAnalysis.details.length === 0) {
      softConflictReason = "no_conflicts_array_populated";
    } else {
      // Surface the specific soft-policy reason (subset_name, bundle_noise, etc.)
      // so QA logs / UI badges can explain WHY the not_match was rejected.
      const softTags = conflictAnalysis.soft
        .map((c) => c.soft_reason || c.field || "vague")
        .slice(0, 4)
        .join("|");
      softConflictReason = `only_soft_conflicts:${softTags}`;
    }
    verdict = "likely_match";
  }

  let signal: DecisionSignal;
  let confidenceCap = 100;

  if (unsafeDowngraded) {
    // AI thought it was exact but we never trust AI for exact — flag it for QA.
    signal = "ai_unsafe_exact_downgraded";
    // Allow slightly higher ceiling when model/MPN agreement backs the AI's reasoning.
    confidenceCap = modelMpnConfirmed ? AI_PACK_CONVERSION_CONFIDENCE_CAP : AI_REASONING_CONFIDENCE_CAP;
  } else if (softConflictDowngraded) {
    // Routed away from not_match because conflicts were vague/soft.
    signal = "ai_review_due_to_missing_data";
    confidenceCap = AI_REVIEW_CONFIDENCE_CAP;
  } else if (verdict === "same_base_product_different_pack") {
    signal = "ai_pack_conversion";
    confidenceCap = AI_PACK_CONVERSION_CONFIDENCE_CAP;
  } else if (verdict === "not_match") {
    // Only reachable when there IS an explicit field-level contradiction.
    signal = "ai_identity_conflict";
  } else if (verdict === "likely_match") {
    signal = "ai_review_due_to_missing_data";
    confidenceCap = AI_REVIEW_CONFIDENCE_CAP;
  } else {
    // Fallback (should not happen — exact_match handled above)
    signal = "ai_base_product_reasoning";
    confidenceCap = AI_REASONING_CONFIDENCE_CAP;
  }

  const finalConfidence = Math.min(rawConfidence, confidenceCap);

  // Build a compact, structured conflict report for downstream UI/logs.
  const conflictReport = conflictAnalysis.details.map((c) => ({
    field: c.field,
    supplier_value: c.supplier_value,
    amazon_value: c.amazon_value,
    is_explicit: c.is_explicit,
    soft_reason: c.soft_reason ?? null,
    raw: c.raw,
  }));

  let reasonOut: string;
  if (unsafeDowngraded) {
    reasonOut = `AI exact_match downgraded to likely_match — ${downgradeReason}. model_mpn_confirmed=${modelMpnConfirmed} strong_attribute_alignment=${strongAttributeAlignment}. Original AI: ${String(args.reason ?? "").slice(0, 240)}`;
  } else if (softConflictDowngraded) {
    reasonOut = `AI not_match downgraded to likely_match — ${softConflictReason}. No explicit field-level contradiction found. Original AI: ${String(args.reason ?? "").slice(0, 240)}`;
  } else {
    reasonOut = String(args.reason ?? "").slice(0, 500);
  }

  return {
    verdict,
    confidence: finalConfidence,
    reason: reasonOut,
    evidence: {
      ...ev,
      _missing_count: missing.length,
      _conflicts_count: conflicts.length,
      _matched_count: matched.length,
      // Policy A taxonomy
      _identifier_confirmed: identifierConfirmed,
      _model_mpn_confirmed: modelMpnConfirmed,
      _strong_attribute_alignment: strongAttributeAlignment,
      _exact_match_eligible: exactMatchEligible,
      _ai_raw_confidence: rawConfidence,
      _confidence_cap_applied: confidenceCap,
      _unsafe_exact_downgraded: unsafeDowngraded,
      _downgrade_reason: downgradeReason,
      // v9 — soft-conflict policy
      _soft_conflict_downgraded: softConflictDowngraded,
      _soft_conflict_reason: softConflictReason,
      _conflict_explicit_count: conflictAnalysis.explicit.length,
      _conflict_soft_count: conflictAnalysis.soft.length,
      _conflict_fields_explicit: conflictAnalysis.explicit.map((c) => c.field).filter(Boolean),
      _conflict_fields_soft: conflictAnalysis.soft.map((c) => c.field || "vague").slice(0, 6),
      _conflict_report: conflictReport.slice(0, 8),
    },
    rule_block: null,
    source: "ai",
    decision_signal: signal,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    if (!LOVABLE_API_KEY) {
      return new Response(
        JSON.stringify({ error: "LOVABLE_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Auth check — accept either a user JWT or an internal service-to-service
    // call signed with INTERNAL_SYNC_SECRET. The latter is used by
    // store-scan-run when bulk-classifying every candidate during a scan.
    const authHeader = req.headers.get("Authorization") || "";
    const internalSecret = req.headers.get("x-internal-secret") || "";
    const expectedInternalSecret = Deno.env.get("INTERNAL_SYNC_SECRET") || "";
    const isInternalCall = !!internalSecret && internalSecret === expectedInternalSecret;

    let resolvedUserId: string | null = null;
    if (!isInternalCall) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userRes } = await userClient.auth.getUser();
      if (!userRes?.user) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      resolvedUserId = userRes.user.id;
    }

    const body = (await req.json().catch(() => ({}))) as VerifyRequest;
    if (isInternalCall && body.userId) resolvedUserId = body.userId;
    const items = Array.isArray(body.items) ? body.items.slice(0, 25) : [];
    if (items.length === 0) {
      return new Response(JSON.stringify({ verifications: {} }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const force = !!body.force;
    const engineOnly = !!body.engineOnly;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1. Bulk-load existing cache entries (unless force)
    const keys = items
      .filter((it) => it.source_url && it.asin)
      .map((it) => ({ norm: normalizeUrl(it.source_url), asin: it.asin.toUpperCase() }));

    const cache = new Map<string, Verdict>();
    if (!force && keys.length > 0) {
      const norms = Array.from(new Set(keys.map((k) => k.norm)));
      const asins = Array.from(new Set(keys.map((k) => k.asin)));
      const { data: cached } = await admin
        .from("store_scan_ai_verifications")
        .select("source_url_norm, asin, verdict, confidence, reason, evidence, rule_block")
        .in("source_url_norm", norms)
        .in("asin", asins)
        .eq("verification_version", VERIFICATION_VERSION)
        .eq("prompt_version", PROMPT_VERSION);

      for (const row of cached ?? []) {
        const ev = (row.evidence as Record<string, unknown>) ?? {};
        // Reconstruct decision_signal from cached evidence (best-effort, for QA logs).
        let signal: DecisionSignal = "cache";
        if (row.rule_block) signal = "rule_size_conflict";
        else if (row.verdict === "same_base_product_different_pack") signal = "ai_pack_conversion";
        else if (row.verdict === "not_match") {
          const c = Array.isArray(ev.conflicts) ? (ev.conflicts as unknown[]) : [];
          signal = c.length > 0 ? "ai_identity_conflict" : "ai_base_product_reasoning";
        } else if (row.verdict === "likely_match") signal = "ai_review_due_to_missing_data";
        else if (row.verdict === "exact_match") signal = "ai_base_product_reasoning";

        cache.set(`${row.source_url_norm}::${row.asin}`, {
          verdict: row.verdict as Verdict["verdict"],
          confidence: row.confidence,
          reason: row.reason ?? "",
          evidence: ev,
          rule_block: row.rule_block,
          source: "cache",
          decision_signal: signal,
        });
      }
    }

    const out: Record<string, Verdict> = {};
    const toUpsert: Array<Record<string, unknown>> = [];

    // Determine which items still need a verdict (cache miss).
    // Only fetch enrichment data for those — saves SP-API calls and DB reads.
    const pendingItems = items.filter((it) => {
      if (!it.source_url || !it.asin) return false;
      const norm = normalizeUrl(it.source_url);
      const asinUp = it.asin.toUpperCase();
      return !cache.has(`${norm}::${asinUp}`);
    });

    // Bulk-load Amazon catalog details + supplier-side cached extraction in parallel.
    const asinList = Array.from(new Set(pendingItems.map((it) => it.asin.toUpperCase())));
    const urlList = Array.from(new Set(pendingItems.map((it) => it.source_url)));
    const [amzDetailsMap, supDetailsMap] = await Promise.all([
      asinList.length > 0
        ? fetchAmazonDetailsBatch(asinList).catch((e) => {
            console.warn("[verify] amazon details batch failed:", e instanceof Error ? (e as Error).message : String(e));
            return new Map<string, AmazonDetails>();
          })
        : Promise.resolve(new Map<string, AmazonDetails>()),
      urlList.length > 0
        ? fetchSupplierDetailsBatch(admin, urlList).catch((e) => {
            console.warn("[verify] supplier details batch failed:", e instanceof Error ? (e as Error).message : String(e));
            return new Map<string, SupplierDetails>();
          })
        : Promise.resolve(new Map<string, SupplierDetails>()),
    ]);

    for (const it of items) {
      if (!it.source_url || !it.asin) continue;
      const norm = normalizeUrl(it.source_url);
      const asinUp = it.asin.toUpperCase();
      const key = `${it.source_url}::${it.asin}`;
      const cacheKey = `${norm}::${asinUp}`;

      const cached = cache.get(cacheKey);
      if (cached) {
        out[key] = cached;
        continue;
      }

      const amzDetails = amzDetailsMap.get(asinUp);
      const supDetails = supDetailsMap.get(it.source_url);

      // ─────────────────────────────────────────────────────────────────────
      // ENGINE-DRIVEN FLOW (v11)
      // 1. Run deterministic Match Intelligence Engine.
      // 2. If engine reaches a confident verdict (exact / not_match / pack-conv
      //    / low-score) — DONE, no AI call.
      // 3. If engine flags `needs_ai_fallback` (mid-band 60-84 score) — call AI
      //    as a tie-breaker, but never let AI override engine hard-conflict
      //    rejects or engine-confirmed exact matches.
      // ─────────────────────────────────────────────────────────────────────
      const engineResult: EngineResult = runMatchEngine({
        source_title: it.source_title,
        amz_title: it.amz_title,
        sup: supDetails,
        amz: amzDetails,
      });

      // Map engine verdict (which has its own enum) → cache verdict enum.
      const mapEngineVerdict = (v: EngineResult["verdict"]): VerdictKind => {
        if (v === "review_needed") return "likely_match"; // existing schema only has 4
        return v;
      };

      // High-confidence engine paths bypass AI entirely.
      // engineOnly callers (e.g. store-scan-run bulk classification) also skip
      // AI here — they fire AI only on the review_needed survivors via a
      // follow-up call without engineOnly set.
      if (!engineResult.needs_ai_fallback || engineOnly) {
        const decisionSignal: DecisionSignal =
          engineResult.decision_path === "hard_conflict"
            ? engineResult.conflicts.identifier_conflict ? "identifier_conflict" : "rule_size_conflict"
            : engineResult.decision_path === "identifier_match" ? "identifier_match"
            : engineResult.decision_path === "mpn_dominance" ? "identifier_match"
            : engineResult.decision_path === "structured_score_high" ? "ai_base_product_reasoning"
            : "ai_review_due_to_missing_data";

        const v: Verdict = {
          verdict: mapEngineVerdict(engineResult.verdict),
          confidence: engineResult.confidence,
          reason: engineResult.upgrade_reason
            || engineResult.downgrade_reason
            || engineResult.reasons[0]
            || "Engine verdict",
          evidence: engineToEvidence(engineResult),
          rule_block: engineResult.decision_path === "hard_conflict"
            ? (engineResult.downgrade_reason ?? "engine_hard_conflict")
            : null,
          source: "rule",
          decision_signal: decisionSignal,
        };
        out[key] = v;
        toUpsert.push({
          source_url: it.source_url,
          source_url_norm: norm,
          asin: asinUp,
          verdict: v.verdict,
          confidence: v.confidence,
          reason: v.reason,
          evidence: v.evidence,
          rule_block: v.rule_block,
          model_used: `engine:v${ENGINE_VERSION}:${engineResult.decision_path}`,
          verification_version: VERIFICATION_VERSION,
          prompt_version: PROMPT_VERSION,
        });
        continue;
      }

      // Mid-band: AI fallback. Engine score is 60-84 — uncertain enough to
      // benefit from AI reasoning, but engine guardrails still apply.
      try {
        // Run AI text verifier and image compare in parallel.
        const supplierImg = supDetails?.image_url ?? it.source_image_url ?? null;
        const amazonImg = amzDetails?.image_url ?? it.amz_image_url ?? null;
        const [aiVerdict, imgCompare] = await Promise.all([
          callAI(it, LOVABLE_API_KEY, amzDetails, supDetails),
          compareImages(supplierImg, amazonImg, LOVABLE_API_KEY).catch((e) => {
            console.warn("[verify] image compare failed:", e instanceof Error ? (e as Error).message : String(e));
            return null as ImageCompareResult | null;
          }),
        ]);

        // Merge: engine evidence (reasons, signals, conflicts) + AI verdict.
        // Engine never lets AI escalate to exact_match unless engine already
        // confirmed identifier_confirmed (which would have bypassed AI).
        const engineEv = engineToEvidence(engineResult);
        const mergedEvidence: Record<string, unknown> = {
          ...aiVerdict.evidence,
          // Engine takes precedence on these critical Policy A flags
          _identifier_confirmed: engineEv._identifier_confirmed,
          _model_mpn_confirmed: engineEv._model_mpn_confirmed,
          _strong_attribute_alignment: engineEv._strong_attribute_alignment,
          _exact_match_eligible: engineEv._exact_match_eligible,
          _engine_version: engineEv._engine_version,
          _engine_decision_path: engineEv._engine_decision_path,
          _engine_score: engineEv._engine_score,
          _engine_reasons: engineEv._engine_reasons,
          _signals: engineEv._signals,
          _conflicts_detail: engineEv._conflicts_detail,
          _ai_fallback_invoked: true,
          // Image compare evidence
          _image_compare: imgCompare
            ? {
                similarity: imgCompare.similarity,
                verdict: imgCompare.verdict,
                phash_similarity: imgCompare.phash_similarity,
                ai_verdict: imgCompare.ai_verdict,
                ai_confidence: imgCompare.ai_confidence,
                reason: imgCompare.reason,
                used_ai: imgCompare.flags.used_ai,
              }
            : null,
        };

        // Guard: AI cannot upgrade to exact_match without engine identifier confirmation
        let finalVerdict = aiVerdict.verdict;
        let finalConfidence = aiVerdict.confidence;
        let finalReason = aiVerdict.reason;
        if (finalVerdict === "exact_match" && !engineEv._identifier_confirmed) {
          finalVerdict = "likely_match";
          finalConfidence = Math.min(finalConfidence, 80);
          finalReason = `AI suggested exact, but no identifier confirmation — capped at likely_match. ${finalReason}`;
          mergedEvidence._unsafe_exact_downgraded = true;
        }

        // ─────────────────────────────────────────────────────────────────
        // Image-similarity decision boost / demote.
        // Rules (image is SUPPORTING signal only — never the sole driver):
        //   - strong_match  → +10 confidence (cap 90 unless identifier confirmed)
        //   - likely_match  → +5  confidence
        //   - likely_diff   → -10 confidence; if AI said exact/likely → demote one tier
        //   - different     → -20 confidence; force likely_match (never not_match alone)
        // ─────────────────────────────────────────────────────────────────
        if (imgCompare && imgCompare.verdict !== "unavailable" && imgCompare.verdict !== "uncertain") {
          const before = finalConfidence;
          const beforeVerdict = finalVerdict;
          if (imgCompare.verdict === "strong_match") {
            finalConfidence = Math.min(95, finalConfidence + 10);
            mergedEvidence._image_signal_applied = "boost_strong";
          } else if (imgCompare.verdict === "likely_match") {
            finalConfidence = Math.min(90, finalConfidence + 5);
            mergedEvidence._image_signal_applied = "boost_light";
          } else if (imgCompare.verdict === "likely_different") {
            finalConfidence = Math.max(40, finalConfidence - 10);
            if (finalVerdict === "exact_match") finalVerdict = "likely_match";
            mergedEvidence._image_signal_applied = "demote_light";
          } else if (imgCompare.verdict === "different") {
            finalConfidence = Math.max(35, finalConfidence - 20);
            if (finalVerdict === "exact_match") finalVerdict = "likely_match";
            mergedEvidence._image_signal_applied = "demote_strong";
            mergedEvidence._image_mismatch_warning = true;
          }
          if (before !== finalConfidence || beforeVerdict !== finalVerdict) {
            finalReason = `${finalReason} | Image: ${imgCompare.reason}`.slice(0, 700);
          }
        }

        // ─────────────────────────────────────────────────────────────────
        // Accessory-as-core-product guard.
        // If the supplier's title is a protector/case/holder itself but the
        // Amazon candidate is NOT in the same accessory family, that's a
        // hard product-family conflict: force not_match so it never lands
        // in the Trusted bucket downstream.
        // ─────────────────────────────────────────────────────────────────
        const _supplierAccessory = detectSupplierAccessoryCore(it.source_title ?? "");
        if (_supplierAccessory && it.amz_title) {
          const _amazonInFamily = amazonIsSameAccessoryFamily(it.amz_title);
          if (!_amazonInFamily) {
            finalVerdict = "not_match";
            finalConfidence = Math.min(finalConfidence, 30);
            mergedEvidence._accessory_core_mismatch = true;
            mergedEvidence._accessory_core_noun = _supplierAccessory;
            mergedEvidence._image_mismatch_warning = true;
            finalReason = `Supplier item is a "${_supplierAccessory}" but Amazon candidate is not the same accessory family. ${finalReason}`.slice(0, 700);
          }
        }

        const v: Verdict = {
          verdict: finalVerdict,
          confidence: finalConfidence,
          reason: finalReason,
          evidence: mergedEvidence,
          rule_block: null,
          source: "ai",
          decision_signal: mergedEvidence._accessory_core_mismatch
            ? "hard_conflict"
            : aiVerdict.decision_signal,
        };
        out[key] = v;
        toUpsert.push({
          source_url: it.source_url,
          source_url_norm: norm,
          asin: asinUp,
          verdict: v.verdict,
          confidence: v.confidence,
          reason: v.reason,
          evidence: v.evidence,
          rule_block: null,
          model_used: `engine:v${ENGINE_VERSION}+ai:${MODEL}${imgCompare?.flags.used_ai ? "+vision" : imgCompare ? "+phash" : ""}`,
          verification_version: VERIFICATION_VERSION,
          prompt_version: PROMPT_VERSION,
        });
      } catch (e) {
        const msg = e instanceof Error ? (e as Error).message : "ai_error";
        if (msg === "rate_limited") {
          return new Response(
            JSON.stringify({
              error: "Rate limit reached. Please wait a moment and try again.",
              code: "rate_limited",
              partial: out,
            }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (msg === "payment_required") {
          return new Response(
            JSON.stringify({
              error: "AI credits exhausted. Please add credits in workspace settings.",
              code: "payment_required",
              partial: out,
            }),
            { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        console.error("[verify-store-scan-match] AI fallback error:", msg, "for", key);
        // Engine-only fallback when AI is unavailable
        const v: Verdict = {
          verdict: mapEngineVerdict(engineResult.verdict),
          confidence: engineResult.confidence,
          reason: `Engine verdict (AI fallback failed: ${msg})`,
          evidence: { ...engineToEvidence(engineResult), _ai_fallback_failed: msg },
          rule_block: null,
          source: "rule",
          decision_signal: "ai_review_due_to_missing_data",
        };
        out[key] = v;
        toUpsert.push({
          source_url: it.source_url,
          source_url_norm: norm,
          asin: asinUp,
          verdict: v.verdict,
          confidence: v.confidence,
          reason: v.reason,
          evidence: v.evidence,
          rule_block: null,
          model_used: `engine:v${ENGINE_VERSION}:fallback_failed`,
          verification_version: VERIFICATION_VERSION,
          prompt_version: PROMPT_VERSION,
        });
      }
    }

    // Bulk upsert verdicts (cache writes)
    if (toUpsert.length > 0) {
      const { error: upErr } = await admin
        .from("store_scan_ai_verifications")
        .upsert(toUpsert, {
          onConflict: "source_url_norm,asin,verification_version,prompt_version",
        });
      if (upErr) console.error("[verify-store-scan-match] upsert error:", upErr.message);
    }

    // QA: log per-item decision signal + aggregate counts so we can audit which
    // signal is carrying each verdict. Distinguish identifier-confirmed exacts
    // (rule-based, trustworthy) from any AI-reasoned outputs.
    const signalCounts: Record<string, number> = {};
    const verdictBreakdown: Record<string, number> = {};
    let unsafeCount = 0;
    let softConflictDowngradeCount = 0;
    let identifierConfirmedExact = 0;
    let explicitConflictRejects = 0;
    for (const [k, v] of Object.entries(out)) {
      signalCounts[v.decision_signal] = (signalCounts[v.decision_signal] ?? 0) + 1;
      const ev = v.evidence as Record<string, unknown>;
      const unsafe = ev?._unsafe_exact_downgraded === true;
      const softDown = ev?._soft_conflict_downgraded === true;
      if (unsafe) unsafeCount++;
      if (softDown) softConflictDowngradeCount++;

      // Categorize verdict by evidence quality for QA audit
      let verdictLabel: string = v.verdict;
      if (v.verdict === "exact_match" && v.decision_signal === "identifier_match") {
        verdictLabel = "exact_match_identifier_confirmed";
        identifierConfirmedExact++;
      } else if (v.verdict === "exact_match") {
        // Should be impossible after Policy A, but flag loudly if it slips through
        verdictLabel = "exact_match_AI_LEAK_BUG";
      } else if (v.verdict === "likely_match" && v.decision_signal === "ai_unsafe_exact_downgraded") {
        verdictLabel = "likely_match_downgraded_from_ai_exact";
      } else if (v.verdict === "likely_match" && softDown) {
        verdictLabel = "likely_match_downgraded_from_ai_not_match";
      } else if (v.verdict === "likely_match") {
        verdictLabel = "likely_match_ai_reasoned";
      } else if (v.verdict === "not_match" && v.decision_signal === "ai_identity_conflict") {
        verdictLabel = "not_match_explicit_conflict";
        explicitConflictRejects++;
      } else if (v.verdict === "not_match") {
        verdictLabel = `not_match_${v.decision_signal}`;
      }
      verdictBreakdown[verdictLabel] = (verdictBreakdown[verdictLabel] ?? 0) + 1;

      const rawC = ev?._ai_raw_confidence;
      const cap = ev?._confidence_cap_applied;
      const idConf = ev?._identifier_confirmed === true;
      const modelConf = ev?._model_mpn_confirmed === true;
      const strongAttr = ev?._strong_attribute_alignment === true;
      const exactEligible = ev?._exact_match_eligible === true;
      const downgradeReason = ev?._downgrade_reason;
      const softReason = ev?._soft_conflict_reason;
      const explicitN = ev?._conflict_explicit_count ?? 0;
      const softN = ev?._conflict_soft_count ?? 0;
      const explicitFields = Array.isArray(ev?._conflict_fields_explicit) ? (ev._conflict_fields_explicit as unknown[]).join("|") : "";
      const softFields = Array.isArray(ev?._conflict_fields_soft) ? (ev._conflict_fields_soft as unknown[]).join("|") : "";
      const conflictReport = Array.isArray(ev?._conflict_report) ? (ev._conflict_report as unknown[]) : [];
      console.log(
        `[verify-store-scan-match] QA item=${k.slice(0, 80)} verdict=${verdictLabel} signal=${v.decision_signal} confidence=${v.confidence}${rawC !== undefined ? ` (raw=${rawC} cap=${cap})` : ""} identifier_confirmed=${idConf} model_mpn_confirmed=${modelConf} strong_attribute_alignment=${strongAttr} exact_match_eligible=${exactEligible} conflicts(explicit=${explicitN}${explicitFields ? `:${explicitFields}` : ""}, soft=${softN}${softFields ? `:${softFields}` : ""})${downgradeReason ? ` downgrade_reason=${downgradeReason}` : ""}${softReason ? ` soft_conflict_reason=${softReason}` : ""} source=${v.source}${unsafe ? " UNSAFE_EXACT_DOWNGRADED" : ""}${softDown ? " SOFT_CONFLICT_DOWNGRADED" : ""}`,
      );
      if (conflictReport.length > 0) {
        console.log(
          `[verify-store-scan-match] QA item=${k.slice(0, 80)} conflict_report=${JSON.stringify(conflictReport).slice(0, 600)}`,
        );
      }
    }
    console.log(
      `[verify-store-scan-match] QA SUMMARY n=${Object.keys(out).length} identifier_confirmed_exact=${identifierConfirmedExact} explicit_conflict_rejects=${explicitConflictRejects} unsafe_downgrades=${unsafeCount} soft_conflict_downgrades=${softConflictDowngradeCount} signals=${JSON.stringify(signalCounts)} verdicts=${JSON.stringify(verdictBreakdown)}`,
    );

    return new Response(JSON.stringify({ verifications: out }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? (err as Error).message : "unknown";
    console.error("[verify-store-scan-match] fatal:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
