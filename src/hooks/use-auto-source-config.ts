import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface AutoSourceConfig {
  enabled: boolean;
  daily_cap: number;
  /** Gated ASINs are auto-searched when true. Restricted are ALWAYS excluded. */
  search_needs_approval: boolean;
}

/** Mirrors the column defaults, used before a row exists for this user. */
const DEFAULTS: AutoSourceConfig = { enabled: true, daily_cap: 80, search_needs_approval: true };

/**
 * Read/write the per-user auto-source settings.
 *
 * The row is created lazily by claim_auto_source_budget the first time the
 * worker runs, so a user who has never had a detection has no row yet. Saving
 * upserts rather than updates, so the toggle works before the worker has ever
 * touched the account.
 */
export function useAutoSourceConfig() {
  const [config, setConfig] = useState<AutoSourceConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [usedToday, setUsedToday] = useState<number>(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [{ data: cfg }, { data: usage }] = await Promise.all([
        supabase.from("auto_source_config").select("enabled, daily_cap, search_needs_approval").maybeSingle(),
        supabase.from("auto_source_daily_usage").select("search_count").eq("day", today).maybeSingle(),
      ]);
      if (cfg) setConfig({ ...DEFAULTS, ...(cfg as Partial<AutoSourceConfig>) });
      setUsedToday((usage as { search_count?: number } | null)?.search_count ?? 0);
    } catch (e) {
      console.error("[useAutoSourceConfig] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const update = useCallback(async (patch: Partial<AutoSourceConfig>) => {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (!userId) throw new Error("Please log in to change this setting.");

    // Optimistic: a toggle that lags behind the click reads as broken.
    const next = { ...config, ...patch };
    setConfig(next);
    setSaving(true);
    try {
      const { error } = await supabase
        .from("auto_source_config")
        .upsert({ user_id: userId, ...next, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (error) {
        setConfig(config); // roll back to what the server still holds
        throw new Error(error.message);
      }
    } finally {
      setSaving(false);
    }
  }, [config]);

  return { config, usedToday, loading, saving, update, refresh };
}
