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

  return { watches, loading, createWatch, cancelWatch, refresh };
}
