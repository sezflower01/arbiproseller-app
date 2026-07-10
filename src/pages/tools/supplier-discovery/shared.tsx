import { Badge } from "@/components/ui/badge";

// ─── Shared label maps (mirrored from PriceExtractor) ───
export const BLOCK_PROVIDER_LABELS: Record<string, string> = {
  perimeterx: "PerimeterX",
  datadome_captcha: "DataDome",
  cloudflare_challenge: "Cloudflare",
  cloudflare_jschallenge: "Cloudflare JS",
  walmart_press_and_hold: "Walmart Press & Hold",
  walmart_short_block_page: "Walmart block page",
  press_and_hold_captcha: "Press & Hold CAPTCHA",
  generic_robot_check: "Robot check",
  access_denied: "Access denied",
  distil_networks: "Distil",
  generic_human_verify: "Human verify",
  empty_or_tiny_response: "Empty response",
};

export const RESOLUTION_LABELS: Record<string, { label: string; tone: Tone }> = {
  price_extracted: { label: "Price extracted", tone: "good" },
  blocked_phase1: { label: "Blocked (Phase 1)", tone: "bad" },
  blocked_phase2: { label: "Blocked (P1 + P2)", tone: "bad" },
  blocked_all_phases: { label: "Blocked (all phases)", tone: "bad" },
  phase2_timeout: { label: "Phase 2 timeout", tone: "bad" },
  phase2_render_failed: { label: "Phase 2 render failed", tone: "bad" },
  phase2_extract_failed: { label: "Phase 2: no price after render", tone: "ai" },
  not_found_unblocked: { label: "Not found (accessible)", tone: "ai" },
  non_product_page: { label: "Not a product page", tone: "bad" },
  fetch_error: { label: "Fetch error", tone: "bad" },
};

export type Tone = "good" | "ok" | "ai" | "bad";

export function toneClass(tone: Tone) {
  return tone === "good"
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
    : tone === "ok"
    ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
    : tone === "ai"
    ? "bg-muted text-foreground border-border"
    : "bg-rose-500/15 text-rose-300 border-rose-500/30";
}

export function fmtPrice(value: number | null | undefined, currency: string | null | undefined) {
  if (value == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
    }).format(value);
  } catch {
    return `${currency || "$"}${value}`;
  }
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export interface DiscoveryRun {
  id: string;
  asin: string;
  amazon_title: string | null;
  brand: string | null;
  model_number: string | null;
  upc: string | null;
  status: string;
  total_candidates: number;
  extracted_count: number;
  blocked_count: number;
  unresolved_count: number;
  invalid_count: number;
  needs_review_count: number;
  top_valid_price: number | null;
  top_valid_url: string | null;
  top_valid_domain: string | null;
  qa_batch_id: string | null;
  previous_run_id?: string | null;
  quality_badge?: string | null;
  error: string | null;
  created_at: string;
}

export interface Candidate {
  id: string;
  run_id: string;
  asin: string;
  source_url: string;
  domain: string | null;
  source_type: string | null;
  source_title: string | null;
  source_snippet: string | null;
  match_score: number;
  match_reason: string | null;
  phase1_status: string | null;
  phase2_status: string | null;
  block_provider: string | null;
  final_resolution: string | null;
  extraction_method: string | null;
  current_price: number | null;
  original_price: number | null;
  currency: string | null;
  availability: string | null;
  confidence_score: number | null;
  needs_review: boolean | null;
  review_reasons: string[] | null;
  image_url: string | null;
  extracted_at: string | null;
  last_checked_at: string | null;
}

export interface SavedSource {
  id: string;
  asin: string;
  source_url: string;
  domain: string | null;
  price: number | null;
  currency: string | null;
  source_title: string | null;
  source_image?: string | null;
  notes: string | null;
  is_preferred?: boolean;
  is_trusted?: boolean;
  manual_cost?: number | null;
  manual_cost_currency?: string | null;
  manual_cost_note?: string | null;
  candidate_id?: string | null;
  run_id?: string | null;
  last_checked_at?: string | null;
  last_status?: string | null;
  last_resolution?: string | null;
  last_confidence?: number | null;
  created_at: string;
}

export interface TrustedDomain {
  id: string;
  user_id: string;
  domain: string;
  notes: string | null;
  created_at: string;
}

// ─── Supplier Registry (Phase 1: curated only) ───
export type SupplierType = "retail" | "wholesale" | "distributor" | "unknown";
export type SupplierTrustLevel = "unknown" | "trusted" | "verified";
export type SupplierOrigin = "curated" | "tactical_arbitrage" | "user_added";

