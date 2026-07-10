// Supplier-side enrichment for verify-store-scan-match.
// Pulls any cached structured details from `extracted_product_data.raw_payload`
// (populated by earlier scrape passes) so the AI sees brand/bullets/identifiers
// instead of just the title.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface SupplierDetails {
  url: string;
  brand?: string | null;
  model?: string | null;
  pack_count?: number | null;
  unit_count?: number | null;
  size?: string | null;
  color?: string | null;
  flavor?: string | null;
  variant?: string | null;
  product_type?: string | null;
  identifiers?: { type: string; value: string }[];
  bullets?: string[];
}

const PACK_RE = /\b(\d{1,3})\s*[- ]?\s*(?:pack|pk|count|ct|pieces|pcs|bundle|set)\b/i;

const pickStr = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
};

function extractPackFromText(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = t.match(PACK_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 && n < 500 ? n : null;
}

function pickIdentifiers(payload: Record<string, unknown>): { type: string; value: string }[] {
  const out: { type: string; value: string }[] = [];
  for (const key of ["upc", "ean", "gtin", "isbn", "mpn", "model"]) {
    const v = pickStr(payload[key]);
    if (v) out.push({ type: key.toUpperCase(), value: v });
  }
  // Some scrapers nest under "identifiers"
  const ids = payload.identifiers;
  if (Array.isArray(ids)) {
    for (const i of ids) {
      const t = pickStr((i as Record<string, unknown>)?.type);
      const v = pickStr((i as Record<string, unknown>)?.value);
      if (t && v) out.push({ type: t.toUpperCase(), value: v });
    }
  }
  return out;
}

function pickBullets(payload: Record<string, unknown>): string[] {
  const candidates = [payload.bullets, payload.features, payload.feature_bullets, payload.description_bullets];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const arr = c.map((x) => pickStr(x)).filter((x): x is string => !!x).slice(0, 5);
      if (arr.length > 0) return arr;
    }
  }
  return [];
}

export async function fetchSupplierDetailsBatch(
  admin: SupabaseClient,
  urls: string[],
): Promise<Map<string, SupplierDetails>> {
  const out = new Map<string, SupplierDetails>();
  if (urls.length === 0) return out;

  const { data, error } = await admin
    .from("extracted_product_data")
    .select("url, raw_payload, variant")
    .in("url", urls);

  if (error) {
    console.warn("[verify] supplier details fetch failed:", error.message);
    return out;
  }

  for (const row of data ?? []) {
    const payload = ((row.raw_payload as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const variantStr = pickStr(row.variant);
    const titleHint = pickStr(payload.title);
    const sd: SupplierDetails = {
      url: row.url as string,
      brand: pickStr(payload.brand) ?? pickStr(payload.manufacturer),
      model: pickStr(payload.model) ?? pickStr(payload.model_number) ?? pickStr(payload.part_number),
      pack_count:
        typeof payload.pack_count === "number"
          ? (payload.pack_count as number)
          : extractPackFromText(pickStr(payload.pack_count) ?? titleHint ?? variantStr),
      unit_count: typeof payload.unit_count === "number" ? (payload.unit_count as number) : null,
      size: pickStr(payload.size) ?? pickStr(payload.dimensions),
      color: pickStr(payload.color),
      flavor: pickStr(payload.flavor) ?? pickStr(payload.scent),
      variant: variantStr,
      product_type: pickStr(payload.product_type) ?? pickStr(payload.category),
      identifiers: pickIdentifiers(payload),
      bullets: pickBullets(payload),
    };
    out.set(sd.url, sd);
  }

  return out;
}
