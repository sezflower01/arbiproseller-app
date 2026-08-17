import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { normalizeDomain, isPlausibleDomain } from "@/hooks/use-source-retailers";

export interface ExcludedDomain {
  id: string;
  domain: string;
  label: string | null;
}

/**
 * Domains Find Source must never return, plus the retroactive cleanup.
 *
 * Only the user's own list is here. The structural floor (amazon, reddit,
 * wikipedia, social) lives in the edge function and is deliberately not
 * editable or shown -- it is not a preference, and listing it would invite
 * someone to remove it.
 */
export function useExcludedDomains() {
  const [domains, setDomains] = useState<ExcludedDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Finished listings whose every candidate is now excluded. */
  const [staleCount, setStaleCount] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data, error }, { data: stale }] = await Promise.all([
        supabase
          .from("source_excluded_domains")
          .select("id, domain, label")
          .order("domain", { ascending: true }),
        // Dry run: counts without deleting, so the button can name a real
        // number before the user commits to anything.
        supabase.rpc("purge_excluded_only_listings", { p_dry_run: true }),
      ]);
      if (error) throw new Error(error.message);
      setDomains((data || []) as ExcludedDomain[]);
      setStaleCount(typeof stale === "number" ? stale : 0);
    } catch (e) {
      console.error("[useExcludedDomains] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const addDomain = useCallback(async (raw: string) => {
    const domain = normalizeDomain(raw);
    if (!isPlausibleDomain(domain)) throw new Error(`"${raw}" is not a valid domain.`);
    if (domains.some((d) => d.domain === domain)) throw new Error(`${domain} is already excluded.`);

    const { data: auth } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (!userId) throw new Error("Please log in to change this setting.");

    setBusy(true);
    try {
      const { error } = await supabase
        .from("source_excluded_domains")
        .insert({ user_id: userId, domain });
      if (error) throw new Error(error.message);
      // Refresh rather than patching state: adding an exclusion changes
      // staleCount too, and a stale count is worse than a slow one.
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [domains, refresh]);

  const removeDomain = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const { error } = await supabase.from("source_excluded_domains").delete().eq("id", id);
      if (error) throw new Error(error.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  /** Delete the listings the dry run counted. Returns how many went. */
  const purgeStale = useCallback(async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("purge_excluded_only_listings", { p_dry_run: false });
      if (error) throw new Error(error.message);
      await refresh();
      return typeof data === "number" ? data : 0;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return { domains, staleCount, loading, busy, addDomain, removeDomain, purgeStale, refresh };
}
