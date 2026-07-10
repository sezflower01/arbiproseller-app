// Image similarity helper for the verify-store-scan-match function.
//
// Two-stage hybrid:
//   1. Perceptual hash (pHash, 8x8 DCT-lite via average-hash) — free + fast.
//      Detects near-duplicate front-art (Funko boxes, packaging, blister packs).
//   2. AI vision fallback (Gemini multimodal) — only when pHash is in a
//      borderline band (similarity 0.45–0.78). The model is asked a single
//      question and returns a structured verdict via tool calling.
//
// Designed to be a SUPPORTING signal: callers should boost / demote confidence
// but NEVER drive the final verdict on image alone.

const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const VISION_MODEL = "google/gemini-3-flash-preview";

// In-memory cache (per-isolate) — one entry per (urlA, urlB) pair, ~30min TTL.
const compareCache = new Map<string, { at: number; data: ImageCompareResult }>();
const TTL_MS = 30 * 60 * 1000;

// Per-image hash cache so we never re-fetch the same supplier/Amazon image.
const hashCache = new Map<string, { at: number; hash: string | null }>();
const HASH_TTL_MS = 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 7000;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB cap per image

export interface ImageCompareResult {
  /** 0–1 — overall image similarity used by callers. */
  similarity: number;
  /** Verdict bucket (callers map to confidence boost). */
  verdict: "strong_match" | "likely_match" | "uncertain" | "likely_different" | "different" | "unavailable";
  /** Cheap pHash similarity (0–1) when computable, else null. */
  phash_similarity: number | null;
  /** AI vision verdict (only set when AI fallback ran). */
  ai_verdict: "same_product" | "same_franchise_diff_item" | "different_product" | null;
  /** AI confidence 0–100 (only set when AI fallback ran). */
  ai_confidence: number | null;
  /** Short human reason (≤120 chars). */
  reason: string;
  /** Diagnostic flags for QA logs / UI badges. */
  flags: {
    used_ai: boolean;
    fetch_failed_supplier: boolean;
    fetch_failed_amazon: boolean;
    cached: boolean;
  };
}

const empty = (reason: string): ImageCompareResult => ({
  similarity: 0,
  verdict: "unavailable",
  phash_similarity: null,
  ai_verdict: null,
  ai_confidence: null,
  reason,
  flags: { used_ai: false, fetch_failed_supplier: false, fetch_failed_amazon: false, cached: false },
});

// ───────────────────────────── Perceptual hash ─────────────────────────────
// Average-hash variant: 8×8 grayscale, threshold = mean. Robust to small
// scaling, recompression, and borders. Produces a 64-bit hex string.
async function fetchImageBytes(url: string): Promise<Uint8Array | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ArbiSeller/1.0)" },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const ct = resp.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

// Decode an image to an 8×8 grayscale matrix using ImageData via OffscreenCanvas-like API.
// Deno does not ship a Canvas, so we use the WebCodecs ImageDecoder, which is available
// in modern V8 isolates. Falls back to null on unsupported formats.
async function decodeTo8x8Gray(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const ImageDecoderCtor = (globalThis as any).ImageDecoder;
    if (!ImageDecoderCtor) return null;
    const decoder = new ImageDecoderCtor({ data: bytes, type: mime });
    const result = await decoder.decode();
    const frame = result.image;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (!w || !h) return null;

    // Render to RGBA via copyTo into a Uint8ClampedArray
    const rgba = new Uint8ClampedArray(w * h * 4);
    await frame.copyTo(rgba, { format: "RGBA" });
    frame.close?.();

    // Downsample to 8×8 via box-average sampling
    const out = new Uint8Array(64);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const sx0 = Math.floor((x * w) / 8);
        const sx1 = Math.floor(((x + 1) * w) / 8);
        const sy0 = Math.floor((y * h) / 8);
        const sy1 = Math.floor(((y + 1) * h) / 8);
        let sum = 0;
        let n = 0;
        for (let yy = sy0; yy < sy1; yy++) {
          for (let xx = sx0; xx < sx1; xx++) {
            const idx = (yy * w + xx) * 4;
            // Luma (Rec. 601)
            const lum = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
            sum += lum;
            n++;
          }
        }
        out[y * 8 + x] = n > 0 ? Math.round(sum / n) : 0;
      }
    }
    return out;
  } catch {
    return null;
  }
}

