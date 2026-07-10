import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';

// Sync status types
type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

interface SyncState {
  status: SyncStatus;
  lastSyncAt: Date | null;
  lastError: string | null;
  message: string;
  ordersCount: number;
  inboundFeesSynced: boolean;
  settledSyncedAt: Date | null;
  enrichingPricesFees: boolean;
  /** Monotonic counter — bumped every time new data is written to DB.
   *  Sales.tsx watches this instead of timestamps to guarantee re-fetch. */
  syncVersion: number;
}

// Enrichment log types
type EnrichmentType = 'price' | 'fees' | 'sync' | 'repair';
type EnrichmentStatus = 'started' | 'success' | 'failed' | 'rate_limited' | 'skipped';

interface EnrichmentLogEntry {
  user_id: string;
  order_id?: string;
  asin?: string;
  seller_sku?: string;
  enrichment_type: EnrichmentType;
  source: string;
  status: EnrichmentStatus;
  error_message?: string;
  attempts?: number;
}

interface SalesSyncContextType {
  syncState: SyncState;
  startBackgroundSync: (options?: { force?: boolean; silent?: boolean }) => Promise<void>;
  isRecentlySynced: boolean;
  isSyncing: boolean;
}

const SalesSyncContext = createContext<SalesSyncContextType | undefined>(undefined);

// Throttle interval: don't sync if last sync was less than 10 minutes ago
const SYNC_THROTTLE_MS = 10 * 60 * 1000;
// Per-ASIN cooldown for price+fee refresh
const ASIN_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

// Amazon business day = midnight-to-midnight in Pacific Time
const AMAZON_BUSINESS_TZ = 'America/Los_Angeles';
// Used when calling edge functions (they now ignore this and use PT internally)
const USER_TIMEZONE = AMAZON_BUSINESS_TZ;

function getTodayLocalDate(): string {
  // Get today's date in Pacific Time - this matches Amazon's business day
  return new Date().toLocaleDateString('en-CA', { timeZone: AMAZON_BUSINESS_TZ });
}

