import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

export interface MarketplaceCoverage {
  marketplace: string;
  active: number;
  checked: number;
  coveragePct: number;
  withActions: number;
  priceChanges: number;
  emptySnapshots: number;
  totalSnapshots: number;
  emptyPct: number;
}

export type QuotaTimeWindow = "1h" | "4h" | "12h" | "24h";

export interface QuotaErrorWindows {
  h1: number;
  h4: number;
  h12: number;
  h24: number;
}

export interface QuotaHealthData {
  emptySnapshotPercent: number;
  totalSnapshots: number;
  emptySnapshots: number;
  quotaErrors24h: number;
  quotaErrorWindows: QuotaErrorWindows;
  skusEvaluatedToday: number;
  skusWithPriceChanges: number;
  totalActions: number;
  totalAssignments: number;
  activeAssignments: number;
  eligibleAssignments: number;
  noRuleCount: number;
  noUsListingCount: number;
  disabledCount: number;
  checkedToday: number;
  checkedEligibleToday: number;
  uniqueAsinsChecked: number;
  uniqueActiveAsins: number;
  uniqueEligibleAsins: number;
  uniqueEligibleAsinsCheckedToday: number;
  coveragePercent: number;
  eligibleCoveragePercent: number;
  uniqueCoveragePercent: number;
  uniqueEligibleCoveragePercent: number;
  avgCycleDurationMs: number | null;
  lastCycleSkus: number;
  marketplaceBreakdown: MarketplaceCoverage[];
  cacheFallbackSaves: number;
}

export interface MonitorData {
  schedulerRuns: number;
  lastRunTime: string | null;
  schedulerHealthy: boolean;
  feedsSubmitted: number;
  lastFeedTime: string | null;
  feedCompletionRate: number;
  feedsCompleted: number;
  verificationRate: number;
  verifiedCount: number;
  completedCount: number;
  mismatchCount: number;
  topMismatchAsins: string[];
  profitGuardBlocks: number;
  topProfitGuardAsins: string[];
  checklistCompletion: number;
  quotaHealth: QuotaHealthData;
  loading: boolean;
  refresh: () => void;
}

type MonitorSnapshot = Omit<MonitorData, "refresh" | "loading">;

const EMPTY_SNAPSHOT: MonitorSnapshot = {
  schedulerRuns: 0,
  lastRunTime: null,
  schedulerHealthy: false,
  feedsSubmitted: 0,
  lastFeedTime: null,
  feedCompletionRate: 0,
  feedsCompleted: 0,
  verificationRate: 0,
  verifiedCount: 0,
  completedCount: 0,
  mismatchCount: 0,
  topMismatchAsins: [],
  profitGuardBlocks: 0,
  topProfitGuardAsins: [],
  checklistCompletion: 0,
  quotaHealth: {
    emptySnapshotPercent: 0,
    totalSnapshots: 0,
    emptySnapshots: 0,
    quotaErrors24h: 0,
    quotaErrorWindows: { h1: 0, h4: 0, h12: 0, h24: 0 },
    skusEvaluatedToday: 0,
    skusWithPriceChanges: 0,
    totalActions: 0,
    totalAssignments: 0,
    activeAssignments: 0,
    eligibleAssignments: 0,
    noRuleCount: 0,
    noUsListingCount: 0,
    disabledCount: 0,
    checkedToday: 0,
    checkedEligibleToday: 0,
    uniqueAsinsChecked: 0,
    uniqueActiveAsins: 0,
    uniqueEligibleAsins: 0,
    uniqueEligibleAsinsCheckedToday: 0,
    coveragePercent: 0,
    eligibleCoveragePercent: 0,
    uniqueCoveragePercent: 0,
    uniqueEligibleCoveragePercent: 0,
    avgCycleDurationMs: null,
    lastCycleSkus: 0,
    marketplaceBreakdown: [],
    cacheFallbackSaves: 0,
  },
};

