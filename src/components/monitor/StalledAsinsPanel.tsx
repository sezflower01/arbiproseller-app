import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pause, ExternalLink, RefreshCw, Copy } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";

interface StalledAsin {
  id: string;
  asin: string;
  sku: string;
  marketplace: string;
  last_applied_price: number | null;
  last_buybox_price: number | null;
  last_evaluated_at: string | null;
  last_recommendation_reason: string | null;
  rule_id: string | null;
  snapshot_buybox_price: number | null;
  snapshot_lowest_price: number | null;
  live_my_price: number | null;
}

// Parse "[constrained_by: X,Y]" from the reason string
function parseConstraints(reason: string | null): string[] {
  if (!reason) return [];
  const match = reason.match(/\[constrained_by:\s*([^\]]+)\]/);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

const CONSTRAINT_LABELS: Record<string, { label: string; color: string; readable: string }> = {
  effective_floor: { label: "PROFIT GUARD", readable: "Profit guard blocked move", color: "bg-orange-500/15 text-orange-700 border-orange-500/30" },
  profit_guard: { label: "PROFIT GUARD", readable: "Profit guard blocked move", color: "bg-orange-500/15 text-orange-700 border-orange-500/30" },
  min_price: { label: "MIN BOUND", readable: "At minimum price floor", color: "bg-blue-500/15 text-blue-700 border-blue-500/30" },
  FINAL_CLAMP_MIN: { label: "MIN BOUND", readable: "Clamped to minimum price", color: "bg-blue-500/15 text-blue-700 border-blue-500/30" },
  requires_min_lower: { label: "MIN BOUND", readable: "Needs lower min to compete", color: "bg-blue-500/15 text-blue-700 border-blue-500/30" },
  max_price: { label: "MAX BOUND", readable: "At maximum price ceiling", color: "bg-purple-500/15 text-purple-700 border-purple-500/30" },
  FINAL_CLAMP_MAX: { label: "MAX BOUND", readable: "Clamped to maximum price", color: "bg-purple-500/15 text-purple-700 border-purple-500/30" },
  max_step: { label: "MAX STEP", readable: "Step size limit reached", color: "bg-yellow-500/15 text-yellow-700 border-yellow-500/30" },
  cooldown: { label: "COOLDOWN", readable: "Waiting between changes", color: "bg-gray-500/15 text-gray-700 border-gray-500/30" },
  market_stable: { label: "MARKET STABLE", readable: "Market is stable, no action needed", color: "bg-green-500/15 text-green-700 border-green-500/30" },
  bb_owner_protection: { label: "BB OWNER", readable: "You own the Buy Box — holding", color: "bg-green-500/15 text-green-700 border-green-500/30" },
  buybox_suppressed_lower: { label: "BB SUPPRESSED", readable: "Buy Box suppressed, blocking lower", color: "bg-red-500/15 text-red-700 border-red-500/30" },
  SAFETY_ABORT_MIN: { label: "SAFETY ABORT", readable: "Safety limit triggered", color: "bg-red-500/15 text-red-700 border-red-500/30" },
  SAFETY_ABORT_MAX: { label: "SAFETY ABORT", readable: "Safety limit triggered", color: "bg-red-500/15 text-red-700 border-red-500/30" },
};

// Human-readable labels for internal constraint codes shown in drill-down
const INTERNAL_CODE_LABELS: Record<string, string> = {
  above_bb_not_owner_no_raise: "Above BB — not owner, won't raise",
  raise_blocked_competitor_cheaper: "Competitor cheaper — raise blocked",
  smart_recapture_enforced: "Smart recapture rule active",
  profit_guard_warn: "Profit guard warning",
  min_price_suggestion: "At suggested minimum",
  min_bound: "At minimum bound",
  market_stable: "Market stable — no action",
};

function getReadableCode(code: string): string {
  const lower = code.toLowerCase().replace(/_/g, "_");
  // Check direct match
  if (INTERNAL_CODE_LABELS[lower]) return INTERNAL_CODE_LABELS[lower];
  // intel_X.XXx → "Intelligence factor X.XX×"
  const intelMatch = lower.match(/^intel_(\d+\.\d+)x$/);
  if (intelMatch) return `Intel factor ${intelMatch[1]}×`;
  // fbm_ignored_N → "FBM seller #N filtered"
  const fbmMatch = lower.match(/^fbm_ignored_(\d+)$/);
  if (fbmMatch) return `FBM seller #${fbmMatch[1]} filtered`;
  // quality_filter_N → "Quality filter #N"
  const qfMatch = lower.match(/^quality_filter_(\d+)$/);
  if (qfMatch) return `Low-quality offer #${qfMatch[1]} filtered`;
  return code;
}

