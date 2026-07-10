// Audit §14b guard — fails if any sales writer edge function reintroduces a
// hardcoded BRL/MXN/CAD FX literal outside the designated `getLiveCurrencyToUsd`
// fallback block. Hardcoded `BRL: 0.17` (stale by ~10%) caused BR FEC
// under-reporting before the live-FX patch landed.
//
// Memory: mem://infrastructure/edge-functions/no-hardcoded-fx-v1

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";

const SALES_WRITER_FUNCTIONS = [
  "sync-sales-orders",
  "fetch-live-orders",
  "reconcile-sales-with-fec",
  "backfill-promotional-discount",
  "_shared/live-sales-core.ts",
];

// Allow these substrings on the line (the official live-FX helper +
// its documented fallback defaults).
const ALLOW_MARKERS = [
  "getLiveCurrencyToUsd",
  "fx_rates",
  "// fallback",
  "/* fallback */",
  'inv("BRL"',
  'inv("MXN"',
  'inv("CAD"',
];

// Pattern matches BRL/MXN/CAD followed by a 0.NN literal (the exact shape of
// the legacy hardcoded `CURRENCY_TO_USD` map).
const BAD_LITERAL = /\b(BRL|MXN|CAD)\s*:\s*0\.\d+/;

async function findOffenders(): Promise<string[]> {
  const root = new URL("../../", import.meta.url).pathname;
  const offenders: string[] = [];
  for await (const entry of walk(root, { exts: [".ts"], includeDirs: false })) {
    const rel = entry.path.slice(root.length);
    if (!SALES_WRITER_FUNCTIONS.some((f) => rel.startsWith(f) || rel.includes(`/${f}/`))) continue;
    if (rel.includes("/_tests/")) continue;
    const text = await Deno.readTextFile(entry.path);
    text.split("\n").forEach((line, i) => {
      const trimmed = line.trim();
      // Skip comments — docstrings may legitimately mention the legacy literals.
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      if (!BAD_LITERAL.test(line)) return;
      if (ALLOW_MARKERS.some((m) => line.includes(m))) return;
      offenders.push(`${rel}:${i + 1}  ${trimmed}`);
    });
  }
  return offenders;
}

Deno.test("no hardcoded BRL/MXN/CAD FX literals in sales writers", async () => {
  const offenders = await findOffenders();
  assert(
    offenders.length === 0,
    `Hardcoded FX literal found in sales writer(s). Use getLiveCurrencyToUsd():\n${offenders.join("\n")}`,
  );
});
