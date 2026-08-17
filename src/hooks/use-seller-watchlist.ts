import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/** Response from bulk-create-seller-watches, in both preview and commit mode. */
export interface BulkAddResult {
  ok: true;
  mode: "preview" | "commit";
  marketplace: string;
  linesRead: number;
  willAdd: number;
  willReactivate: number;
  alreadyWatched: number;
  duplicatesInUpload: number;
  invalidLines: number;
  overCap: boolean;
  cap: number;
  droppedOverCap: number;
  samples: {
    invalid: string[];
    duplicates: string[];
    alreadyWatched: string[];
  };
  committed: boolean;
  /** Commit only: rows actually written. */
  added?: number;
  reactivated?: number;
  /** Commit only: set when a chunk failed partway through. */
  partial?: boolean;
}

export interface SellerWatch {
  id: string;
  seller_id: string;
  seller_name: string | null;
  marketplace: string;
  notify_email: string;
  // 'pending_confirmation' was dropped in migration 20260815230000 -- seller
  // watches activate immediately, since notify_email is always the caller's
  // own verified account email.
  status: "active" | "cancelled";
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
 * CONSERVATIVE FALLBACK ONLY -- used before enough real check times exist to
 * measure the rate directly. Prefer estimateWatchTiming() below, which reads
 * the actual throughput off last_checked_at.
 *
 * Derived 2026-08-15: a /seller?storefront=1 call costs a flat 10 tokens
 * (catalog size is irrelevant) against a plan refilling 5 tokens/min, and
 * assuming seller monitoring gets about half the budget gives ~350 checks/day.
 *
 * That assumption proved too pessimistic in practice -- 402 sellers seeded in
 * roughly ten hours, not the predicted twenty-eight. The gate never split the
 * budget in half; it only reserves a floor for the repricer, so a quiet
 * repricer leaves far more headroom. The number is kept as a floor for the
 * cold-start case rather than retuned to a second guess.
 */
const CHECKS_PER_DAY_TOTAL = 350;

export interface WatchTiming {
  /** Days for the queue to work through every active watch once. */
  rotationDays: number;
  /** Days until a brand-new watch could produce its first alert. */
  daysToFirstAlert: number;
  /** Whether this came from observed check times or the derived constant. */
  source: "measured" | "estimated";
}

/** Below this many checked watches the observed rate is too noisy to trust. */
const MIN_SAMPLES_FOR_MEASURED_RATE = 10;

/**
 * Estimate rotation timing, preferring MEASURED throughput over the constant.
 *
 * The constant above is a derivation from token cost and plan rate, and it
 * turned out materially pessimistic in practice -- 402 sellers seeded in about
 * ten hours against a predicted twenty-eight. The derivation assumed seller
 * monitoring gets roughly half the Keepa budget, but the gate does not split
 * anything: it simply reserves a floor for the repricer, so a quiet repricer
 * leaves far more headroom than the model allowed for.
 *
 * Every checked watch carries a last_checked_at, so the real rate is already
 * on screen: count how many were checked and over what span. That measures
 * whatever the budget, plan rate and repricer contention actually are today,
 * instead of restating an assumption that was wrong once already.
 */
export function estimateWatchTiming(watches: Pick<SellerWatch, "last_checked_at">[] | number): WatchTiming {
  // Number form kept for callers that only know a projected count -- the bulk
  // preview estimating a list it has not added yet.
  if (typeof watches === "number") {
    const rotationDays = Math.max(1, watches) / CHECKS_PER_DAY_TOTAL;
    return { rotationDays, daysToFirstAlert: rotationDays * 2, source: "estimated" };
  }

  const total = Math.max(1, watches.length);
  const stamps = watches
    .map((w) => (w.last_checked_at ? new Date(w.last_checked_at).getTime() : null))
    .filter((t): t is number => t !== null && Number.isFinite(t));

  if (stamps.length >= MIN_SAMPLES_FOR_MEASURED_RATE) {
    const spanDays = (Math.max(...stamps) - Math.min(...stamps)) / 86_400_000;
    if (spanDays > 0) {
      const checksPerDay = stamps.length / spanDays;
      const rotationDays = total / checksPerDay;
      return { rotationDays, daysToFirstAlert: rotationDays * 2, source: "measured" };
    }
  }

  const rotationDays = total / CHECKS_PER_DAY_TOTAL;
  return { rotationDays, daysToFirstAlert: rotationDays * 2, source: "estimated" };
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

  /**
   * Bulk add from a pasted list or CSV.
   *
   * Two passes over the SAME server-side parser: 'preview' classifies and
   * writes nothing, 'commit' classifies and then writes. Running the identical
   * code path both times is what makes the preview trustworthy -- a separate
   * client-side estimate could disagree with what actually lands.
   */
  const bulkAddWatches = useCallback(async (
    text: string,
    marketplace: string,
    mode: "preview" | "commit",
  ): Promise<BulkAddResult> => {
    const { data: authData } = await supabase.auth.getSession();
    const token = authData.session?.access_token;
    if (!token) throw new Error("Please log in to add sellers.");

    const { data: res, error } = await supabase.functions.invoke("bulk-create-seller-watches", {
      body: { text, marketplace, mode },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) throw new Error(await getFunctionErrorMessage(error, "Bulk add failed"));
    if ((res as any)?.error) throw new Error((res as any).error);

    if (mode === "commit") await refresh();
    return res as BulkAddResult;
  }, [refresh]);

  const cancelWatch = useCallback(async (id: string) => {
    const { error } = await supabase
      .from("seller_watchlist")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
    await refresh();
  }, [refresh]);

  /**
   * Cancel many watches at once.
   *
   * Chunked because the id list travels in the PATCH query string: ~400 UUIDs
   * is roughly 15KB of URL, past what proxies will accept, and the failure
   * would look like a random server error rather than a length problem.
   *
   * Refreshes once at the end rather than per chunk -- five hundred rows
   * re-rendering four times over is visible jank for no added certainty.
   *
   * Soft cancel, matching cancelWatch: seller_watch_new_listings cascades on
   * DELETE, so hard-deleting here would silently take every detected listing
   * with it. Setting status keeps the Results tab intact.
   */
  const cancelWatches = useCallback(async (ids: string[]) => {
    if (!ids.length) return 0;
    const CHUNK = 100;
    const cancelled_at = new Date().toISOString();
    let done = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("seller_watchlist")
        .update({ status: "cancelled", cancelled_at })
        .in("id", slice);
      if (error) {
        // Report what DID land -- a partial cancel that claims total failure
        // sends the user back to re-select rows that are already gone.
        await refresh();
        throw new Error(`${error.message} (cancelled ${done} of ${ids.length} before failing)`);
      }
      done += slice.length;
    }
    await refresh();
    return done;
  }, [refresh]);

  // A watch is "seeding" until its first successful check, which writes
  // last_checked_at and known_asin_list together. Until then it cannot
  // produce an alert -- there is no baseline to diff against yet.
  const timing = estimateWatchTiming(watches);

  return { watches, loading, createWatch, cancelWatch, cancelWatches, bulkAddWatches, refresh, timing };
}
