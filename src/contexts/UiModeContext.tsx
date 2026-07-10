import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export type UiMode = "simple" | "advanced";

interface Ctx {
  mode: UiMode;
  setMode: (m: UiMode) => Promise<void>;
  loading: boolean;
}

const UiModeContext = createContext<Ctx>({ mode: "simple", setMode: async () => {}, loading: true });

const LOCAL_KEY = "arbi_ui_mode";

export function UiModeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [mode, setModeState] = useState<UiMode>(() => {
    if (typeof window === "undefined") return "simple";
    return (localStorage.getItem(LOCAL_KEY) as UiMode) || "simple";
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user) { setLoading(false); return; }
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("ui_mode")
        .eq("id", user.id)
        .maybeSingle();
      if (cancelled) return;
      const m = (data?.ui_mode as UiMode) || "simple";
      setModeState(m);
      localStorage.setItem(LOCAL_KEY, m);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user]);

  const setMode = useCallback(async (m: UiMode) => {
    setModeState(m);
    localStorage.setItem(LOCAL_KEY, m);
    if (user) {
      await supabase.from("profiles").update({ ui_mode: m }).eq("id", user.id);
    }
  }, [user]);

  return <UiModeContext.Provider value={{ mode, setMode, loading }}>{children}</UiModeContext.Provider>;
}

export const useUiMode = () => useContext(UiModeContext);