function ConstraintBadges({ reason }: { reason: string | null }) {
  const constraints = parseConstraints(reason);
  if (constraints.length === 0) {
    // Fallback: try to infer from reason text
    if (reason?.includes("already at or near floor")) {
      return <Badge variant="outline" className="text-[10px] bg-orange-500/15 text-orange-700 border-orange-500/30">PROFIT GUARD</Badge>;
    }
    if (reason?.includes("owner protection")) {
      return <Badge variant="outline" className="text-[10px] bg-green-500/15 text-green-700 border-green-500/30">BB OWNER</Badge>;
    }
    return <Badge variant="outline" className="text-[10px]">UNKNOWN</Badge>;
  }

  // Deduplicate labels
  const seen = new Set<string>();
  const badges: { label: string; color: string; rawCode: string }[] = [];
  for (const c of constraints) {
    const info = CONSTRAINT_LABELS[c] || { label: c.toUpperCase(), color: "bg-muted text-muted-foreground" };
    if (!seen.has(info.label)) {
      seen.add(info.label);
      badges.push({ ...info, rawCode: c });
    }
  }

  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <Badge key={b.label} variant="outline" className={`text-[10px] ${b.color}`} title={`Raw: ${b.rawCode}`}>
          {b.label}
        </Badge>
      ))}
    </div>
  );
}

