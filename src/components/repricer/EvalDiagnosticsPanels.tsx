import { Badge } from "@/components/ui/badge";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";

interface EvalDiagnosticsPanelsProps {
  factors: any;
  marketplace: string;
  livePrice?: number | null;
}

function makeFmt(symbol: string) {
  return (v: number | null | undefined, prefix?: string) => {
    if (v == null) return "—";
    return `${prefix ?? symbol}${Number(v).toFixed(2)}`;
  };
}

function Row({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium ${highlight ? "text-primary" : "text-foreground"}`}>{value}</span>
    </div>
  );
}

function BoolBadge({ value, trueLabel = "Yes", falseLabel = "No" }: { value: boolean | null | undefined; trueLabel?: string; falseLabel?: string }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return value 
    ? <span className="text-green-600 dark:text-green-400">✅ {trueLabel}</span>
    : <span className="text-red-500 dark:text-red-400">❌ {falseLabel}</span>;
}

function Section({ title, icon, children, defaultOpen = false }: { title: string; icon: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="border rounded-lg overflow-hidden" open={defaultOpen}>
      <summary className="cursor-pointer px-3 py-2 bg-muted/40 hover:bg-muted/60 text-xs font-semibold text-foreground flex items-center gap-2">
        <span>{icon}</span> {title}
      </summary>
      <div className="px-3 py-2 space-y-1 text-xs">
        {children}
      </div>
    </details>
  );
}

export default function EvalDiagnosticsPanels({ factors, marketplace, livePrice }: EvalDiagnosticsPanelsProps) {
  // Currency-safe formatter: use the marketplace's actual currency symbol (MX$, C$, R$, $, etc.)
  // so non-USD marketplaces never display USD-style "$" prefix on local-currency values.
  const currencySymbol = getMarketplaceConfig(marketplace || 'US').currencySymbol;
  const fmt = makeFmt(currencySymbol);

  const pp = factors.position_proof;
  const pt = factors.price_trace;
  const rc = factors.reason_codes;
  const pg = factors.profit_guard;
  const timing = factors.timing;
  const intel = factors.intelligence_summary;
  const bounds = factors.bounds;
  const guards = factors.guards_applied || [];

  return (
    <div className="mt-2 space-y-1.5">
      {/* 1. Position Proof */}
      {pp && (() => {
        const snapMyPrice = pp.my_price;
        const isStale = livePrice != null && snapMyPrice != null && Math.abs(livePrice - snapMyPrice) >= 0.01;
        // Recompute blocker gap against live price when stale
        const blockerGap = pp.blocker
          ? (livePrice != null && pp.blocker.price != null
              ? pp.blocker.price - livePrice
              : pp.blocker.gap)
          : null;
        const gapSign = (g: number | null | undefined) =>
          g == null ? "" : g > 0 ? `+${currencySymbol}${g.toFixed(2)} (competitor higher)` : `${currencySymbol}${g.toFixed(2)} (competitor lower)`;
        return (
        <Section title="Position Proof" icon="🎯" defaultOpen>
          {isStale && (
            <div className="mb-1 px-2 py-1 rounded bg-amber-100 dark:bg-amber-950/40 border border-amber-400 text-amber-800 dark:text-amber-300 text-[10px] font-medium">
              ⚠️ Snapshot is outdated — live price has changed since last evaluation
            </div>
          )}
          <Row label={isStale ? "My price (at snapshot)" : "My price"} value={fmt(pp.my_price)} highlight />
          {isStale && (
            <Row label="Current price (live)" value={<span className="text-green-600 dark:text-green-400 font-semibold">{fmt(livePrice)}</span>} />
          )}
          {pp.has_shipping && pp.my_item_price != null && (
            <div className="ml-3 text-muted-foreground text-[10px] flex gap-2">
              <span>Item: {fmt(pp.my_item_price)}</span>
              <span>+ Shipping: {fmt(pp.my_shipping ?? 0)}</span>
              <span>= Landed: {fmt(pp.my_price)}</span>
            </div>
          )}
          <Row label={isStale ? "Buy Box (at snapshot)" : "Buy Box"} value={fmt(pp.buy_box_price)} />
          <Row label="Lowest (raw)" value={fmt(pp.lowest_price_raw)} />
          <Row label="Lowest (filtered)" value={fmt(pp.lowest_price_filtered)} />
          {pp.has_shipping && pp.lowest_item_price != null && (
            <div className="ml-3 text-muted-foreground text-[10px] flex gap-2">
              <span>Item: {fmt(pp.lowest_item_price)}</span>
              <span>+ Shipping: {fmt(pp.lowest_shipping ?? 0)}</span>
              <span>= Landed: {fmt(pp.lowest_price_filtered)}</span>
            </div>
          )}
          {(() => {
            // Recompute against live price when snapshot is stale, and treat ties as "shared lowest"
            const eps = 0.01;
            const effectiveMy = isStale && livePrice != null ? livePrice : pp.my_price;
            const tieRaw = effectiveMy != null && pp.lowest_price_raw != null && Math.abs(effectiveMy - pp.lowest_price_raw) <= eps;
            const tieFilt = effectiveMy != null && pp.lowest_price_filtered != null && Math.abs(effectiveMy - pp.lowest_price_filtered) <= eps;
            const lowerRaw = effectiveMy != null && pp.lowest_price_raw != null && effectiveMy < pp.lowest_price_raw - eps;
            const lowerFilt = effectiveMy != null && pp.lowest_price_filtered != null && effectiveMy < pp.lowest_price_filtered - eps;
            const renderLowest = (tie: boolean, lower: boolean, fallback: boolean | null | undefined) => {
              if (lower) return <span className="text-green-600 dark:text-green-400">✅ Yes</span>;
              if (tie) return <span className="text-amber-600 dark:text-amber-400">🤝 Shared lowest (tie)</span>;
              return <BoolBadge value={fallback} />;
            };
            return (
              <>
                <Row label="Am I lowest (raw)" value={renderLowest(tieRaw, lowerRaw, pp.am_i_lowest_raw)} />
                <Row label="Am I lowest (filtered)" value={renderLowest(tieFilt, lowerFilt, pp.am_i_lowest_filtered)} />
              </>
            );
          })()}
          <Row label="BB owner (snapshot)" value={
            pp.buy_box_owner_is_me === true 
              ? <span className="text-green-600 dark:text-green-400">✅ Confirmed owner</span>
              : pp.buy_box_owner_is_me === false 
                ? <span className="text-orange-600 dark:text-orange-400">📡 Not owner in this snapshot</span>
                : <BoolBadge value={pp.buy_box_owner_is_me} />
          } />
          <Row label="Lowest channel" value={pp.lowest_offer_channel || "—"} />
          <Row label="Competitors (raw)" value={pp.competitor_count_raw ?? "—"} />
          <Row label="Competitors (filtered)" value={pp.competitor_count_filtered ?? "—"} />
          {pp.is_price_cluster != null && (
            <div className="border-t border-border pt-1 mt-1">
              <Row label="🔄 Price cluster" value={
                pp.is_price_cluster 
                  ? <span className="text-amber-600 dark:text-amber-400">⚠️ YES — {pp.lowest_price_seller_count} sellers at same price</span>
                  : <span className="text-green-600 dark:text-green-400">No cluster</span>
              } />
            </div>
          )}
          {pp.has_shipping && (
            <div className="border-t border-border pt-1 mt-1">
              <span className="text-blue-600 dark:text-blue-400 text-[10px] font-medium">📦 Comparison uses landed price (item + shipping)</span>
            </div>
          )}
          {pp.filter_gap_warning && (
            <div className="border-t border-border pt-1 mt-1">
              <span className="text-amber-600 dark:text-amber-400 text-[10px] font-medium">{pp.filter_gap_warning}</span>
            </div>
          )}
          {pp.blocker && (
            <div className="border-t border-border pt-1 mt-1">
              <Row 
                label="⚠️ Blocker" 
                value={`${pp.blocker.channel} ${pp.blocker.seller_id?.slice(0, 10)}… @ ${fmt(pp.blocker.price)} (gap: ${gapSign(blockerGap)})`} 
              />
              {pp.has_shipping && pp.blocker.item_price != null && (
                <div className="ml-3 text-muted-foreground text-[10px] flex gap-2">
                  <span>Item: {fmt(pp.blocker.item_price)}</span>
                  <span>+ Shipping: {fmt(pp.blocker.shipping ?? 0)}</span>
                  <span>= Landed: {fmt(pp.blocker.price)}</span>
                </div>
              )}
            </div>
          )}
        </Section>
        );
      })()}

      {/* 2. Price Trace */}
      {pt && (
        <Section title="Price Trace" icon="📊" defaultOpen>
          <Row label="Current price" value={fmt(pt.current_price)} />
          <Row label="Buy Box" value={fmt(pt.buybox_price)} />
          <Row label="Lowest FBA" value={fmt(pt.lowest_fba)} />
          <Row label="Lowest overall" value={fmt(pt.lowest_overall)} />
          <div className="border-t border-border pt-1 mt-1" />
          <Row label="Anchor" value={
            <Badge variant="outline" className="text-[10px] py-0">{pt.anchor_source || "—"}</Badge>
          } />
          <Row label="BB source" value={
            <Badge variant="outline" className={`text-[10px] py-0 ${
              pt.bb_confidence === 'high' ? 'border-green-500 text-green-700 dark:text-green-400' :
              pt.bb_confidence === 'medium' ? 'border-yellow-500 text-yellow-700 dark:text-yellow-400' :
              'border-red-500 text-red-700 dark:text-red-400'
            }`}>{pt.bb_source} ({pt.bb_confidence})</Badge>
          } />
          <Row label="Raw target" value={fmt(pt.raw_target)} />
          <Row label="Final price" value={fmt(pt.final_price)} highlight />
          <Row label="Delta" value={pt.delta != null ? `${pt.delta >= 0 ? '+' : ''}${currencySymbol}${pt.delta.toFixed(3)}` : "—"} />
          <Row label="Mode" value={
            <Badge variant="secondary" className="text-[10px] py-0">{pt.mode}</Badge>
          } />
          {/* Safeguard clamp indicator */}
          {pt.clamped_by && (
            <div className="border-t border-border pt-1 mt-1">
              <div className="flex items-center gap-1.5">
                <span className="text-amber-600 dark:text-amber-400 font-semibold text-[10px]">⚠️ Safeguard:</span>
                <span className="text-amber-600 dark:text-amber-400 text-[10px]">
                  Raw target {fmt(pt.raw_target)} clamped to {pt.clamped_by === 'min' || pt.clamped_by === 'floor' ? 'Min floor' : 'Max ceiling'} {pt.clamped_by === 'min' || pt.clamped_by === 'floor' ? fmt(pt.min_floor) : fmt(pt.max_ceiling)}
                </span>
              </div>
            </div>
          )}
          {/* Show min/max bounds for reference */}
          {(pt.min_floor != null || pt.max_ceiling != null) && !pt.clamped_by && (
            <div className="border-t border-border pt-1 mt-1 text-muted-foreground">
              {pt.min_floor != null && <Row label="Min floor" value={fmt(pt.min_floor)} />}
              {pt.max_ceiling != null && <Row label="Max ceiling" value={fmt(pt.max_ceiling)} />}
            </div>
          )}
        </Section>
      )}

      {/* 3. Competitor Filter Summary */}
      {rc && (
        <Section title="Competitor Filters" icon="🔍">
          <Row label="Offers (raw)" value={rc.offers_count_raw ?? "—"} />
          <Row label="Offers (after filter)" value={rc.offers_count_after_filter ?? "—"} />
          <Row label="Offers status" value={
            <Badge variant={rc.offers_status === 'ok' ? 'default' : 'destructive'} className="text-[10px] py-0">
              {rc.offers_status}
            </Badge>
          } />
          {rc.filters_applied && rc.filters_applied.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {rc.filters_applied.map((f: string, i: number) => (
                <Badge key={i} variant="secondary" className="text-[10px] py-0">{f}</Badge>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* 4. AI / Tuning */}
      {(factors.tuning_source || factors.enhanced_multiplier != null) && (
        <Section title="AI / Tuning" icon="🧠">
          <Row label="Tuning source" value={factors.tuning_source || "none"} />
          <Row label="Enhanced multiplier" value={factors.enhanced_multiplier != null ? `${factors.enhanced_multiplier.toFixed(2)}x` : "—"} />
          <Row label="Combined multiplier" value={factors.combined_multiplier != null ? `${factors.combined_multiplier.toFixed(2)}x` : "—"} />
          {factors.enhanced_factors && factors.enhanced_factors.length > 0 && (
            <div className="mt-1">
              <span className="text-muted-foreground">Factors:</span>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {factors.enhanced_factors.map((f: string, i: number) => (
                  <Badge key={i} variant="outline" className="text-[10px] py-0">{f}</Badge>
                ))}
              </div>
            </div>
          )}
          {intel && (
            <div className="border-t border-border pt-1 mt-1 space-y-1">
              <Row label="Sales velocity" value={`${intel.velocity ?? 0}/100`} />
              <Row label="BB win rate" value={`${intel.bb_win_rate ?? 0}%`} />
              <Row label="BB win streak" value={intel.bb_win_streak ?? 0} />
              <Row label="BB loss streak" value={intel.bb_loss_streak ?? 0} />
              <Row label="Urgency" value={`${intel.urgency ?? 0}/100`} />
              <Row label="FBA competitors" value={intel.fba_competitors ?? "—"} />
              <Row label="Competitor stock" value={intel.competitor_stock || "—"} />
              <Row label="Amazon selling" value={<BoolBadge value={intel.amazon_selling} />} />
              <Row label="Days of stock" value={intel.days_of_stock ?? "—"} />
              <Row label="Stock modifier" value={intel.stock_modifier != null ? `${intel.stock_modifier.toFixed(2)}x` : "—"} />
              <Row label="Units today" value={intel.units_today ?? 0} />
              <Row label="Momentum triggered" value={<BoolBadge value={intel.momentum_triggered} />} />
            </div>
          )}
        </Section>
      )}

      {/* 5. Guard Results */}
      {(guards.length > 0 || pg) && (
        <Section title="Guard Results" icon="🛡️">
          {pg && (
            <>
              <Row label="Profit guard" value={pg.enabled ? (pg.blocked ? "❌ BLOCKED" : "✅ Passed") : "OFF"} />
              <Row label="PG mode" value={pg.mode || "—"} />
              <Row label="Unit cost" value={pg.unit_cost ? `${fmt(pg.unit_cost)} (${pg.cost_source})` : "—"} />
              <Row label="Est. fees" value={pg.estimated_fees ? `${fmt(pg.estimated_fees)} (${pg.fees_source})` : "—"} />
              <Row label="Profit floor" value={fmt(pg.profit_floor_price)} />
              <Row label="Min ROI" value={pg.effective_min_roi != null ? `${pg.effective_min_roi}%${pg.is_high_risk ? ' (HIGH RISK)' : ''}` : "—"} />
            </>
          )}
          {guards.length > 0 && (
            <div className="border-t border-border pt-1 mt-1">
              <span className="text-muted-foreground">Guards applied:</span>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {guards.map((g: string, i: number) => (
                  <Badge key={i} variant="outline" className="text-[10px] py-0">{g}</Badge>
                ))}
              </div>
            </div>
          )}
          {bounds && (
            <div className="border-t border-border pt-1 mt-1">
              <Row label="Min price" value={fmt(bounds.min_price)} />
              <Row label="Max price" value={fmt(bounds.max_price)} />
              <Row label="Undercut" value={fmt(bounds.undercut_amount)} />
              <Row label="Fulfillment" value={bounds.fulfillment_type || "—"} />
              <Row label="Compete" value={
                [bounds.compete_amazon && 'AMZ', bounds.compete_fba && 'FBA', bounds.compete_fbm && 'FBM'].filter(Boolean).join(', ') || "—"
              } />
            </div>
          )}
        </Section>
      )}

      {/* 6. Timing */}
      {timing && (
        <Section title="Timing" icon="⏱️">
          <Row label="Total" value={`${timing.total_ms}ms`} highlight />
          <Row label="Context" value={`${timing.context_ms}ms`} />
          <Row label="SP-API" value={`${timing.sp_api_ms}ms`} />
          <Row label="Rolling window" value={`${timing.rolling_ms}ms`} />
          <Row label="Intelligence" value={`${timing.intel_ms}ms`} />
          <Row label="Pricing" value={`${timing.pricing_ms}ms`} />
          <Row label="DB writes" value={`${timing.write_ms}ms`} />
        </Section>
      )}

      {/* Raw JSON fallback for any extra data */}
      <details className="border rounded-lg overflow-hidden">
        <summary className="cursor-pointer px-3 py-2 bg-muted/20 hover:bg-muted/40 text-[10px] text-muted-foreground">
          Raw JSON
        </summary>
        <pre className="text-[10px] bg-muted p-2 overflow-x-auto max-h-[200px]">
          {JSON.stringify(factors, null, 2)}
        </pre>
      </details>
    </div>
  );
}
