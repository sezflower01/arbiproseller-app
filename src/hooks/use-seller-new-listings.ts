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
  source_status: "unsourced" | "sourcing" | "candidates_found" | "sourced" | "no_candidates" | "expired";
  /** Passed auto-source qualification. false = deliberately never searched. */
  qualified: boolean | null;
  disqualified_reason: string | null;
  candidates: SourceCandidate[] | null;
  sourced_candidate: SourceCandidate | null;
  /** URLs the user ruled out; excluded from future searches. */
  rejected_candidate_urls: string[] | null;
  /** Amazon-side price captured overnight, in cents. Null = not captured. */
  amazon_price_cents: number | null;
  new_price_cents: number | null;
  /** SP-API fee estimate priced against the captured price, in cents. */
  total_fees_cents: number | null;
}

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}


const SELECT_COLS =
  "id, watch_id, seller_id, marketplace, asin, title, brand, image_url, upc, detected_at, " +
  "source_status, qualified, disqualified_reason, candidates, sourced_candidate, rejected_candidate_urls, " +
  "amazon_price_cents, new_price_cents, total_fees_cents";

/** Sourcer sends 20 per call; check-product-eligibility is built for batches. */
const ELIGIBILITY_BATCH = 20;

/**
 * Rows fetched per tab.
 *
 * Was 50, inherited from the original single shared query and never revisited.
 * The database does not care -- (user_id, detected_at DESC) is indexed and RLS
 * already scopes by user -- so this is a UI choice, raised to make a backlog
 * browsable.
 */
const PAGE_SIZE = 200;

/**
 * Ceiling on ASINs auto-checked for eligibility per load.
 *
 * This is the one thing that scaled 1:1 with PAGE_SIZE: every loaded row fed
 * the eligibility fan-out, so raising 50 to 200 would have taken page load from
 * ~3 check-product-eligibility invocations to ~20, every time. Verdicts cache
 * server-side per ASIN so the SP-API work behind them is mostly free on repeat,
 * but the invocations are not.
 *
 * The cap is applied to the most recent rows, which are the ones being triaged.
 * Older rows simply render without a badge -- EligibilityBadge returns null for
 * an unknown status -- rather than showing a wrong or invented one.
 */
const MAX_ELIGIBILITY_ASINS = 60;

