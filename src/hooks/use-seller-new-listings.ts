import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { EligibilityStatus } from "@/components/common/EligibilityBadge";

export interface SourceCandidate {
  url: string;
  domain: string;
  title: string;
  imageUrl: string | null;
  confidence: number;
  label: string;
  reason: string;
  price: number | null;
  currency: string | null;
  availability: string | null;
}

export interface NewListing {
  id: string;
  watch_id: string;
  seller_id: string;
  marketplace: string;
  asin: string;
  title: string | null;
  brand: string | null;
  image_url: string | null;
  upc: string | null;
  detected_at: string;
  source_status: "unsourced" | "sourcing" | "candidates_found" | "sourced" | "no_candidates";
  candidates: SourceCandidate[] | null;
  sourced_candidate: SourceCandidate | null;
}

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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

/** Sourcer sends 20 per call; check-product-eligibility is built for batches. */
const ELIGIBILITY_BATCH = 20;

export function useSellerNewListings() {
  const [listings, setListings] = useState<NewListing[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchingId, setSearchingId] = useState<string | null>(null);
  const [monthlySearchCount, setMonthlySearchCount] = useState<number>(0);
  const [eligibility, setEligibility] = useState<Record<string, EligibilityStatus>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: rows, error }, { data: usageRow }] = await Promise.all([
        supabase
          .from("seller_watch_new_listings")
          .select("id, watch_id, seller_id, marketplace, asin, title, brand, image_url, upc, detected_at, source_status, candidates, sourced_candidate")
          .order("detected_at", { ascending: false })
          .limit(50),
        supabase
          .from("find_source_usage")
          .select("search_count")
          .eq("month_key", currentMonthKey())
          .maybeSingle(),
      ]);
      if (error) throw error;
      setListings((rows as unknown as NewListing[]) || []);
      setMonthlySearchCount((usageRow as any)?.search_count || 0);
    } catch (e) {
      console.error("[useSellerNewListings] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * Auto-check listing eligibility for every visible ASIN.
   *
   * Gating is the first triage question on a new listing -- a restricted ASIN
   * is worth nothing however good the source is -- so this runs on load rather
   * than behind a button. Same edge function and batch size the six existing
   * consumers use (Sourcer, MobileScan, ...), and it caches server-side by
   * ASIN, so re-opening the panel costs nothing.
   *
   * Grouped by marketplace because gating is per-marketplace: the same ASIN can
   * be open in one and restricted in another, so a single blended call would
   * give a confidently wrong answer.
   */
  useEffect(() => {
    if (!listings.length) return;

    const byMarketplace = new Map<string, string[]>();
    for (const l of listings) {
      if (eligibility[l.asin]) continue; // already known or in flight
      if (!byMarketplace.has(l.marketplace)) byMarketplace.set(l.marketplace, []);
      const arr = byMarketplace.get(l.marketplace)!;
      if (!arr.includes(l.asin)) arr.push(l.asin);
    }
    if (byMarketplace.size === 0) return;

    let cancelled = false;

    const markAll = (asins: string[], status: EligibilityStatus) =>
      setEligibility((prev) => {
        const next = { ...prev };
        for (const a of asins) next[a] = status;
        return next;
      });

    (async () => {
      for (const [marketplace, asins] of byMarketplace) {
        markAll(asins, "checking");
        for (let i = 0; i < asins.length; i += ELIGIBILITY_BATCH) {
          if (cancelled) return;
          const batch = asins.slice(i, i + ELIGIBILITY_BATCH);
          try {
            const { data, error } = await supabase.functions.invoke("check-product-eligibility", {
              body: { marketplace, asins: batch, force_rescan: false },
            });
            if (error) throw error;
            const results =
              (data as { results?: { asin: string; status: string }[] } | null)?.results ?? [];
            if (cancelled) return;
            setEligibility((prev) => {
              const next = { ...prev };
              for (const r of results) {
                // The function lowercases before returning; anything outside
                // the known set becomes 'error' rather than being rendered raw.
                next[r.asin] =
                  r.status === "approved" ? "approved"
                  : r.status === "approval_required" ? "approval_required"
                  : r.status === "restricted" ? "restricted"
                  : "error";
              }
              // A batch can come back short; leave nothing stuck on "checking".
              for (const a of batch) if (next[a] === "checking") next[a] = "error";
              return next;
            });
          } catch (e) {
            console.error("[useSellerNewListings] eligibility check failed", e);
            if (!cancelled) markAll(batch, "error");
          }
        }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listings]);

  const findSource = useCallback(async (listingId: string) => {
    setSearchingId(listingId);
    try {
      const { data: authData } = await supabase.auth.getSession();
      const token = authData.session?.access_token;
      if (!token) throw new Error("Please log in to search for sources.");

      const { data: res, error } = await supabase.functions.invoke("find-source-candidates", {
        body: { listingId },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw new Error(await getFunctionErrorMessage(error, "Failed to search for sources"));
      if ((res as any)?.error) throw new Error((res as any).error);

      const result = res as { status: NewListing["source_status"]; candidates: SourceCandidate[]; usage: { searchCount: number } };
      setListings((prev) => prev.map((l) => (l.id === listingId ? { ...l, source_status: result.status, candidates: result.candidates } : l)));
      setMonthlySearchCount(result.usage.searchCount);
      return result;
    } finally {
      setSearchingId(null);
    }
  }, []);

  const markAsSourced = useCallback(async (listingId: string, candidate: SourceCandidate) => {
    const { error } = await supabase
      .from("seller_watch_new_listings")
      .update({ source_status: "sourced", sourced_at: new Date().toISOString(), sourced_candidate: candidate })
      .eq("id", listingId);
    if (error) throw new Error(error.message);
    setListings((prev) => prev.map((l) => (l.id === listingId ? { ...l, source_status: "sourced", sourced_candidate: candidate } : l)));
  }, []);

  return { listings, loading, searchingId, monthlySearchCount, eligibility, findSource, markAsSourced, refresh };
}
