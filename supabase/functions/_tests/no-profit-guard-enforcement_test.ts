// Guard test: Profit Guard is definitively removed from all pricing paths.
// If any of these files reintroduces profit-guard enforcement or imports
// the display-only ROI helper, this test fails.
//
// Policy: manual min_price_override is the sole authoritative price floor.
// See mem://strategy/repricer/manual-min-only-v1

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const PRICING_PATH_FILES = [
  "supabase/functions/repricer-ai-evaluate/index.ts",
  "supabase/functions/repricer-evaluate/index.ts",
  "supabase/functions/repricer-unified-dispatch/index.ts",
  "supabase/functions/repricer-scheduler/index.ts",
];

// Substrings that would indicate re-enabled enforcement.
// (Trace-only mentions inside comments are allowed; the test targets
// live code shapes that could cause a clamp or block.)
const FORBIDDEN_SHAPES: RegExp[] = [
  /hardProfitFloor\s*=\s*profitGuard/,          // reintroducing hard floor from context
  /blockedByProfitGuard\s*=\s*true/,            // any live assignment to true
  /constraint\s*===\s*['"]profit_guard['"]/,    // dispatch cooldown branch
  /action_type\s*:\s*['"]blocked_by_profit_guard['"]/, // scheduler write
  /from\s+['"].*_shared\/roi-display['"]/,      // pricing path importing display helper
];

for (const file of PRICING_PATH_FILES) {
  Deno.test(`no profit-guard enforcement in ${file}`, async () => {
    let src = "";
    try {
      src = await Deno.readTextFile(file);
    } catch (e) {
      // If a file is renamed later, fail loudly so someone updates this test.
      throw new Error(`Guard test could not read ${file}: ${(e as Error).message}`);
    }
    for (const pattern of FORBIDDEN_SHAPES) {
      const match = src.match(pattern);
      assert(
        !match,
        `Forbidden Profit Guard shape reintroduced in ${file}: ${pattern} matched "${match?.[0]}"`,
      );
    }
  });
}