function aHash(gray: Uint8Array): string {
  let mean = 0;
  for (let i = 0; i < 64; i++) mean += gray[i];
  mean /= 64;
  let bits = "";
  for (let i = 0; i < 64; i++) bits += gray[i] >= mean ? "1" : "0";
  // Convert to 16-char hex
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    const xa = parseInt(a[i], 16);
    const xb = parseInt(b[i], 16);
    let x = xa ^ xb;
    while (x) { diff += x & 1; x >>>= 1; }
  }
  return diff;
}

async function hashImage(url: string): Promise<string | null> {
  const cached = hashCache.get(url);
  if (cached && Date.now() - cached.at < HASH_TTL_MS) return cached.hash;

  const bytes = await fetchImageBytes(url);
  if (!bytes) {
    hashCache.set(url, { at: Date.now(), hash: null });
    return null;
  }
  // Sniff mime from magic bytes (jpeg, png, webp, gif)
  let mime = "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) mime = "image/png";
  else if (bytes[0] === 0x47 && bytes[1] === 0x49) mime = "image/gif";
  else if (bytes[8] === 0x57 && bytes[9] === 0x45) mime = "image/webp";

  const gray = await decodeTo8x8Gray(bytes, mime);
  if (!gray) {
    hashCache.set(url, { at: Date.now(), hash: null });
    return null;
  }
  const hash = aHash(gray);
  hashCache.set(url, { at: Date.now(), hash });
  return hash;
}

// ───────────────────────────── AI vision compare ─────────────────────────────
async function aiVisionCompare(
  supplierUrl: string,
  amazonUrl: string,
  apiKey: string,
): Promise<{ verdict: "same_product" | "same_franchise_diff_item" | "different_product"; confidence: number; reason: string } | null> {
  try {
    const resp = await fetch(LOVABLE_AI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a product-identity image verifier for an arbitrage tool. Compare two product photos and decide whether they show the SAME PRODUCT (same SKU / box art / character / model). Reseller bundles, plastic protectors, and slight angle/lighting differences do NOT make products different. Different characters, editions, or color/variant DO. Respond ONLY via the compare_images tool.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Image 1 (supplier):" },
              { type: "image_url", image_url: { url: supplierUrl } },
              { type: "text", text: "Image 2 (Amazon listing):" },
              { type: "image_url", image_url: { url: amazonUrl } },
              { type: "text", text: "Same product?" },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "compare_images",
              description: "Return whether the two images depict the same product.",
              parameters: {
                type: "object",
                properties: {
                  verdict: {
                    type: "string",
                    enum: ["same_product", "same_franchise_diff_item", "different_product"],
                  },
                  confidence: { type: "integer", description: "0-100" },
                  reason: { type: "string", description: "≤120 chars" },
                },
                required: ["verdict", "confidence", "reason"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "compare_images" } },
      }),
    });

    if (!resp.ok) return null;
    const j = await resp.json();
    const call = j?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return null;
    const args = JSON.parse(call.function?.arguments ?? "{}");
    const verdict = args.verdict;
    if (verdict !== "same_product" && verdict !== "same_franchise_diff_item" && verdict !== "different_product") {
      return null;
    }
    return {
      verdict,
      confidence: Math.max(0, Math.min(100, parseInt(String(args.confidence ?? 0), 10))),
      reason: String(args.reason ?? "").slice(0, 120),
    };
  } catch {
    return null;
  }
}

// ───────────────────────────── Public API ─────────────────────────────
/**
 * Compare a supplier image vs an Amazon image.
 *
 * @param supplierUrl  Direct URL to the supplier product image.
 * @param amazonUrl    Direct URL to the Amazon main image.
 * @param apiKey       LOVABLE_API_KEY (used only when AI fallback fires).
 * @param opts.useAi   When true (default), run the AI fallback for borderline
 *                     pHash scores. Set false to limit to free pHash only.
 */
