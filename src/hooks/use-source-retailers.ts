import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface SourceRetailer {
  id: string;
  domain: string;
  label: string | null;
  enabled: boolean;
  search_hits: number;
  price_attempts: number;
  price_success: number;
}

/** Bare registrable domain: strips scheme, www, path, port. */
export function normalizeDomain(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  return s;
}

export function isPlausibleDomain(d: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !d.endsWith(".");
}

/**
 * The retailers Find Source is allowed to search, newest counters included.
 *
 * Rows are seeded by migration for every user, so an empty list here means the
 * user disabled everything -- not that the feature is unconfigured. The search
 * treats an empty allowlist as "go straight to the fallback pass".
 */
export function useSourceRetailers() {
  const [retailers, setRetailers] = useState<SourceRetailer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("source_retailers")
        .select("id, domain, label, enabled, search_hits, price_attempts, price_success")
        .order("enabled", { ascending: false })
        .order("search_hits", { ascending: false })
        .order("domain", { ascending: true });
      if (error) throw new Error(error.message);
      setRetailers((data || []) as SourceRetailer[]);
    } catch (e) {
      console.error("[useSourceRetailers] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    // Optimistic -- a switch that waits on a round trip reads as broken.
    const prev = retailers;
    setRetailers((rs) => rs.map((r) => (r.id === id ? { ...r, enabled } : r)));
    setBusy(true);
    try {
      const { error } = await supabase
        .from("source_retailers")
        .update({ enabled, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) {
        setRetailers(prev);
        throw new Error(error.message);
      }
    } finally {
      setBusy(false);
    }
  }, [retailers]);

  const addRetailer = useCallback(async (rawDomain: string, label?: string) => {
    const domain = normalizeDomain(rawDomain);
    if (!isPlausibleDomain(domain)) throw new Error(`"${rawDomain}" is not a valid domain.`);
    if (retailers.some((r) => r.domain === domain)) throw new Error(`${domain} is already on the list.`);

    const { data: auth } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (!userId) throw new Error("Please log in to change this setting.");

    setBusy(true);
    try {
      const { error } = await supabase
        .from("source_retailers")
        .insert({ user_id: userId, domain, label: label?.trim() || null });
      if (error) throw new Error(error.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [retailers, refresh]);

  const removeRetailer = useCallback(async (id: string) => {
    const prev = retailers;
    setRetailers((rs) => rs.filter((r) => r.id !== id));
    setBusy(true);
    try {
      const { error } = await supabase.from("source_retailers").delete().eq("id", id);
      if (error) {
        setRetailers(prev);
        throw new Error(error.message);
      }
    } finally {
      setBusy(false);
    }
  }, [retailers]);

  return { retailers, loading, busy, refresh, setEnabled, addRetailer, removeRetailer };
}
