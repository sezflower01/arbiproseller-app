import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface SellerStore {
  sellerId: string;
  sellerName: string;
  rating: number | null;
  ratingCount: number | null;
  totalAsins: number;
  hasFBA: boolean;
  isScammer: boolean;
}

export interface SellerOfferRow {
  sellerId: string;
  isFBA: boolean;
  isPrime: boolean;
  stock: number | null;
  price: number;
}

export interface SellerProductCard {
  asin: string;
  title: string;
  image: string | null;
  brand: string | null;
  category: string;
  bsr: number | null;
  estSales: string;
  buyBox: number | null;
  newPrice: number | null;
  reviewCount: number | null;
  offers: number | null;
  fbaOffers: number;
  fbmOffers: number;
  storeStock: number | null;
  topOffers: SellerOfferRow[];
  upc: string | null;
}

export interface SellerSnapshot {
  store: SellerStore;
  asinList: string[];
  page: number;
  pageSize: number;
  totalPages: number;
  topBrands: { name: string; count: number }[];
  topCategories: { name: string; count: number }[];
  pageItems: SellerProductCard[];
  cachedAt?: string | null;
  fromCache?: boolean;
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

export function useSellerSnapshot() {
  const [data, setData] = useState<SellerSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<{ sellerId: string; marketplace: string; page: number } | null>(null);

  const load = useCallback(async (
    sellerId: string,
    marketplace: string,
    page = 0,
    opts?: { prev?: SellerSnapshot | null; forceRefresh?: boolean },
  ) => {
    const prev = opts?.prev;
    const forceRefresh = !!opts?.forceRefresh;
    setLoading(true); setError(null);
    setParams({ sellerId, marketplace, page });
    try {
      const { data: authData } = await supabase.auth.getSession();
      const token = authData.session?.access_token;
      if (!token) throw new Error("Please log in to analyze seller storefronts.");

      const reuse = !forceRefresh && page > 0 && prev && prev.store?.sellerId === sellerId && prev.asinList?.length;
      const { data: res, error } = await supabase.functions.invoke("seller-storefront-snapshot", {
        body: {
          sellerId, marketplace, page, pageSize: 12,
          forceRefresh,
          ...(reuse ? { cachedAsinList: prev!.asinList, cachedStore: prev!.store } : {}),
        },
        headers: { Authorization: `Bearer ${token}` },
      });
      if (error) throw new Error(await getFunctionErrorMessage(error, "Failed to load seller"));
      if ((res as any)?.error) throw new Error((res as any).error);
      setData(res as SellerSnapshot);
    } catch (e: any) {
      setError(e.message || "Failed to load seller");
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, error, load, params };
}
