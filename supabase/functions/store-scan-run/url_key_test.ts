// Unit tests for the deterministic URL key canonicalizer + rescan diff
// behavior. Run with: deno test --allow-net --allow-env
//
// These tests purposely avoid hitting Supabase. They validate that
// normalizeUrlKey produces stable output across the kinds of drift that
// were causing rescans to flag every product as NEW (host casing,
// trailing slashes, tracking params, query-param order).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Mirror of normalizeUrlKey from store-scan-run/index.ts. Keep in sync.
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "ref", "ref_", "tag", "linkCode", "psc", "gclid", "fbclid", "afid",
  "ascsubtag", "source", "lnk", "clkid", "trkid", "preselect",
  "sid", "scid", "sscid", "cm_mmc", "cm_sp", "icid", "intcmp",
  "mc_cid", "mc_eid", "mkt_tok", "_branch_match_id", "_ga", "_gl",
  "yclid", "msclkid", "dclid", "igshid", "spm", "pf_rd_p", "pf_rd_r",
  "pd_rd_w", "pd_rd_wg", "pd_rd_r", "pd_rd_i", "th", "qid", "sr",
];
function normalizeUrlKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    const entries = [...u.searchParams.entries()].sort(([ak, av], [bk, bv]) => {
      if (ak === bk) return av.localeCompare(bv);
      return ak.localeCompare(bk);
    });
    const search = entries.length > 0
      ? `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`
      : "";
    let path = (u.pathname || "/").replace(/\/+$/g, "");
    if (!path) path = "/";
    const host = u.host.toLowerCase().replace(/^www\./, "");
    return `${host}${path}${search}`;
  } catch {
    return String(raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/#.*$/, "")
      .replace(/\/+$/g, "");
  }
}

Deno.test("normalizeUrlKey: host casing is normalized", () => {
  assertEquals(
    normalizeUrlKey("https://CulinaryDepotInc.com/p/timer-12345"),
    normalizeUrlKey("https://culinarydepotinc.com/p/timer-12345"),
  );
});

Deno.test("normalizeUrlKey: www. is stripped", () => {
  assertEquals(
    normalizeUrlKey("https://www.culinarydepotinc.com/p/timer-12345"),
    normalizeUrlKey("https://culinarydepotinc.com/p/timer-12345"),
  );
});

Deno.test("normalizeUrlKey: trailing slashes are stripped", () => {
  assertEquals(
    normalizeUrlKey("https://culinarydepotinc.com/p/timer-12345/"),
    normalizeUrlKey("https://culinarydepotinc.com/p/timer-12345"),
  );
  assertEquals(
    normalizeUrlKey("https://culinarydepotinc.com/p/timer-12345///"),
    normalizeUrlKey("https://culinarydepotinc.com/p/timer-12345"),
  );
});

Deno.test("normalizeUrlKey: tracking params are stripped", () => {
  assertEquals(
    normalizeUrlKey("https://culinarydepotinc.com/p/timer-12345?utm_source=google&gclid=abc&ref=foo"),
    normalizeUrlKey("https://culinarydepotinc.com/p/timer-12345"),
  );
});

Deno.test("normalizeUrlKey: query params are sorted deterministically", () => {
  assertEquals(
    normalizeUrlKey("https://culinarydepotinc.com/p/timer?color=red&size=large"),
    normalizeUrlKey("https://culinarydepotinc.com/p/timer?size=large&color=red"),
  );
});

Deno.test("normalizeUrlKey: hash is stripped", () => {
  assertEquals(
    normalizeUrlKey("https://culinarydepotinc.com/p/timer-12345#reviews"),
    normalizeUrlKey("https://culinarydepotinc.com/p/timer-12345"),
  );
});

Deno.test("normalizeUrlKey: real Walmart-style drift collapses to one key", () => {
  // Note: unknown query params (e.g. wmlspartner) are preserved by design —
  // product_id matching is the backstop for those cases. We only assert that
  // host casing, www, trailing slash, hash, and known tracking params drift away.
  const variants = [
    "https://www.walmart.com/ip/Some-Timer/123456789",
    "https://walmart.com/ip/Some-Timer/123456789/",
    "https://WALMART.com/ip/Some-Timer/123456789?utm_source=email&gclid=xyz",
    "https://www.walmart.com/ip/Some-Timer/123456789#description",
  ];
  const keys = variants.map(normalizeUrlKey);
  for (let i = 1; i < keys.length; i++) {
    assertEquals(keys[i], keys[0], `variant ${i} drifted: ${variants[i]}`);
  }
});

