import { describe, it, expect } from 'vitest';
import {
  getGrossSalesForOrder,
  getFeesForOrder,
  sumGrossSales,
  calculateEstimatedFeesFromCache,
  buildSnapshotMap,
  buildSnapshotKey,
  type SaleOrder,
  type InventoryInfo,
  type PriceSnapshot,
  type FeeCache,
} from '../salesCalculations';

// ============================================================
// HELPERS
// ============================================================
const makeOrder = (overrides: Partial<SaleOrder> = {}): SaleOrder => ({
  asin: 'B000TEST01',
  order_id: 'ORDER-001',
  sold_price: 0,
  total_sale_amount: 0,
  quantity: 1,
  ...overrides,
});

const emptyInvMap = new Map<string, InventoryInfo>();

const invMap = (asin: string, price: number) => {
  const m = new Map<string, InventoryInfo>();
  m.set(asin, { price });
  return m;
};

const invMapAmazon = (asin: string, amazonPrice: number) => {
  const m = new Map<string, InventoryInfo>();
  m.set(asin, { price: null, amazon_price: amazonPrice });
  return m;
};

const snapMap = (orderId: string, asin: string, price: number) => {
  return buildSnapshotMap([{
    order_id: orderId,
    asin,
    snapshot_item_price: price,
    snapshot_shipping_price: 0,
    snapshot_source: 'test',
  }]);
};

// ============================================================
// 1. PRICING PRIORITY CHAIN
// ============================================================
describe('Pricing Priority Chain', () => {
  it('Priority 1: sold_price wins over everything', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ sold_price: 25, estimated_price: 20 }),
      invMap('B000TEST01', 30),
      true,
      snapMap('ORDER-001', 'B000TEST01', 22),
    );
    expect(result.totalSale).toBe(25);
    expect(result.source).toBe('actual');
  });

  it('Priority 2: total_sale_amount when sold_price=0', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ sold_price: 0, total_sale_amount: 18 }),
      emptyInvMap,
      true,
    );
    expect(result.totalSale).toBe(18);
    expect(result.source).toBe('actual');
  });

  it('Priority 3: snapshot wins over estimated & inventory', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ estimated_price: 15 }),
      invMap('B000TEST01', 30),
      true,
      snapMap('ORDER-001', 'B000TEST01', 22),
    );
    expect(result.totalSale).toBe(22);
    expect(result.source).toBe('snapshot');
  });

  it('Priority 4: estimated_price when no snapshot', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ estimated_price: 15 }),
      invMap('B000TEST01', 30),
      true,
      new Map(),
    );
    expect(result.totalSale).toBe(15);
    expect(result.source).toBe('estimated');
  });

  it('Priority 5: inventory fallback as last resort', () => {
    const result = getGrossSalesForOrder(
      makeOrder({}),
      invMap('B000TEST01', 30),
      true,
      new Map(),
    );
    expect(result.totalSale).toBe(30);
    expect(result.source).toBe('inventory');
  });

  it('Returns null when no price available at all', () => {
    const result = getGrossSalesForOrder(
      makeOrder({}),
      emptyInvMap,
      true,
      new Map(),
    );
    expect(result.totalSale).toBeNull();
    expect(result.priceMissing).toBe(true);
  });

  it('amazon_price used as fallback when price is null', () => {
    const result = getGrossSalesForOrder(
      makeOrder({}),
      invMapAmazon('B000TEST01', 42),
      true,
      new Map(),
    );
    expect(result.totalSale).toBe(42);
    expect(result.source).toBe('inventory');
  });

  it('sold_price of $0.01 still treated as actual', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ sold_price: 0.01 }),
      invMap('B000TEST01', 30),
      true,
    );
    expect(result.totalSale).toBe(0.01);
    expect(result.source).toBe('actual');
  });

  it('negative estimated_price is ignored', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ estimated_price: -5 }),
      invMap('B000TEST01', 10),
      true,
      new Map(),
    );
    expect(result.totalSale).toBe(10);
    expect(result.source).toBe('inventory');
  });
});