export interface Supplier {
  id: string;
  user_id: string;
  domain: string;
  supplier_name: string | null;
  supplier_type: SupplierType;
  trust_level: SupplierTrustLevel;
  source_origin: SupplierOrigin;
  supports_scraping: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupplierContext {
  // Map domain → supplier record for fast lookup during ranking
  byDomain: Map<string, Supplier>;
}

export const EMPTY_SUPPLIER_CONTEXT: SupplierContext = { byDomain: new Map() };

export function normalizeDomain(domain: string | null | undefined): string {
  if (!domain) return "";
  return domain
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

export function buildSupplierContext(suppliers: Supplier[]): SupplierContext {
  const byDomain = new Map<string, Supplier>();
  for (const s of suppliers) byDomain.set(normalizeDomain(s.domain), s);
  return { byDomain };
}

export function findSupplierForCandidate(
  c: Candidate,
  ctx: SupplierContext,
): Supplier | null {
  const d = normalizeDomain(c.domain);
  if (!d) return null;
  return ctx.byDomain.get(d) || null;
}

// ─── Domain similarity / related-supplier detection ───
// We extract the "root name" of a domain (e.g. grillpartsamerica.com → "grillpartsamerica")
// and compare it against the user's supplier roots. We deliberately only SUGGEST —
// we never auto-trust similar domains, and we never apply a ranking boost from a suggestion.
const COMMON_TLDS = new Set([
  "com", "net", "org", "co", "io", "shop", "store", "us", "ca", "uk", "mx", "biz", "info",
]);
const STOPWORDS = new Set([
  "shop", "store", "online", "official", "the", "buy", "sale", "outlet",
  "deals", "warehouse", "supply", "supplies", "direct", "wholesale",
]);

export function rootNameOfDomain(domain: string | null | undefined): string {
  const d = normalizeDomain(domain);
  if (!d) return "";
  // strip TLDs progressively (handles co.uk style chains too)
  const parts = d.split(".");
  while (parts.length > 1 && COMMON_TLDS.has(parts[parts.length - 1])) parts.pop();
  return (parts[parts.length - 1] || "").toLowerCase();
}

// Levenshtein distance — small implementation, capped iterations are fine here
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const v0 = new Array(b.length + 1).fill(0);
  const v1 = new Array(b.length + 1).fill(0);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}

// 0..1 similarity score — combines root-containment and edit distance.
// 1.0 means root names match exactly. 0.6+ is "likely related".
export function rootSimilarity(rootA: string, rootB: string): number {
  if (!rootA || !rootB) return 0;
  if (rootA === rootB) return 1;
  // ignore common stopword roots — they cause false positives ("shop", "store")
  if (STOPWORDS.has(rootA) || STOPWORDS.has(rootB)) return 0;

  // containment heuristic: one root contains the other AND the longer is at least 5 chars
  const longer = rootA.length >= rootB.length ? rootA : rootB;
  const shorter = rootA.length >= rootB.length ? rootB : rootA;
  if (longer.length >= 5 && shorter.length >= 5 && longer.includes(shorter)) {
    // ratio of shared length to longer length
    return Math.max(0.7, shorter.length / longer.length);
  }

  // edit-distance-based ratio
  const dist = levenshtein(rootA, rootB);
  const maxLen = Math.max(rootA.length, rootB.length);
  if (maxLen === 0) return 0;
  const ratio = 1 - dist / maxLen;
  // require both roots to be at least 5 chars to avoid noise on short tokens
  if (rootA.length < 5 || rootB.length < 5) return 0;
  return ratio;
}

export interface RelatedSupplierMatch {
  supplier: Supplier;
  similarity: number; // 0..1
  candidateRoot: string;
  supplierRoot: string;
  reason: "root_contains" | "edit_distance";
}

// Find the best related supplier (if any) for a candidate that is NOT in the registry.
// Returns null if the candidate domain itself IS in the registry — use findSupplierForCandidate
// for the direct match.
export function findRelatedSupplier(
  c: Candidate,
  ctx: SupplierContext,
  minSimilarity = 0.7,
): RelatedSupplierMatch | null {
  const candDomain = normalizeDomain(c.domain);
  if (!candDomain) return null;
  if (ctx.byDomain.has(candDomain)) return null; // direct match — not a "related" case

  const candRoot = rootNameOfDomain(candDomain);
  if (!candRoot || candRoot.length < 5) return null;

  let best: RelatedSupplierMatch | null = null;
  for (const supplier of ctx.byDomain.values()) {
    const supRoot = rootNameOfDomain(supplier.domain);
    if (!supRoot) continue;
    const sim = rootSimilarity(candRoot, supRoot);
    if (sim < minSimilarity) continue;
    const reason: RelatedSupplierMatch["reason"] =
      candRoot.includes(supRoot) || supRoot.includes(candRoot)
        ? "root_contains"
        : "edit_distance";
    if (!best || sim > best.similarity) {
      best = { supplier, similarity: sim, candidateRoot: candRoot, supplierRoot: supRoot, reason };
    }
  }
  return best;
}

// Ranking boost from supplier registry — strong for curated, smaller for TA, none for unknown.
export function supplierRankBoost(supplier: Supplier | null): number {
  if (!supplier) return 0;
  let boost = 0;
  if (supplier.source_origin === "curated") boost += 200;
  else if (supplier.source_origin === "tactical_arbitrage") boost += 60;
  else boost += 20;
  if (supplier.trust_level === "verified") boost += 80;
  else if (supplier.trust_level === "trusted") boost += 40;
  return boost;
}

// Detailed breakdown for ranking transparency UI (tooltips, debug)
export interface SupplierBoostBreakdown {
  total: number;
  originBoost: number;
  trustBoost: number;
  originLabel: string;
  trustLabel: string;
}

export function supplierBoostBreakdown(supplier: Supplier | null): SupplierBoostBreakdown | null {
  if (!supplier) return null;
  const originBoost =
    supplier.source_origin === "curated" ? 200
    : supplier.source_origin === "tactical_arbitrage" ? 60
    : 20;
  const trustBoost =
    supplier.trust_level === "verified" ? 80
    : supplier.trust_level === "trusted" ? 40
    : 0;
  return {
    total: originBoost + trustBoost,
    originBoost,
    trustBoost,
    originLabel:
      supplier.source_origin === "curated" ? "Curated"
      : supplier.source_origin === "tactical_arbitrage" ? "Tactical Arbitrage"
      : "User-added",
    trustLabel:
      supplier.trust_level === "verified" ? "Verified"
      : supplier.trust_level === "trusted" ? "Trusted"
      : "Unknown",
  };
}

// Tone for the supplier badge shown on candidate rows
export function supplierBadgeTone(supplier: Supplier): Tone {
  if (supplier.trust_level === "verified") return "good";
  if (supplier.source_origin === "curated") return "good";
  if (supplier.trust_level === "trusted") return "ok";
  if (supplier.source_origin === "tactical_arbitrage") return "ai";
  return "ok";
}

export function supplierBadgeLabel(supplier: Supplier): string {
  if (supplier.trust_level === "verified") return "Verified supplier";
  if (supplier.trust_level === "trusted") return "Trusted supplier";
  if (supplier.source_origin === "curated") return "Curated supplier";
  if (supplier.source_origin === "tactical_arbitrage") return "TA supplier";
  return "Supplier";
}

// ─── Trust context: which sources/domains the USER has explicitly approved ───
// Used to bypass strict gate rejections (membership / untrusted / social)
// while still surfacing margin & match warnings.
export interface TrustContext {
  // URLs the user marked trusted for THIS asin (from saved_sources.is_trusted)
  trustedUrls: Set<string>;
  // Domains the user marked globally trusted (from trusted_domains)
  trustedDomains: Set<string>;
  // Per-URL manual cost overrides (from saved_sources.manual_cost) for THIS asin
  manualCosts: Map<string, { cost: number; currency: string | null; note: string | null }>;
}

export const EMPTY_TRUST_CONTEXT: TrustContext = {
  trustedUrls: new Set(),
  trustedDomains: new Set(),
  manualCosts: new Map(),
};

export function buildTrustContext(
  saved: SavedSource[],
  domains: TrustedDomain[],
): TrustContext {
  const trustedUrls = new Set<string>();
  const manualCosts = new Map<string, { cost: number; currency: string | null; note: string | null }>();
  for (const s of saved) {
    if (s.is_trusted) trustedUrls.add(s.source_url);
    if (s.manual_cost != null && s.manual_cost > 0) {
      manualCosts.set(s.source_url, {
        cost: Number(s.manual_cost),
        currency: s.manual_cost_currency || s.currency || "USD",
        note: s.manual_cost_note || null,
      });
    }
  }
  const trustedDomains = new Set<string>(
    domains.map((d) => d.domain.toLowerCase().replace(/^www\./, "")),
  );
  return { trustedUrls, trustedDomains, manualCosts };
}

export function isUserTrusted(c: Candidate, ctx: TrustContext): boolean {
  if (ctx.trustedUrls.has(c.source_url)) return true;
  if (c.domain) {
    const d = c.domain.toLowerCase().replace(/^www\./, "");
    if (ctx.trustedDomains.has(d)) return true;
  }
  return false;
}

export function effectivePriceForCandidate(c: Candidate, ctx: TrustContext): {
  price: number | null;
  currency: string | null;
  isManual: boolean;
  note: string | null;
} {
  const manual = ctx.manualCosts.get(c.source_url);
  if (manual) {
    return { price: manual.cost, currency: manual.currency, isManual: true, note: manual.note };
  }
  return { price: c.current_price, currency: c.currency, isManual: false, note: null };
}

// ─── Margin helpers ───
export interface MarginInfo {
  margin: number | null;
  marginPct: number | null;
  guard: MarginGuard;
}

export type MarginGuard =
  | "none"          // no calc possible
  | "negative"      // margin < 0
  | "low_confidence"// confidence below threshold but extracted
  | "suspicious"    // margin % unusually high (likely mismatch)
  | "ok";

export function computeMargin(
  sourcePrice: number | null | undefined,
  amazonPrice: number | null | undefined,
  confidence: number | null | undefined
): MarginInfo {
  if (sourcePrice == null || sourcePrice <= 0 || amazonPrice == null || amazonPrice <= 0) {
    return { margin: null, marginPct: null, guard: "none" };
  }
  const margin = amazonPrice - sourcePrice;
  const marginPct = (margin / amazonPrice) * 100;
  let guard: MarginGuard = "ok";
  if (margin < 0) guard = "negative";
  else if (marginPct >= 70) guard = "suspicious";
  else if (confidence != null && confidence < 0.5) guard = "low_confidence";
  return { margin, marginPct, guard };
}

export function marginGuardLabel(g: MarginGuard): { label: string; tone: Tone } | null {
  switch (g) {
    case "negative": return { label: "Negative margin", tone: "bad" };
    case "suspicious": return { label: "Margin too high — verify match", tone: "ai" };
    case "low_confidence": return { label: "Low confidence — review for ROI", tone: "ai" };
    default: return null;
  }
}

// ─── Domain trust tiers ───
// Tier 1: major direct retailers we'd buy from with confidence
// Tier 2: mid-tier / regional retailers — usable but verify
// Tier 3: aggregators, marketplaces, membership-only — down-rank, never auto-pick best
// Tier 4: social / blog / unknown — heavy penalty, hidden by default
export type DomainTier = 1 | 2 | 3 | 4;

const TIER1_DOMAINS = new Set([
  // Mass merchants & big box
  "walmart.com", "target.com", "bestbuy.com", "homedepot.com", "lowes.com",
  "kohls.com", "macys.com", "jcpenney.com", "nordstrom.com", "nordstromrack.com",
  "saksfifthavenue.com", "saksoff5th.com", "bloomingdales.com", "neimanmarcus.com",
  "dillards.com", "belk.com", "burlington.com", "ross.com", "tjmaxx.com",
  "marshalls.com", "homegoods.com", "sierra.com",
  // Pharmacy / beauty
  "walgreens.com", "cvs.com", "riteaid.com", "ulta.com", "sephora.com",
  "bathandbodyworks.com", "victoriassecret.com",
  // Office
  "staples.com", "officedepot.com",
  // Hardware / industrial
  "acehardware.com", "menards.com", "harborfreight.com", "tractorsupply.com",
  "northerntool.com", "grainger.com", "zoro.com", "fastenal.com",
  // Home / furniture
  "wayfair.com", "ikea.com", "potterybarn.com", "westelm.com", "crateandbarrel.com",
  "cb2.com", "worldmarket.com",
  // Crafts / books
  "michaels.com", "joann.com", "hobbylobby.com", "barnesandnoble.com", "books-a-million.com",
  // Pet
  "petco.com", "petsmart.com", "chewy.com", "petsuppliesplus.com",
  // Sporting goods / outdoors / apparel
  "dickssportinggoods.com", "academy.com", "rei.com", "basspro.com", "cabelas.com",
  "scheels.com", "footlocker.com", "finishline.com", "champssports.com", "eastbay.com",
  "lululemon.com", "gap.com", "oldnavy.com", "bananarepublic.com",
  // Toys / kids / baby
  "toysrus.com", "buybuybaby.com", "carters.com", "oshkosh.com", "thechildrensplace.com",
  // Clubs
  "samsclub.com", "costco.com", "bjs.com",
  // Grocery (general merchandise)
  "kroger.com", "publix.com", "wegmans.com", "heb.com", "meijer.com",
  "wholefoodsmarket.com", "vitacost.com", "iherb.com",
]);

const TIER2_DOMAINS = new Set([
  // Specialty / general
  "containerstore.com", "bedbathandbeyond.com", "qvc.com", "hsn.com",
  "newegg.com", "bhphotovideo.com", "adorama.com", "overstock.com",
  "zappos.com", "6pm.com", "shoes.com", "famousfootwear.com", "dsw.com", "shoecarnival.com",
  // Electronics
  "microcenter.com", "abt.com", "crutchfield.com",
  "samsung.com", "apple.com", "lenovo.com", "dell.com", "hp.com",
  "razer.com", "logitech.com", "corsair.com",
  // Auto / tools
  "autozone.com", "advanceautoparts.com", "oreillyauto.com", "napaonline.com",
  "rockauto.com", "summitracing.com", "carid.com",
  // Health / supplements / beauty
  "gnc.com", "vitaminshoppe.com", "puritan.com", "swansonvitamins.com",
  "luckyvitamin.com", "dermstore.com", "skinstore.com",
  // Home / kitchen
  "surlatable.com", "williams-sonoma.com",
  // Books / media
  "thriftbooks.com", "abebooks.com", "alibris.com", "betterworldbooks.com",
  // Apparel
  "uniqlo.com", "hm.com", "express.com", "abercrombie.com",
  "hollisterco.com", "americaneagle.com", "aerie.com",
  // Music
  "sweetwater.com", "guitarcenter.com", "musiciansfriend.com", "samash.com",
  // Outdoor / sports
  "backcountry.com", "moosejaw.com", "campsaver.com",
  "sportsmanswarehouse.com", "fieldandstreamshop.com",
  // Toys / collectibles
  "entertainmentearth.com", "bigbadtoystore.com",
]);

// Membership / wholesale-only (price requires login or membership)
const MEMBERSHIP_DOMAINS = new Set([
  "costco.com", "samsclub.com", "bjs.com",
]);

// Aggregators, re-sellers, drop-shippers, multi-region "ubuy"-style sites
const AGGREGATOR_PATTERNS = [
  /\bubuy\./i, /\btiendamia\./i, /\bpicclick\./i, /\baddros\./i,
  /\bwarehouserunner\./i, /\bsupplyleader\./i, /\bbabyluckretail\./i,
  /\binstacart\./i, /\bgoogle\.com\/shopping/i,
];

// Social platforms (never product pages we'd source from)
const SOCIAL_PATTERNS = [
  /\binstagram\./i, /\btiktok\./i, /\bfacebook\./i, /\bpinterest\./i,
  /\byoutube\./i, /\btwitter\./i, /\bx\.com$/i, /\breddit\./i,
];

export function domainTier(domain: string | null | undefined): DomainTier {
  if (!domain) return 4;
  const d = domain.toLowerCase().replace(/^www\./, "");
  if (SOCIAL_PATTERNS.some((re) => re.test(d))) return 4;
  if (AGGREGATOR_PATTERNS.some((re) => re.test(d))) return 3;
  if (TIER1_DOMAINS.has(d)) return 1;
  if (TIER2_DOMAINS.has(d)) return 2;
  // unknown direct retailer → tier 2 by default (don't kill discovery)
  return 2;
}

export function isMembershipDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase().replace(/^www\./, "");
  return MEMBERSHIP_DOMAINS.has(d);
}