export async function compareImages(
  supplierUrl: string | null | undefined,
  amazonUrl: string | null | undefined,
  apiKey: string,
  opts: { useAi?: boolean } = {},
): Promise<ImageCompareResult> {
  if (!supplierUrl || !amazonUrl) return empty("missing_url");

  const cacheKey = `${supplierUrl}::${amazonUrl}`;
  const cached = compareCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { ...cached.data, flags: { ...cached.data.flags, cached: true } };
  }

  const useAi = opts.useAi !== false;

  const [hashA, hashB] = await Promise.all([hashImage(supplierUrl), hashImage(amazonUrl)]);
  const fetchFailedSup = hashA === null;
  const fetchFailedAmz = hashB === null;

  let phashSim: number | null = null;
  if (hashA && hashB) {
    const dist = hammingHex(hashA, hashB);
    phashSim = 1 - dist / 64;
  }

  // Decision bands for pHash
  let result: ImageCompareResult;
  if (phashSim !== null) {
    if (phashSim >= 0.86) {
      result = {
        similarity: phashSim,
        verdict: "strong_match",
        phash_similarity: phashSim,
        ai_verdict: null,
        ai_confidence: null,
        reason: `Near-identical box art (pHash ${Math.round(phashSim * 100)}%)`,
        flags: { used_ai: false, fetch_failed_supplier: false, fetch_failed_amazon: false, cached: false },
      };
    } else if (phashSim <= 0.35) {
      result = {
        similarity: phashSim,
        verdict: "different",
        phash_similarity: phashSim,
        ai_verdict: null,
        ai_confidence: null,
        reason: `Images differ strongly (pHash ${Math.round(phashSim * 100)}%)`,
        flags: { used_ai: false, fetch_failed_supplier: false, fetch_failed_amazon: false, cached: false },
      };
    } else if (useAi) {
      // Borderline — call AI vision
      const ai = await aiVisionCompare(supplierUrl, amazonUrl, apiKey);
      if (!ai) {
        // AI failed: fall back to pHash midpoint verdict
        result = {
          similarity: phashSim,
          verdict: phashSim >= 0.6 ? "likely_match" : "uncertain",
          phash_similarity: phashSim,
          ai_verdict: null,
          ai_confidence: null,
          reason: `pHash ${Math.round(phashSim * 100)}% (AI unavailable)`,
          flags: { used_ai: false, fetch_failed_supplier: false, fetch_failed_amazon: false, cached: false },
        };
      } else {
        // Blend: AI verdict drives, pHash informs similarity score
        let verdict: ImageCompareResult["verdict"];
        let blended = phashSim;
        if (ai.verdict === "same_product") {
          verdict = ai.confidence >= 80 ? "strong_match" : "likely_match";
          blended = Math.max(phashSim, 0.7 + (ai.confidence - 80) / 200); // 0.6–0.8 range
        } else if (ai.verdict === "same_franchise_diff_item") {
          verdict = "likely_different";
          blended = Math.min(phashSim, 0.45);
        } else {
          verdict = "different";
          blended = Math.min(phashSim, 0.25);
        }
        result = {
          similarity: blended,
          verdict,
          phash_similarity: phashSim,
          ai_verdict: ai.verdict,
          ai_confidence: ai.confidence,
          reason: ai.reason,
          flags: { used_ai: true, fetch_failed_supplier: false, fetch_failed_amazon: false, cached: false },
        };
      }
    } else {
      result = {
        similarity: phashSim,
        verdict: phashSim >= 0.6 ? "likely_match" : "uncertain",
        phash_similarity: phashSim,
        ai_verdict: null,
        ai_confidence: null,
        reason: `pHash ${Math.round(phashSim * 100)}%`,
        flags: { used_ai: false, fetch_failed_supplier: false, fetch_failed_amazon: false, cached: false },
      };
    }
  } else {
    result = {
      ...empty(fetchFailedSup && fetchFailedAmz ? "both_images_unavailable" : fetchFailedSup ? "supplier_image_unavailable" : "amazon_image_unavailable"),
      flags: {
        used_ai: false,
        fetch_failed_supplier: fetchFailedSup,
        fetch_failed_amazon: fetchFailedAmz,
        cached: false,
      },
    };
  }

  compareCache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}