/**
 * ───────────────────────────────────────────────────────────────────────────
 * Single-flight cache shared across all useMonitorData mounts.
 *
 * Problem this fixes:
 *   When Repricer, RepricerMonitor, SimpleMonitor, and SafeModePanel mount at
 *   the same time, each independently called fetchAllAssignments() and pulled
 *   ~5k JSON rows through PostgREST. That query alone was 28% of DB CPU.
 *
 * How it works:
 *   - Cache is keyed by `${userId}::${marketplace ?? ''}` so different
 *     marketplaces still get their own fetches (correctness preserved).
 *   - All concurrent hook mounts on the same key share ONE in-flight promise.
 *   - A successful fetch is cached for FRESH_MS — subsequent mounts within
 *     that window hydrate from cache instead of refetching.
 *   - Subscribers are notified on every snapshot update so the 5-min interval
 *     keeps everything in sync.
 *   - Explicit refresh() ignores the freshness window.
 *
 * No DB schema, RPC, repricer logic, evaluator, rules, cron, or marketplace
 * logic is touched. The returned MonitorData shape is identical.
 * ───────────────────────────────────────────────────────────────────────────
 */
type StoreEntry = {
  snapshot: MonitorSnapshot;
  loading: boolean;
  lastFetchAt: number;
  inflight: Promise<void> | null;
  subscribers: Set<(s: { snapshot: MonitorSnapshot; loading: boolean }) => void>;
};

const store = new Map<string, StoreEntry>();
const FRESH_MS = 4 * 60_000; // dedupe within ~4 min (interval is 5 min)

function getEntry(key: string): StoreEntry {
  let e = store.get(key);
  if (!e) {
    e = {
      snapshot: EMPTY_SNAPSHOT,
      loading: true,
      lastFetchAt: 0,
      inflight: null,
      subscribers: new Set(),
    };
    store.set(key, e);
  }
  return e;
}

function notify(entry: StoreEntry) {
  entry.subscribers.forEach((cb) =>
    cb({ snapshot: entry.snapshot, loading: entry.loading }),
  );
}

