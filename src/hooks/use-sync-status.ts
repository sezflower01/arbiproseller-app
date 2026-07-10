import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface SyncStatus {
  amazon_connected: boolean;
  inventory_synced: boolean;
  fnsku_mapped: boolean;
  recent_sales_synced: boolean;
  fee_cache_seeded: boolean;
  repricer_assignments_created: boolean;
  repricer_ready: boolean;
  history_syncing: boolean;
  history_complete: boolean;
  pl_ready: boolean;
  inventory_sync_started_at: string | null;
  inventory_sync_completed_at: string | null;
  last_error: string | null;
}

const DEFAULT_STATUS: SyncStatus = {
  amazon_connected: false,
  inventory_synced: false,
  fnsku_mapped: false,
  recent_sales_synced: false,
  fee_cache_seeded: false,
  repricer_assignments_created: false,
  repricer_ready: false,
  history_syncing: false,
  history_complete: false,
  pl_ready: false,
  inventory_sync_started_at: null,
  inventory_sync_completed_at: null,
  last_error: null,
};

export function useSyncStatus() {
  const { user } = useAuth();
  const [status, setStatus] = useState<SyncStatus>(DEFAULT_STATUS);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    if (!user) { setLoading(false); return; }

    const { data, error } = await supabase
      .from("user_sync_status")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!error && data) {
      setStatus({
        amazon_connected: data.amazon_connected,
        inventory_synced: data.inventory_synced,
        fnsku_mapped: data.fnsku_mapped,
        recent_sales_synced: data.recent_sales_synced,
        fee_cache_seeded: data.fee_cache_seeded,
        repricer_assignments_created: data.repricer_assignments_created,
        repricer_ready: data.repricer_ready,
        history_syncing: data.history_syncing,
        history_complete: data.history_complete,
        pl_ready: data.pl_ready,
        inventory_sync_started_at: data.inventory_sync_started_at,
        inventory_sync_completed_at: data.inventory_sync_completed_at,
        last_error: data.last_error,
      });
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll while inventory sync is in progress
  useEffect(() => {
    if (!status.inventory_sync_started_at || status.inventory_synced) return;
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [status.inventory_sync_started_at, status.inventory_synced, fetchStatus]);

  const updateStatus = useCallback(async (updates: Partial<SyncStatus>) => {
    if (!user) return;

    const { error } = await supabase
      .from("user_sync_status")
      .upsert({ user_id: user.id, ...updates }, { onConflict: "user_id" });

    if (!error) {
      setStatus(prev => ({ ...prev, ...updates }));
    }
  }, [user]);

  return { status, loading, refreshStatus: fetchStatus, updateStatus };
}
