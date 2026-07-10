import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Period totals structure matching the cache table
export interface PeriodCacheTotals {
  sales_total: number;
  amazon_fees_total: number;
  fba_fee_total: number;
  referral_fee_total: number;
  closing_fee_total: number;
  cogs_total: number;
  refund_cost_total: number;
  gross_profit: number;
  net_profit: number;
  row_count: number;
  updated_at: string;
}

// Cache key structure
export interface PeriodCacheKey {
  userId: string;
  sellerId: string;
  marketplaceId: string;
  dateStart: string;
  dateEnd: string;
  timezoneCutoff: string;
  includeSettled: boolean;
  hideDeferred: boolean;
  refreshKey?: number; // Forces cache invalidation on manual refresh
}

// Helper to generate a unique key string
function getCacheKeyString(key: PeriodCacheKey): string {
  // Include refreshKey in cache key so Refresh Data invalidates cache
  const refreshPart = key.refreshKey !== undefined ? `|r${key.refreshKey}` : '';
  return `${key.userId}|${key.sellerId}|${key.marketplaceId}|${key.dateStart}|${key.dateEnd}|${key.timezoneCutoff}|${key.includeSettled}|${key.hideDeferred}${refreshPart}`;
}

// Cache stale threshold (15 minutes)
const CACHE_STALE_MINUTES = 15;

