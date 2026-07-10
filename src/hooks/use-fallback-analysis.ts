import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface FallbackAgeBucket {
  label: string;
  count: number;
  pct: number;
}

export interface FallbackOutcome {
  source: "live" | "fallback" | "skipped";
  total: number;
  actioned: number;
  actionRate: number;
}

export interface MarketplaceRecovery {
  marketplace: string;
  totalEmpty: number;
  recovered: number;
  persistent: number;
  recoveryPct: number;
}

export interface FallbackAnalysis {
  /** Total evaluations using LKG fallback */
  fallbackEvalCount: number;
  /** Total evaluations using live snapshot */
  liveEvalCount: number;
  /** Total skipped evaluations */
  skippedCount: number;
  /** Fallback age distribution */
  ageBuckets: FallbackAgeBucket[];
  /** Outcome comparison */
  outcomes: FallbackOutcome[];
  /** Safety breakdown: conservative / neutral / aggressive on fallback */
  safetyBreakdown: { conservative: number; neutral: number; aggressive: number };
  /** Recovery by marketplace */
  marketplaceRecovery: MarketplaceRecovery[];
  /** Persistent vs intermittent by marketplace */
  persistentByMarketplace: { marketplace: string; persistent: number; intermittent: number }[];
  loading: boolean;
}