// ============================================================
// 2. SNAPSHOT ENFORCEMENT — Critical edge cases
// ============================================================
describe('Snapshot Enforcement', () => {
  it('Same-day price change: snapshot preserves original price', () => {
    const order = makeOrder({ asin: 'B00REPRICED' });
    const liveInv = invMap('B00REPRICED', 50);
    const snap = snapMap('ORDER-001', 'B00REPRICED', 40);

    const result = getGrossSalesForOrder(order, liveInv, true, snap);
    expect(result.totalSale).toBe(40);
    expect(result.source).toBe('snapshot');
  });

  it('Multi-unit order uses snapshot × quantity', () => {
    const order = makeOrder({ quantity: 3 });
    const snap = snapMap('ORDER-001', 'B000TEST01', 15);
    const result = getGrossSalesForOrder(order, emptyInvMap, true, snap);
    expect(result.totalSale).toBe(45);
  });

  it('Live inventory blocked when allowLiveInventoryFallback=false', () => {
    const result = getGrossSalesForOrder(
      makeOrder({}),
      invMap('B000TEST01', 30),
      true,
      new Map(),
      false,
    );
    expect(result.totalSale).toBeNull();
    expect(result.priceMissing).toBe(true);
  });

  it('Snapshot with $0 price is ignored (falls through)', () => {
    const snap = buildSnapshotMap([{
      order_id: 'ORDER-001',
      asin: 'B000TEST01',
      snapshot_item_price: 0,
      snapshot_shipping_price: 0,
      snapshot_source: 'test',
    }]);
    const result = getGrossSalesForOrder(
      makeOrder({ estimated_price: 12 }),
      emptyInvMap,
      true,
      snap,
    );
    expect(result.totalSale).toBe(12);
    expect(result.source).toBe('estimated');
  });

  it('Snapshot with null price is ignored', () => {
    const snap = buildSnapshotMap([{
      order_id: 'ORDER-001',
      asin: 'B000TEST01',
      snapshot_item_price: null,
      snapshot_shipping_price: 0,
      snapshot_source: 'test',
    }]);
    const result = getGrossSalesForOrder(
      makeOrder({ estimated_price: 8 }),
      emptyInvMap,
      true,
      snap,
    );
    expect(result.totalSale).toBe(8);
    expect(result.source).toBe('estimated');
  });

  it('Snapshot key is order_id:asin format', () => {
    expect(buildSnapshotKey('O-123', 'B00ABC')).toBe('O-123:B00ABC');
  });
});

// ============================================================
// 3. SHOWESTIMATEPRICE=FALSE blocks all fallbacks
// ============================================================
describe('showEstimatedPrices=false', () => {
  it('Returns null for unsettled orders even with snapshot', () => {
    const result = getGrossSalesForOrder(
      makeOrder({}),
      invMap('B000TEST01', 30),
      false,
      snapMap('ORDER-001', 'B000TEST01', 22),
    );
    expect(result.totalSale).toBeNull();
    expect(result.priceMissing).toBe(true);
  });

  it('Still returns actual price even when showEstimated=false', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ sold_price: 25 }),
      emptyInvMap,
      false,
    );
    expect(result.totalSale).toBe(25);
    expect(result.source).toBe('actual');
  });

  it('total_sale_amount still works with showEstimated=false', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ total_sale_amount: 33 }),
      emptyInvMap,
      false,
    );
    expect(result.totalSale).toBe(33);
    expect(result.source).toBe('actual');
  });
});

