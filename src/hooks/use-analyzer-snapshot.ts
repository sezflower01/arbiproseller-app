import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface AnalyzerSnapshot {
  asin: string;
  marketplace: string;
  fetchedAt: string;
  cached: boolean;
  identity: {
    title: string | null;
    brand: string | null;
    category: string | null;
    image: string | null;
    reviewCount: number | null;
    rating: number | null;
    productGroup: string | null;
    packageDimensions: { length: number | null; width: number | null; height: number | null; weight: number | null; unit: string };
    itemDimensions: { length: number | null; width: number | null; height: number | null; weight: number | null; unit: string };
  };
  alerts: Array<{ key: string; label: string; status: "good" | "warn" | "bad" | "info"; value: string }>;
  quickInfo: {
    eligible: boolean | null;
    alertsCount: number;
    bsr: number | null;
    bsrTopPercent: number | null;
    estimatedSales: string;
    salesPerMonth: number | null;
    bsrDrops30: number | null;
    bbPriceChanges30: number | null;
    lastChecked: string;
  };
  offers: Array<{ rank: number; type: "FBA" | "FBM"; stock: number | null; price: number | null; isBuyBoxWinner: boolean; sellerId?: string | null; sellerName?: string | null; isAmazon?: boolean; isSelf?: boolean }>;
  series: {
    buyBox: { t: number; v: number }[];
    amazon: { t: number; v: number }[];
    newFba: { t: number; v: number }[];
    bsr: { t: number; v: number }[];
    offerCount: { t: number; v: number }[];
  };
  ranksPrices: Record<"bsr" | "buyBox" | "amazon" | "newFba" | "offerCount", { current: number | null; avg30: number | null; avg90: number | null; avg180: number | null }>;
  computed: { fbaOffers: number; fbmOffers: number; totalOffers: number };
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

export function useAnalyzerSnapshot() {
  const [data, setData] = useState<AnalyzerSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (asin: string, marketplace = "US", force = false) => {
    setLoading(true);
    setError(null);
    try {
      const { data: authData } = await supabase.auth.getSession();
      const token = authData.session?.access_token;
      if (!token) throw new Error("Please log in to run full web analysis.");

      const { data: res, error: invokeErr } = await supabase.functions.invoke("analyzer-product-snapshot", {
        body: { asin, marketplace, force },
        headers: { Authorization: `Bearer ${token}` },
      });
      const bodyError = (res as any)?.error;
      if (invokeErr) throw new Error(bodyError || await getFunctionErrorMessage(invokeErr, "Failed to load product"));
      if (bodyError) throw new Error(bodyError);
      setData(res as AnalyzerSnapshot);
    } catch (e) {
      setError((e as Error).message ?? "Failed to load product");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, error, load, setData };
}

export function useAnalyzerNotes(asin: string | null, marketplace = "US") {
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!asin) return;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u?.user) return;
      const { data } = await supabase
        .from("analyzer_notes")
        .select("notes, tags")
        .eq("user_id", u.user.id)
        .eq("asin", asin)
        .eq("marketplace", marketplace)
        .maybeSingle();
      setNotes((data?.notes as string) ?? "");
      setTags(((data?.tags as string[] | null) ?? []) as string[]);
    })();
  }, [asin, marketplace]);

  const save = useCallback(async (newNotes: string, newTags: string[]) => {
    if (!asin) return;
    setSaving(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u?.user) return;
      await supabase.from("analyzer_notes").upsert(
        { user_id: u.user.id, asin, marketplace, notes: newNotes, tags: newTags },
        { onConflict: "user_id,asin,marketplace" },
      );
      setNotes(newNotes);
      setTags(newTags);
    } finally {
      setSaving(false);
    }
  }, [asin, marketplace]);

  return { notes, tags, saving, save };
}
