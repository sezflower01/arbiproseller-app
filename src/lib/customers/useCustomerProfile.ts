import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type CustomerFlagLevel = "new" | "returning" | "refunder" | "replacer" | "review";

export interface CustomerProfile {
  customer_key: string;
  buyer_email: string | null;
  buyer_name: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  orders_count: number;
  units_count: number;
  revenue_usd: number;
  refund_orders_count: number;
  refund_amount_usd: number;
  replacement_orders_count: number;
  distinct_asins_count: number;
  distinct_asins: string[];
  order_ids: string[];
  flag_level: CustomerFlagLevel;
}

const cache = new Map<string, CustomerProfile>();

/**
 * Batched customer profile loader. Reads the customer_key from any of the
 * caller-provided lookup values: buyer_email or explicit customer_key.
 * Fetches from Supabase in a single call, caches by customer_key.
 */
export function useCustomerProfiles(keys: Array<string | null | undefined>) {
  const stable = Array.from(new Set(keys.filter(Boolean) as string[])).sort().join("|");
  const [profiles, setProfiles] = useState<Record<string, CustomerProfile>>({});

  useEffect(() => {
    if (!stable) return;
    let cancelled = false;
    const needed = stable.split("|").filter((k) => !cache.has(k));
    if (needed.length === 0) {
      const hit: Record<string, CustomerProfile> = {};
      for (const k of stable.split("|")) if (cache.has(k)) hit[k] = cache.get(k)!;
      setProfiles(hit);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from("customer_profiles" as any)
        .select("*")
        .in("customer_key", needed);
      if (cancelled) return;
      for (const row of (data as any[]) || []) cache.set(row.customer_key, row as CustomerProfile);
      const out: Record<string, CustomerProfile> = {};
      for (const k of stable.split("|")) if (cache.has(k)) out[k] = cache.get(k)!;
      setProfiles(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [stable]);

  return profiles;
}

export function useCustomerProfile(key: string | null | undefined) {
  const map = useCustomerProfiles(key ? [key] : []);
  return key ? map[key] || null : null;
}

/** Resolve a client-side customer_key from raw order fields, matching the DB helper. */
export function resolveCustomerKey(opts: {
  buyer_id?: string | null;
  buyer_email?: string | null;
  buyer_name?: string | null;
  ship_to_hash?: string | null;
  customer_key?: string | null;
}): string | null {
  if (opts.customer_key) return opts.customer_key;
  if (opts.buyer_id && opts.buyer_id.trim()) return `bid:${opts.buyer_id.trim().toLowerCase()}`;
  if (opts.buyer_email && opts.buyer_email.trim()) return `email:${opts.buyer_email.trim().toLowerCase()}`;
  if (opts.buyer_name && opts.buyer_name.trim() && opts.ship_to_hash) {
    return `nh:${opts.buyer_name.trim().toLowerCase()}|${opts.ship_to_hash}`;
  }
  return null;
}