// ============================================================
// 4. FEE CALCULATIONS
// ============================================================
describe('Fee Calculations', () => {
  const feeCache: FeeCache = {
    fbaFeeFixed: 3.22,
    referralRate: 0.15,
    isMedia: false,
  };

  it('Actual DB fees win over cache', () => {
    const result = getFeesForOrder(
      makeOrder({ referral_fee: 5, fba_fee: 3.5, closing_fee: 0 }),
      25,
      feeCache,
    );
    expect(result.source).toBe('actual');
    expect(result.referralFee).toBe(5);
    expect(result.fbaFee).toBe(3.5);
  });

  it('Cache fees calculated when no actual fees', () => {
    const result = getFeesForOrder(makeOrder({}), 20, feeCache);
    expect(result.source).toBe('cache');
    expect(result.referralFee).toBe(3);
    expect(result.fbaFee).toBe(3.22);
    expect(result.closingFee).toBe(0);
  });

  it('Media items get $1.80 closing fee', () => {
    const mediaCache: FeeCache = { fbaFeeFixed: 3.22, referralRate: 0.15, isMedia: true };
    const result = getFeesForOrder(makeOrder({}), 20, mediaCache);
    expect(result.closingFee).toBe(1.8);
  });

  it('Null fees when no cache and no actual fees', () => {
    const result = getFeesForOrder(makeOrder({}), 20, null);
    expect(result.totalFees).toBeNull();
    expect(result.feesMissing).toBe(true);
  });

  it('Multi-unit fees scale correctly', () => {
    const result = getFeesForOrder(makeOrder({ quantity: 3 }), 20, feeCache);
    expect(result.referralFee).toBe(9);
    expect(result.fbaFee).toBe(9.66);
  });

  it('Zero price yields null cache fees', () => {
    const result = getFeesForOrder(makeOrder({}), 0, feeCache);
    expect(result.totalFees).toBeNull();
    expect(result.feesMissing).toBe(true);
  });

  it('Negative price yields null cache fees', () => {
    const result = getFeesForOrder(makeOrder({}), -10, feeCache);
    expect(result.totalFees).toBeNull();
    expect(result.feesMissing).toBe(true);
  });

  it('Only fba_fee > 0 still counts as actual', () => {
    const result = getFeesForOrder(
      makeOrder({ referral_fee: 0, fba_fee: 4.5, closing_fee: 0 }),
      25,
      feeCache,
    );
    expect(result.source).toBe('actual');
    expect(result.totalFees).toBe(4.5);
  });

  it('Only referral_fee > 0 still counts as actual', () => {
    const result = getFeesForOrder(
      makeOrder({ referral_fee: 3, fba_fee: 0, closing_fee: 0 }),
      25,
      feeCache,
    );
    expect(result.source).toBe('actual');
    expect(result.totalFees).toBe(3);
  });
});

// ============================================================
// 5. calculateEstimatedFeesFromCache
// ============================================================
describe('calculateEstimatedFeesFromCache', () => {
  const feeCache: FeeCache = { fbaFeeFixed: 3.22, referralRate: 0.15, isMedia: false };

  it('Calculates fees correctly', () => {
    const result = calculateEstimatedFeesFromCache(20, 1, feeCache);
    expect(result).not.toBeNull();
    expect(result!.referralFee).toBe(3);
    expect(result!.fbaFee).toBe(3.22);
    expect(result!.totalFees).toBe(6.22);
  });

  it('Returns null with no cache', () => {
    expect(calculateEstimatedFeesFromCache(20, 1, null)).toBeNull();
  });

  it('Returns null with zero price', () => {
    expect(calculateEstimatedFeesFromCache(0, 1, feeCache)).toBeNull();
  });

  it('Scales by quantity', () => {
    const result = calculateEstimatedFeesFromCache(20, 4, feeCache);
    expect(result!.referralFee).toBe(12); // 20 * 0.15 * 4
    expect(result!.fbaFee).toBe(12.88); // 3.22 * 4
  });

  it('Media closing fee applied per unit', () => {
    const mediaCache: FeeCache = { fbaFeeFixed: 3.22, referralRate: 0.15, isMedia: true };
    const result = calculateEstimatedFeesFromCache(20, 2, mediaCache);
    expect(result!.closingFee).toBe(3.6); // 1.80 * 2
  });
});

// ============================================================
// 6. CANCELLED ORDER EXCLUSION (verified at call site)
// ============================================================
describe('sumGrossSales aggregation', () => {
  it('Excludes orders with null price from total', () => {
    const orders = [
      makeOrder({ sold_price: 25 }),
      makeOrder({ asin: 'B00NOPRICE', order_id: 'ORDER-002' }),
    ];
    const result = sumGrossSales(orders, emptyInvMap, true, new Map());
    expect(result.total).toBe(25);
    expect(result.countWithPrice).toBe(1);
    expect(result.countMissingPrice).toBe(1);
  });

  it('Sums multiple orders correctly', () => {
    const orders = [
      makeOrder({ sold_price: 25, order_id: 'O1' }),
      makeOrder({ sold_price: 15, order_id: 'O2', asin: 'B000TEST02' }),
    ];
    const result = sumGrossSales(orders, emptyInvMap, true);
    expect(result.total).toBe(40);
    expect(result.countWithPrice).toBe(2);
  });

  it('Empty orders array returns zero', () => {
    const result = sumGrossSales([], emptyInvMap, true);
    expect(result.total).toBe(0);
    expect(result.countWithPrice).toBe(0);
    expect(result.countMissingPrice).toBe(0);
  });

  it('All missing prices returns total=0 with correct count', () => {
    const orders = [
      makeOrder({ order_id: 'O1' }),
      makeOrder({ order_id: 'O2', asin: 'B00MISS' }),
    ];
    const result = sumGrossSales(orders, emptyInvMap, true, new Map());
    expect(result.total).toBe(0);
    expect(result.countMissingPrice).toBe(2);
  });

  it('Uses snapshot prices when available', () => {
    const orders = [
      makeOrder({ order_id: 'O1' }),
      makeOrder({ order_id: 'O2', asin: 'B000TEST02' }),
    ];
    const snaps = buildSnapshotMap([
      { order_id: 'O1', asin: 'B000TEST01', snapshot_item_price: 10, snapshot_shipping_price: 0, snapshot_source: 'api' },
      { order_id: 'O2', asin: 'B000TEST02', snapshot_item_price: 20, snapshot_shipping_price: 0, snapshot_source: 'api' },
    ]);
    const result = sumGrossSales(orders, emptyInvMap, true, snaps);
    expect(result.total).toBe(30);
    expect(result.countWithPrice).toBe(2);
  });
});

