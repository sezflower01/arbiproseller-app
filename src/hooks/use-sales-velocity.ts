import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface SalesVelocity {
  units_30d: number;
  orders_30d: number;
  last_sale_at: string | null;
  days_since_last_sale: number | null;
}

export type SalesVelocityMap = Record<string, SalesVelocity>;

export function useSalesVelocity(asins: string[]): {
  velocityMap: SalesVelocityMap;
  loading: boolean;
} {
  const { user } = useAuth();
  const [velocityMap, setVelocityMap] = useState<SalesVelocityMap>({});
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!user || asins.length === 0) return;
    setLoading(true);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoff = thirtyDaysAgo.toISOString().split("T")[0];

    try {
      const { data: rows } = await supabase
        .from("sales_orders")
        .select("asin, quantity, order_date, order_id")
        .eq("user_id", user.id)
        .gte("order_date", cutoff)
        .in("asin", asins)
        .not("order_status", "in", '("Canceled","Cancelled")')
        .is("is_cancelled", false);

      const map: SalesVelocityMap = {};

      // Initialize all requested ASINs
      for (const asin of asins) {
        map[asin] = {
          units_30d: 0,
          orders_30d: 0,
          last_sale_at: null,
          days_since_last_sale: null,
        };
      }

      if (rows) {
        for (const row of rows as any[]) {
          const asin = row.asin;
          if (!map[asin]) continue;
          map[asin].units_30d += row.quantity || 1;
          map[asin].orders_30d += 1; // simplified; dedup by order_id below
          if (
            !map[asin].last_sale_at ||
            row.order_date > map[asin].last_sale_at!
          ) {
            map[asin].last_sale_at = row.order_date;
          }
        }

        // Deduplicate orders count by order_id per ASIN
        const orderSets: Record<string, Set<string>> = {};
        for (const row of rows as any[]) {
          const asin = row.asin;
          if (!orderSets[asin]) orderSets[asin] = new Set();
          if (row.order_id) orderSets[asin].add(row.order_id);
        }
        for (const asin of Object.keys(orderSets)) {
          if (map[asin]) map[asin].orders_30d = orderSets[asin].size;
        }

        // Compute days since last sale
        const now = new Date();
        for (const asin of Object.keys(map)) {
          if (map[asin].last_sale_at) {
            const lastDate = new Date(map[asin].last_sale_at!);
            map[asin].days_since_last_sale = Math.floor(
              (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
            );
          }
        }
      }

      setVelocityMap(map);
    } catch (err) {
      console.error("Sales velocity fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [user, asins.join(",")]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { velocityMap, loading };
}
