/**
 * Lightweight SWR cache for Mobile Live Sales.
 *
 * Mirrors the pattern used by Sales Report (`use-sales-cache` +
 * `periodStatsCache`) so the mobile page can paint last-known totals
 * instantly on cold open / tab resume, then revalidate in the
 * background.
 *
 * Keyed by user + business-date so switching accounts or rolling over
 * midnight never shows another user's / yesterday's numbers.
 */

const CACHE_KEY_PREFIX = "lov.mobileLiveSales.today.v20";
const MAX_CACHED_ROWS = 300;
// Keep the last stable period paint available when the user leaves the route
// and comes back. Manual Refresh / explicit fetches still revalidate, but the
// UI must not blank to skeleton for heavy YTD/reconciled views.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface MobileLiveSalesSnapshot {
  rows: any[];
  todaySummary: {
    units: number;
    orders: number;
    revenue: number;
    fees: number;
    cost: number;
    profit: number;
    roi: number;
  };
  todayRefunds: { amount: number; count: number };
  periodAdjustments?: any;
  periodPromotions?: any;
  periodPendingEst?: any;
  profitTrace?: any;
  savedAt: number;
}

interface StoredSnapshot extends MobileLiveSalesSnapshot {
  v: 1;
}

function keyFor(userId: string, dateStr: string): string {
  return `${CACHE_KEY_PREFIX}.${userId}.${dateStr}`;
}

export function loadMobileLiveSalesCache(
  userId: string | undefined,
  dateStr: string
): MobileLiveSalesSnapshot | null {
  if (!userId || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(keyFor(userId, dateStr));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSnapshot;
    if (parsed.v !== 1) return null;
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(keyFor(userId, dateStr));
      return null;
    }
    return {
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
      todaySummary: parsed.todaySummary,
      todayRefunds: parsed.todayRefunds,
      periodAdjustments: parsed.periodAdjustments,
      periodPromotions: parsed.periodPromotions,
      periodPendingEst: (parsed as any).periodPendingEst,
      profitTrace: parsed.profitTrace,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

export function saveMobileLiveSalesCache(
  userId: string | undefined,
  dateStr: string,
  snapshot: Omit<MobileLiveSalesSnapshot, "savedAt">
): void {
  if (!userId || typeof window === "undefined") return;
  try {
    const trimmed: StoredSnapshot = {
      v: 1,
      rows: (snapshot.rows || []).slice(0, MAX_CACHED_ROWS),
      todaySummary: snapshot.todaySummary,
      todayRefunds: snapshot.todayRefunds,
      periodAdjustments: snapshot.periodAdjustments,
      periodPromotions: snapshot.periodPromotions,
      periodPendingEst: (snapshot as any).periodPendingEst,
      profitTrace: snapshot.profitTrace,
      savedAt: Date.now(),
    };
    localStorage.setItem(keyFor(userId, dateStr), JSON.stringify(trimmed));
    // Clean up any stale day-keys for this user (>24h old or other dates)
    pruneOldKeys(userId, dateStr);
  } catch {
    // localStorage quota or private mode — ignore
  }
}

function pruneOldKeys(userId: string, keepDateStr: string) {
  try {
    const prefix = `${CACHE_KEY_PREFIX}.${userId}.`;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      if (k === `${prefix}${keepDateStr}`) continue;
      toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}
