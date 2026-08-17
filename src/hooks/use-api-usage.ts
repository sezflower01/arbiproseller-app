import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface KeepaBudget {
  tokens_left: number;
  refill_per_min: number;
  bucket_max: number;
  denied_count: number;
  last_denied_at: string | null;
  last_observed_at: string | null;
}

export interface GeminiDay {
  usage_date: string;
  call_count: number;
  success_count: number;
  quota_failure_count: number;
  other_failure_count: number;
  last_failure_at: string | null;
  last_failure_status: number | null;
  last_failure_caller: string | null;
}

export interface SearchDay {
  usage_date: string;
  provider: "google_cse" | "serpapi";
  call_count: number;
  empty_count: number;
  error_count: number;
  last_error_at: string | null;
  last_error_status: number | null;
}

export interface KeepaDay {
  usage_date: string;
  keepa_429_count: number;
  sp_api_throttled_count: number;
}

export interface ApiUsage {
  keepaBudget: KeepaBudget | null;
  keepaDays: KeepaDay[];
  geminiDays: GeminiDay[];
  searchDays: SearchDay[];
  /** Source searches this month, per find_source_usage. */
  searchesThisMonth: number;
  /** Auto-source searches today and the cap they run against. */
  autoSourceToday: number;
  autoSourceCap: number;
}

function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Everything measured about external API consumption, in one read.
 *
 * Only counters this app writes itself. It deliberately does NOT try to mirror
 * each provider's own balance — the one exception is Keepa, which reports
 * tokensLeft on every response so the figure is real rather than inferred.
 * Gemini and SerpAPI expose no usable balance to a server-side caller, so those
 * show what WE spent and what failed, which is the part this app can know.
 */
export function useApiUsage() {
  const [data, setData] = useState<ApiUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [budget, keepaDays, gemini, search, monthUsage, autoToday, cfg] = await Promise.all([
        supabase.from("keepa_token_budget").select("*").maybeSingle(),
        supabase
          .from("keepa_daily_usage")
          .select("usage_date, keepa_429_count, sp_api_throttled_count")
          .order("usage_date", { ascending: false })
          .limit(14),
        supabase
          .from("gemini_daily_usage")
          .select("*")
          .order("usage_date", { ascending: false })
          .limit(14),
        supabase
          .from("search_api_daily_usage")
          .select("*")
          .order("usage_date", { ascending: false })
          .limit(28),
        supabase.from("find_source_usage").select("search_count").eq("month_key", monthKey()).maybeSingle(),
        supabase.from("auto_source_daily_usage").select("search_count").eq("day", today).maybeSingle(),
        supabase.from("auto_source_config").select("daily_cap").maybeSingle(),
      ]);

      setData({
        keepaBudget: (budget.data as KeepaBudget) ?? null,
        keepaDays: (keepaDays.data as KeepaDay[]) ?? [],
        geminiDays: (gemini.data as GeminiDay[]) ?? [],
        searchDays: (search.data as SearchDay[]) ?? [],
        searchesThisMonth: (monthUsage.data as { search_count?: number } | null)?.search_count ?? 0,
        autoSourceToday: (autoToday.data as { search_count?: number } | null)?.search_count ?? 0,
        autoSourceCap: (cfg.data as { daily_cap?: number } | null)?.daily_cap ?? 80,
      });
    } catch (e) {
      console.error("[useApiUsage] refresh failed", e);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, error, refresh };
}