async function runFetch(
  key: string,
  userId: string,
  marketplace: string | undefined,
): Promise<void> {
  const entry = getEntry(key);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();
  const twentyFourHoursAgo = new Date(
    Date.now() - 24 * 60 * 60 * 1000,
  ).toISOString();

  // Server-side aggregate: replaces the previous paginated row pull of
  // repricer_assignments (~5k JSON rows per mount) which was the single
  // largest DB-CPU consumer (~38% via PostgREST serialization).
  // We only need counts / distincts / checked-today — all computed in SQL.
  async function fetchAssignmentStats(): Promise<Record<string, any>> {
    const { data, error } = await (supabase.rpc as any)(
      "get_monitor_assignment_stats",
      { p_user_id: userId, p_today_start: todayISO },
    );
    if (error) {
      console.warn("get_monitor_assignment_stats failed:", error);
      return {};
    }
    return (data?.per_marketplace ?? {}) as Record<string, any>;
  }

  try {
    const [
      feedsRes,
      actionsRes,
      settingsRes,
      checksRes,
      snapshotsRes,
      assignmentsAll,
      mktSnapshotsRes,
    ] = await Promise.all([
      supabase
        .from("repricer_feed_submissions")
        .select("*")
        .eq("user_id", userId)
        .gte("submitted_at", todayISO)
        .order("submitted_at", { ascending: false }),
      supabase
        .from("repricer_price_actions")
        .select(
          "asin, sku, marketplace, action_type, success, error_type, error_message, intelligence_factors, update_method, created_at",
        )
        .eq("user_id", userId)
        .gte("created_at", todayISO),
      supabase
        .from("repricer_settings")
        .select("last_scheduler_run_at, scheduler_enabled, scheduler_status")
        .limit(1)
        .maybeSingle(),
      supabase
        .from("repricer_monitor_checks")
        .select("step_key, is_checked")
        .eq("user_id", userId)
        .eq("check_date", new Date().toISOString().split("T")[0]),
      supabase
        .from("repricer_competitor_snapshots")
        .select(
          "id, offers_json, offers_count, source, fetched_at, buybox_price, lowest_fba_price, lowest_overall_price",
        )
        .eq("user_id", userId)
        .gte("fetched_at", twentyFourHoursAgo)
        .order("fetched_at", { ascending: false })
        .limit(500),
      fetchAssignmentStats(),
      supabase
        .from("repricer_competitor_snapshots")
        .select(
          "id, marketplace, buybox_price, lowest_fba_price, lowest_overall_price, offers_json, offers_count, fetched_at",
        )
        .eq("user_id", userId)
        .gte("fetched_at", todayISO)
        .limit(1000),
    ]);

    const feeds = (feedsRes.data || []) as any[];
    const actions = (actionsRes.data || []) as any[];
    const settings = settingsRes.data as any;
    const checks = (checksRes.data || []) as any[];
    const snapshots = (snapshotsRes.data || []) as any[];
    const statsPerMkt = (assignmentsAll || {}) as Record<string, any>;
    const mktSnapshots = (mktSnapshotsRes.data || []) as any[];

    const lastRun = settings?.last_scheduler_run_at;
    const lastRunDate = lastRun ? new Date(lastRun) : null;
    const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000);
    const schedulerHealthy = !!lastRunDate && lastRunDate > sixtyMinAgo;

    const schedulerRuns = feeds.length;

    const completedFeeds = feeds.filter((f: any) =>
      ["completed", "DONE", "DONE_NO_REPORT"].includes(f.status),
    );
    const feedCompletionRate =
      feeds.length > 0
        ? Math.round((completedFeeds.length / feeds.length) * 100)
        : 100;

    const feedActions = actions.filter(
      (a: any) => a.update_method === "FEED" && a.success,
    );
    const verifiedActions = feedActions.filter(
      (a: any) => a.intelligence_factors?.verification?.confirmed === true,
    );
    const unverifiedActions = feedActions.filter(
      (a: any) => a.intelligence_factors?.verification?.confirmed === false,
    );
    const verificationRate =
      feedActions.length > 0
        ? Math.round((verifiedActions.length / feedActions.length) * 100)
        : 100;

    const mismatchAsins = unverifiedActions.map((a: any) => a.asin);

    const profitGuardActions = actions.filter(
      (a: any) =>
        a.action_type === "blocked_by_profit_guard" ||
        a.error_type === "profit_guard",
    );
    const pgAsins = [
      ...new Set(profitGuardActions.map((a: any) => a.asin)),
    ].slice(0, 3);

    const totalSteps = 6;
    const checkedSteps = checks.filter((c: any) => c.is_checked).length;
    const checklistCompletion = Math.round((checkedSteps / totalSteps) * 100);

    const totalSnapshotsCount = snapshots.length;
    const emptySnapshotsCount = snapshots.filter((s: any) => {
      const hasPricingData =
        s.buybox_price ||
        s.lowest_fba_price ||
        s.lowest_overall_price ||
        (s.offers_json &&
          Array.isArray(s.offers_json) &&
          s.offers_json.length > 0);
      return !hasPricingData;
    }).length;
    const emptySnapshotPercent =
      totalSnapshotsCount > 0
        ? Math.round((emptySnapshotsCount / totalSnapshotsCount) * 100)
        : 0;

    const now = Date.now();
    const isQuotaError = (a: any) => {
      if (a.success === true && !a.error_message) return false;
      const errMsg = (a.error_message || "").toLowerCase();
      return (
        errMsg.includes("quota") ||
        errMsg.includes("429") ||
        errMsg.includes("throttl")
      );
    };
    const quotaActions = actions.filter(isQuotaError);
    const countInWindow = (ms: number) =>
      quotaActions.filter((a: any) => {
        const ts = new Date(a.created_at).getTime();
        return ts >= now - ms;
      }).length;
    const quotaErrorWindows: QuotaErrorWindows = {
      h1: countInWindow(1 * 60 * 60 * 1000),
      h4: countInWindow(4 * 60 * 60 * 1000),
      h12: countInWindow(12 * 60 * 60 * 1000),
      h24: quotaActions.length,
    };
    const quotaErrors = quotaErrorWindows.h24;

    const skusWithChanges = new Set(
      actions
        .filter((a: any) => {
          if (a.success !== true) return false;
          const at = (a.action_type || "").toLowerCase();
          const um = (a.update_method || "").toLowerCase();
          return (
            at === "price_change" ||
            at === "changed" ||
            at === "write" ||
            um === "direct_patch" ||
            um === "patch"
          );
        })
        .map((a: any) => a.asin),
    );
    const skusWithPriceChanges = skusWithChanges.size;

    const evaluatedAsins = new Set(actions.map((a: any) => a.asin));
    const skusEvaluatedToday = evaluatedAsins.size;

    // Pick the marketplaces this view aggregates over. The RPC already
    // computed per-marketplace stats; no row-level work happens client-side.
    const mktKeys = Object.keys(statsPerMkt);
    const selectedMkts = marketplace
      ? mktKeys.filter((m) => m === marketplace)
      : mktKeys;

    const sum = (key: string) =>
      selectedMkts.reduce(
        (acc, m) => acc + Number(statsPerMkt[m]?.[key] ?? 0),
        0,
      );

    const totalAssignments = sum("total");
    const inactiveCount = sum("inactive");
    const disabledCount = sum("disabled");
    const noUsListingCount = sum("no_us_listing");
    const noRuleCount = sum("no_rule");
    const eligibleAssignments = sum("eligible");
    const activeAssignments = totalAssignments - inactiveCount;
    const checkedToday = sum("checked_today");
    const checkedEligibleToday = sum("checked_eligible_today");

    // unique-ASIN counters are per-marketplace in the RPC; when the view
    // aggregates multiple marketplaces we conservatively sum them — the same
    // behavior as before, since assignments are 1-row-per-(user, mkt, asin).
    const uniqueAsinsChecked = sum("unique_asins_checked");
    const uniqueActiveAsins = sum("unique_active_asins");
    const uniqueEligibleAsins = sum("unique_eligible_asins");
    const uniqueEligibleAsinsCheckedToday = sum(
      "unique_eligible_asins_checked_today",
    );

    const cacheFallbackSaves = actions.filter((a: any) => {
      const factors = a.intelligence_factors || {};
      return (
        factors.snapshot_source === "cache" ||
        factors.snapshot_source === "lkg"
      );
    }).length;

    const coveragePercent =
      activeAssignments > 0
        ? Math.round((checkedToday / activeAssignments) * 100)
        : 0;
    const eligibleCoveragePercent =
      eligibleAssignments > 0
        ? Math.round((checkedEligibleToday / eligibleAssignments) * 100)
        : 0;
    const uniqueCoveragePercent =
      uniqueActiveAsins > 0
        ? Math.round((uniqueAsinsChecked / uniqueActiveAsins) * 100)
        : 0;
    const uniqueEligibleCoveragePercent =
      uniqueEligibleAsins > 0
        ? Math.round(
            (uniqueEligibleAsinsCheckedToday / uniqueEligibleAsins) * 100,
          )
        : 0;

    const marketplaces: string[] = mktKeys;
    const marketplaceBreakdown: MarketplaceCoverage[] = marketplaces
      .map((mkt) => {
        const s = statsPerMkt[mkt] || {};
        const mktActive = Number(s.active ?? 0);
        const mktChecked = Number(s.checked_today ?? 0);
        const mktActions = actions.filter(
          (a: any) => (a.marketplace || "US") === mkt,
        );
        const mktWithActions = new Set(
          mktActions.filter((a: any) => a.success).map((a: any) => a.asin),
        ).size;
        const mktPriceChanges = new Set(
          mktActions
            .filter((a: any) => a.action_type === "price_change" && a.success)
            .map((a: any) => a.asin),
        ).size;
        const mktSnaps = mktSnapshots.filter(
          (s: any) => (s.marketplace || "US") === mkt,
        );
        const mktEmptySnaps = mktSnaps.filter((s: any) => {
          const hasPricingData =
            s.buybox_price ||
            s.lowest_fba_price ||
            s.lowest_overall_price ||
            (s.offers_json &&
              Array.isArray(s.offers_json) &&
              s.offers_json.length > 0);
          return !hasPricingData;
        }).length;

        return {
          marketplace: mkt,
          active: mktActive,
          checked: mktChecked,
          coveragePct:
            mktActive > 0 ? Math.round((mktChecked / mktActive) * 100) : 0,
          withActions: mktWithActions,
          priceChanges: mktPriceChanges,
          emptySnapshots: mktEmptySnaps,
          totalSnapshots: mktSnaps.length,
          emptyPct:
            mktSnaps.length > 0
              ? Math.round((mktEmptySnaps / mktSnaps.length) * 100)
              : 0,
        };
      })
      .sort((a, b) => b.active - a.active);

    entry.snapshot = {
      schedulerRuns,
      lastRunTime: lastRun ? new Date(lastRun).toLocaleString() : null,
      schedulerHealthy,
      feedsSubmitted: feeds.length,
      lastFeedTime: feeds[0]?.submitted_at
        ? new Date(feeds[0].submitted_at).toLocaleString()
        : null,
      feedCompletionRate,
      feedsCompleted: completedFeeds.length,
      verificationRate,
      verifiedCount: verifiedActions.length,
      completedCount: feedActions.length,
      mismatchCount: unverifiedActions.length,
      topMismatchAsins: [...new Set(mismatchAsins)].slice(0, 5) as string[],
      profitGuardBlocks: profitGuardActions.length,
      topProfitGuardAsins: pgAsins as string[],
      checklistCompletion,
      quotaHealth: {
        emptySnapshotPercent,
        totalSnapshots: totalSnapshotsCount,
        emptySnapshots: emptySnapshotsCount,
        quotaErrors24h: quotaErrors,
        quotaErrorWindows,
        skusEvaluatedToday,
        skusWithPriceChanges,
        totalActions: actions.length,
        totalAssignments,
        activeAssignments,
        eligibleAssignments,
        noRuleCount,
        noUsListingCount,
        disabledCount,
        checkedToday,
        checkedEligibleToday,
        uniqueAsinsChecked,
        uniqueActiveAsins,
        uniqueEligibleAsins,
        uniqueEligibleAsinsCheckedToday,
        coveragePercent,
        eligibleCoveragePercent,
        uniqueCoveragePercent,
        uniqueEligibleCoveragePercent,
        avgCycleDurationMs: null,
        lastCycleSkus: actions.filter((a: any) => a.success).length,
        marketplaceBreakdown,
        cacheFallbackSaves,
      },
    };
    entry.lastFetchAt = Date.now();
  } catch (err) {
    console.error("Monitor data fetch error:", err);
  } finally {
    entry.loading = false;
    entry.inflight = null;
    notify(entry);
  }
}

