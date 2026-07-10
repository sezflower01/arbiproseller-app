import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { ShipmentBusinessMode } from "@/lib/shipment/businessMode";

const LOCAL_KEY = "arbi_shipment_business_mode";
const ONBOARDED_KEY = "arbi_shipment_business_mode_onboarded";

/**
 * Per-user shipment business mode preference. Defaults to "oa" so the
 * existing workflow is preserved. `hasChosen` is a local per-device flag
 * that gates the one-time onboarding dialog.
 */
export function useBusinessMode() {
  const { user } = useAuth();
  const [mode, setModeState] = useState<ShipmentBusinessMode>(() => {
    if (typeof window === "undefined") return "oa";
    return (localStorage.getItem(LOCAL_KEY) as ShipmentBusinessMode) || "oa";
  });
  const [hasChosen, setHasChosen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setLoading(false);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("shipment_business_mode")
        .eq("id", user.id)
        .maybeSingle();
      if (cancelled) return;
      const m = ((data as { shipment_business_mode?: string } | null)?.shipment_business_mode as ShipmentBusinessMode) || "oa";
      setModeState(m);
      localStorage.setItem(LOCAL_KEY, m);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const setMode = useCallback(
    async (m: ShipmentBusinessMode) => {
      setModeState(m);
      setHasChosen(true);
      localStorage.setItem(LOCAL_KEY, m);
      localStorage.setItem(ONBOARDED_KEY, "1");
      if (user) {
        await supabase.from("profiles").update({ shipment_business_mode: m } as never).eq("id", user.id);
      }
    },
    [user],
  );

  return { mode, setMode, hasChosen, loading };
}