export function isTrustedDomain(domain: string | null | undefined): boolean {
  return domainTier(domain) <= 2;
}

export function domainTierLabel(t: DomainTier): { label: string; tone: Tone } {
  switch (t) {
    case 1: return { label: "Trusted retailer", tone: "good" };
    case 2: return { label: "Retailer", tone: "ok" };
    case 3: return { label: "Aggregator", tone: "ai" };
    case 4: return { label: "Social / unknown", tone: "bad" };
  }
}

// ─── Identity-aware match validation (pack count, size, brand) ───
const PACK_RE = /(\d+)\s*[- ]?\s*(?:pack|pk|count|ct|pc|pieces?)\b/i;
const SIZE_TOKENS = [
  "xx-small", "xx small", "xxs",
  "x-small", "x small", "xs",
  "small", "medium", "large",
  "x-large", "x large", "xl",
  "xx-large", "xx large", "xxl",
  "xxxl", "3xl", "4xl",
];

function extractPackCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(PACK_RE);
  return m ? parseInt(m[1], 10) : null;
}

function extractSizeToken(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const t of SIZE_TOKENS) {
    const re = new RegExp(`\\b${t.replace(/[-\s]/g, "[\\s-]?")}\\b`, "i");
    if (re.test(lower)) return t.replace(/[-\s]/g, "");
  }
  return null;
}

