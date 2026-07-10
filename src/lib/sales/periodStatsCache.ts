/**
 * Smart cache for Sales Report period stats.
 *
 * Keyed by:  period + mode + start + end + marketplaces + userId
 * Value:     the full PeriodStat returned by the fetcher
 *
 * Strategy:
 *   - In-memory Map (instant tab/mode switch)
 *   - localStorage persistence for SUMMARY entries only (small footprint;
 *     orders/refunds tables stay in memory).
 *   - TTL per period (Today 60s · Yesterday/MTD 5m · Custom/Reconciled 20m).
 *   - getFresh()  → only entries inside TTL
 *   - getAny()    → any cached entry, even if stale (for instant paint)
 *   - SWR caller is responsible for revalidating when getAny() is stale.
 */

import type { PeriodStat } from '@/components/sales/PeriodStatsBlocks';

export type CacheMode = 'smart' | 'estimated' | 'reconciled';

export interface CacheKeyParts {
  userId: string;
  periodId: string;
  mode: CacheMode;
  start: string;
  end: string;
  marketplaces?: string[];
}

interface Entry {
  stat: PeriodStat;
  fetchedAt: number;
}

const STORAGE_KEY = 'lov.salesReport.cache.v2.promotions-deducted';
const STORAGE_MAX_BYTES = 500_000; // hard cap to avoid blowing localStorage
const PERSIST_DEBOUNCE_MS = 800;

const TTL_MS: Record<string, number> = {
  today: 60 * 1000,
  yesterday: 5 * 60 * 1000,
  month_to_date: 5 * 60 * 1000,
  this_month: 5 * 60 * 1000,
  last_month: 30 * 60 * 1000,
  custom: 20 * 60 * 1000,
};

function ttlForKey(periodId: string, mode: CacheMode): number {
  // Reconciled mode is always slowest source-of-truth → cache longer.
  if (mode === 'reconciled') return Math.max(TTL_MS[periodId] || 20 * 60 * 1000, 20 * 60 * 1000);
  return TTL_MS[periodId] ?? 5 * 60 * 1000;
}

export function makeCacheKey(p: CacheKeyParts): string {
  const m = (p.marketplaces && p.marketplaces.length > 0)
    ? [...p.marketplaces].sort().join(',')
    : 'all';
  return `promo-v2|${p.userId}|${p.periodId}|${p.mode}|${p.start}|${p.end}|${m}`;
}

const memCache = new Map<string, Entry>();
const listeners = new Set<() => void>();

function notify() { listeners.forEach((l) => { try { l(); } catch {} }); }

export function subscribeCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ── Persistence (summary fields only) ───────────────────────────────────
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const PERSIST_FIELDS: (keyof PeriodStat)[] = [
  'id', 'label', 'sublabel', 'dateLabel',
  'sales', 'orders', 'units', 'refunds', 'refundAmount',
  'estPayout', 'grossProfit', 'netProfit', 'totalFees', 'totalCost',
  'roi', 'margin', 'refundPercent', 'avgOrderValue', 'avgUnitPrice',
  'profitPerUnit', 'expenses', 'inboundFees', 'inboundFeesCount',
  'cancelledOrders', 'fbaFee', 'referralFee', 'closingFee',
  'recordFees', 'feeBreakdown', 'refundsFromCache', 'netSalesBreakdown',
] as any;

function projectForPersist(stat: PeriodStat): Partial<PeriodStat> {
  const out: any = {};
  for (const k of PERSIST_FIELDS) {
    if ((stat as any)[k] !== undefined) out[k] = (stat as any)[k];
  }
  return out;
}

