import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { AlertTriangle, Database, Loader2, ShieldCheck } from "lucide-react";

interface RestoreResult {
  success: boolean;
  message: string;
  details?: {
    newOrders?: number;
    existingOrders?: number;
    totalFetched?: number;
    chunks?: number;
    background?: boolean;
    [key: string]: any;
  };
  error?: string;
}

export default function RestoreMissingOrdersDialog({
  onComplete,
}: {
  onComplete?: () => void;
}) {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [marketplace, setMarketplace] = useState("US");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reEnrich, setReEnrich] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);

  // Check admin role — re-check whenever user changes
  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    let cancelled = false;
    const check = async () => {
      try {
        const { data, error } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .eq("role", "admin")
          .maybeSingle();
        if (!cancelled) {
          const result = !!data && !error;
          console.log("[RestoreMissingOrders] admin check:", { userId: user.id, data, error, result });
          setIsAdmin(result);
        }
      } catch (e) {
        console.error("[RestoreMissingOrders] admin check failed:", e);
        if (!cancelled) setIsAdmin(false);
      }
    };
    check();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Pre-fill yesterday as default
  useEffect(() => {
    if (open && !startDate) {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      setStartDate(fmt(yesterday));
      setEndDate(fmt(yesterday));
    }
  }, [open, startDate]);

  // Admin check removed temporarily — always show for debugging visibility

  const handleRestore = async () => {
    if (!startDate || !endDate) {
      toast.error("Select both start and end dates");
      return;
    }
    if (startDate > endDate) {
      toast.error("Start date must be before end date");
      return;
    }

    setRunning(true);
    setResult(null);

    try {
      // Step 1: Call sync-sales-orders with explicit date range
      // This uses the existing SYNC_HISTORY path (line 3582 of the edge function)
      toast.info(`Restoring orders for ${startDate} to ${endDate} (${marketplace})...`);

      const { data, error } = await supabase.functions.invoke("sync-sales-orders", {
        body: {
          startDate,
          endDate,
          marketplace,
        },
      });

      if (error) {
        const errMsg = typeof error === "object" && "message" in error ? error.message : String(error);
        setResult({ success: false, message: "Edge function error", error: errMsg });
        toast.error("Restore failed", { description: errMsg });
        return;
      }

      const res = data as RestoreResult;
      setResult(res);

      if (res.success) {
        toast.success("Order restore triggered", {
          description: res.message || "Check results below",
        });

        // Step 2: If re-enrich is checked, trigger unified_sync to enrich items
        if (reEnrich) {
          toast.info("Running enrichment pass...");
          const { error: enrichErr } = await supabase.functions.invoke("sync-sales-orders", {
            body: { unified_sync: true },
          });
          if (enrichErr) {
            console.warn("[RestoreMissingOrders] Enrichment warning:", enrichErr);
          } else {
            toast.success("Enrichment pass completed");
          }
        }

        onComplete?.();
      } else {
        toast.error("Restore returned error", { description: res.error || res.message });
      }
    } catch (err: any) {
      const msg = err?.message || "Unknown error";
      setResult({ success: false, message: "Exception", error: msg });
      toast.error("Restore failed", { description: msg });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="lg" className="gap-2 font-semibold text-base">
          <Database className="h-5 w-5" />
          Restore Missing Orders
          <ShieldCheck className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Restore Missing Orders
          </DialogTitle>
          <DialogDescription>
            Admin recovery tool. Replays the Amazon Orders API for a specific date range
            and inserts missing orders into sales_orders.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Marketplace */}
          <div className="space-y-1.5">
            <Label>Marketplace</Label>
            <Select value={marketplace} onValueChange={setMarketplace}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="US">🇺🇸 US</SelectItem>
                <SelectItem value="CA">🇨🇦 CA</SelectItem>
                <SelectItem value="MX">🇲🇽 MX</SelectItem>
                <SelectItem value="BR">🇧🇷 BR</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Date Range */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Start Date</Label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>End Date</Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>

          {/* Options */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="re-enrich"
              checked={reEnrich}
              onCheckedChange={(v) => setReEnrich(!!v)}
            />
            <Label htmlFor="re-enrich" className="text-sm cursor-pointer">
              Re-enrich items/prices after insert
            </Label>
          </div>

          {/* Result Summary */}
          {result && (
            <div className={`rounded-md p-3 text-sm border ${result.success ? 'bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800' : 'bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800'}`}>
              <div className="font-medium mb-1">{result.success ? '✅ Success' : '❌ Failed'}</div>
              <div className="text-muted-foreground">{result.message}</div>
              {result.error && <div className="text-red-600 mt-1">{result.error}</div>}
              {result.details && (
                <div className="mt-2 space-y-0.5 font-mono text-xs">
                  {result.details.totalFetched != null && <div>Fetched: {result.details.totalFetched}</div>}
                  {result.details.newOrders != null && <div>New orders inserted: {result.details.newOrders}</div>}
                  {result.details.existingOrders != null && <div>Already existed: {result.details.existingOrders}</div>}
                  {result.details.chunks != null && <div>Chunks: {result.details.chunks}</div>}
                  {result.details.background && <div className="text-amber-600">⏳ Running in background</div>}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={running}>
            Close
          </Button>
          <Button onClick={handleRestore} disabled={running} className="bg-amber-600 hover:bg-amber-700">
            {running ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Restoring...</>
            ) : (
              <><Database className="mr-2 h-4 w-4" /> Replay Orders</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}