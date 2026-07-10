import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeFunctionClient";
import { useAuth } from "@/contexts/AuthContext";
import { Search, RefreshCw, Package } from "lucide-react";
import { toast } from "sonner";

interface InventoryResult {
  asin: string;
  sku: string;
  title: string;
  available: number;
  reserved: number;
  inbound: number;
  inbound_working: number | null;
  inbound_receiving: number | null;
  inbound_shipped: number | null;
  unfulfilled: number;
  listing_status: string | null;
  last_inventory_sync_at: string | null;
  last_summaries_at: string | null;
  image_url: string | null;
}

interface LiveApiResult {
  available: number;
  reserved: number;
  inbound: number;
  inbound_working?: number;
  inbound_receiving?: number;
  inbound_shipped?: number;
  trace?: any;
}

const AsinInventoryLookupDialog = () => {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [asin, setAsin] = useState("");
  const [loading, setLoading] = useState(false);
  const [liveLoading, setLiveLoading] = useState(false);
  const [results, setResults] = useState<InventoryResult[]>([]);
  const [liveResult, setLiveResult] = useState<Record<string, LiveApiResult>>({});
  const [searched, setSearched] = useState(false);

  const handleSearch = async (preserveLiveTrace = false) => {
    const trimmed = asin.trim().toUpperCase();
    if (!trimmed || !user) return;

    setLoading(true);
    setSearched(true);
    if (!preserveLiveTrace) {
      setLiveResult({});
    }

    try {
      const { data, error } = await supabase
        .from("inventory")
        .select("asin, sku, title, available, reserved, inbound, inbound_working, inbound_receiving, inbound_shipped, unfulfilled, listing_status, last_inventory_sync_at, last_summaries_at, image_url")
        .eq("user_id", user.id)
        .eq("asin", trimmed);

      if (error) throw error;
      setResults((data as any) || []);
    } catch (err: any) {
      toast.error("Failed to look up ASIN: " + err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleLiveCheck = async (itemAsin: string, sku: string) => {
    if (!user) return;
    setLiveLoading(true);

    try {
      const res = await invokeEdgeFunction({
        functionName: "rescue-inventory-asin",
        body: { asin: itemAsin, sku },
      });

      if (!res.ok) throw new Error(res.errorMessage || "Live API call failed");

      const data = res.data as any;
      setLiveResult((prev) => ({
        ...prev,
        [sku]: {
          ...(data?.live_stock || { available: 0, reserved: 0, inbound: 0 }),
          trace: data,
        },
      }));

      toast.success("Live API check completed");
      // Refresh DB data without wiping the live trace panel
      handleSearch(true);
    } catch (err: any) {
      toast.error("Live API error: " + err.message);
    } finally {
      setLiveLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="gap-2 bg-yellow-400 hover:bg-yellow-500 text-black font-bold text-base px-6 shadow-md">
          <Package className="h-5 w-5" />
          ASIN Stock Check
        </Button>
      </DialogTrigger>
      <DialogContent className="w-[95vw] max-w-5xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>ASIN Inventory Lookup</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2 mt-2">
          <Input
            placeholder="Enter ASIN (e.g. B01H0XM5D4)"
            value={asin}
            onChange={(e) => setAsin(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1"
          />
          <Button onClick={() => handleSearch()} disabled={loading || !asin.trim()}>
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </Button>
        </div>

        {searched && results.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground text-center py-6">
            No inventory records found for this ASIN.
          </p>
        )}

        {results.map((item) => (
          <div key={item.sku} className="border rounded-lg p-4 space-y-3">
            <div className="flex items-start gap-3">
              {item.image_url && (
                <img src={item.image_url} alt="" className="w-12 h-12 object-contain rounded" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.title}</p>
                <p className="text-xs text-muted-foreground">
                  SKU: {item.sku} · Status: {item.listing_status || "—"}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <StockCard label="Available" value={item.available} live={liveResult[item.sku]?.available} />
              <StockCard label="Reserved" value={item.reserved} live={liveResult[item.sku]?.reserved} />
              <StockCard label="Inbound" value={item.inbound} live={liveResult[item.sku]?.inbound} />
              <StockCard label="Unfulfilled" value={item.unfulfilled} />
            </div>

            <div
              className="rounded-md border bg-muted/30 p-3 text-xs"
              title="Working units are shipment-plan units not yet shipped/receiving. They are shown for visibility but not counted in inbound inventory until Amazon moves them to shipped or receiving."
            >
              <p className="font-medium mb-2">Inbound breakdown</p>
              <div className="grid grid-cols-4 gap-2">
                <BreakdownCell label="Working" value={item.inbound_working} live={liveResult[item.sku]?.trace?.inbound_components?.working} muted />
                <BreakdownCell label="Shipped" value={item.inbound_shipped} live={liveResult[item.sku]?.trace?.inbound_components?.shipped} />
                <BreakdownCell label="Receiving" value={item.inbound_receiving} live={liveResult[item.sku]?.trace?.inbound_components?.receiving} />
                <BreakdownCell label="Counted Inbound" value={item.inbound} live={liveResult[item.sku]?.inbound} highlight />
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground italic">
                Working units are shipment-plan units not yet shipped/receiving. Shown for visibility — not counted in inbound until Amazon moves them to shipped or receiving.
              </p>
            </div>

            {liveResult[item.sku]?.trace && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-3 text-xs">
                <div className="grid gap-3 md:grid-cols-2">
                  <TraceBlock
                    title="Amazon response"
                    rows={[
                      ["available", liveResult[item.sku].trace.raw_quantities?.available],
                      ["reserved", liveResult[item.sku].trace.raw_quantities?.reserved],
                      ["inbound", liveResult[item.sku].trace.raw_quantities?.inbound],
                      ["unfulfillable", liveResult[item.sku].trace.raw_quantities?.unfulfillable],
                    ]}
                  />
                  <TraceBlock
                    title="Matched summary identity"
                    rows={[
                      ["sellerSku", liveResult[item.sku].trace.matched_summary_identity?.seller_sku],
                      ["fnSku", liveResult[item.sku].trace.matched_summary_identity?.fnsku],
                      ["asin", liveResult[item.sku].trace.matched_summary_identity?.asin],
                      ["condition", liveResult[item.sku].trace.matched_summary_identity?.condition],
                      ["product_name", liveResult[item.sku].trace.matched_summary_identity?.product_name],
                    ]}
                  />
                  <TraceBlock
                    title="Inbound components"
                    rows={[
                      ["receiving", liveResult[item.sku].trace.inbound_components?.receiving],
                      ["shipped", liveResult[item.sku].trace.inbound_components?.shipped],
                      ["working", liveResult[item.sku].trace.inbound_components?.working],
                      ["total", liveResult[item.sku].trace.inbound_components?.total],
                    ]}
                  />
                  <TraceBlock
                    title="Marketplace resolution"
                    rows={[
                      ["requested_marketplace", liveResult[item.sku].trace.requested_marketplace],
                      ["listing_marketplace", liveResult[item.sku].trace.listing_marketplace],
                      ["inventory_source_marketplace", liveResult[item.sku].trace.inventory_source_marketplace],
                      ["marketplaces_attempted", (liveResult[item.sku].trace.marketplaces_attempted || []).join(", ") || "—"],
                      ["fallback_used", String(!!liveResult[item.sku].trace.fallback_used)],
                    ]}
                  />
                  <TraceBlock
                    title="DB write attempt"
                    rows={[
                      ["inventory_row_id", liveResult[item.sku].trace.inventory_row_id],
                      ["asin", liveResult[item.sku].trace.attempted_write_payload?.asin],
                      ["sku", liveResult[item.sku].trace.attempted_write_payload?.sku],
                      ["write_available", liveResult[item.sku].trace.attempted_write_payload?.available],
                      ["write_reserved", liveResult[item.sku].trace.attempted_write_payload?.reserved],
                      ["write_inbound", liveResult[item.sku].trace.attempted_write_payload?.inbound],
                      ["db_write_succeeded", String(!!liveResult[item.sku].trace.db_write_succeeded)],
                    ]}
                  />
                  <TraceBlock
                    title="DB after write"
                    rows={[
                      ["title", liveResult[item.sku].trace.post_write_db?.title],
                      ["available", liveResult[item.sku].trace.post_write_db?.available],
                      ["reserved", liveResult[item.sku].trace.post_write_db?.reserved],
                      ["inbound", liveResult[item.sku].trace.post_write_db?.inbound],
                      ["listing_status", liveResult[item.sku].trace.post_write_db?.listing_status],
                      ["source", liveResult[item.sku].trace.post_write_db?.source],
                    ]}
                  />
                  <TraceBlock
                    title="Raw summary excerpt"
                    rows={[
                      ["summary", liveResult[item.sku].trace.raw_summary_excerpt],
                    ]}
                  />
                </div>
              </div>
            )}

            {(item.last_summaries_at || item.last_inventory_sync_at) && (
              <p className="text-xs text-muted-foreground">
                Stock synced: {new Date((item.last_summaries_at || item.last_inventory_sync_at)!).toLocaleString()}
                {item.last_summaries_at ? ' (Summaries API)' : ' (Report)'}
              </p>
            )}

            <Button
              variant="secondary"
              size="sm"
              className="w-full gap-2"
              onClick={() => handleLiveCheck(item.asin, item.sku)}
              disabled={liveLoading}
            >
              {liveLoading ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Live API Check
            </Button>
          </div>
        ))}
      </DialogContent>
    </Dialog>
  );
};

function BreakdownCell({ label, value, live, muted, highlight }: { label: string; value: number | null; live?: number; muted?: boolean; highlight?: boolean }) {
  const dbVal = value ?? 0;
  const changed = live !== undefined && live !== dbVal;
  return (
    <div className={`rounded-md p-2 text-center ${highlight ? "bg-primary/10 border border-primary/30" : muted ? "bg-muted/40" : "bg-muted/50"}`}>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-base font-bold ${muted ? "text-muted-foreground" : ""}`}>{dbVal}</p>
      {live !== undefined && (
        <p className={`text-[10px] font-medium ${changed ? "text-orange-500" : "text-green-500"}`}>Live: {live}</p>
      )}
    </div>
  );
}

function StockCard({ label, value, live }: { label: string; value: number | null; live?: number }) {
  const dbVal = value ?? 0;
  const changed = live !== undefined && live !== dbVal;

  return (
    <div className="bg-muted/50 rounded-md p-2 text-center">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-lg font-bold">{dbVal}</p>
      {live !== undefined && (
        <p className={`text-xs font-medium ${changed ? "text-orange-500" : "text-green-500"}`}>
          Live: {live}
        </p>
      )}
    </div>
  );
}

function TraceBlock({ title, rows }: { title: string; rows: Array<[string, unknown]> }) {
  return (
    <div className="space-y-1">
      <p className="font-medium text-foreground">{title}</p>
      <div className="space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[140px_minmax(0,1fr)] gap-2">
            <span className="text-muted-foreground">{label}</span>
            <span className="break-words font-mono">
              {value === null || value === undefined || value === ""
                ? "—"
                : typeof value === "object"
                  ? JSON.stringify(value, null, 2)
                  : String(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default AsinInventoryLookupDialog;