export interface IdentityForScoring {
  title?: string | null;
  brand?: string | null;
  amazonPrice?: number | null;
}

export interface MatchPenalty {
  kind: "pack_mismatch" | "size_mismatch" | "missing_brand" | "suspicious_price" | "low_tier" | "membership";
  delta: number; // negative = penalty
  label: string;
}

export function matchPenalties(c: Candidate, id: IdentityForScoring): MatchPenalty[] {
  const out: MatchPenalty[] = [];
  const candText = `${c.source_title || ""} ${c.source_snippet || ""}`;

  // Pack-count mismatch
  const idPack = extractPackCount(id.title);
  const cPack = extractPackCount(candText);
  if (idPack && cPack && idPack !== cPack) {
    out.push({ kind: "pack_mismatch", delta: -25, label: `Pack mismatch: ${cPack} vs ${idPack}` });
  } else if (idPack && cPack == null) {
    out.push({ kind: "pack_mismatch", delta: -10, label: `Pack count not confirmed (need ${idPack})` });
  }

  // Size-variation mismatch
  const idSize = extractSizeToken(id.title);
  const cSize = extractSizeToken(candText);
  if (idSize && cSize && idSize !== cSize) {
    out.push({ kind: "size_mismatch", delta: -20, label: `Size mismatch: ${cSize} vs ${idSize}` });
  } else if (idSize && cSize == null) {
    out.push({ kind: "size_mismatch", delta: -8, label: `Size not confirmed (need ${idSize})` });
  }

  // Brand missing from candidate title
  if (id.brand) {
    const brandLower = id.brand.toLowerCase().split(/\s+/)[0];
    if (brandLower.length >= 3 && !candText.toLowerCase().includes(brandLower)) {
      out.push({ kind: "missing_brand", delta: -15, label: `Brand "${id.brand}" not found in title` });
    }
  }

  // Suspicious extracted price (less than 20% of Amazon reference → likely wrong product / single unit of pack)
  if (
    c.current_price != null && c.current_price > 0 &&
    id.amazonPrice != null && id.amazonPrice > 0 &&
    c.current_price < id.amazonPrice * 0.2
  ) {
    out.push({
      kind: "suspicious_price",
      delta: -30,
      label: `Price ${c.current_price.toFixed(2)} far below Amazon ${id.amazonPrice.toFixed(2)} — likely wrong product`,
    });
  }

  // Domain tier penalty
  const tier = domainTier(c.domain);
  if (tier === 3) out.push({ kind: "low_tier", delta: -20, label: "Aggregator / re-seller domain" });
  if (tier === 4) out.push({ kind: "low_tier", delta: -50, label: "Social / unknown domain" });
  if (isMembershipDomain(c.domain)) {
    out.push({ kind: "membership", delta: -15, label: "Membership-only pricing (Costco/Sam's/BJ's)" });
  }

  return out;
}