export function useSellerNewListings() {
  const [done, setDone] = useState<NewListing[]>([]);
  const [pending, setPending] = useState<NewListing[]>([]);
  /** Total finished rows, which exceeds `done.length` whenever PAGE_SIZE bites. */
  const [doneTotal, setDoneTotal] = useState(0);
  /** Finished rows that found nothing — the low-value bulk of a backlog. */
  const [noCandidatesTotal, setNoCandidatesTotal] = useState(0);
  /** Total queued rows, which exceeds `pending.length` whenever PAGE_SIZE bites. */
  const [pendingTotal, setPendingTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [monthlySearchCount, setMonthlySearchCount] = useState<number>(0);
  const [eligibility, setEligibility] = useState<Record<string, EligibilityStatus>>({});
  /** `${seller_id}|${marketplace}` -> seller_name, for listings to show their origin. */
  const [sellerNames, setSellerNames] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [
        { data: doneRows, error },
        { data: pendingRows },
        { data: usageRow },
        { data: watchRows },
        { count: doneCount },
        { count: noCandidatesCount },
        { count: pendingCount },
      ] = await Promise.all([
        // DONE and SEARCHING are fetched separately with their own limits.
        // A single combined query ordered by detected_at is exactly what buried
        // completed research: 281 detections in a day pushed the 78 finished
        // rows past a shared 50-row window.
        supabase
          .from("seller_watch_new_listings")
          .select(SELECT_COLS)
          .in("source_status", ["candidates_found", "sourced", "no_candidates"])
          .order("detected_at", { ascending: false })
          .limit(PAGE_SIZE),
        supabase
          .from("seller_watch_new_listings")
          .select(SELECT_COLS)
          .in("source_status", ["unsourced", "sourcing"])
          .order("detected_at", { ascending: false })
          .limit(PAGE_SIZE),
        supabase
          .from("find_source_usage")
          .select("search_count")
          .eq("month_key", currentMonthKey())
          .maybeSingle(),
        // Listing rows carry seller_id but not the seller's NAME -- that lives
        // on the watch. Fetched here so a listing can say who it came from,
        // which is the first thing you need in order to judge it.
        supabase
          .from("seller_watchlist")
          .select("seller_id, marketplace, seller_name")
          .neq("status", "cancelled"),
        // Counted, not fetched. Bulk delete can only ever act on the 50 rows
        // on screen, so the UI has to be able to say "50 of 213" rather than
        // implying a Select-all reached everything.
        supabase
          .from("seller_watch_new_listings")
          .select("id", { count: "exact", head: true })
          .in("source_status", ["candidates_found", "sourced", "no_candidates"]),
        // Counted separately so "Delete all with no candidates" can name a real
        // number before the user commits to it.
        supabase
          .from("seller_watch_new_listings")
          .select("id", { count: "exact", head: true })
          .eq("source_status", "no_candidates"),
        supabase
          .from("seller_watch_new_listings")
          .select("id", { count: "exact", head: true })
          .in("source_status", ["unsourced", "sourcing"]),
      ]);
      if (error) throw error;
      setDone((doneRows as unknown as NewListing[]) || []);
      setPending((pendingRows as unknown as NewListing[]) || []);
      setDoneTotal(doneCount ?? 0);
      setNoCandidatesTotal(noCandidatesCount ?? 0);
      setPendingTotal(pendingCount ?? 0);
      setMonthlySearchCount((usageRow as any)?.search_count || 0);

      const names: Record<string, string> = {};
      type WatchNameRow = { seller_id: string; marketplace: string; seller_name: string | null };
      for (const w of (watchRows as WatchNameRow[] | null) ?? []) {
        if (w?.seller_name) names[`${w.seller_id}|${w.marketplace}`] = w.seller_name;
      }
      setSellerNames(names);
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
    const listings = [...done, ...pending];
    if (!listings.length) return;

    const byMarketplace = new Map<string, string[]>();
    let queued = 0;
    for (const l of listings) {
      if (eligibility[l.asin]) continue; // already known or in flight
      // Bounded so the fan-out stops tracking PAGE_SIZE. Both lists are ordered
      // newest-first, so what gets checked is what is actually being triaged.
      if (queued >= MAX_ELIGIBILITY_ASINS) break;
      if (!byMarketplace.has(l.marketplace)) byMarketplace.set(l.marketplace, []);
      const arr = byMarketplace.get(l.marketplace)!;
      if (!arr.includes(l.asin)) { arr.push(l.asin); queued++; }
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
  }, [done, pending]);

  /**
   * Mark a candidate as NOT the source.
   *
   * Persisted rather than hidden client-side, because the whole point is that
   * it survives "Search again" -- otherwise the same ruled-out candidate comes
   * back every run and gets re-rejected. find-source-candidates filters these
   * URLs out before scoring, so a rejection also stops costing verification
   * budget.
   *
   * The judgement being captured is one the scorer cannot see: "right product,
   * wrong seller" -- e.g. the item is correct but reaches you via Instacart
   * rather than the brand's own store. Text and image similarity both look
   * excellent in that case, which is exactly why the candidate keeps ranking.
   */
  const rejectCandidate = useCallback(async (listingId: string, candidate: SourceCandidate) => {
    const listing = done.find((l) => l.id === listingId);
    if (!listing) return;

    const remaining = (listing.candidates || []).filter((c) => c.url !== candidate.url);
    const rejected = Array.from(
      new Set([...(listing.rejected_candidate_urls || []), candidate.url]),
    );

    const { error } = await supabase
      .from("seller_watch_new_listings")
      .update({
        candidates: remaining,
        rejected_candidate_urls: rejected,
        // Falling back to 'no_candidates' when the last one is ruled out keeps
        // the row honest: it has been searched and nothing usable remains,
        // which is a different state from never having searched.
        source_status: remaining.length ? listing.source_status : "no_candidates",
      })
      .eq("id", listingId);
    if (error) throw new Error(error.message);

    setDone((prev) =>
      prev.map((l) =>
        l.id === listingId
          ? {
              ...l,
              candidates: remaining,
              rejected_candidate_urls: rejected,
              source_status: remaining.length ? l.source_status : "no_candidates",
            }
          : l,
      ),
    );
  }, [done, pending]);

  const markAsSourced = useCallback(async (listingId: string, candidate: SourceCandidate) => {
    const { error } = await supabase
      .from("seller_watch_new_listings")
      .update({ source_status: "sourced", sourced_at: new Date().toISOString(), sourced_candidate: candidate })
      .eq("id", listingId);
    if (error) throw new Error(error.message);
    setDone((prev) => prev.map((l) => (l.id === listingId ? { ...l, source_status: "sourced", sourced_candidate: candidate } : l)));
  }, []);

  /**
   * Permanently delete listing rows.
   *
   * A real DELETE, not the soft cancel the watchlist uses -- verified safe:
   * nothing in the schema has a foreign key to seller_watch_new_listings(id),
   * so the row is a leaf and takes only its own candidates and
   * rejected_candidate_urls with it.
   *
   * It also does NOT come back. Detection diffs against
   * seller_watchlist.known_asin_list, never against this table, and that list
   * already contains the ASIN -- so a deleted row is not re-detected on the
   * next check. That makes this irreversible from the UI, which is what the
   * confirm dialog is for.
   *
   * Chunked at 100 for the same reason as cancelWatches: the ids ride in the
   * DELETE query string, and a few hundred UUIDs overflow what proxies accept
   * while failing as an opaque server error.
   */
  const deleteListings = useCallback(async (ids: string[]) => {
    if (!ids.length) return 0;
    const CHUNK = 100;
    let removed = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { error } = await supabase.from("seller_watch_new_listings").delete().in("id", slice);
      if (error) {
        // Say what actually landed -- a partial delete reported as total
        // failure sends the user back to re-select rows that are already gone.
        await refresh();
        throw new Error(`${error.message} (removed ${removed} of ${ids.length} before failing)`);
      }
      removed += slice.length;
    }
    await refresh();
    return removed;
  }, [refresh]);

  /**
   * Delete every finished row matching a status, server-side.
   *
   * Deliberately NOT "select all then delete the ids": clearing a backlog by id
   * requires first loading every row into the browser, which is exactly the
   * wrong shape for the job -- these rows carry `candidates` JSONB and are the
   * fattest in the table. This deletes by predicate in one request, so it is
   * unaffected by PAGE_SIZE and costs the same whether it removes 20 or 2,000.
   *
   * RLS scopes it: the policy is FOR ALL with `auth.uid() = user_id`, so the
   * filter here is the status only and Postgres restricts the rest.
   *
   * Same permanence as deleteListings -- detection diffs against
   * seller_watchlist.known_asin_list, so nothing deleted here reappears.
   */
  const deleteByStatus = useCallback(async (statuses: NewListing["source_status"][]) => {
    if (!statuses.length) return 0;
    const { count, error } = await supabase
      .from("seller_watch_new_listings")
      .delete({ count: "exact" })
      .in("source_status", statuses);
    if (error) throw new Error(error.message);
    await refresh();
    return count ?? 0;
  }, [refresh]);

  return {
    done, pending, doneTotal, pendingTotal, noCandidatesTotal, loading, monthlySearchCount,
    eligibility, sellerNames, markAsSourced, rejectCandidate, deleteListings,
    deleteByStatus, refresh,
  };
}