export function useFallbackAnalysis(): FallbackAnalysis {
  const { user } = useAuth();
  const [data, setData] = useState<Omit<FallbackAnalysis, "loading">>({
    fallbackEvalCount: 0,
    liveEvalCount: 0,
    skippedCount: 0,
    ageBuckets: [],
    outcomes: [],
    safetyBreakdown: { conservative: 0, neutral: 0, aggressive: 0 },
    marketplaceRecovery: [],
    persistentByMarketplace: [],
  });
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayISO = todayStart.toISOString();
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Fetch price actions today (with intelligence_factors for fallback info)
      const [actionsRes, snapshotsRes] = await Promise.all([
        supabase
          .from("repricer_price_actions")
          .select("asin, marketplace, action_type, success, intelligence_factors, created_at")
          .eq("user_id", user.id)
          .gte("created_at", todayISO)
          .limit(2000),
        supabase
          .from("repricer_competitor_snapshots")
          .select("asin, marketplace, buybox_price, lowest_fba_price, lowest_overall_price, offers_json, fetched_at")
          .eq("user_id", user.id)
          .gte("fetched_at", twentyFourHoursAgo)
          .limit(2000),
      ]);

      const actions = (actionsRes.data || []) as any[];
      const snapshots = (snapshotsRes.data || []) as any[];

      // === Classify actions by data source ===
      let fallbackEvalCount = 0;
      let liveEvalCount = 0;
      let skippedCount = 0;
      let fallbackActioned = 0;
      let liveActioned = 0;
      const fallbackAgeMinutes: number[] = [];
      let conservative = 0, neutral = 0, aggressive = 0;

      for (const a of actions) {
        const factors = a.intelligence_factors || {};
        const source = factors.data_source || factors.buybox_source || factors.eval_source || "";
        const srcLower = (typeof source === "string" ? source : "").toLowerCase();

        const isFallback = srcLower.includes("cached") || srcLower.includes("lkg") ||
          srcLower.includes("fallback") || srcLower.includes("virtual");
        const isSkip = a.action_type === "skip" || a.action_type === "no_change" ||
          srcLower.includes("skip");

        if (isSkip && !isFallback) {
          skippedCount++;
        } else if (isFallback) {
          fallbackEvalCount++;
          if (a.action_type === "price_change" && a.success) fallbackActioned++;

          // Extract snapshot age if available
          const ageMin = factors.snapshot_age_minutes ?? factors.cache_age_minutes ?? null;
          if (typeof ageMin === "number") fallbackAgeMinutes.push(ageMin);

          // Safety classification
          const direction = factors.price_direction || factors.direction || "";
          const dirLower = (typeof direction === "string" ? direction : "").toLowerCase();
          if (dirLower.includes("raise") || dirLower.includes("up") || dirLower.includes("aggressive")) {
            aggressive++;
          } else if (dirLower.includes("lower") || dirLower.includes("down") || dirLower.includes("conservative")) {
            conservative++;
          } else {
            neutral++;
          }
        } else {
          liveEvalCount++;
          if (a.action_type === "price_change" && a.success) liveActioned++;
        }
      }

      // === Age buckets ===
      const bucketDefs = [
        { label: "< 15 min", max: 15 },
        { label: "15–60 min", max: 60 },
        { label: "1–2 hours", max: 120 },
        { label: "2–4 hours", max: 240 },
      ];
      const ageBuckets: FallbackAgeBucket[] = bucketDefs.map(({ label, max }, i) => {
        const min = i === 0 ? 0 : bucketDefs[i - 1].max;
        const count = fallbackAgeMinutes.filter(m => m >= min && m < max).length;
        return {
          label,
          count,
          pct: fallbackAgeMinutes.length > 0 ? Math.round((count / fallbackAgeMinutes.length) * 100) : 0,
        };
      });

      // === Outcomes ===
      const outcomes: FallbackOutcome[] = [
        {
          source: "live",
          total: liveEvalCount,
          actioned: liveActioned,
          actionRate: liveEvalCount > 0 ? Math.round((liveActioned / liveEvalCount) * 100) : 0,
        },
        {
          source: "fallback",
          total: fallbackEvalCount,
          actioned: fallbackActioned,
          actionRate: fallbackEvalCount > 0 ? Math.round((fallbackActioned / fallbackEvalCount) * 100) : 0,
        },
        {
          source: "skipped",
          total: skippedCount,
          actioned: 0,
          actionRate: 0,
        },
      ];

      // === Marketplace recovery ===
      const isEmpty = (s: any) =>
        !s.buybox_price && !s.lowest_fba_price && !s.lowest_overall_price &&
        (!s.offers_json || !Array.isArray(s.offers_json) || s.offers_json.length === 0);

      const mktMap: Record<string, { emptyAsins: Set<string>; successAsins: Set<string> }> = {};
      for (const s of snapshots) {
        const mkt = s.marketplace || "US";
        if (!mktMap[mkt]) mktMap[mkt] = { emptyAsins: new Set(), successAsins: new Set() };
        if (isEmpty(s)) {
          mktMap[mkt].emptyAsins.add(s.asin);
        } else {
          mktMap[mkt].successAsins.add(s.asin);
        }
      }

      const marketplaceRecovery: MarketplaceRecovery[] = Object.entries(mktMap).map(([marketplace, v]) => {
        const totalEmpty = v.emptyAsins.size;
        const recovered = [...v.emptyAsins].filter(a => v.successAsins.has(a)).length;
        const persistent = totalEmpty - recovered;
        return {
          marketplace,
          totalEmpty,
          recovered,
          persistent,
          recoveryPct: totalEmpty > 0 ? Math.round((recovered / totalEmpty) * 100) : 0,
        };
      }).sort((a, b) => b.totalEmpty - a.totalEmpty);

      const persistentByMarketplace = marketplaceRecovery.map(m => ({
        marketplace: m.marketplace,
        persistent: m.persistent,
        intermittent: m.recovered,
      }));

      setData({
        fallbackEvalCount,
        liveEvalCount,
        skippedCount,
        ageBuckets,
        outcomes,
        safetyBreakdown: { conservative, neutral, aggressive },
        marketplaceRecovery,
        persistentByMarketplace,
      });
    } catch (e) {
      console.error("Fallback analysis error:", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetch_(); const i = setInterval(fetch_, 120_000); return () => clearInterval(i); }, [fetch_]);
  return { ...data, loading };
}
