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
        const found = new Set<string>();
        for (let i = 0; i < list.length; i += CHUNK) {
          const slice = list.slice(i, i + CHUNK);
          const { data, error } = await supabase
            .from("created_listings")
            .select("asin")
            .eq("user_id", user.id)
            .in("asin", slice);
          if (error) throw error;
          for (const r of data ?? []) {
            if (r.asin) found.add(r.asin);
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