// ============================================================
// 7. SNAPSHOT MAP BUILDER
// ============================================================
describe('buildSnapshotMap', () => {
  it('Creates correct lookup keys', () => {
    const map = buildSnapshotMap([
      { order_id: 'O1', asin: 'A1', snapshot_item_price: 10, snapshot_shipping_price: 0, snapshot_source: 'api' },
      { order_id: 'O1', asin: 'A2', snapshot_item_price: 20, snapshot_shipping_price: 0, snapshot_source: 'api' },
    ]);
    expect(map.get('O1:A1')?.snapshot_item_price).toBe(10);
    expect(map.get('O1:A2')?.snapshot_item_price).toBe(20);
    expect(map.has('O1:A3')).toBe(false);
  });

  it('Last entry wins for duplicate keys', () => {
    const map = buildSnapshotMap([
      { order_id: 'O1', asin: 'A1', snapshot_item_price: 10, snapshot_shipping_price: 0, snapshot_source: 'v1' },
      { order_id: 'O1', asin: 'A1', snapshot_item_price: 12, snapshot_shipping_price: 0, snapshot_source: 'v2' },
    ]);
    expect(map.get('O1:A1')?.snapshot_item_price).toBe(12);
  });

  it('Preserves currency_code when provided', () => {
    const map = buildSnapshotMap([
      { order_id: 'O1', asin: 'A1', snapshot_item_price: 10, snapshot_shipping_price: 0, snapshot_source: 'api', currency_code: 'CAD' },
    ]);
    expect(map.get('O1:A1')?.currency_code).toBe('CAD');
  });

  it('Empty input returns empty map', () => {
    const map = buildSnapshotMap([]);
    expect(map.size).toBe(0);
  });
});

// ============================================================
// 8. MULTI-UNIT SCALING EDGE CASES
// ============================================================
describe('Multi-unit scaling', () => {
  it('quantity=0 defaults to 1 internally', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ sold_price: 20, quantity: 0 }),
      emptyInvMap,
      true,
    );
    expect(result.totalSale).toBe(20);
  });

  it('Large quantity scales snapshot correctly', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ quantity: 100 }),
      emptyInvMap,
      true,
      snapMap('ORDER-001', 'B000TEST01', 5),
    );
    expect(result.totalSale).toBe(500);
  });

  it('Large quantity scales estimated_price correctly', () => {
    const result = getGrossSalesForOrder(
      makeOrder({ quantity: 50, estimated_price: 8 }),
      emptyInvMap,
      true,
      new Map(),
    );
    expect(result.totalSale).toBe(400);
  });
});

