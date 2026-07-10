// Amazon Catalog Items API helper for the verify-store-scan-match function.
// Fetches structured product details (brand, model, identifiers, dimensions, bullets)
// for a list of ASINs and normalizes them for AI consumption.
//
// Uses SP-API LWA token refresh + AWS SigV4 signing identical to other functions.

import { createHmac } from "https://deno.land/std@0.177.0/node/crypto.ts";

const SPAPI_HOST = "sellingpartnerapi-na.amazon.com";
const MARKETPLACE_ID = "ATVPDKIKX0DER"; // US — verify is currently US-only
const REGION = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";

export interface AmazonDetails {
  asin: string;
  title?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  model_number?: string | null;
  part_number?: string | null;
  color?: string | null;
  size?: string | null;
  flavor?: string | null;
  scent?: string | null;
  item_form?: string | null;
  product_type?: string | null;
  pack_count?: number | null;
  unit_count?: number | null;
  unit_count_type?: string | null;
  item_dimensions?: string | null;
  item_weight?: string | null;
  identifiers?: { type: string; value: string }[];
  bullets?: string[];
  image_url?: string | null;
}

// In-memory cache (per-isolate), keyed by ASIN. ~30min TTL.
const memCache = new Map<string, { at: number; data: AmazonDetails }>();
const TTL_MS = 30 * 60 * 1000;

let tokenPromise: Promise<string> | null = null;
let tokenCachedAt = 0;
let cachedToken = "";

async function getLwaAccessToken(): Promise<string> {
  if (cachedToken && Date.now() - tokenCachedAt < 50 * 60 * 1000) return cachedToken;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const clientId = Deno.env.get("SPAPI_LWA_CLIENT_ID");
    const clientSecret = Deno.env.get("SPAPI_LWA_CLIENT_SECRET");
    const refreshToken = Deno.env.get("SPAPI_REFRESH_TOKEN");
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("SP-API LWA credentials missing");
    }
    const resp = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!resp.ok) throw new Error(`LWA token error ${resp.status}`);
    const j = await resp.json();
    cachedToken = j.access_token as string;
    tokenCachedAt = Date.now();
    return cachedToken;
  })();
  try {
    return await tokenPromise;
  } finally {
    tokenPromise = null;
  }
}

