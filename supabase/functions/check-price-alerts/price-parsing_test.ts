// Unit tests for currentAmazonPrice() in check-price-alerts/index.ts.
// Mirrored verbatim (not imported) — index.ts calls Deno.serve(...) at
// module scope, same reason as mobile-scan-price-history's test file.
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

function currentAmazonPrice(csv: (number[] | null)[] | undefined): number | null {
  const series = csv?.[0];
  if (!Array.isArray(series) || series.length < 2) return null;
  for (let i = series.length - 2; i >= 0; i -= 2) {
    const v = series[i + 1];
    if (typeof v === 'number' && v >= 0) return v / 100;
  }
  return null;
}

Deno.test('currentAmazonPrice: takes the last [t, v] pair, converts cents to dollars', () => {
  const csv = [[1000, 1999, 2000, 2499]];
  assertEquals(currentAmazonPrice(csv), 24.99);
});

Deno.test('currentAmazonPrice: skips a trailing -1 (no-data) point and uses the last valid one', () => {
  const csv = [[1000, 1999, 2000, 2499, 3000, -1]];
  assertEquals(currentAmazonPrice(csv), 24.99);
});

Deno.test('currentAmazonPrice: all -1 (Amazon never on this listing) => null', () => {
  const csv = [[1000, -1, 2000, -1]];
  assertEquals(currentAmazonPrice(csv), null);
});

Deno.test('currentAmazonPrice: missing csv[0] entirely => null', () => {
  assertEquals(currentAmazonPrice(undefined), null);
  assertEquals(currentAmazonPrice([]), null);
  assertEquals(currentAmazonPrice([null]), null);
});

Deno.test('currentAmazonPrice: a single [t, v] pair still works', () => {
  const csv = [[1000, 500]];
  assertEquals(currentAmazonPrice(csv), 5.00);
});