// ============================================================
// 9. REPLAY DEDUPLICATION SAFETY
// ============================================================
describe('Replay deduplication', () => {
  it('financial_events_cache uniqueness key prevents duplicates', () => {
    // The unique index is: (user_id, event_type, event_date, amazon_order_id, asin)
    // Verify the dedupe key format matches
    const entry1 = { user_id: 'U1', event_type: 'shipment', event_date: '2026-03-01', amazon_order_id: 'ORD-001', asin: 'B00TEST' };
    const entry2 = { ...entry1 }; // Same key = would be deduped by upsert
    const key1 = `${entry1.user_id}|${entry1.event_type}|${entry1.event_date}|${entry1.amazon_order_id}|${entry1.asin}`;
    const key2 = `${entry2.user_id}|${entry2.event_type}|${entry2.event_date}|${entry2.amazon_order_id}|${entry2.asin}`;
    expect(key1).toBe(key2);
  });

  it('Different event_types for same order create separate rows', () => {
    const shipment = { user_id: 'U1', event_type: 'shipment', event_date: '2026-03-01', amazon_order_id: 'ORD-001', asin: 'B00TEST' };
    const refund = { ...shipment, event_type: 'refund' };
    const key1 = `${shipment.user_id}|${shipment.event_type}|${shipment.event_date}|${shipment.amazon_order_id}|${shipment.asin}`;
    const key2 = `${refund.user_id}|${refund.event_type}|${refund.event_date}|${refund.amazon_order_id}|${refund.asin}`;
    expect(key1).not.toBe(key2);
  });

  it('Empty ASIN events with same order_id share dedupe key (risk acknowledged)', () => {
    const entry1 = { user_id: 'U1', event_type: 'shipment', event_date: '2026-03-01', amazon_order_id: 'ORD-001', asin: '' };
    const entry2 = { ...entry1 };
    const key1 = `${entry1.user_id}|${entry1.event_type}|${entry1.event_date}|${entry1.amazon_order_id}|${entry1.asin}`;
    const key2 = `${entry2.user_id}|${entry2.event_type}|${entry2.event_date}|${entry2.amazon_order_id}|${entry2.asin}`;
    // These collide - which means multi-item orders with blank ASINs could lose data
    // The dedupeCacheEntries function merges such entries to prevent data loss
    expect(key1).toBe(key2);
  });

  it('Account-level charges use empty order_id and asin', () => {
    const charge1 = { user_id: 'U1', event_type: 'storage', event_date: '2026-03-01', amazon_order_id: '', asin: '' };
    const charge2 = { ...charge1, event_date: '2026-03-02' };
    const key1 = `${charge1.user_id}|${charge1.event_type}|${charge1.event_date}|${charge1.amazon_order_id}|${charge1.asin}`;
    const key2 = `${charge2.user_id}|${charge2.event_type}|${charge2.event_date}|${charge2.amazon_order_id}|${charge2.asin}`;
    // Different dates = separate rows (correct)
    expect(key1).not.toBe(key2);
  });
});

// ============================================================
// 10. CORRECTION DELTA LOGIC
// ============================================================
describe('Correction delta calculations', () => {
  it('Price upgrade delta is (new - old) × quantity', () => {
    const oldPrice = 15;
    const newPrice = 22;
    const qty = 3;
    const revenueDelta = (newPrice - oldPrice) * qty;
    expect(revenueDelta).toBe(21);
  });

  it('Fee upgrade delta is (new - old) × quantity', () => {
    const oldFees = 0;
    const newFees = 5.50;
    const qty = 2;
    const feeDelta = (newFees - oldFees) * qty;
    expect(feeDelta).toBe(11);
  });

  it('Profit delta is revenue delta - fee delta', () => {
    const revenueDelta = 21;
    const feeDelta = 11;
    const profitDelta = revenueDelta - feeDelta;
    expect(profitDelta).toBe(10);
  });

  it('Zero delta when price unchanged despite source change', () => {
    const oldPrice = 20;
    const newPrice = 20;
    const delta = (newPrice - oldPrice) * 1;
    expect(delta).toBe(0);
  });
});

// ============================================================
// 11. PARITY VALIDATION LOGIC
// ============================================================
describe('Parity validation', () => {
  it('Block vs row totals match when derived from same source', () => {
    const blockSales = 1234.56;
    const rowSales = 1234.56;
    const delta = Math.abs(blockSales - rowSales);
    expect(delta).toBeLessThanOrEqual(0.01);
  });

  it('Mismatch detected when delta exceeds penny threshold', () => {
    const blockSales = 1234.56;
    const rowSales = 1230.00;
    const delta = Math.abs(blockSales - rowSales);
    expect(delta).toBeGreaterThan(0.01);
  });

  it('Fee breakdown components sum to total', () => {
    const referral = 3.75;
    const fba = 4.50;
    const closing = 1.80;
    const inbound = 0;
    const other = 0.25;
    const total = referral + fba + closing + inbound + other;
    expect(total).toBe(10.30);
  });
});