export function effectiveMatchScore(c: Candidate, id: IdentityForScoring): number {
  const base = c.match_score || 0;
  const penalties = matchPenalties(c, id);
  const total = penalties.reduce((sum, p) => sum + p.delta, 0);
  return Math.max(0, base + total);
}

// ─── Ranking score for "Best matches first" ───
// Match quality (with penalties) > confidence > trust tier > supplier boost > valid-price bonus.
export function candidateRankScore(
  c: Candidate,
  id: IdentityForScoring = {},
  trust: TrustContext = EMPTY_TRUST_CONTEXT,
  suppliers: SupplierContext = EMPTY_SUPPLIER_CONTEXT,
): number {
  let s = 0;
  const eff = effectiveMatchScore(c, id);

  // Match quality drives ranking — NOT raw price.
  s += eff * 20;

  // Confidence (0..1) → 0..100
  s += (c.confidence_score ?? 0) * 100;

  // Domain tier bonus
  const tier = domainTier(c.domain);
  if (tier === 1) s += 80;
  else if (tier === 2) s += 30;

  // Supplier registry boost — curated network ranks above generic results.
  const sup = findSupplierForCandidate(c, suppliers);
  s += supplierRankBoost(sup);

  // User-trust boost — raise sources the user has explicitly approved
  if (isUserTrusted(c, trust)) s += 250;

  // Manual cost set → user has personally vetted this source
  if (trust.manualCosts.has(c.source_url)) s += 150;

  // Successful extraction bonus (must be earned, not dominant)
  if (c.current_price != null && c.current_price > 0 && c.final_resolution === "price_extracted") {
    s += 200;
  }
  // Trusted sources with a manual cost don't need extraction to be considered
  if (trust.manualCosts.has(c.source_url)) s += 100;

  // Penalize blocked / invalid so they sink (unless user-trusted)
  if (!isUserTrusted(c, trust)) {
    if (c.final_resolution && c.final_resolution.startsWith("blocked_")) s -= 300;
    if (c.final_resolution === "phase2_timeout" || c.final_resolution === "phase2_render_failed") s -= 250;
    if (c.final_resolution === "non_product_page") s -= 600;
  }

  return s;
}

// ─── Best Candidate gate (tunable) ───
export interface BestCandidateGate {
  minMatchScore: number;        // effective (post-penalty)
  minConfidence: number;        // 0..1
  maxMarginPct: number;         // %
  minMarginPct: number;         // % (negative allowed)
  /** Minimum desired ROI % = (amazon - source) / source * 100. 0 = disabled. */
  minRoiPct: number;
  /** Maximum desired ROI %. 0 = disabled (no upper cap). */
  maxRoiPct: number;
  requireTrustedDomain: boolean;
  blockMembership: boolean;
  blockSocial: boolean;
}

export const DEFAULT_GATE: BestCandidateGate = {
  minMatchScore: 40,
  minConfidence: 0.7,
  maxMarginPct: 60,
  minMarginPct: -20,
  minRoiPct: 30,
  maxRoiPct: 0,
  requireTrustedDomain: true,
  blockMembership: true,
  blockSocial: true,
};

/**
 * Estimated Amazon fee total (referral + FBA pick & pack) for a given Amazon
 * sell price. Used by the gate ONLY as a pre-filter so the slider matches the
 * real ROI shown on the Best Candidate card (which uses true SP-API fees via
 * useLiveRoi). A per-candidate SP-API fee call would defeat the cost-saving
 * purpose of the slider, so we use a conservative blended estimate:
 *   - 15% referral fee (Amazon default for most categories)
 *   - ~$3.50 FBA pick & pack on a typical small/standard item
 */
const ESTIMATED_REFERRAL_RATE = 0.15;
const ESTIMATED_FBA_FIXED_USD = 3.5;

export function estimateAmazonFeesUsd(amazonPrice: number): number {
  if (!(amazonPrice > 0)) return 0;
  return amazonPrice * ESTIMATED_REFERRAL_RATE + ESTIMATED_FBA_FIXED_USD;
}

/**
 * Real ROI % matching the Best Candidate card formula:
 *   ROI = (AmazonPrice − EstimatedFees − Cost) / Cost × 100
 *
 * The Best Candidate card overrides this with true SP-API fees once available;
 * here we use an estimate so the slider/gate can pre-filter without burning
 * API calls.
 */
