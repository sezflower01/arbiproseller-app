import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface StuckRow {
  asin: string;
  sku: string;
  marketplace: string;
  available: number;
  reserved: number;
  inbound: number;
  listing_status: string | null;
}

export default function StuckAssignmentsPanel() {
  const [rows, setRows] = useState<StuckRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fixing, setFixing] = useState(false);

  const fetchStuck = async () => {
    setLoading(true);
    try {
      // Get enabled assignments
      const { data: assignments } = await supabase
        .from("repricer_assignments")
        .select("asin, sku, marketplace, user_id")
        .eq("is_enabled", true);

      if (!assignments?.length) { setRows([]); setLoading(false); return; }

      const skus = [...new Set(assignments.map(a => a.sku).filter(Boolean))];
      const userId = assignments[0].user_id;

      // Get inventory for those SKUs
      const { data: inventory } = await supabase
        .from("inventory")
        .select("asin, sku, available, reserved, inbound, listing_status")
        .eq("user_id", userId)
        .in("sku", skus);

      const invMap = new Map((inventory || []).map(i => [i.sku, i]));

      const stuck: StuckRow[] = [];
      for (const a of assignments) {
        const inv = invMap.get(a.sku);
        if (!inv) continue;
        if ((inv.available ?? 0) === 0) {
          stuck.push({
            asin: a.asin,
            sku: a.sku,
            marketplace: a.marketplace,
            available: inv.available ?? 0,
            reserved: inv.reserved ?? 0,
            inbound: inv.inbound ?? 0,
            listing_status: inv.listing_status,
          });
        }
      }
      setRows(stuck);
    } catch (e) {
      console.error("StuckAssignments fetch error:", e);
    }
    setLoading(false);
  };

  useEffect(() => { fetchStuck(); }, []);

  const handleFixAll = async () => {
    if (!rows.length) return;
    setFixing(true);
    try {
      // Disable all stuck assignments
      for (const r of rows) {
        await supabase
          .from("repricer_assignments")
          .update({
            is_enabled: false,
            manual_paused: false,
            last_disabled_by: "user",
            last_disabled_reason: "Stuck assignments panel: bulk fix",
            last_disabled_at: new Date().toISOString(),
          })
          .eq("asin", r.asin)
          .eq("marketplace", r.marketplace)
          .eq("is_enabled", true);
      }
      toast.success(`Disabled ${rows.length} stuck assignments`);
      await fetchStuck();
    } catch (e: any) {
      toast.error("Fix failed: " + e.message);
    }
    setFixing(false);
  };

  if (loading) return null;
  if (!rows.length) return null; // Only show when there are issues

  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          Stuck Assignments — Enabled but Zero Available Stock
          <Badge variant="destructive" className="ml-2">{rows.length}</Badge>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchStuck} disabled={loading}>
              <RefreshCw className="h-3 w-3 mr-1" /> Refresh
            </Button>
            <Button variant="destructive" size="sm" onClick={handleFixAll} disabled={fixing}>
              {fixing ? "Fixing..." : `Disable All (${rows.length})`}
            </Button>
          </div>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          These assignments are still enabled but have 0 available (sellable) inventory.
          Reserved/inbound units are not buyable — these waste API quota and inflate coverage.
        </p>
      </CardHeader>
      <CardContent>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-1 px-2">ASIN</th>
                <th className="text-left py-1 px-2">SKU</th>
                <th className="text-center py-1 px-2">Mkt</th>
                <th className="text-center py-1 px-2">Avail</th>
                <th className="text-center py-1 px-2">Rsrvd</th>
                <th className="text-center py-1 px-2">Inbound</th>
                <th className="text-center py-1 px-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.asin}-${r.marketplace}-${i}`} className="border-b border-border/30">
                  <td className="py-1 px-2 font-mono">{r.asin}</td>
                  <td className="py-1 px-2 font-mono text-muted-foreground">{r.sku}</td>
                  <td className="py-1 px-2 text-center">{r.marketplace}</td>
                  <td className="py-1 px-2 text-center text-destructive font-bold">{r.available}</td>
                  <td className="py-1 px-2 text-center">{r.reserved}</td>
                  <td className="py-1 px-2 text-center">{r.inbound}</td>
                  <td className="py-1 px-2 text-center">
                    {r.listing_status ? (
                      <Badge variant={r.listing_status === "ACTIVE" ? "default" : "secondary"} className="text-[10px]">
                        {r.listing_status}
                      </Badge>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