export function usePeriodCache(userId: string | undefined) {
  const [cacheMap, setCacheMap] = useState<Map<string, PeriodCacheTotals>>(new Map());
  const [loadingCache, setLoadingCache] = useState(false);
  const fetchedKeysRef = useRef<Set<string>>(new Set());

  // Read cache from database
  const readCache = useCallback(async (keys: PeriodCacheKey[]): Promise<Map<string, PeriodCacheTotals>> => {
    if (!userId || keys.length === 0) return new Map();

    const results = new Map<string, PeriodCacheTotals>();
    
    try {
      // Build an array of date ranges to query
      const dateRanges = keys.map(k => ({ start: k.dateStart, end: k.dateEnd }));
      
      // Query all matching cache entries
      const { data, error } = await supabase
        .from('sales_period_totals_cache')
        .select('*')
        .eq('user_id', userId);
      
      if (error) {
        console.error('[PeriodCache] Error reading cache:', error);
        return results;
      }

      if (!data) return results;

      // Match cache entries to keys
      for (const row of data) {
        for (const key of keys) {
          if (
            row.date_start === key.dateStart &&
            row.date_end === key.dateEnd &&
            row.seller_id === key.sellerId &&
            row.marketplace_id === key.marketplaceId &&
            row.timezone_cutoff === key.timezoneCutoff &&
            row.include_settled === key.includeSettled &&
            row.hide_deferred === key.hideDeferred
          ) {
            const keyStr = getCacheKeyString(key);
            results.set(keyStr, {
              sales_total: Number(row.sales_total),
              amazon_fees_total: Number(row.amazon_fees_total),
              fba_fee_total: Number(row.fba_fee_total),
              referral_fee_total: Number(row.referral_fee_total),
              closing_fee_total: Number(row.closing_fee_total),
              cogs_total: Number(row.cogs_total),
              refund_cost_total: Number(row.refund_cost_total),
              gross_profit: Number(row.gross_profit),
              net_profit: Number(row.net_profit),
              row_count: Number(row.row_count),
              updated_at: row.updated_at,
            });
          }
        }
      }

      return results;
    } catch (err) {
      console.error('[PeriodCache] Exception reading cache:', err);
      return results;
    }
  }, [userId]);

  // Check if cache entry is stale
  const isCacheStale = useCallback((totals: PeriodCacheTotals | undefined): boolean => {
    if (!totals) return true;
    
    const updatedAt = new Date(totals.updated_at).getTime();
    const now = Date.now();
    const ageMinutes = (now - updatedAt) / (1000 * 60);
    
    return ageMinutes > CACHE_STALE_MINUTES;
  }, []);

  // Write cache to database
  const writeCache = useCallback(async (
    key: PeriodCacheKey,
    totals: Omit<PeriodCacheTotals, 'updated_at'>
  ): Promise<void> => {
    if (!userId) return;

    try {
      const { error } = await supabase
        .from('sales_period_totals_cache')
        .upsert({
          user_id: userId,
          seller_id: key.sellerId,
          marketplace_id: key.marketplaceId,
          date_start: key.dateStart,
          date_end: key.dateEnd,
          timezone_cutoff: key.timezoneCutoff,
          include_settled: key.includeSettled,
          hide_deferred: key.hideDeferred,
          sales_total: totals.sales_total,
          amazon_fees_total: totals.amazon_fees_total,
          fba_fee_total: totals.fba_fee_total,
          referral_fee_total: totals.referral_fee_total,
          closing_fee_total: totals.closing_fee_total,
          cogs_total: totals.cogs_total,
          refund_cost_total: totals.refund_cost_total,
          gross_profit: totals.gross_profit,
          net_profit: totals.net_profit,
          row_count: totals.row_count,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'user_id,seller_id,marketplace_id,date_start,date_end,timezone_cutoff,include_settled,hide_deferred'
        });

      if (error) {
        console.error('[PeriodCache] Error writing cache:', error);
        return;
      }

      // Update local state
      const keyStr = getCacheKeyString(key);
      setCacheMap(prev => {
        const next = new Map(prev);
        next.set(keyStr, {
          ...totals,
          updated_at: new Date().toISOString(),
        });
        return next;
      });
      
      console.log(`[PeriodCache] Cached ${key.dateStart} to ${key.dateEnd}`);
    } catch (err) {
      console.error('[PeriodCache] Exception writing cache:', err);
    }
  }, [userId]);

  // Invalidate cache for specific periods
  const invalidateCache = useCallback(async (keys: PeriodCacheKey[]): Promise<void> => {
    if (!userId || keys.length === 0) return;

    try {
      for (const key of keys) {
        await supabase
          .from('sales_period_totals_cache')
          .delete()
          .eq('user_id', userId)
          .eq('seller_id', key.sellerId)
          .eq('marketplace_id', key.marketplaceId)
          .eq('date_start', key.dateStart)
          .eq('date_end', key.dateEnd)
          .eq('timezone_cutoff', key.timezoneCutoff)
          .eq('include_settled', key.includeSettled)
          .eq('hide_deferred', key.hideDeferred);
        
        const keyStr = getCacheKeyString(key);
        fetchedKeysRef.current.delete(keyStr);
        setCacheMap(prev => {
          const next = new Map(prev);
          next.delete(keyStr);
          return next;
        });
      }
      
      console.log(`[PeriodCache] Invalidated ${keys.length} cache entries`);
    } catch (err) {
      console.error('[PeriodCache] Exception invalidating cache:', err);
    }
  }, [userId]);

  // Force refresh all cache for this user
  const forceRefreshAll = useCallback(async (): Promise<void> => {
    if (!userId) return;

    try {
      await supabase
        .from('sales_period_totals_cache')
        .delete()
        .eq('user_id', userId);
      
      fetchedKeysRef.current.clear();
      setCacheMap(new Map());
      
      console.log('[PeriodCache] Force refreshed all cache');
    } catch (err) {
      console.error('[PeriodCache] Exception force refreshing:', err);
    }
  }, [userId]);

  // Get cached totals for a key (from local state)
  const getCachedTotals = useCallback((key: PeriodCacheKey): PeriodCacheTotals | undefined => {
    const keyStr = getCacheKeyString(key);
    return cacheMap.get(keyStr);
  }, [cacheMap]);

  // Pre-load cache entries
  const preloadCache = useCallback(async (keys: PeriodCacheKey[]): Promise<void> => {
    if (!userId || keys.length === 0) return;
    
    setLoadingCache(true);
    try {
      const cached = await readCache(keys);
      setCacheMap(prev => {
        const next = new Map(prev);
        for (const [keyStr, totals] of cached) {
          next.set(keyStr, totals);
          fetchedKeysRef.current.add(keyStr);
        }
        return next;
      });
    } finally {
      setLoadingCache(false);
    }
  }, [userId, readCache]);

  return {
    cacheMap,
    loadingCache,
    readCache,
    writeCache,
    isCacheStale,
    invalidateCache,
    forceRefreshAll,
    getCachedTotals,
    preloadCache,
    getCacheKeyString,
  };
}