export function computeRoiPct(
  sourcePrice: number | null | undefined,
  amazonPrice: number | null | undefined,
): number | null {
  if (sourcePrice == null || sourcePrice <= 0) return null;
  if (amazonPrice == null || amazonPrice <= 0) return null;
  const fees = estimateAmazonFeesUsd(amazonPrice);
  const profit = amazonPrice - fees - sourcePrice;
  return (profit / sourcePrice) * 100;
}

export interface GateResult {
  passed: boolean;
  reasons: string[]; // why each candidate failed
  bypassedByTrust?: boolean; // true when user-trust bypassed gate failures
}

export function evaluateGate(
  c: Candidate,
  id: IdentityForScoring,
  gate: BestCandidateGate,
  trust: TrustContext = EMPTY_TRUST_CONTEXT,
): GateResult {
  const reasons: string[] = [];
  const userTrusted = isUserTrusted(c, trust);
  const manual = trust.manualCosts.get(c.source_url);
  const effPrice = manual?.cost ?? c.current_price;

  // Must have SOME price — extracted or manually entered
  if (!(effPrice != null && effPrice > 0)) {
    reasons.push("No valid extracted price");
  } else if (!manual && c.final_resolution !== "price_extracted") {
    reasons.push("No valid extracted price");
  }

  const eff = effectiveMatchScore(c, id);
  if (eff < gate.minMatchScore) reasons.push(`Match score ${eff} < ${gate.minMatchScore}`);

  // Confidence check is skipped when manual cost overrides extraction
  if (!manual && (c.confidence_score ?? 0) < gate.minConfidence) {
    reasons.push(`Confidence ${Math.round((c.confidence_score ?? 0) * 100)}% < ${Math.round(gate.minConfidence * 100)}%`);
  }

  if (id.amazonPrice != null && id.amazonPrice > 0 && effPrice != null && effPrice > 0) {
    // Margin sanity guards still use spread vs Amazon price (these are
    // catch-mismatch heuristics, NOT profitability)
    const pct = ((id.amazonPrice - effPrice) / id.amazonPrice) * 100;
    if (pct > gate.maxMarginPct) reasons.push(`Margin ${pct.toFixed(0)}% > ${gate.maxMarginPct}% (suspicious)`);
    if (pct < gate.minMarginPct) reasons.push(`Margin ${pct.toFixed(0)}% < ${gate.minMarginPct}% (loss)`);

    // ROI gate — REAL ROI after estimated Amazon fees (referral + FBA),
    // matching the Best Candidate card formula.
    const roi = computeRoiPct(effPrice, id.amazonPrice);
    if (roi != null) {
      if (gate.minRoiPct > 0 && roi < gate.minRoiPct) {
        reasons.push(`Real ROI ${roi.toFixed(0)}% < ${gate.minRoiPct}% target (after est. Amazon fees)`);
      }
      if (gate.maxRoiPct > 0 && roi > gate.maxRoiPct) {
        reasons.push(`Real ROI ${roi.toFixed(0)}% > ${gate.maxRoiPct}% (above range)`);
      }
    }
  }

  const tier = domainTier(c.domain);
  if (gate.blockSocial && tier === 4) reasons.push("Social / unknown domain");
  if (gate.blockMembership && isMembershipDomain(c.domain)) reasons.push("Membership-only pricing");
  if (gate.requireTrustedDomain && tier > 2) reasons.push("Domain not in trusted retailer list");

  // User-trust bypass — keep margin/match warnings but allow the source through
  if (userTrusted && reasons.length > 0) {
    // Bypass ONLY trust/extraction failures, not match-quality / margin sanity checks
    const bypassable = new Set([
      "Membership-only pricing",
      "Social / unknown domain",
      "Domain not in trusted retailer list",
      "No valid extracted price", // user has manual cost OR explicitly trusts this
    ]);
    const remaining = reasons.filter((r) => !bypassable.has(r));
    return { passed: remaining.length === 0, reasons: remaining, bypassedByTrust: remaining.length === 0 && reasons.length > 0 };
  }

  return { passed: reasons.length === 0, reasons };
}

export function pickBestCandidate(
  candidates: Candidate[],
  id: IdentityForScoring = {},
  gate: BestCandidateGate = DEFAULT_GATE,
  trust: TrustContext = EMPTY_TRUST_CONTEXT,
): Candidate | null {
  const eligible = candidates.filter((c) => evaluateGate(c, id, gate, trust).passed);
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => candidateRankScore(b, id, trust) - candidateRankScore(a, id, trust))[0];
}

// ─── CSV helper ───
export function toCSV(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => escape(r[h])).join(","));
  return lines.join("\n");
}

