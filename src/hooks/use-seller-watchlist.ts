import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface SellerWatch {
  id: string;
  seller_id: string;
  seller_name: string | null;
  marketplace: string;
  notify_email: string;
  status: "pending_confirmation" | "active" | "cancelled";
  created_at: string;
  last_checked_at: string | null;
  last_alert_at: string | null;
}

async function getFunctionErrorMessage(error: unknown, fallback: string) {
  const err = error as { message?: string; context?: Response } | null;
  const response = err?.context;
  if (response?.clone) {
    const text = await response.clone().text().catch(() => "");
    if (text) {
      try {
        const body = JSON.parse(text);
        return body?.error || body?.message || text;
      } catch {
        return text;
      }
    }
  }
  return err?.message || fallback;
}

/**
 * Measured Keepa throughput for seller monitoring, 2026-08-15.
 *
 * A /seller?storefront=1 call costs a flat 10 tokens (catalog size is
 * irrelevant) against a plan refilling 5 tokens/min. At the ~50% budget
 * share seller monitoring is allowed -- the rest is reserved for live
 * repricing -- that works out to roughly 350 checks per day across ALL
 * watched sellers, shared.
 *
 * This is what makes the wait honest rather than mysterious: at 1000 watched
 * sellers a full rotation takes about three days, and because a watch must be
 * SEEDED on its first check before a second check can diff against it, the
 * first possible alert is roughly two rotations out.
 */
const CHECKS_PER_DAY_TOTAL = 350;

export interface WatchTiming {
  /** Estimated days for the queue to work through every active watch once. */
  rotationDays: number;
  /** Estimated days until a brand-new watch could produce its first alert. */
  daysToFirstAlert: number;
}

export function estimateWatchTiming(activeWatchCount: number): WatchTiming {
  const sellers = Math.max(1, activeWatchCount);
  const rotationDays = sellers / CHECKS_PER_DAY_TOTAL;
  return {
    rotationDays,
    // Seed on the first check, diff on the second -- two rotations.
    daysToFirstAlert: rotationDays * 2,
  };
}

export function formatDuration(days: number): string {
  if (days < 1 / 24) return 'under an hour';
  if (days < 1) {
    const hours = Math.round(days * 24);
    return `~${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const rounded = days < 10 ? Math.round(days * 10) / 10 : Math.round(days);
  return `~${rounded} day${rounded === 1 ? '' : 's'}`;
}

export function useSellerWatchlist() {
  const [watches, setWatches] = useState<SellerWatch[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("seller_watchlist")
        .select("id, seller_id, seller_name, marketplace, notify_email, status, created_at, last_checked_at, last_alert_at")
        .neq("status", "cancelled")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setWatches((data as SellerWatch[]) || []);
    } catch (e) {
      console.error("[useSellerWatchlist] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const createWatch = useCallback(async (sellerId: string, sellerName: string | null, marketplace: string) => {
    const { data: authData } = await supabase.auth.getSession();
    const token = authData.session?.access_token;
    if (!token) throw new Error("Please log in to watch a seller.");

    const { data: res, error } = await supabase.functions.invoke("create-seller-watch", {
      body: { sellerId, sellerName, marketplace },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) throw new Error(await getFunctionErrorMessage(error, "Failed to create seller watch"));
    if ((res as any)?.error) throw new Error((res as any).error);
    await refresh();
    return res as { ok: true; id: string; message: string };
  }, [refresh]);

  const cancelWatch = useCallback(async (id: string) => {
    const { error } = await supabase
      .from("seller_watchlist")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
    await refresh();
  }, [refresh]);

  // A watch is "seeding" until its first successful check, which writes
  // last_checked_at and known_asin_list together. Until then it cannot
  // produce an alert -- there is no baseline to diff against yet.
  const timing = estimateWatchTiming(watches.length);

  return { watches, loading, createWatch, cancelWatch, refresh, timing };
}
