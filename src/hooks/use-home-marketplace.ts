import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { getMarketplaceFromId, getMarketplaceConfig } from "@/lib/marketplaceCurrency";

/**
 * Returns the user's home marketplace code (e.g. "US", "UK", "CA"),
 * their home currency + symbol, and whether they are an admin.
 * 
 * Resolution order:
 * 1. repricer_settings.primary_marketplace (explicit setting)
 * 2. profiles.primary_marketplace_id → converted to code
 * 3. Fallback: "US"
 * 
 * Home currency comes from repricer_settings.home_currency (default: "USD").
 * Non-admin users should be restricted to this marketplace only.
 */
export function useHomeMarketplace() {
  const { user } = useAuth();
  const [homeMarketplace, setHomeMarketplace] = useState<string>("US");
  const [homeCurrency, setHomeCurrency] = useState<string>("USD");
  const [homeCurrencySymbol, setHomeCurrencySymbol] = useState<string>("$");
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) {
      setHomeMarketplace("US");
      setHomeCurrency("USD");
      setHomeCurrencySymbol("$");
      setIsAdmin(false);
      setLoading(false);
      return;
    }

    const resolve = async () => {
      try {
        // Fetch admin status, repricer_settings, and profile in parallel
        const [adminRes, settingsRes, profileRes] = await Promise.all([
          supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", user.id)
            .eq("role", "admin")
            .maybeSingle(),
          supabase
            .from("repricer_settings")
            .select("primary_marketplace, home_currency")
            .eq("user_id", user.id)
            .maybeSingle(),
          supabase
            .from("profiles")
            .select("primary_marketplace_id")
            .eq("id", user.id)
            .maybeSingle(),
        ]);

        setIsAdmin(!!adminRes.data);

        // Resolve home marketplace
        const fromSettings = (settingsRes.data as any)?.primary_marketplace as string | null;
        const fromProfile = (profileRes.data as any)?.primary_marketplace_id as string | null;

        let resolvedMarketplace = "US";
        if (fromSettings) {
          resolvedMarketplace = fromSettings;
        } else if (fromProfile) {
          resolvedMarketplace = getMarketplaceFromId(fromProfile);
        }
        setHomeMarketplace(resolvedMarketplace);

        // Resolve home currency
        const explicitCurrency = (settingsRes.data as any)?.home_currency as string | null;
        if (explicitCurrency) {
          setHomeCurrency(explicitCurrency);
          // Resolve symbol from marketplace configs or known currencies
          setHomeCurrencySymbol(getCurrencySymbol(explicitCurrency));
        } else {
          // Derive from home marketplace
          const mpConfig = getMarketplaceConfig(resolvedMarketplace);
          setHomeCurrency(mpConfig.currency);
          setHomeCurrencySymbol(mpConfig.currencySymbol);
        }
      } catch (e) {
        console.error("[useHomeMarketplace] Failed to resolve:", e);
        setHomeMarketplace("US");
        setHomeCurrency("USD");
        setHomeCurrencySymbol("$");
        setIsAdmin(false);
      } finally {
        setLoading(false);
      }
    };

    resolve();
  }, [user?.id]);

  /**
   * For non-admins, returns only [homeMarketplace].
   * For admins, returns all provided marketplaces.
   */
  const filterMarketplaces = (allMarketplaces: string[]): string[] => {
    if (isAdmin) return allMarketplaces;
    return allMarketplaces.filter((mp) => mp === homeMarketplace);
  };

  /**
   * Format a monetary value using the seller's home currency symbol.
   */
  const formatHomeCurrency = (value: number): string => {
    const safe = Number.isFinite(value) ? value : 0;
    return `${homeCurrencySymbol}${Math.abs(safe).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return { homeMarketplace, homeCurrency, homeCurrencySymbol, isAdmin, loading, filterMarketplaces, formatHomeCurrency };
}

/** Map currency codes to symbols */
function getCurrencySymbol(currency: string): string {
  const symbols: Record<string, string> = {
    USD: "$",
    CAD: "C$",
    MXN: "MX$",
    BRL: "R$",
    GBP: "£",
    EUR: "€",
    JPY: "¥",
    AUD: "A$",
    INR: "₹",
    SGD: "S$",
    AED: "د.إ",
    SAR: "﷼",
    PLN: "zł",
    SEK: "kr",
    TRY: "₺",
  };
  return symbols[currency] || currency;
}
