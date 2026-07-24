import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Phase 7+ — fetch the set of ASINs the current user has Created Listing
 * (purchase) rows for. Used by cost UI to distinguish:
 *   - "Overridden"                 — manual cost, purchase record exists
 *   - "Manual / No Purchase Record"— manual cost, no purchase record yet
 *
 * This is intentionally a single batched query keyed off the displayed ASIN
 * list. Returns a Set for O(1) lookups; never throws — empty Set on error.
 */
export function useAsinPurchaseRecords(asins: string[] | undefined): {
  hasPurchaseRecord: (asin: string | null | undefined) => boolean;
  loading: boolean;
} {
  const { user } = useAuth();
  const [withRecord, setWithRecord] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  // Stable stringified key so we only refetch when the actual asin set changes
  const key = (asins ?? []).filter(Boolean).slice().sort().join("|");

  useEffect(() => {
    if (!user || !key) {
      setWithRecord(new Set());
      return;
    }
    const list = key.split("|");
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        // Supabase has a practical IN-clause limit; chunk to be safe.
        const CHUNK = 500;
        const PAGE_SIZE = 1000;
        const found = new Set<string>();
        for (let i = 0; i < list.length; i += CHUNK) {
          const slice = list.slice(i, i + CHUNK);
          // Paginate with .range() — this project's PostgREST "Max Rows"
          // setting silently clamps ANY query to 1000 rows regardless of a
          // client-side .limit(), so a single request per 500-ASIN chunk can
          // never return more than that. Repeat-purchase ASINs average ~1.9
          // rows each in created_listings, so some chunks genuinely exceed
          // 1000 total rows, and whichever ASINs land past the cutoff quietly
          // show up as "no purchase record" even though one exists.
          let from = 0;
          while (true) {
            const { data, error } = await supabase
              .from("created_listings")
              .select("asin")
              .eq("user_id", user.id)
              .in("asin", slice)
              .order("id", { ascending: true })
              .range(from, from + PAGE_SIZE - 1);
            if (error) throw error;
            const rows = data ?? [];
            for (const r of rows) {
              if (r.asin) found.add(r.asin);
            }
            if (rows.length < PAGE_SIZE) break;
            from += PAGE_SIZE;
          }
        }
        if (!cancelled) setWithRecord(found);
      } catch (err) {
        console.warn("[useAsinPurchaseRecords] failed:", err);
        if (!cancelled) setWithRecord(new Set());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, key]);

  return {
    hasPurchaseRecord: (asin) => (asin ? withRecord.has(asin) : false),
    loading,
  };
}