function ensureFetch(
  key: string,
  userId: string,
  marketplace: string | undefined,
  force = false,
): Promise<void> {
  const entry = getEntry(key);
  if (entry.inflight) return entry.inflight;
  if (!force && entry.lastFetchAt && Date.now() - entry.lastFetchAt < FRESH_MS) {
    return Promise.resolve();
  }
  entry.loading = entry.lastFetchAt === 0; // only show spinner on first load
  entry.inflight = runFetch(key, userId, marketplace);
  return entry.inflight;
}

export function useMonitorData(marketplace?: string): MonitorData {
  const { user } = useAuth();
  const key = user ? `${user.id}::${marketplace ?? ""}` : "";
  const initial = key ? getEntry(key) : null;

  const [snapshot, setSnapshot] = useState<MonitorSnapshot>(
    initial?.snapshot ?? EMPTY_SNAPSHOT,
  );
  const [loading, setLoading] = useState<boolean>(initial?.loading ?? true);
  const keyRef = useRef(key);
  keyRef.current = key;

  // Subscribe to the shared store for this key
  useEffect(() => {
    if (!key || !user) return;
    const entry = getEntry(key);
    const cb = (s: { snapshot: MonitorSnapshot; loading: boolean }) => {
      setSnapshot(s.snapshot);
      setLoading(s.loading);
    };
    entry.subscribers.add(cb);
    // Hydrate immediately from cache if present
    setSnapshot(entry.snapshot);
    setLoading(entry.loading);
    // Kick off a fetch (deduped + freshness-gated)
    ensureFetch(key, user.id, marketplace);
    return () => {
      entry.subscribers.delete(cb);
    };
  }, [key, user, marketplace]);

  const refresh = useCallback(() => {
    if (!key || !user) return;
    ensureFetch(key, user.id, marketplace, true);
  }, [key, user, marketplace]);

  // Manual-refresh only: subscribe to the global Monitor "Refresh" button.
  // Initial fetch still runs on mount via ensureFetch above; no periodic polling.
  useEffect(() => {
    const unsub = onMonitorRefresh(refresh);
    return () => unsub();
  }, [refresh]);

  return { ...snapshot, loading, refresh };
}
