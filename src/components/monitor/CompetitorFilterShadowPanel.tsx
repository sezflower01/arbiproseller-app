import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, Search, Eye, AlertTriangle, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

interface AsinDetail {
  asin: string;
  myPrice: number | null;
  buyboxPrice: number | null;
  lowestFba: number | null;
  lowestFbm: number | null;
  isBuyboxOwner: boolean;
  lastChecked: string;
  category: "no_data" | "only_self" | "fbm_filtered" | "quality_filtered" | "monopoly";
}

export default function CompetitorFilterShadowPanel() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [details, setDetails] = useState<AsinDetail[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!user) return;
    const fetchData = async () => {
      setLoading(true);

      // Get recent "no competitors" eval acks
      const { data: acks } = await supabase
        .from("repricer_eval_acks")
        .select("asin, my_price, buybox_price, lowest_fba_price, lowest_fbm_price, is_buybox_owner, acked_at")
        .eq("user_id", user.id)
        .like("reason", "%No eligible competitors%")
        .gte("acked_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order("acked_at", { ascending: false })
        .limit(500);

      if (!acks) { setLoading(false); return; }

      // Deduplicate — keep latest per ASIN
      const seen = new Set<string>();
      const unique: AsinDetail[] = [];
      for (const a of acks) {
        if (seen.has(a.asin)) continue;
        seen.add(a.asin);

        let category: AsinDetail["category"] = "no_data";
        const hasData = a.buybox_price || a.lowest_fba_price || a.lowest_fbm_price;
        if (!hasData) {
          category = "no_data";
        } else if (a.lowest_fba_price && !a.lowest_fbm_price) {
          // Only FBA prices and user is the lowest → "only self"
          category = a.my_price && a.lowest_fba_price && Math.abs(a.my_price - a.lowest_fba_price) < 0.05 ? "only_self" : "quality_filtered";
        } else if (a.lowest_fbm_price && !a.lowest_fba_price) {
          category = "fbm_filtered";
        } else if (a.lowest_fbm_price && a.lowest_fba_price) {
          // Has both — user is likely lowest FBA and FBM was ignored
          category = a.my_price && a.lowest_fba_price && Math.abs(a.my_price - a.lowest_fba_price) < 0.05 ? "fbm_filtered" : "quality_filtered";
        } else {
          category = "no_data";
        }

        unique.push({
          asin: a.asin,
          myPrice: a.my_price,
          buyboxPrice: a.buybox_price,
          lowestFba: a.lowest_fba_price,
          lowestFbm: a.lowest_fbm_price,
          isBuyboxOwner: a.is_buybox_owner || false,
          lastChecked: a.acked_at,
          category,
        });
      }

      setDetails(unique);
      setLoading(false);
    };
    fetchData();
  }, [user]);

  const counts = {
    no_data: details.filter(d => d.category === "no_data").length,
    only_self: details.filter(d => d.category === "only_self").length,
    fbm_filtered: details.filter(d => d.category === "fbm_filtered").length,
    quality_filtered: details.filter(d => d.category === "quality_filtered").length,
  };

  const total = details.length;
  const actionable = counts.fbm_filtered + counts.quality_filtered;

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Search className="h-4 w-4 text-primary" />
          Competitor Filter Shadow Analysis
          <Badge variant="secondary" className="ml-auto">{total} ASINs</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </div>
        ) : (
          <>
            {/* Category breakdown */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg border bg-background p-3 text-center">
                <p className="text-2xl font-bold text-muted-foreground">{counts.no_data}</p>
                <p className="text-xs text-muted-foreground">No SP-API Data</p>
                <p className="text-[10px] text-muted-foreground/70">Empty offers response</p>
              </div>
              <div className="rounded-lg border bg-background p-3 text-center">
                <p className="text-2xl font-bold text-blue-500">{counts.only_self}</p>
                <p className="text-xs text-muted-foreground">Only Seller (FBA)</p>
                <p className="text-[10px] text-muted-foreground/70">You are the only FBA</p>
              </div>
              <div className="rounded-lg border bg-background p-3 text-center">
                <p className="text-2xl font-bold text-orange-500">{counts.fbm_filtered}</p>
                <p className="text-xs text-muted-foreground">FBM Filtered Out</p>
                <p className="text-[10px] text-muted-foreground/70">Could target FBM price</p>
              </div>
              <div className="rounded-lg border bg-background p-3 text-center">
                <p className="text-2xl font-bold text-red-500">{counts.quality_filtered}</p>
                <p className="text-xs text-muted-foreground">Quality Filter</p>
                <p className="text-[10px] text-muted-foreground/70">Top-N / rating trim</p>
              </div>
            </div>

            {/* Insight box */}
            <div className="rounded-lg border p-3 bg-muted/30 space-y-2">
              <div className="flex items-start gap-2">
                <Info className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                <div className="text-sm space-y-1">
                  <p>
                    <strong>{counts.no_data}</strong> of {total} ASINs ({total > 0 ? Math.round(counts.no_data / total * 100) : 0}%) returned
                    <strong> zero offers from SP-API</strong> — this is NOT a filter problem. These listings may be suppressed,
                    restricted, or have no active sellers.
                  </p>
                  {actionable > 0 && (
                    <p className="text-orange-600">
                      <strong>{actionable} ASINs</strong> have real competitor data but got filtered out.
                      These are potentially unlockable with a selective filter relaxation.
                    </p>
                  )}
                  {counts.fbm_filtered > 0 && (
                    <p className="text-muted-foreground text-xs">
                      💡 <strong>FBM Filtered:</strong> These ASINs have FBM competitors whose prices got ignored because
                      "ignore FBM unless BB owner" is active. The FBM-Premium fallback should handle these — check if it's triggering.
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Expandable ASIN table */}
            <Collapsible open={expanded} onOpenChange={setExpanded}>
              <CollapsibleTrigger asChild>
                <Button variant="outline" size="sm" className="w-full text-xs gap-1">
                  <Eye className="h-3 w-3" />
                  {expanded ? "Hide" : "Show"} ASIN Details
                  {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <div className="max-h-96 overflow-auto rounded border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">ASIN</TableHead>
                        <TableHead className="text-xs">Category</TableHead>
                        <TableHead className="text-xs text-right">My Price</TableHead>
                        <TableHead className="text-xs text-right">Buy Box</TableHead>
                        <TableHead className="text-xs text-right">Lowest FBA</TableHead>
                        <TableHead className="text-xs text-right">Lowest FBM</TableHead>
                        <TableHead className="text-xs">BB Owner</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {details.map(d => (
                        <TableRow key={d.asin}>
                          <TableCell className="text-xs font-mono py-1">
                            <a href={`https://www.amazon.com/dp/${d.asin}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                              {d.asin}
                            </a>
                          </TableCell>
                          <TableCell className="py-1">
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${
                                d.category === "no_data" ? "text-muted-foreground" :
                                d.category === "only_self" ? "text-blue-500 border-blue-500/30" :
                                d.category === "fbm_filtered" ? "text-orange-500 border-orange-500/30" :
                                "text-red-500 border-red-500/30"
                              }`}
                            >
                              {d.category === "no_data" ? "No Data" :
                               d.category === "only_self" ? "Only Seller" :
                               d.category === "fbm_filtered" ? "FBM Filtered" :
                               "Quality Filter"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-right py-1 font-mono">
                            {d.myPrice ? `$${d.myPrice.toFixed(2)}` : "—"}
                          </TableCell>
                          <TableCell className="text-xs text-right py-1 font-mono">
                            {d.buyboxPrice ? `$${d.buyboxPrice.toFixed(2)}` : "—"}
                          </TableCell>
                          <TableCell className="text-xs text-right py-1 font-mono">
                            {d.lowestFba ? `$${d.lowestFba.toFixed(2)}` : "—"}
                          </TableCell>
                          <TableCell className="text-xs text-right py-1 font-mono">
                            {d.lowestFbm ? `$${d.lowestFbm.toFixed(2)}` : "—"}
                          </TableCell>
                          <TableCell className="text-xs py-1">
                            {d.isBuyboxOwner ? "✅" : "❌"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </CardContent>
    </Card>
  );
}
