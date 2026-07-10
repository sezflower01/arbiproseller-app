import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

/**
 * Header pill that surfaces the count of ASINs currently flagged
 * `fba_blocked = true` across `inventory` + `created_listings`.
 * Only renders when count > 0.
 */
export function FbaBlockedPill({ className }: { className?: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const load = async () => {
      const [inv, cl] = await Promise.all([
        supabase
          .from("inventory")
          .select("asin", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("fba_blocked", true),
        supabase
          .from("created_listings")
          .select("asin", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("fba_blocked", true),
      ]);
      if (cancelled) return;
      setCount((inv.count ?? 0) + (cl.count ?? 0));
    };

    void load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [user]);

  if (!user || count <= 0) return null;

  return (
    <button
      type="button"
      onClick={() => navigate("/tools/fba-eligibility-issues")}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200/90 hover:bg-amber-500/15 transition-colors",
        className,
      )}
      title="Review ASINs flagged for FBA — most are approval-related and not urgent"
    >
      <ShieldAlert className="h-3.5 w-3.5" />
      {count} FBA-flagged · review when ready
    </button>
  );
}
