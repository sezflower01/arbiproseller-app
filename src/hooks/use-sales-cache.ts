/**
 * Stale-While-Revalidate cache hook for Sales Report
 * Stores last sales data in localStorage for instant display on page load
 */

import { useCallback, useRef } from 'react';

const CACHE_KEY = 'sales_report_cache';
const CACHE_VERSION = 1;
const MAX_CACHED_ROWS = 500; // Limit cached rows to avoid localStorage size limits

interface SalesCacheData {
  version: number;
  timestamp: number;
  dateFilter: string;
  customStartDate: string;
  customEndDate: string;
  marketplaces: string[];
  sales: any[];
  refunds: any[];
}

interface UseSalesCacheReturn {
  loadFromCache: (dateFilter: string, customStartDate: string, customEndDate: string, marketplaces: string[]) => { sales: any[]; refunds: any[] } | null;
  saveToCache: (dateFilter: string, customStartDate: string, customEndDate: string, marketplaces: string[], sales: any[], refunds: any[]) => void;
  clearCache: () => void;
  getCacheAge: () => number | null;
  isCacheStale: (maxAgeMinutes?: number) => boolean;
}

export function useSalesCache(): UseSalesCacheReturn {
  const lastSaveTimeRef = useRef<number>(0);
  
  const loadFromCache = useCallback((
    dateFilter: string,
    customStartDate: string,
    customEndDate: string,
    marketplaces: string[]
  ): { sales: any[]; refunds: any[] } | null => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;
      
      const data: SalesCacheData = JSON.parse(cached);
      
      // Check version compatibility
      if (data.version !== CACHE_VERSION) {
        console.log('[SalesCache] Version mismatch, clearing cache');
        localStorage.removeItem(CACHE_KEY);
        return null;
      }
      
      // Check if cache matches current filters
      const marketplaceKey = [...marketplaces].sort().join(',');
      const cachedMarketplaceKey = [...(data.marketplaces || [])].sort().join(',');
      
      const filterMatches = 
        data.dateFilter === dateFilter &&
        data.customStartDate === customStartDate &&
        data.customEndDate === customEndDate &&
        marketplaceKey === cachedMarketplaceKey;
      
      if (!filterMatches) {
        console.log('[SalesCache] Filter mismatch, cache not used');
        return null;
      }
      
      console.log(`[SalesCache] Loaded ${data.sales?.length || 0} sales from cache (age: ${Math.round((Date.now() - data.timestamp) / 1000)}s)`);
      
      return {
        sales: data.sales || [],
        refunds: data.refunds || [],
      };
    } catch (err) {
      console.warn('[SalesCache] Failed to load cache:', err);
      return null;
    }
  }, []);
  
  const saveToCache = useCallback((
    dateFilter: string,
    customStartDate: string,
    customEndDate: string,
    marketplaces: string[],
    sales: any[],
    refunds: any[]
  ) => {
    // Debounce saves to avoid excessive localStorage writes
    const now = Date.now();
    if (now - lastSaveTimeRef.current < 2000) {
      return;
    }
    lastSaveTimeRef.current = now;
    
    try {
      // Limit cached data to avoid localStorage limits (~5MB)
      const trimmedSales = sales.slice(0, MAX_CACHED_ROWS);
      const trimmedRefunds = refunds.slice(0, MAX_CACHED_ROWS);
      
      const data: SalesCacheData = {
        version: CACHE_VERSION,
        timestamp: now,
        dateFilter,
        customStartDate,
        customEndDate,
        marketplaces,
        sales: trimmedSales,
        refunds: trimmedRefunds,
      };
      
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      console.log(`[SalesCache] Saved ${trimmedSales.length} sales to cache`);
    } catch (err) {
      console.warn('[SalesCache] Failed to save cache:', err);
      // If localStorage is full, try to clear and save again
      try {
        localStorage.removeItem(CACHE_KEY);
      } catch {}
    }
  }, []);
  
  const clearCache = useCallback(() => {
    try {
      localStorage.removeItem(CACHE_KEY);
      console.log('[SalesCache] Cache cleared');
    } catch (err) {
      console.warn('[SalesCache] Failed to clear cache:', err);
    }
  }, []);
  
  const getCacheAge = useCallback((): number | null => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;
      
      const data: SalesCacheData = JSON.parse(cached);
      return Date.now() - data.timestamp;
    } catch {
      return null;
    }
  }, []);
  
  const isCacheStale = useCallback((maxAgeMinutes: number = 15): boolean => {
    const age = getCacheAge();
    if (age === null) return true;
    return age > maxAgeMinutes * 60 * 1000;
  }, [getCacheAge]);
  
  return {
    loadFromCache,
    saveToCache,
    clearCache,
    getCacheAge,
    isCacheStale,
  };
}
