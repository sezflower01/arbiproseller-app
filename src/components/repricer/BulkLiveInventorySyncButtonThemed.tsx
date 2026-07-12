import { useState } from "react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Zap } from "lucide-react";
import { toast } from "sonner";

// Light "InventoryHub" re-theme of BulkLiveInventorySyncButton.tsx — identical
// sync logic. Only change: the custom one-off emerald color swapped for the
// standard Button `default` variant (button-standardization pass — this button
// sits next to ASIN Stock Check, also standardized to `default`, for consistency).

const BATCH_PAUSE_MS = 2000;
const BATCH_SIZE = 5;

const BulkLiveInventorySyncButtonThemed = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, recovered: 0, errors: 0 });

  const handleRun = async () => {
    if (!user || running) return;
    setRunning(true);
    setProgress({ done: 0, total: 0, recovered: 0, errors: 0 });

    try {
      // Pull every enabled assignment (one row per ASIN+marketplace).
      // We dedupe by sku so we only hit SP-API once per physical SKU.
      const { data: assignments, error } = await supabase
        .from("repricer_assignments")
        .select("asin, sku")
        .eq("user_id", user.id)
        .eq("is_enabled", true);

      if (error) throw error;

      const seen = new Set<string>();
      const items = (assignments || []).filter((a) => {
        if (!a.asin || !a.sku) return false;
        const key = `${a.asin}::${a.sku}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const total = items.length;
      if (total === 0) {
        toast.info("No enabled assignments to sync.");
        setRunning(false);
        return;
      }

      setProgress({ done: 0, total, recovered: 0, errors: 0 });
      let recovered = 0;
      let errors = 0;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
          const { data: result, error: rescueError } = await supabase.functions.invoke(
            "rescue-inventory-asin",
            { body: { asin: item.asin, sku: item.sku } },
          );
          if (rescueError) {
            errors++;
          } else {
            const live = result?.live_stock;
            const liveTotal =
              (live?.available || 0) + (live?.reserved || 0) + (live?.inbound || 0);
            if (liveTotal > 0) recovered++;
          }
        } catch {
          errors++;
        }

        setProgress({ done: i + 1, total, recovered, errors });

        // Rate-limit pause every BATCH_SIZE items
        if ((i + 1) % BATCH_SIZE === 0 && i + 1 < items.length) {
          await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        }
      }

      toast.success(
        `Live sync complete: ${recovered} with stock, ${errors} errors out of ${total}.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["repricer-assignments"] });
      await queryClient.invalidateQueries({ queryKey: ["synced-inventory", user.id] });
    } catch (err: any) {
      toast.error(`Live sync failed: ${err?.message || "Unknown error"}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button
      size="lg"
      onClick={handleRun}
      disabled={running}
      className="gap-2 text-base px-6 shadow-md"
    >
      {running ? (
        <>
          <RefreshCw className="h-5 w-5 animate-spin" />
          Live Sync {progress.done}/{progress.total}
        </>
      ) : (
        <>
          <Zap className="h-5 w-5" />
          Live Inventory Sync
        </>
      )}
    </Button>
  );
};

export default BulkLiveInventorySyncButtonThemed;
