import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Amazon price for ROI column.
 * Order: inventory.amazon_price (user-scoped) → keepa_products.buy_box_price (catalog).
 */
export function useAmazonPrice(asin: string | null, userId: string | null) {
  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!asin) { setPrice(null); return; }

    (async () => {
      // 1. inventory (user-scoped)
      if (userId) {
        const { data } = await supabase
          .from("inventory")
          .select("amazon_price, price")
          .eq("user_id", userId)
          .eq("asin", asin)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (data?.amazon_price && data.amazon_price > 0) {
          if (!cancelled) setPrice(Number(data.amazon_price));
          return;
        }
        if (data?.price && data.price > 0) {
          if (!cancelled) setPrice(Number(data.price));
          return;
        }
      }

      // 2. keepa fallback
      const { data: keepa } = await supabase
        .from("keepa_products")
        .select("buy_box_price, amazon_price")
        .eq("asin", asin)
        .maybeSingle();
      if (keepa?.buy_box_price && keepa.buy_box_price > 0) {
        if (!cancelled) setPrice(Number(keepa.buy_box_price));
        return;
      }
      if (keepa?.amazon_price && keepa.amazon_price > 0) {
        if (!cancelled) setPrice(Number(keepa.amazon_price));
        return;
      }
      if (!cancelled) setPrice(null);
    })();

    return () => { cancelled = true; };
  }, [asin, userId]);

  return price;
}