// ──────────────────────────────────────────────────────────────────
// Rescan diff behavior — validates the carry-over + is_new logic
// using the same Map<string, PriorRow> shape used by runCrawlPhase.
// ──────────────────────────────────────────────────────────────────

type PriorRow = {
  url_key: string | null;
  product_id: string | null;
  matched_asin: string | null;
  amz_title: string | null;
  amz_price: number | null;
  roi: number | null;
  margin_pct: number | null;
  status: string | null;
  created_at: string;
};

function buildPriorMap(rows: PriorRow[]): Map<string, PriorRow> {
  const map = new Map<string, PriorRow>();
  for (const r of rows) {
    if (r.url_key) map.set(`k:${r.url_key}`, r);
    if (r.product_id) map.set(`p:${r.product_id}`, r);
  }
  return map;
}

function diffCard(
  card: { url_key: string; product_id: string | null },
  prior: Map<string, PriorRow>,
): { is_new: boolean; carried_over: boolean; carried_asin: string | null } {
  const p = prior.get(`k:${card.url_key}`) ?? (card.product_id ? prior.get(`p:${card.product_id}`) : undefined);
  return {
    is_new: !p,
    carried_over: !!(p && p.matched_asin),
    carried_asin: p?.matched_asin ?? null,
  };
}

Deno.test("rescan: known url_key is NOT flagged as new", () => {
  const prior = buildPriorMap([{
    url_key: "culinarydepotinc.com/p/timer-12345",
    product_id: null,
    matched_asin: "B0ABCDE123",
    amz_title: "Generic Timer",
    amz_price: 19.99,
    roi: 35,
    margin_pct: 22,
    status: "matched",
    created_at: "2026-04-19T15:00:00Z",
  }]);
  const result = diffCard(
    { url_key: "culinarydepotinc.com/p/timer-12345", product_id: null },
    prior,
  );
  assertEquals(result.is_new, false);
  assertEquals(result.carried_over, true);
  assertEquals(result.carried_asin, "B0ABCDE123");
});

Deno.test("rescan: brand-new url_key IS flagged as new", () => {
  const prior = buildPriorMap([{
    url_key: "culinarydepotinc.com/p/timer-old",
    product_id: null,
    matched_asin: null,
    amz_title: null,
    amz_price: null,
    roi: null,
    margin_pct: null,
    status: "pending",
    created_at: "2026-04-19T15:00:00Z",
  }]);
  const result = diffCard(
    { url_key: "culinarydepotinc.com/p/timer-brand-new", product_id: null },
    prior,
  );
  assertEquals(result.is_new, true);
  assertEquals(result.carried_over, false);
});

Deno.test("rescan: known product_id matches even if url_key drifted", () => {
  const prior = buildPriorMap([{
    url_key: "old.example.com/p/timer-A-12345",
    product_id: "target:A-12345",
    matched_asin: "B0XYZ",
    amz_title: "Timer X",
    amz_price: 25,
    roi: 40,
    margin_pct: 20,
    status: "matched",
    created_at: "2026-04-19T15:00:00Z",
  }]);
  const result = diffCard(
    // url_key changed but the supplier product_id is still the same
    { url_key: "example.com/p/different-slug-A-12345", product_id: "target:A-12345" },
    prior,
  );
  assertEquals(result.is_new, false);
  assertEquals(result.carried_over, true);
  assertEquals(result.carried_asin, "B0XYZ");
});

// ──────────────────────────────────────────────────────────────────
// Zero-extraction safeguard logic
// ──────────────────────────────────────────────────────────────────

function shouldPreservePriorRows(found: number, extracted: number, matched: number): boolean {
  return extracted === 0 && matched === 0;
}

Deno.test("safeguard: rescan with zero extraction preserves prior rows", () => {
  assertEquals(shouldPreservePriorRows(8, 0, 0), true);
  assertEquals(shouldPreservePriorRows(0, 0, 0), true);
});

Deno.test("safeguard: successful rescan allows cleanup", () => {
  assertEquals(shouldPreservePriorRows(8, 8, 6), false);
  assertEquals(shouldPreservePriorRows(8, 8, 0), false);
  assertEquals(shouldPreservePriorRows(8, 4, 0), false);
});