export default function StalledAsinsPanel() {
  const [rows, setRows] = useState<StalledAsin[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStalled = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("repricer_assignments")
      .select("id, asin, sku, marketplace, last_applied_price, last_buybox_price, last_evaluated_at, last_recommendation_reason, rule_id")
      .ilike("last_recommendation_reason", "%too small%")
      .order("last_evaluated_at", { ascending: false })
      .limit(200);
    if (error) {
      console.error("Failed to fetch stalled ASINs:", error);
    }

    const assignments = (data || []) as StalledAsin[];

    const asinKeys = [...new Set(assignments.map(r => r.asin))];
    const assignmentMarketplaces = [...new Set(assignments.map(r => r.marketplace))];
    let snapshotMap: Record<string, { buybox_price: number | null; lowest_overall_price: number | null }> = {};
    let livePriceMap: Record<string, number | null> = {};

    if (asinKeys.length > 0) {
      const { data: snapshots } = await supabase
        .from("repricer_competitor_snapshots")
        .select("asin, marketplace, buybox_price, lowest_overall_price, fetched_at")
        .in("asin", asinKeys)
        .order("fetched_at", { ascending: false })
        .limit(500);

      for (const s of (snapshots || [])) {
        const key = `${s.asin}_${s.marketplace}`;
        if (!snapshotMap[key]) {
          snapshotMap[key] = { buybox_price: s.buybox_price, lowest_overall_price: s.lowest_overall_price };
        }
      }

      const skuKeys = [...new Set(assignments.map(r => r.sku))];
      const marketplaceIds = assignmentMarketplaces
        .map((marketplace) => getMarketplaceConfig(marketplace).marketplaceId)
        .filter(Boolean);

      const { data: invPrices } = await supabase
        .from("inventory")
        .select("asin, sku, my_price, price")
        .eq("user_id", (await supabase.auth.getUser()).data.user?.id ?? "")
        .in("sku", skuKeys)
        .limit(500);

      for (const inv of (invPrices || [])) {
        const price = inv.my_price ?? inv.price;
        if (price != null) livePriceMap[`${inv.sku}_US`] = price;
      }

      const { data: cachePrices } = await supabase
        .from("asin_my_price_cache")
        .select("asin, seller_sku, my_price, marketplace_id")
        .eq("user_id", (await supabase.auth.getUser()).data.user?.id ?? "")
        .in("asin", asinKeys)
        .in("marketplace_id", marketplaceIds)
        .not("my_price", "is", null)
        .limit(500);

      for (const cp of (cachePrices || [])) {
        if (cp.my_price != null && cp.seller_sku) {
          const matchedMarketplace = assignmentMarketplaces.find(
            (marketplace) => getMarketplaceConfig(marketplace).marketplaceId === cp.marketplace_id,
          );
          if (!matchedMarketplace) continue;

          const key = `${cp.seller_sku}_${matchedMarketplace}`;
          if (!livePriceMap[key]) livePriceMap[key] = cp.my_price;
        }
      }
    }

    const enriched = assignments.map(r => {
      const snap = snapshotMap[`${r.asin}_${r.marketplace}`];
      return {
        ...r,
        snapshot_buybox_price: snap?.buybox_price ?? null,
        snapshot_lowest_price: snap?.lowest_overall_price ?? null,
        live_my_price: livePriceMap[`${r.sku}_${r.marketplace}`] ?? null,
      };
    });

    const filtered = enriched.filter(r => !(r.snapshot_lowest_price == null && r.snapshot_buybox_price == null));
    setRows(filtered);
    setLoading(false);
  };

  useEffect(() => { fetchStalled(); }, []);

  const priceDiff = (row: StalledAsin) => {
    const myPrice = row.live_my_price ?? row.last_applied_price;
    const bb = row.snapshot_buybox_price ?? row.last_buybox_price;
    if (myPrice == null || bb == null) return null;
    return myPrice - bb;
  };

  // Aggregate constraint stats
  const constraintCounts: Record<string, number> = {};
  for (const r of rows) {
    const constraints = parseConstraints(r.last_recommendation_reason);
    if (constraints.length === 0) {
      const key = r.last_recommendation_reason?.includes("floor") ? "profit_guard" :
        r.last_recommendation_reason?.includes("owner") ? "bb_owner_protection" : "unknown";
      constraintCounts[key] = (constraintCounts[key] || 0) + 1;
    } else {
      // Deduplicate per row
      const seen = new Set<string>();
      for (const c of constraints) {
        const label = CONSTRAINT_LABELS[c]?.label || c;
        if (!seen.has(label)) {
          seen.add(label);
          constraintCounts[label] = (constraintCounts[label] || 0) + 1;
        }
      }
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Pause className="h-5 w-5 text-yellow-500" />
          Constrained ASINs — Delta Collapsed by Guards
          <Badge variant="secondary" className="ml-2">{rows.length}</Badge>
          <span className="text-xs font-normal text-muted-foreground ml-1">(unique ASINs)</span>
        </CardTitle>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => {
            const largeGapRows = rows.filter(r => {
              const gap = priceDiff(r);
              return gap != null && Math.abs(gap) > 1;
            });
            const asins = largeGapRows.map(r => r.asin).join(", ");
            navigator.clipboard.writeText(asins);
            toast.success(`${largeGapRows.length} ASINs (gap > $1) copied to clipboard`);
          }} disabled={rows.filter(r => { const g = priceDiff(r); return g != null && Math.abs(g) > 1; }).length === 0}>
            <Copy className="h-4 w-4 mr-1" />
            Copy All
          </Button>
          <Button size="sm" variant="outline" onClick={fetchStalled} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-6 text-muted-foreground">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            No constrained ASINs — all repricing normally
          </div>
        ) : (
          <>
            {/* Constraint summary badges — grouped by category */}
            {Object.keys(constraintCounts).length > 0 && (
              <div className="space-y-2 mb-3">
                {/* Group constraints into categories */}
                {(() => {
                  const profitLabels = ["PROFIT GUARD", "profit_guard", "effective_floor"];
                  const minMaxLabels = ["MIN BOUND", "MAX BOUND", "min_price", "FINAL_CLAMP_MIN", "requires_min_lower", "FINAL_CLAMP_MAX", "max_price", "MIN_PRICE_SUGGESTION"];
                  const marketLabels = ["BB OWNER", "MARKET STABLE", "COOLDOWN", "bb_owner_protection", "market_stable", "cooldown"];
                  
                  const groups: { title: string; emoji: string; items: [string, number][] }[] = [];
                  
                  const profitItems = Object.entries(constraintCounts).filter(([l]) => 
                    profitLabels.some(pl => l.toUpperCase().includes(pl.toUpperCase()))
                  );
                  const minMaxItems = Object.entries(constraintCounts).filter(([l]) => 
                    minMaxLabels.some(ml => l.toUpperCase().includes(ml.toUpperCase()))
                  );
                  const marketItems = Object.entries(constraintCounts).filter(([l]) => 
                    marketLabels.some(ml => l.toUpperCase().includes(ml.toUpperCase()))
                  );
                  const otherItems = Object.entries(constraintCounts).filter(([l]) =>
                    !profitItems.find(([pl]) => pl === l) &&
                    !minMaxItems.find(([ml]) => ml === l) &&
                    !marketItems.find(([ml]) => ml === l)
                  );

                  if (profitItems.length > 0) groups.push({ title: "Profit Protections", emoji: "🟡", items: profitItems.sort((a, b) => b[1] - a[1]) });
                  if (minMaxItems.length > 0) groups.push({ title: "Price Bounds", emoji: "🔵", items: minMaxItems.sort((a, b) => b[1] - a[1]) });
                  if (marketItems.length > 0) groups.push({ title: "Market Constraints", emoji: "🟢", items: marketItems.sort((a, b) => b[1] - a[1]) });
                  if (otherItems.length > 0) groups.push({ title: "Other Filters", emoji: "⚪", items: otherItems.sort((a, b) => b[1] - a[1]) });

                  return groups.map(group => (
                    <div key={group.title}>
                      <p className="text-xs font-medium text-muted-foreground mb-1">{group.emoji} {group.title}</p>
                      <div className="flex flex-wrap gap-1">
                        {group.items.map(([label, count]) => {
                          const info = Object.values(CONSTRAINT_LABELS).find((l) => l.label === label);
                          const readable = getReadableCode(label.toLowerCase());
                          return (
                            <Badge key={label} variant="outline" className={`text-xs ${info?.color || ""}`} title={`Raw: ${label}`}>
                              {readable !== label.toLowerCase() ? readable : label}: {count}
                            </Badge>
                          );
                        })}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}
            <p className="text-sm text-muted-foreground mb-3">
              These ASINs were evaluated but the calculated price change was &lt;$0.01 after guards.
              The <strong>Constraint</strong> column shows why the target price was clamped back to the current price.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-3">ASIN</th>
                    <th className="pb-2 pr-3">SKU</th>
                    <th className="pb-2 pr-3">MP</th>
                    <th className="pb-2 pr-3 text-right">My Price</th>
                    <th className="pb-2 pr-3 text-right">Low</th>
                    <th className="pb-2 pr-3 text-right">BB</th>
                    <th className="pb-2 pr-3 text-right">Gap</th>
                    <th className="pb-2 pr-3">Constraint</th>
                    <th className="pb-2 pr-3">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const gap = priceDiff(r);
                    const isLargeGap = gap != null && Math.abs(gap) > 1;
                    const myPrice = r.live_my_price ?? r.last_applied_price;
                    return (
                      <tr key={r.id} className={`border-b last:border-0 ${isLargeGap ? "bg-destructive/5" : ""}`}>
                        <td className="py-2 pr-3 font-mono text-xs">
                          <a
                            href={`https://www.${getMarketplaceConfig(r.marketplace).domain}/dp/${r.asin}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline inline-flex items-center gap-1"
                          >
                            {r.asin}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </td>
                        <td className="py-2 pr-3 text-xs truncate max-w-[100px]" title={r.sku}>{r.sku}</td>
                        <td className="py-2 pr-3">
                          <Badge variant="outline" className="text-xs">{r.marketplace}</Badge>
                        </td>
                        <td className="py-2 pr-3 text-right font-mono">
                          {myPrice != null ? (
                            <span title={r.live_my_price != null ? "Live price" : "Stale last-applied"}>
                              ${myPrice.toFixed(2)}
                              {r.live_my_price == null && <span className="text-muted-foreground ml-1 text-xs">⚠</span>}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono text-muted-foreground">
                          {r.snapshot_lowest_price != null ? `$${r.snapshot_lowest_price.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono">
                          {r.snapshot_buybox_price != null ? `$${r.snapshot_buybox_price.toFixed(2)}` : "—"}
                        </td>
                        <td className={`py-2 pr-3 text-right font-mono ${isLargeGap ? "text-destructive font-bold" : "text-muted-foreground"}`}>
                          {gap != null ? `${gap > 0 ? "+" : ""}$${gap.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2 pr-3">
                          <ConstraintBadges reason={r.last_recommendation_reason} />
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {r.last_evaluated_at ? format(new Date(r.last_evaluated_at), "MMM d, HH:mm") : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.filter(r => {
              const gap = priceDiff(r);
              return gap != null && Math.abs(gap) > 1;
            }).length > 0 && (
              <p className="text-xs text-destructive mt-3">
                ⚠ {rows.filter(r => { const g = priceDiff(r); return g != null && Math.abs(g) > 1; }).length} ASINs have gap &gt; $1.00 — check the Constraint column for the specific guard blocking the update.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}