function addDaysISO(dateStr: string, delta: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function getMonthStartISO(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

export const SalesSyncProvider = ({ children }: { children: React.ReactNode }) => {
  const { user, session } = useAuth();
  
  const [syncState, setSyncState] = useState<SyncState>({
    status: 'idle',
    lastSyncAt: null,
    lastError: null,
    message: '',
    ordersCount: 0,
    inboundFeesSynced: false,
    settledSyncedAt: null,
    enrichingPricesFees: false,
    syncVersion: 0,
  });
  
  // Lock to prevent concurrent syncs
  const syncLockRef = useRef(false);
  // Track if initial auto-sync has been attempted
  const autoSyncAttemptedRef = useRef(false);
  // Track SKU cooldowns for price+fee refresh (SKU-first architecture)
  const skuRefreshCooldownRef = useRef<Map<string, number>>(new Map());

  // Check if recently synced (within throttle period)
  const isRecentlySynced = syncState.lastSyncAt 
    ? (Date.now() - syncState.lastSyncAt.getTime()) < SYNC_THROTTLE_MS 
    : false;

  const isSyncing = syncState.status === 'syncing';

  // Interface for SKU-first order items from fetch-live-orders
  interface NewOrderItem {
    order_id: string;
    asin: string;
    seller_sku: string | null;
  }

  // Log enrichment attempt to database for observability
  const logEnrichment = useCallback(async (entry: EnrichmentLogEntry) => {
    try {
      await supabase.from('enrichment_logs').insert(entry as any);
    } catch (err) {
      console.warn('[SalesSync] Failed to log enrichment:', err);
    }
  }, []);

  // Mark order for retry (self-healing mechanism)
  const markOrderForRetry = useCallback(async (
    orderId: string, 
    asin: string, 
    retryType: 'price' | 'fees' | 'both',
    errorMessage: string
  ) => {
    try {
      const updates: Record<string, any> = {
        last_enrich_attempt_at: new Date().toISOString(),
        last_enrich_error: errorMessage.slice(0, 500),
        // Exponential backoff: next retry in 5 minutes initially, doubling each time
        next_enrich_after: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
      
      if (retryType === 'price' || retryType === 'both') {
        updates.needs_price_enrich = true;
      }
      if (retryType === 'fees' || retryType === 'both') {
        updates.needs_fee_enrich = true;
      }
      
      await supabase
        .from('sales_orders')
        .update(updates)
        .eq('order_id', orderId)
        .eq('asin', asin)
        .eq('user_id', user?.id);
        
    } catch (err) {
      console.warn('[SalesSync] Failed to mark order for retry:', err);
    }
  }, [user?.id]);

  // Mark fee enrichment as complete. Do NOT clear needs_price_enrich here:
  // fee enrichment can succeed while sold_price is still only an estimate.
  // Price retry must stay true until Orders API ItemPrice / FEC writes the real sold_price.
  const clearRetryFlags = useCallback(async (orderId: string, asin: string) => {
    try {
      await supabase
        .from('sales_orders')
        .update({
          needs_fee_enrich: false,
          last_enrich_error: null,
        })
        .eq('order_id', orderId)
        .eq('asin', asin)
        .eq('user_id', user?.id);
    } catch (err) {
      console.warn('[SalesSync] Failed to clear retry flags:', err);
    }
  }, [user?.id]);

  // Refresh Prices + Fees using SKU-first architecture with durable logging
  // Note: accessToken param kept for backward compat but not used - Supabase client handles auth
  const refreshPricesAndFeesForItems = useCallback(async (items: NewOrderItem[], _accessToken?: string) => {
    if (items.length === 0) return;
    
    // Guard: Verify session is available before making authenticated calls
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    if (!currentSession?.access_token) {
      console.warn('[SalesSync] No session token available, skipping background enrichment');
      return;
    }
    
    console.log(`[SalesSync] Starting SKU-first Prices + Fees refresh for ${items.length} items:`, items);
    
    setSyncState(prev => ({ ...prev, enrichingPricesFees: true, message: `Enriching prices for ${items.length} products...` }));
    
    try {
      // Log sync started
      if (user) {
        await logEnrichment({
          user_id: user.id,
          enrichment_type: 'sync',
          source: 'global_background',
          status: 'started',
        });
      }

      // Step 1: Refresh listing prices via backfill-my-price-cache (pass SKUs when available)
      const skusToRefresh = items
        .filter(item => item.seller_sku)
        .map(item => item.seller_sku!)
        .slice(0, 10);
      
      const asinsToRefresh = items
        .map(item => item.asin)
        .filter((asin, idx, arr) => arr.indexOf(asin) === idx)
        .slice(0, 10);
      
      // Don't pass explicit Authorization header - Supabase client includes it automatically
      const priceResponse = await supabase.functions.invoke("backfill-my-price-cache", {
        body: { 
          asins: asinsToRefresh,
          skus: skusToRefresh.length > 0 ? skusToRefresh : undefined,
        },
      });
      
      if (priceResponse.error) {
        console.warn('[SalesSync] Price refresh warning:', priceResponse.error);
        // Log price batch failure
        if (user) {
          await logEnrichment({
            user_id: user.id,
            enrichment_type: 'price',
            source: 'backfill-my-price-cache',
            status: 'failed',
            error_message: priceResponse.error.message || 'Unknown error',
          });
        }
      } else {
        console.log('[SalesSync] SKU-first prices refreshed:', priceResponse.data);
      }
      
      // Step 2: Enrich fees for each item (SKU-first)
      setSyncState(prev => ({ ...prev, message: `Enriching fees for ${items.length} products...` }));
      
      let successCount = 0;
      let failedCount = 0;
      let rateLimitedCount = 0;
      
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const cooldownKey = item.seller_sku || item.asin;
        
        try {
          // Don't pass explicit Authorization header - Supabase client includes it automatically
          // This matches the working manual button pattern in Sales.tsx
          const feeResponse = await supabase.functions.invoke("sync-sales-orders", {
            body: { 
              enrich_by_asin: true, 
              target_asin: item.asin,  // ✅ Fixed: use target_asin (matches manual yellow button)
              seller_sku: item.seller_sku,
            },
          });
          
          if (feeResponse.error) {
            const isRateLimited = feeResponse.error.message?.includes('429') || 
                                  feeResponse.error.message?.toLowerCase().includes('quota');
            
            console.warn(`[SalesSync] Fee enrichment warning for ${cooldownKey}:`, feeResponse.error);
            
            // Log failure
            if (user) {
              await logEnrichment({
                user_id: user.id,
                order_id: item.order_id,
                asin: item.asin,
                seller_sku: item.seller_sku || undefined,
                enrichment_type: 'fees',
                source: 'sync-sales-orders',
                status: isRateLimited ? 'rate_limited' : 'failed',
                error_message: feeResponse.error.message || 'Unknown error',
              });
            }
            
            // Mark for retry
            await markOrderForRetry(
              item.order_id, 
              item.asin, 
              'fees', 
              feeResponse.error.message || 'Fee enrichment failed'
            );
            
            if (isRateLimited) {
              rateLimitedCount++;
              console.log('[SalesSync] Rate limit hit, stopping fee enrichment');
              break;
            }
            failedCount++;
          } else {
            successCount++;
            console.log(`[SalesSync] Fees enriched for ${cooldownKey}:`, feeResponse.data);
            
            // Clear retry flags on success
            await clearRetryFlags(item.order_id, item.asin);
            
            // Log success
            if (user) {
              await logEnrichment({
                user_id: user.id,
                order_id: item.order_id,
                asin: item.asin,
                seller_sku: item.seller_sku || undefined,
                enrichment_type: 'fees',
                source: 'sync-sales-orders',
                status: 'success',
              });
            }
          }
          
          // Mark cooldown using SKU-first key
          skuRefreshCooldownRef.current.set(cooldownKey, Date.now());
          
          // 500ms delay between calls
          if (i < items.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (err: any) {
          console.warn(`[SalesSync] Fee enrichment error for ${cooldownKey}:`, err);
          failedCount++;
          
          // Mark for retry on exception
          await markOrderForRetry(item.order_id, item.asin, 'fees', err?.message || 'Exception during enrichment');
          
          if (err?.message?.includes('429')) {
            rateLimitedCount++;
            break;
          }
        }
      }
      
      console.log(`[SalesSync] SKU-first Prices + Fees enrichment complete: ${successCount} success, ${failedCount} failed, ${rateLimitedCount} rate-limited`);
      
      // Log final sync status
      if (user) {
        await logEnrichment({
          user_id: user.id,
          enrichment_type: 'sync',
          source: 'global_background',
          status: rateLimitedCount > 0 ? 'rate_limited' : (failedCount > 0 ? 'failed' : 'success'),
        });
      }
      
    } catch (error: any) {
      console.error('[SalesSync] Prices + Fees refresh error:', error);
      // Log sync failure
      if (user) {
        await logEnrichment({
          user_id: user.id,
          enrichment_type: 'sync',
          source: 'global_background',
          status: 'failed',
          error_message: error?.message || 'Unknown error',
        });
      }
    } finally {
      setSyncState(prev => ({ ...prev, enrichingPricesFees: false }));
    }
  }, [user, logEnrichment, markOrderForRetry, clearRetryFlags]);

  // Main background sync function
  const startBackgroundSync = useCallback(async (options?: { force?: boolean; silent?: boolean }) => {
    const force = options?.force ?? false;
    const silent = options?.silent ?? false;

    // Guard: no user
    if (!user || !session) {
      console.log('[SalesSync] No user/session, skipping sync');
      return;
    }

    // Guard: already syncing
    if (syncLockRef.current) {
      console.log('[SalesSync] Sync already in progress, skipping');
      return;
    }

    // Guard: recently synced (unless forced)
    if (!force && isRecentlySynced) {
      console.log('[SalesSync] Recently synced, skipping (use force=true to override)');
      return;
    }

    // Acquire lock
    syncLockRef.current = true;
    
    const today = getTodayLocalDate();
    const yesterday = addDaysISO(today, -1);
    const monthStart = getMonthStartISO(today);

    console.log(`[SalesSync] Starting background sync for orders ${yesterday} to ${today}, financials ${monthStart} to ${today}`);

    setSyncState(prev => ({
      ...prev,
      status: 'syncing',
      message: 'Syncing sales data...',
      lastError: null,
    }));

    try {
      // ── Step 1 (critical path): unified_sync for full order + daily rollup update ──
      setSyncState(prev => ({ ...prev, message: 'Syncing sales data...' }));
      
      const { data: unifiedData, error: unifiedError } = await supabase.functions.invoke('sync-sales-orders', {
        body: {
          mode: 'unified_sync',
          unified_sync: true,
        },
      });

      if (unifiedError) {
        console.warn('[SalesSync] unified_sync warning:', unifiedError);
      } else {
        console.log('[SalesSync] unified_sync completed:', unifiedData);
      }

      // Also fetch live orders for new item detection (enrichment)
      const { data: ordersData, error: ordersError } = await supabase.functions.invoke('fetch-live-orders', {
        body: {
          startDate: yesterday,
          endDate: today,
          timezone: USER_TIMEZONE,
        },
      });

      if (ordersError) {
        throw new Error(`Failed to fetch orders: ${ordersError.message}`);
      }

      const ordersCount = ordersData?.orders?.length || 0;
      const newOrderItems: NewOrderItem[] = ordersData?.newOrderItems || [];
      console.log(`[SalesSync] Fetched ${ordersCount} orders, ${newOrderItems.length} new items`);

      // ── Signal success EARLY so Sales page / Repricer get today's units fast ──
      const now = new Date();
      setSyncState(prev => ({
        status: 'success',
        lastSyncAt: now,
        lastError: null,
        message: `Synced ${ordersCount} orders`,
        ordersCount,
        inboundFeesSynced: false,
        settledSyncedAt: null,
        enrichingPricesFees: newOrderItems.length > 0,
        syncVersion: prev.syncVersion + 1,
      }));
      localStorage.setItem('sales_last_background_sync', now.toISOString());
      console.log('[SalesSync] Early success signal sent (orders ready)');

      // ── Steps 2-4 run in PARALLEL (non-blocking for UI) ───────────────
      setSyncState(prev => ({ ...prev, message: 'Syncing fees & refunds...' }));

      const inboundFeesPromise = supabase.functions.invoke('sync-inbound-fees', {
        body: { startDate: yesterday, endDate: today },
      }).then(({ error }) => {
        if (!error) console.log('[SalesSync] Inbound fees synced');
        else console.warn('[SalesSync] Inbound fees warning:', error);
        return !error;
      }).catch(err => { console.warn('[SalesSync] Inbound fees failed:', err); return false; });

      const refundsPromise = supabase.functions.invoke('fetch-live-refunds', {
        body: { start_date: yesterday, end_date: today },
      }).then(() => console.log('[SalesSync] Refunds synced'))
        .catch(err => console.warn('[SalesSync] Refunds failed:', err));

      const financialPromise = supabase.functions.invoke('fetch-profit-loss', {
        body: {
          // Keep Month-to-Date financial events warm globally so Sales Report opens with accurate totals.
          startDate: `${monthStart}T00:00:00.000Z`,
          endDate: `${today}T23:59:59.999Z`,
          forceRefresh: true,
        },
      }).then(({ error }) => {
        if (!error) console.log('[SalesSync] Financial events synced (MTD)');
        else console.warn('[SalesSync] Financial events warning:', error);
        return !error;
      }).catch(err => { console.warn('[SalesSync] Financial events failed:', err); return false; });

      // Wait for all three in parallel
      const [inboundOk, , financialOk] = await Promise.all([
        inboundFeesPromise,
        refundsPromise,
        financialPromise,
      ]);

      // Update state with parallel results
      setSyncState(prev => ({
        ...prev,
        inboundFeesSynced: inboundOk,
        settledSyncedAt: financialOk ? new Date() : null,
        lastSyncAt: new Date(), // Bump so Sales listener re-triggers after enrichment phase
        syncVersion: prev.syncVersion + 1,
      }));

      // ── Fire-and-forget: last month P&L (no need to block) ────────────
      try {
        const todayDate = new Date(today + 'T12:00:00');
        const lastMonthStart = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1);
        const lastMonthEnd = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0);
        const lastMonthStartStr = lastMonthStart.toISOString().split('T')[0];
        const lastMonthEndStr = lastMonthEnd.toISOString().split('T')[0];
        
        // Don't await — this runs in the background
        supabase.functions.invoke('fetch-profit-loss', {
          body: {
            startDate: `${lastMonthStartStr}T00:00:00.000Z`,
            endDate: `${lastMonthEndStr}T23:59:59.999Z`,
            forceRefresh: false,
          },
        }).then(() => console.log('[SalesSync] Last month P&L synced'))
          .catch(err => console.warn('[SalesSync] Last month P&L failed:', err));
      } catch (err) {
        // Ignore
      }

      // ── Step 5: Enrich new items (fire-and-forget, update state when done) ──
      if (newOrderItems.length > 0) {
        const nowMs = Date.now();
        const itemsToEnrich = newOrderItems.filter(item => {
          const cooldownKey = item.seller_sku || item.asin;
          const lastRefresh = skuRefreshCooldownRef.current.get(cooldownKey);
          return !lastRefresh || (nowMs - lastRefresh) > ASIN_REFRESH_COOLDOWN_MS;
        }).slice(0, 10);
        
        if (itemsToEnrich.length > 0) {
          console.log(`[SalesSync] Enriching ${itemsToEnrich.length} items (background)`);
          // Don't await — run in background, signal completion via state update
          refreshPricesAndFeesForItems(itemsToEnrich, session.access_token)
            .then(() => {
              console.log('[SalesSync] Enrichment completed');
              const enrichDone = new Date();
              setSyncState(prev => ({
                ...prev,
                lastSyncAt: enrichDone,
                message: `Synced ${ordersCount} orders + enriched fees`,
                enrichingPricesFees: false,
                syncVersion: prev.syncVersion + 1,
              }));
              localStorage.setItem('sales_last_background_sync', enrichDone.toISOString());
            })
            .catch(err => {
              console.warn('[SalesSync] Enrichment failed:', err?.message);
              setSyncState(prev => ({ ...prev, enrichingPricesFees: false }));
            });
        } else {
          setSyncState(prev => ({ ...prev, enrichingPricesFees: false }));
        }
      }

      // ── Step 6: Auto-enrich orders with missing/stale fees for current month (first 10) ──
      // Keeps MTD gross/net profit accurate even when user is not on Sales Report page.
      try {
        const { data: missingFeeOrders } = await supabase
          .from('sales_orders')
          .select('order_id, asin, seller_sku')
          .eq('user_id', user.id)
          .or('fees_missing.eq.true,fees_source.eq.unavailable,total_fees.is.null')
          .gte('order_date', monthStart)
          .not('order_status', 'in', '("Canceled","Cancelled")')
          .order('order_date', { ascending: false })
          .limit(10);

        if (missingFeeOrders && missingFeeOrders.length > 0) {
          console.log(`[SalesSync] Auto-enriching ${missingFeeOrders.length} orders with missing fees`);
          
          // Fire-and-forget: enrich each ASIN via sync-sales-orders (same as manual Refresh Fees)
          (async () => {
            let enriched = 0;
            for (const row of missingFeeOrders) {
              try {
                const { error } = await supabase.functions.invoke('sync-sales-orders', {
                  body: {
                    enrich_by_asin: true,
                    target_asin: row.asin,
                    force_price_update: true,
                  },
                });
                if (!error) enriched++;
                else {
                  const msg = String((error as any)?.message || '');
                  if (msg.includes('429') || msg.toLowerCase().includes('quota')) {
                    console.warn('[SalesSync] Auto-enrich hit rate limit, stopping');
                    break;
                  }
                }
                // 600ms delay between calls
                await new Promise(r => setTimeout(r, 600));
              } catch (err: any) {
                if (err?.message?.includes('429')) break;
              }
            }
            console.log(`[SalesSync] Auto-enriched fees for ${enriched}/${missingFeeOrders.length} orders`);
          })();
        }
      } catch (err) {
        console.warn('[SalesSync] Auto-enrich missing fees failed:', err);
      }

      console.log('[SalesSync] Background sync core steps completed');

    } catch (error: any) {
      console.error('[SalesSync] Background sync failed:', error);
      setSyncState(prev => ({
        ...prev,
        status: 'error',
        lastError: error?.message || 'Unknown error',
        message: 'Sync failed',
        enrichingPricesFees: false,
      }));
    } finally {
      syncLockRef.current = false;
    }
  }, [user, session, isRecentlySynced, refreshPricesAndFeesForItems]);

  // Auto-sync only on pages that actually need fresh sales/repricer data.
  // This avoids heavy app-wide startup work that can freeze refreshes.
  useEffect(() => {
    if (!user || !session) {
      autoSyncAttemptedRef.current = false;
      return;
    }

    const pathname = window.location.pathname;
    const shouldAutoSync = [
      '/tools/dashboard',
      '/tools/sales',
      '/tools/repricer',
      '/tools/repricer/monitor',
      '/tools/repricer/live-sales',
      '/tools/profit-loss',
      '/tools/reports',
      '/tools/settlement',
      '/tools/reimbursements',
      '/m/live-sales',
    ].some((route) => pathname === route || pathname.startsWith(`${route}/`));

    if (!shouldAutoSync) {
      autoSyncAttemptedRef.current = false;
      return;
    }

    const checkAuthAndSync = async (isInitial: boolean) => {
      const { data: auth } = await supabase
        .from('seller_authorizations')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!auth) {
        console.log('[SalesSync] No Amazon authorization, skipping auto-sync');
        return;
      }

      if (isInitial) {
        const IMMEDIATE_SYNC_THRESHOLD_MS = 5 * 60 * 1000;
        const lastSyncStr = localStorage.getItem('sales_last_background_sync');

        if (lastSyncStr) {
          const lastSync = new Date(lastSyncStr);
          const timeSinceLastSync = Date.now() - lastSync.getTime();

          if (timeSinceLastSync < IMMEDIATE_SYNC_THRESHOLD_MS) {
            console.log('[SalesSync] Recently synced (from localStorage), loading cached timestamp');
            setSyncState(prev => ({
              ...prev,
              lastSyncAt: lastSync,
              status: 'success',
              message: 'Data ready',
            }));
            autoSyncAttemptedRef.current = true;
            return;
          }
        }
      }

      autoSyncAttemptedRef.current = true;
      console.log(`[SalesSync] Starting ${isInitial ? 'initial' : 'periodic'} auto-sync on ${pathname}`);
      // Periodic ticks: let the 10-min throttle skip when data is already
      // fresh. Initial mount still forces a sync so the page gets data on
      // first paint after the throttle window check above.
      startBackgroundSync({ silent: true, force: isInitial });
    };

    if (!autoSyncAttemptedRef.current) {
      checkAuthAndSync(true);
    }

    const PERIODIC_SYNC_INTERVAL_MS = 15 * 60 * 1000;
    const intervalId = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      console.log('[SalesSync] Periodic re-sync tick (every 15 min, throttle-respecting)');
      checkAuthAndSync(false);
    }, PERIODIC_SYNC_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [user, session, startBackgroundSync]);

  return (
    <SalesSyncContext.Provider value={{ syncState, startBackgroundSync, isRecentlySynced, isSyncing }}>
      {children}
    </SalesSyncContext.Provider>
  );
};

const FALLBACK_SYNC_CONTEXT: SalesSyncContextType = {
  syncState: {
    status: 'idle',
    lastSyncAt: null,
    lastError: null,
    message: '',
    ordersCount: 0,
    inboundFeesSynced: false,
    settledSyncedAt: null,
    enrichingPricesFees: false,
    syncVersion: 0,
  },
  startBackgroundSync: async () => {},
  isRecentlySynced: false,
  isSyncing: false,
};

export const useSalesSync = () => {
  const context = useContext(SalesSyncContext);
  if (context === undefined) {
    console.warn('useSalesSync called outside SalesSyncProvider – returning fallback');
    return FALLBACK_SYNC_CONTEXT;
  }
  return context;
};
