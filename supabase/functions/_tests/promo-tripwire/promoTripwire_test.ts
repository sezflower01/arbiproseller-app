// Verifies the promo USD-safety tripwire only fires for non-US, non-zero promos.
// Marker contract: PROMO_NON_US_SO_DISCOUNT_DETECTED

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { maybeFirePromoTripwire } from '../../_shared/promo-tripwire.ts';

function withCapturedWarn(fn: () => void): string[] {
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return logs;
}

const base = {
  userId: 'u1',
  orderId: '701-1234567-1234567',
  asin: 'B000000001',
  sourceFunction: 'unit-test',
};

Deno.test('fires for CA promo > 0', () => {
  let fired = false;
  const logs = withCapturedWarn(() => {
    fired = maybeFirePromoTripwire({ ...base, marketplace: 'CA', promotionDiscount: 1.23, currency: 'CAD' });
  });
  assertEquals(fired, true);
  assertEquals(logs.some((l) => l.includes('PROMO_NON_US_SO_DISCOUNT_DETECTED')), true);
  assertEquals(logs.some((l) => l.includes('"marketplace":"CA"')), true);
});

Deno.test('fires for MX promo > 0', () => {
  let fired = false;
  withCapturedWarn(() => {
    fired = maybeFirePromoTripwire({ ...base, marketplace: 'mx', promotionDiscount: 50, currency: 'MXN' });
  });
  assertEquals(fired, true);
});

Deno.test('fires for BR promo > 0', () => {
  let fired = false;
  withCapturedWarn(() => {
    fired = maybeFirePromoTripwire({ ...base, marketplace: 'BR', promotionDiscount: 9.99, currency: 'BRL' });
  });
  assertEquals(fired, true);
});

Deno.test('does NOT fire for US promo > 0', () => {
  let fired = true;
  const logs = withCapturedWarn(() => {
    fired = maybeFirePromoTripwire({ ...base, marketplace: 'US', promotionDiscount: 2.5, currency: 'USD' });
  });
  assertEquals(fired, false);
  assertEquals(logs.length, 0);
});

Deno.test('does NOT fire for CA with zero promo', () => {
  let fired = true;
  const logs = withCapturedWarn(() => {
    fired = maybeFirePromoTripwire({ ...base, marketplace: 'CA', promotionDiscount: 0, currency: 'CAD' });
  });
  assertEquals(fired, false);
  assertEquals(logs.length, 0);
});

Deno.test('does NOT fire for missing marketplace', () => {
  let fired = true;
  withCapturedWarn(() => {
    fired = maybeFirePromoTripwire({ ...base, marketplace: null, promotionDiscount: 5, currency: 'CAD' });
  });
  assertEquals(fired, false);
});

Deno.test('does NOT fire for unknown marketplace code', () => {
  let fired = true;
  withCapturedWarn(() => {
    fired = maybeFirePromoTripwire({ ...base, marketplace: 'XX', promotionDiscount: 5, currency: 'XXX' });
  });
  assertEquals(fired, false);
});