export function downloadCSV(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

export interface QABatch {
  id: string;
  name: string | null;
  total_asins: number;
  completed_asins: number;
  status: string;
  created_at: string;
}

// Status filter buckets for candidate table
export type StatusFilter =
  | "all"
  | "extracted"
  | "blocked"
  | "unresolved"
  | "invalid"
  | "needs_review";

export function classifyCandidate(c: Candidate): Exclude<StatusFilter, "all"> | "pending" {
  if (c.needs_review) return "needs_review";
  if (c.current_price != null && c.current_price > 0 && c.final_resolution === "price_extracted") return "extracted";
  if (!c.final_resolution && !c.extracted_at) return "pending";
  const fr = c.final_resolution || "";
  if (fr.startsWith("blocked_") || fr === "phase2_timeout" || fr === "phase2_render_failed") return "blocked";
  if (fr === "non_product_page") return "invalid";
  return "unresolved";
}

export function MatchScoreBadge({ score }: { score: number }) {
  let cls = "bg-rose-500/15 text-rose-300 border-rose-500/30";
  let label = "Weak";
  if (score >= 70) { cls = "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"; label = "Strong"; }
  else if (score >= 40) { cls = "bg-sky-500/15 text-sky-300 border-sky-500/30"; label = "Good"; }
  else if (score >= 20) { cls = "bg-muted text-foreground border-border"; label = "Fair"; }
  return <Badge variant="outline" className={cls}>{label} · {score}</Badge>;
}

export function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "good" | "bad" | "ai" }) {
  const cls = tone === "good" ? "text-emerald-400"
    : tone === "bad" ? "text-rose-400"
    : tone === "ai" ? "text-amber-400"
    : "text-white";
  return (
    <div>
      <div className={`text-xl font-semibold ${cls}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

// ─── Freshness ───
export type Freshness = "fresh" | "cached" | "stale" | "unknown";

export function freshnessOf(iso: string | null | undefined): Freshness {
  if (!iso) return "unknown";
  const ageMs = Date.now() - new Date(iso).getTime();
  const hours = ageMs / 3_600_000;
  if (hours < 6) return "fresh";
  if (hours < 48) return "cached";
  return "stale";
}

export function freshnessLabel(f: Freshness): { label: string; tone: Tone } {
  switch (f) {
    case "fresh": return { label: "Fresh", tone: "good" };
    case "cached": return { label: "Cached", tone: "ok" };
    case "stale": return { label: "Stale", tone: "ai" };
    default: return { label: "Unchecked", tone: "ai" };
  }
}

// ─── Run quality badge ───
export type QualityBadge = "strong" | "mixed" | "review_needed" | "empty";

export function computeQualityBadge(run: DiscoveryRun, candidates?: Candidate[]): QualityBadge {
  const total = run.total_candidates || 0;
  if (total === 0) return "empty";
  const extracted = run.extracted_count || 0;
  const blocked = run.blocked_count || 0;
  const review = run.needs_review_count || 0;
  const blockedRate = total > 0 ? blocked / total : 0;
  const extractedRate = total > 0 ? extracted / total : 0;
  const reviewRate = extracted > 0 ? review / extracted : 0;

  let avgConf: number | null = null;
  if (candidates && candidates.length > 0) {
    const ext = candidates.filter(
      (c) => c.current_price != null && c.current_price > 0 && c.final_resolution === "price_extracted"
    );
    if (ext.length > 0) {
      avgConf = ext.reduce((a, c) => a + (c.confidence_score ?? 0), 0) / ext.length;
    }
  }

  if (extracted >= 2 && extractedRate >= 0.2 && blockedRate < 0.6 && (avgConf == null || avgConf >= 0.6) && reviewRate < 0.5) {
    return "strong";
  }
  if (extracted === 0 || (blockedRate >= 0.7 && extracted < 2)) return "review_needed";
  if (review > 0 || (avgConf != null && avgConf < 0.5) || extractedRate < 0.1) return "review_needed";
  return "mixed";
}

export function qualityBadgeMeta(b: QualityBadge): { label: string; tone: Tone } {
  switch (b) {
    case "strong": return { label: "Strong", tone: "good" };
    case "mixed": return { label: "Mixed", tone: "ok" };
    case "review_needed": return { label: "Review needed", tone: "ai" };
    case "empty": return { label: "No candidates", tone: "bad" };
  }
}

// ─── Best candidate context warnings ───
export interface BestContextWarning {
  kind: "low_confidence" | "suspicious_margin" | "blocked_only" | "match_penalty" | "membership" | "untrusted_domain";
  label: string;
  tone: Tone;
}

export function bestCandidateWarnings(
  best: Candidate | null,
  amazonPrice: number | null,
  candidates: Candidate[],
  identity: IdentityForScoring = {},
): BestContextWarning[] {
  if (!best) return [];
  const out: BestContextWarning[] = [];
  if (best.confidence_score != null && best.confidence_score < 0.5) {
    out.push({ kind: "low_confidence", label: "Best candidate has low confidence — verify manually", tone: "ai" });
  }
  const m = computeMargin(best.current_price, amazonPrice, best.confidence_score);
  if (m.marginPct != null && m.marginPct >= 70) {
    out.push({ kind: "suspicious_margin", label: "Margin unusually high — may indicate product mismatch", tone: "ai" });
  }

  // Surface specific match penalties so the user knows WHY it's risky
  const id = { ...identity, amazonPrice: identity.amazonPrice ?? amazonPrice };
  const penalties = matchPenalties(best, id);
  for (const p of penalties) {
    if (p.kind === "membership") {
      out.push({ kind: "membership", label: p.label, tone: "ai" });
    } else if (p.kind === "low_tier") {
      out.push({ kind: "untrusted_domain", label: p.label, tone: "bad" });
    } else {
      out.push({ kind: "match_penalty", label: p.label, tone: "ai" });
    }
  }

  const extracted = candidates.filter(
    (c) => c.current_price != null && c.current_price > 0 && c.final_resolution === "price_extracted"
  );
  const blockedLike = candidates.filter((c) => {
    const fr = c.final_resolution || "";
    return fr.startsWith("blocked_") || fr === "phase2_timeout" || fr === "phase2_render_failed";
  });
  if (extracted.length <= 1 && blockedLike.length >= 3) {
    out.push({ kind: "blocked_only", label: "Best because most others were blocked — explore alternatives carefully", tone: "ai" });
  }
  return out;
}

// Group rejection reasons into a stable category so we can count across candidates
// without losing the actual numeric values that explain the rule.
function rejectionCategory(reason: string): string {
  if (reason.startsWith("Match score")) return "match_score";
  if (reason.startsWith("Confidence")) return "confidence";
  if (reason.startsWith("Margin") && reason.includes("suspicious")) return "margin_high";
  if (reason.startsWith("Margin") && reason.includes("loss")) return "margin_low";
  if (reason === "No valid extracted price") return "no_price";
  if (reason === "Social / unknown domain") return "social";
  if (reason === "Membership-only pricing") return "membership";
  if (reason === "Domain not in trusted retailer list") return "untrusted";
  return reason;
}

function categoryLabel(cat: string, gate: BestCandidateGate): string {
  switch (cat) {
    case "match_score":
      return `Match score below minimum (${gate.minMatchScore})`;
    case "confidence":
      return `Confidence below minimum (${Math.round(gate.minConfidence * 100)}%)`;
    case "margin_high":
      return `Margin too high — likely product mismatch (>${gate.maxMarginPct}%)`;
    case "margin_low":
      return `Margin too low / loss (<${gate.minMarginPct}%)`;
    case "no_price":
      return "No valid extracted price";
    case "social":
      return "Social / unknown domain";
    case "membership":
      return "Membership-only pricing (Costco, Sam's, BJ's)";
    case "untrusted":
      return "Domain not in trusted retailer list";
    default:
      return cat;
  }
}

// Reason text for "no reliable source" empty state — top failure causes across candidates
export function noReliableSourceReasons(
  candidates: Candidate[],
  identity: IdentityForScoring,
  gate: BestCandidateGate,
  trust: TrustContext = EMPTY_TRUST_CONTEXT,
): string[] {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const r = evaluateGate(c, identity, gate, trust);
    if (r.passed) continue;
    for (const reason of r.reasons) {
      const cat = rejectionCategory(reason);
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([cat, n]) => `${categoryLabel(cat, gate)} — ${n} ${n === 1 ? "candidate" : "candidates"}`);
}

// Suggested next actions when no candidate passes the gate
export function noReliableSourceSuggestions(
  candidates: Candidate[],
  identity: IdentityForScoring,
  gate: BestCandidateGate,
  trust: TrustContext = EMPTY_TRUST_CONTEXT,
): string[] {
  const cats = new Set<string>();
  for (const c of candidates) {
    const r = evaluateGate(c, identity, gate, trust);
    if (r.passed) continue;
    for (const reason of r.reasons) cats.add(rejectionCategory(reason));
  }
  const out: string[] = [];
  if (cats.has("match_score")) out.push(`Lower the minimum match score (currently ${gate.minMatchScore})`);
  if (cats.has("confidence")) out.push(`Lower the minimum confidence (currently ${Math.round(gate.minConfidence * 100)}%)`);
  if (cats.has("untrusted") || cats.has("membership")) {
    out.push("Mark a known supplier as Trusted (e.g. costco.com) — trusted sources bypass these blocks");
  }
  if (cats.has("margin_high")) out.push("Set a manual cost on the row that matches your real buy price");
  if (cats.has("no_price")) out.push("Use \"Retry blocked\" to try extracting prices again");
  return out.slice(0, 4);
}

// ─── Run-to-run comparison ───
export interface RunDiff {
  bestChanged: boolean;
  prevBestUrl: string | null;
  newBestUrl: string | null;
  prevTopPrice: number | null;
  newTopPrice: number | null;
  topPriceDelta: number | null;
  newDomains: string[];
  lostDomains: string[];
  newlyBlockedDomains: string[];
  newlyWorkingDomains: string[];
}

interface RunCandSet { run: DiscoveryRun; candidates: Candidate[]; }

export function diffRuns(prev: RunCandSet | null, curr: RunCandSet | null): RunDiff | null {
  if (!prev || !curr) return null;
  const prevDomains = new Set(prev.candidates.map((c) => c.domain).filter(Boolean) as string[]);
  const currDomains = new Set(curr.candidates.map((c) => c.domain).filter(Boolean) as string[]);

  const blockedSet = (cands: Candidate[]) => new Set(
    cands.filter((c) => {
      const fr = c.final_resolution || "";
      return fr.startsWith("blocked_") || fr === "phase2_timeout" || fr === "phase2_render_failed";
    }).map((c) => c.domain).filter(Boolean) as string[]
  );
  const workingSet = (cands: Candidate[]) => new Set(
    cands.filter((c) => c.current_price != null && c.current_price > 0 && c.final_resolution === "price_extracted")
      .map((c) => c.domain).filter(Boolean) as string[]
  );

  const prevBlocked = blockedSet(prev.candidates);
  const currBlocked = blockedSet(curr.candidates);
  const prevWorking = workingSet(prev.candidates);
  const currWorking = workingSet(curr.candidates);

  const prevTopPrice = prev.run.top_valid_price ?? null;
  const newTopPrice = curr.run.top_valid_price ?? null;
  const prevBestUrl = prev.run.top_valid_url ?? null;
  const newBestUrl = curr.run.top_valid_url ?? null;

  return {
    bestChanged: prevBestUrl !== newBestUrl,
    prevBestUrl, newBestUrl,
    prevTopPrice, newTopPrice,
    topPriceDelta: prevTopPrice != null && newTopPrice != null ? newTopPrice - prevTopPrice : null,
    newDomains: Array.from(currDomains).filter((d) => !prevDomains.has(d)),
    lostDomains: Array.from(prevDomains).filter((d) => !currDomains.has(d)),
    newlyBlockedDomains: Array.from(currBlocked).filter((d) => prevWorking.has(d) && !prevBlocked.has(d)),
    newlyWorkingDomains: Array.from(currWorking).filter((d) => prevBlocked.has(d) && !prevWorking.has(d)),
  };
}

// ─── Domain insights aggregator (extended) ───
export interface DomainAggExt {
  domain: string;
  total: number;
  blocked: number;
  unresolved: number;
  valid: number;
  needsReview: number;
}

export function aggregateDomains(candidates: Candidate[]): DomainAggExt[] {
  const map = new Map<string, DomainAggExt>();
  for (const c of candidates) {
    const d = c.domain || "unknown";
    const cur = map.get(d) || { domain: d, total: 0, blocked: 0, unresolved: 0, valid: 0, needsReview: 0 };
    cur.total++;
    const fr = c.final_resolution || "";
    if (fr.startsWith("blocked_") || fr === "phase2_timeout" || fr === "phase2_render_failed") cur.blocked++;
    else if (fr === "price_extracted" && (c.current_price || 0) > 0) cur.valid++;
    else if (c.extracted_at) cur.unresolved++;
    if (c.needs_review) cur.needsReview++;
    map.set(d, cur);
  }
  return Array.from(map.values());
}
