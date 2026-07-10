import { useState, useEffect, useCallback, useRef } from "react";
import { getInventoryCache, setInventoryCache } from "@/hooks/use-inventory-cache";
import { supabase } from "@/integrations/supabase/client";

const CACHE_KEY = "repricer_assignments_cache";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BACKGROUND_REFRESH_COOLDOWN_MS = 30 * 1000; // 30 seconds — keep UI fresh across browsers

// Check if the server-side inventory has been synced more recently than our cache
async function getServerSyncTimestamp(userId: string): Promise<number | null> {
  try {
    const { data } = await supabase
      .from("profiles")
      .select("inventory_synced_at")
      .eq("id", userId)
      .single();
    if (data?.inventory_synced_at) {
      return new Date(data.inventory_synced_at).getTime();
    }
  } catch { /* ignore */ }
  return null;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export function useRepricerCache<T>(fetchFn: () => Promise<T>, userId: string | undefined, cacheKeySuffix?: string) {
  const [data, setDataRaw] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const fetchInProgressRef = useRef(false);
  const lastFetchTimestampRef = useRef(0);
  const fetchFnRef = useRef(fetchFn);
  const cacheKeySuffixRef = useRef(cacheKeySuffix);
  const updateGenRef = useRef(0);
  const dataRef = useRef<T | null>(null);

  // Wrapper that keeps dataRef in sync
  const setData = useCallback((val: T | null) => {
    dataRef.current = val;
    setDataRaw(val);
  }, []);
  // Monotonically increasing ID that changes every time the effect re-runs
  // (i.e. on marketplace switch). Any async operation captures the current
  // value and only applies its result if it still matches.
  const effectEpochRef = useRef(0);

  fetchFnRef.current = fetchFn;
  cacheKeySuffixRef.current = cacheKeySuffix;

  const cacheKey = cacheKeySuffix 
    ? `${CACHE_KEY}_${userId}_${cacheKeySuffix}` 
    : `${CACHE_KEY}_${userId}`;

  const getCachedData = useCallback((): { data: T; timestamp: number } | null => {
    if (!userId) return null;
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const entry: CacheEntry<T> = JSON.parse(cached);
        if (Date.now() - entry.timestamp < CACHE_TTL_MS) {
          // Time-relative sales counters can be stale across reloads/day boundaries.
          // Clear them from session cache; live sales poll will repopulate them.
          const sanitizedData = Array.isArray(entry.data)
            ? (entry.data as any[]).map((row: any) => {
                if (!row || typeof row !== "object") return row;
                if (!("units_sold_today" in row) && !("units_sold_7d" in row) && !("units_sold_30d" in row)) return row;
                return {
                  ...row,
                  units_sold_today: null,
                  units_sold_7d: null,
                  units_sold_30d: null,
                };
              })
            : entry.data;
          return { data: sanitizedData as T, timestamp: entry.timestamp };
        }
      }
    } catch (e) {
      console.warn("Failed to read repricer cache:", e);
    }
    return null;
  }, [userId, cacheKey]);

  const setCachedData = useCallback((newData: T) => {
    if (!userId) return;
    const json = JSON.stringify({ data: newData, timestamp: Date.now() });
    if (json.length > 3_000_000) {
      // Quietly skip sessionStorage for large payloads — IDB handles persistence.
      // Log once per key per session to avoid console noise on every poll.
      const flagKey = `__rcache_oversize_${cacheKey}`;
      if (!(window as any)[flagKey]) {
        (window as any)[flagKey] = true;
        console.info(`[RepricerCache] Using IDB-only for ${cacheKey} (${(json.length / 1e6).toFixed(1)} MB)`);
      }
      return;
    }
    try {
      sessionStorage.setItem(cacheKey, json);
    } catch (e) {
      console.warn("Failed to save repricer cache, clearing old entries:", e);
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key && key.startsWith(CACHE_KEY)) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(k => sessionStorage.removeItem(k));
        sessionStorage.setItem(cacheKey, json);
      } catch (retryErr) {
        console.warn("Failed to save repricer cache even after clearing:", retryErr);
      }
    }
  }, [userId, cacheKey]);

  // Fetch fresh data; uses epoch to discard stale results from previous marketplace
  const fetchDataInternal = useCallback(async (silent: boolean, epoch: number) => {
    if (!userId || fetchInProgressRef.current) return;

    fetchInProgressRef.current = true;
    // Capture the cache key suffix at the START of this fetch so we always
    // write to the correct IDB key, even if the user switches marketplace
    // before the fetch completes.
    const capturedSuffix = cacheKeySuffixRef.current;

    if (!silent) {
      setLoading(true);
      updateGenRef.current = 0;
    } else {
      setIsRefreshing(true);
    }

    try {
      const freshData = await fetchFnRef.current();
      // CRITICAL: Only apply if epoch still matches (same marketplace)
      if (effectEpochRef.current !== epoch) {
        console.log("[RepricerCache] Discarding stale fetch (epoch changed)");
        // Still save to IDB with the CAPTURED suffix (not current) so it's
        // available next time the user visits this marketplace.
        const idbKey = `repricer_${capturedSuffix || "US"}`;
        if (Array.isArray(freshData) && (freshData as any[]).length > 0) {
          setInventoryCache(`${userId}_${idbKey}`, freshData as any[]);
        }
        return;
      }

      // Always apply fresh data from background refresh.
      const freshArr = Array.isArray(freshData) ? (freshData as any[]) : [];
      const currentArr = Array.isArray(dataRef.current) ? (dataRef.current as any[]) : [];

      if (silent && freshArr.length === 0 && currentArr.length > 0) {
        console.warn(`[RepricerCache] Background refresh returned 0 items but we have ${currentArr.length} cached — keeping cached data`);
      } else if (currentArr.length > 0 && freshArr.length > 0) {
        // Merge refreshes with current local state so client-derived/enriched fields
        // (manual edits, diagnostics, sales counters, title/image fallbacks) never
        // disappear during any refresh cycle.
        // Fresh DB data remains the base; local values are only preserved when
        // the fresh value is null/zero (stale/empty response).
        const currentById = new Map<string, any>();
        for (const item of currentArr) {
          if (item && item.id) currentById.set(item.id, item);
        }

        const LOCAL_FIELDS = [
          "price", "my_price", "buybox_price", "buybox_seller_id", "buybox_is_fba",
          "lowest_fba_price", "lowest_overall_price", "offers_count", "snapshot_fetched_at",
          "min_price_override", "max_price_override", "actual_roi", "cost_converted",
          "buybox_roi", "roi_at_min_percent", "roi_at_max_percent", "min_roi_override",
          "roi_range_updated_at", "cost_floor",
          "image_url", "title",
          "units_sold_today", "units_sold_7d", "units_sold_30d",
        ];

        const merged = freshArr.map((freshItem: any) => {
          const localItem = freshItem?.id ? currentById.get(freshItem.id) : null;
          if (!localItem) return freshItem;

          // MARKETPLACE GUARD — inventory.id is shared across marketplaces, so
          // never preserve local fields from a row that belongs to a different
          // marketplace than the fresh row. Prevents min/max/ROI bleed (e.g.
          // MX min=$238.73 leaking into a US row).
          if (localItem.marketplace && freshItem.marketplace &&
              localItem.marketplace !== freshItem.marketplace) {
            return freshItem;
          }

          const result = { ...freshItem };
          for (const field of LOCAL_FIELDS) {
            if (localItem[field] != null && (freshItem[field] == null || freshItem[field] === 0)) {
              result[field] = localItem[field];
            }
          }
          return result;
        });

        console.log(`[RepricerCache] Merged ${merged.length} items (preserved local fields for ${currentById.size} cached rows)`);
        setData(merged as T);
        setCachedData(merged as T);
        lastFetchTimestampRef.current = Date.now();
      } else {
        console.log(`[RepricerCache] Applying ${freshArr.length} items for ${capturedSuffix || "US"}`);
        setData(freshData);
        setCachedData(freshData);
        lastFetchTimestampRef.current = Date.now();
      }

      const idbKey = `repricer_${capturedSuffix || "US"}`;
      if (freshArr.length > 0) {
        setInventoryCache(`${userId}_${idbKey}`, freshData as any[]);
      }
    } catch (error) {
      console.error("Error fetching repricer data:", error);
      // On error, DON'T clear data — keep whatever was previously loaded.
    } finally {
      // Only clear loading/progress flags if epoch still matches
      if (effectEpochRef.current === epoch) {
        setLoading(false);
        setIsRefreshing(false);
        fetchInProgressRef.current = false;
      } else {
        // IMPORTANT: Reset fetchInProgressRef even on stale epoch so the
        // next marketplace's fetch isn't permanently blocked.
        fetchInProgressRef.current = false;
      }
    }
  }, [userId, setCachedData]);

  // Initial load
  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    // Bump epoch so any in-flight fetch from the previous marketplace is discarded
    const epoch = ++effectEpochRef.current;
    fetchInProgressRef.current = false;
    updateGenRef.current = 0;

    // Show loading spinner immediately — but DON'T clear data yet.
    // Data will be replaced when the correct marketplace's data arrives.
    // Clearing data here caused "No inventory" when fetches took too long.
    setLoading(true);

    // Try sessionStorage first
    const cached = getCachedData();
    if (cached) {
      setData(cached.data);
      setLoading(false);
      lastFetchTimestampRef.current = cached.timestamp;
      
      // ALWAYS do a background refresh on initial load to catch cross-browser changes
      fetchDataInternal(true, epoch);
      return;
    }

    // No sessionStorage cache — show loading spinner but DON'T null out data yet.
    // This prevents a brief flash of "No inventory items found" while IDB loads.
    setLoading(true);

    // Try IndexedDB
    const idbKey = `repricer_${cacheKeySuffix || "US"}`;
    getInventoryCache(`${userId}_${idbKey}`).then(async (idbCached) => {
      // Discard if epoch changed (user switched marketplace while IDB was loading)
      if (effectEpochRef.current !== epoch) return;

      // Check server sync timestamp — if server synced after our cache, discard it
      let idbIsStale = false;
      if (idbCached?.data && idbCached.data.length > 0) {
        const serverTs = await getServerSyncTimestamp(userId);
        if (serverTs && serverTs > idbCached.timestamp) {
          console.log(`[RepricerCache] IDB cache is stale (cached: ${new Date(idbCached.timestamp).toISOString()}, server synced: ${new Date(serverTs).toISOString()}) — discarding`);
          idbIsStale = true;
        }
      }

      if (idbCached?.data && idbCached.data.length > 0 && !idbIsStale) {
        const ageMin = Math.round((Date.now() - idbCached.timestamp) / 60000);
        console.log(`[IDB Repricer] Loaded ${idbCached.data.length} items for ${cacheKeySuffix || "US"} (age: ${ageMin}m)`);
        // CRITICAL: Clear time-relative sales counts from IDB cache.
        // These values (units_sold_today, 7d, 30d) are stale — they were correct
        // at cache-write time but "today" has likely changed. The live sales poll
        // (or background refresh) will fill in correct values within seconds.
        const sanitized = (idbCached.data as any[]).map((row: any) => ({
          ...row,
          units_sold_today: null,
          units_sold_7d: null,
          units_sold_30d: null,
        }));
        setData(sanitized as T);
        setLoading(false);
        lastFetchTimestampRef.current = idbCached.timestamp;
        // Background refresh — silent, won't show loading spinner
        fetchDataInternal(true, epoch);
      } else {
        console.log(`[RepricerCache] No valid cache for ${cacheKeySuffix || "US"}, fetching fresh`);
        setData(null);
        fetchDataInternal(false, epoch);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, cacheKey]);

  // Force refresh
  const refresh = useCallback(async () => {
    await fetchDataInternal(false, effectEpochRef.current);
  }, [fetchDataInternal]);

  // Update data in place
  const updateData = useCallback((updater: (prev: T | null) => T | null) => {
    updateGenRef.current++;
    setDataRaw(prev => {
      const newData = updater(prev);
      dataRef.current = newData;
      if (newData) {
        setCachedData(newData);
      }
      return newData;
    });
  }, [setCachedData]);

  // Clear cache
  const clearCache = useCallback(() => {
    if (!userId) return;
    try {
      sessionStorage.removeItem(cacheKey);
    } catch (e) {
      console.warn("Failed to clear repricer cache:", e);
    }
  }, [userId, cacheKey]);

  return {
    data,
    loading,
    isRefreshing,
    refresh,
    updateData,
    clearCache,
  };
}