function hmacSha256(key: string | Uint8Array, data: string): Uint8Array {
  const h = createHmac("sha256", key as never);
  h.update(data);
  return new Uint8Array(h.digest());
}
function getSigningKey(key: string, dateStamp: string, region: string, service: string) {
  const kDate = hmacSha256(`AWS4${key}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}
async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function callCatalogItem(asin: string, accessToken: string): Promise<unknown> {
  const awsKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const awsSecret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  if (!awsKeyId || !awsSecret) throw new Error("AWS credentials missing");

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const path = `/catalog/2022-04-01/items/${asin}`;
  const qs = new URLSearchParams({
    marketplaceIds: MARKETPLACE_ID,
    includedData: "summaries,attributes,identifiers,images,productTypes",
  }).toString();
  const canonical = `GET\n${path}\n${qs}\nhost:${SPAPI_HOST}\nx-amz-date:${amzDate}\n\nhost;x-amz-date\n${await sha256Hex("")}`;
  const credScope = `${dateStamp}/${REGION}/execute-api/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credScope}\n${await sha256Hex(canonical)}`;
  const signingKey = getSigningKey(awsSecret, dateStamp, REGION, "execute-api");
  const sig = createHmac("sha256", signingKey as never);
  sig.update(stringToSign);
  const signature = sig.digest("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${awsKeyId}/${credScope}, SignedHeaders=host;x-amz-date, Signature=${signature}`;

  const url = `https://${SPAPI_HOST}${path}?${qs}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      host: SPAPI_HOST,
      "x-amz-date": amzDate,
      "x-amz-access-token": accessToken,
      Authorization: auth,
    },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`catalog_${resp.status}:${txt.slice(0, 160)}`);
  }
  return await resp.json();
}

const flatStr = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    if (first && typeof first === "object" && "value" in (first as Record<string, unknown>)) {
      const val = (first as Record<string, unknown>).value;
      return typeof val === "string" ? val.trim() || null : val != null ? String(val) : null;
    }
    return flatStr(first);
  }
  if (typeof v === "object" && v !== null && "value" in (v as Record<string, unknown>)) {
    return flatStr((v as Record<string, unknown>).value);
  }
  return null;
};

const toInt = (v: unknown): number | null => {
  const s = flatStr(v);
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function normalize(asin: string, raw: unknown): AmazonDetails {
  const r = (raw ?? {}) as Record<string, unknown>;
  const summaries = (r.summaries ?? []) as Array<Record<string, unknown>>;
  const summary = summaries[0] ?? {};
  const attrs = (r.attributes ?? {}) as Record<string, unknown>;
  const idGroups = (r.identifiers ?? []) as Array<Record<string, unknown>>;
  const images = (r.images ?? []) as Array<Record<string, unknown>>;
  const productTypes = (r.productTypes ?? []) as Array<Record<string, unknown>>;

  const identifiers: { type: string; value: string }[] = [];
  for (const grp of idGroups) {
    const list = (grp.identifiers ?? []) as Array<Record<string, unknown>>;
    for (const ii of list) {
      const t = String(ii.identifierType ?? "").toUpperCase();
      const v = String(ii.identifier ?? "").trim();
      if (t && v && /^(UPC|EAN|GTIN|ISBN|JAN|MPN)$/.test(t)) {
        identifiers.push({ type: t, value: v });
      }
    }
  }

  const bulletsAttr = (attrs.bullet_point ?? attrs.feature_bullets ?? []) as Array<Record<string, unknown>>;
  const bullets: string[] = [];
  for (const b of bulletsAttr) {
    const s = flatStr(b);
    if (s) bullets.push(s);
    if (bullets.length >= 5) break;
  }

  const dimsRaw = (attrs.item_dimensions ?? attrs.package_dimensions ?? []) as Array<Record<string, unknown>>;
  let item_dimensions: string | null = null;
  if (Array.isArray(dimsRaw) && dimsRaw.length > 0) {
    const d = dimsRaw[0] as Record<string, unknown>;
    const len = flatStr((d.length as Record<string, unknown>)?.value);
    const wid = flatStr((d.width as Record<string, unknown>)?.value);
    const hei = flatStr((d.height as Record<string, unknown>)?.value);
    const unit = flatStr((d.length as Record<string, unknown>)?.unit);
    if (len || wid || hei) item_dimensions = `${len ?? "?"} x ${wid ?? "?"} x ${hei ?? "?"} ${unit ?? ""}`.trim();
  }

  const weightRaw = (attrs.item_weight ?? []) as Array<Record<string, unknown>>;
  let item_weight: string | null = null;
  if (Array.isArray(weightRaw) && weightRaw.length > 0) {
    const w = weightRaw[0] as Record<string, unknown>;
    const v = flatStr(w.value);
    const u = flatStr(w.unit);
    if (v) item_weight = `${v} ${u ?? ""}`.trim();
  }

  let image_url: string | null = null;
  for (const grp of images) {
    const list = (grp.images ?? []) as Array<Record<string, unknown>>;
    if (list.length > 0) {
      const big = list.find((x) => Number(x.height ?? 0) >= 200) ?? list[0];
      image_url = String(big?.link ?? "") || null;
      break;
    }
  }

  return {
    asin,
    title: flatStr(summary.itemName) ?? flatStr(attrs.item_name),
    brand: flatStr(summary.brand) ?? flatStr(attrs.brand),
    manufacturer: flatStr(summary.manufacturer) ?? flatStr(attrs.manufacturer),
    model_number: flatStr(summary.modelNumber) ?? flatStr(attrs.model_number) ?? flatStr(attrs.model_name),
    part_number: flatStr(summary.partNumber) ?? flatStr(attrs.part_number),
    color: flatStr(summary.color) ?? flatStr(attrs.color),
    size: flatStr(summary.size) ?? flatStr(attrs.size),
    flavor: flatStr(attrs.flavor),
    scent: flatStr(attrs.scent),
    item_form: flatStr(attrs.item_form),
    product_type: flatStr(productTypes[0]?.productType) ?? flatStr(summary.itemClassification),
    pack_count: toInt(attrs.number_of_items) ?? toInt(attrs.item_package_quantity),
    unit_count: toInt((attrs.unit_count as Array<Record<string, unknown>>)?.[0]?.value),
    unit_count_type: flatStr((attrs.unit_count as Array<Record<string, unknown>>)?.[0]?.type),
    item_dimensions,
    item_weight,
    identifiers,
    bullets,
    image_url,
  };
}

export async function fetchAmazonDetailsBatch(asins: string[]): Promise<Map<string, AmazonDetails>> {
  const out = new Map<string, AmazonDetails>();
  const need: string[] = [];
  const now = Date.now();

  for (const a of asins) {
    const c = memCache.get(a);
    if (c && now - c.at < TTL_MS) out.set(a, c.data);
    else need.push(a);
  }
  if (need.length === 0) return out;

  let token = "";
  try {
    token = await getLwaAccessToken();
  } catch (e) {
    console.warn("[verify] LWA token fetch failed:", e instanceof Error ? e.message : String(e));
    return out; // fall back gracefully — AI will run with title only
  }

  // Tiny pool: 4 concurrent
  const queue = [...need];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(4, queue.length); i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const asin = queue.shift()!;
        try {
          const raw = await callCatalogItem(asin, token);
          const norm = normalize(asin, raw);
          memCache.set(asin, { at: Date.now(), data: norm });
          out.set(asin, norm);
        } catch (err) {
          console.warn(`[verify] catalog fetch failed for ${asin}:`, err instanceof Error ? err.message : String(err));
        }
      }
    })());
  }
  await Promise.all(workers);
  return out;
}