function schedulePersist() {
  if (typeof window === 'undefined') return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const snapshot: Record<string, { stat: any; fetchedAt: number }> = {};
      for (const [key, entry] of memCache) {
        snapshot[key] = { stat: projectForPersist(entry.stat), fetchedAt: entry.fetchedAt };
      }
      const json = JSON.stringify(snapshot);
      if (json.length > STORAGE_MAX_BYTES) {
        // Drop the oldest entries until under cap.
        const sorted = Object.entries(snapshot).sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
        while (sorted.length > 0 && JSON.stringify(Object.fromEntries(sorted)).length > STORAGE_MAX_BYTES) {
          sorted.shift();
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(sorted)));
      } else {
        localStorage.setItem(STORAGE_KEY, json);
      }
    } catch (e) {
      // localStorage may be unavailable (private mode, quota, etc.) — ignore.
      console.warn('[periodStatsCache] persist failed', e);
    }
  }, PERSIST_DEBOUNCE_MS);
}

let hydrated = false;
export function hydrateFromStorage() {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, { stat: any; fetchedAt: number }>;
    const now = Date.now();
    let kept = 0;
    for (const [key, entry] of Object.entries(parsed)) {
      // Discard entries older than 24h on hydrate.
      if (now - entry.fetchedAt > 24 * 60 * 60 * 1000) continue;
      memCache.set(key, { stat: entry.stat as PeriodStat, fetchedAt: entry.fetchedAt });
      kept++;
    }
    if (kept > 0) {
      console.log(`[periodStatsCache] hydrated ${kept} entries from localStorage`);
      notify();
    }
  } catch (e) {
    console.warn('[periodStatsCache] hydrate failed', e);
  }
}

// ── API ────────────────────────────────────────────────────────────────
export function getAny(key: string): { stat: PeriodStat; fetchedAt: number } | null {
  const entry = memCache.get(key);
  return entry ? { stat: entry.stat, fetchedAt: entry.fetchedAt } : null;
}

export function getFresh(key: string, periodId: string, mode: CacheMode): { stat: PeriodStat; fetchedAt: number } | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ttlForKey(periodId, mode)) return null;
  return { stat: entry.stat, fetchedAt: entry.fetchedAt };
}

export function isStale(key: string, periodId: string, mode: CacheMode): boolean {
  const entry = memCache.get(key);
  if (!entry) return true;
  return Date.now() - entry.fetchedAt > ttlForKey(periodId, mode);
}

export function set(key: string, stat: PeriodStat) {
  memCache.set(key, { stat, fetchedAt: Date.now() });
  notify();
  schedulePersist();
}

export function invalidate(key: string) {
  if (memCache.delete(key)) {
    notify();
    schedulePersist();
  }
}

export function clearAll() {
  memCache.clear();
  notify();
  if (typeof window !== 'undefined') {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }
}

/**
 * Compare two stats — returns true if the displayed totals differ enough to
 * justify a re-render swap. Avoids flicker when SWR returns identical data.
 */
export function totalsDiffer(a: PeriodStat | undefined, b: PeriodStat): boolean {
  if (!a) return true;
  const diff = (k: keyof PeriodStat) => Math.abs(Number(a[k] || 0) - Number(b[k] || 0)) > 0.01;
  if (diff('sales' as any)) return true;
  if (diff('orders' as any)) return true;
  if (diff('units' as any)) return true;
  if (diff('totalFees' as any)) return true;
  if (diff('refundAmount' as any)) return true;
  if (diff('grossProfit' as any)) return true;
  if (diff('netProfit' as any)) return true;
  if (diff('totalCost' as any)) return true;
  // Fee breakdown deep check
  const fa = (a as any).feeBreakdown || {};
  const fb = (b as any).feeBreakdown || {};
  for (const k of ['fbaFulfillmentFee', 'referralFee', 'variableClosingFee', 'storageFees', 'inboundTransportation', 'amazonOtherFees']) {
    if (Math.abs(Number(fa[k] || 0) - Number(fb[k] || 0)) > 0.01) return true;
  }
  return false;
}

export function getCacheAge(key: string): number | null {
  const entry = memCache.get(key);
  return entry ? Date.now() - entry.fetchedAt : null;
}
