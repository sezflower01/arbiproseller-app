import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Boxes, Package, Truck, Sparkles, Info, AlertTriangle } from "lucide-react";

/**
 * Wholesale Optimization Engine — Phase 1 (per-SKU).
 *
 * RECOMMENDATION-ONLY. Does NOT modify draft, boxes, or Amazon payload.
 * Computes a per-SKU carton distribution from each row's units, units/case
 * and unit weight. Totals roll up only after every row has the inputs it
 * needs — no fake "0 lb" cartons or guessed FC split risk.
 */

const LS_PREFIX = "arbi_wholesale_opt_v2_";

interface SkuOverride {
  unitsPerCase: number;
  unitWeightLb: number;
}

interface OptimizerState {
  maxCartonWeightLb: number;
  preferLtl: boolean;
  overrides: Record<string, SkuOverride>;
}

export interface OptimizerSkuRow {
  sku: string;
  title?: string | null;
  units: number;
}

interface PerSkuPlan {
  sku: string;
  title?: string | null;
  units: number;
  unitsPerCase: number;
  unitWeightLb: number;
  unitsPerCarton: number;
  cartons: number;
  fullCartons: number;
  partialUnits: number;
  cartonWeightLb: number;
  missing: string[];
}

function useScopedState(draftId: string | null | undefined) {
  const key = `${LS_PREFIX}${draftId ?? "unscoped"}`;
  const [state, setState] = useState<OptimizerState>(() => {
    if (typeof window === "undefined") {
      return { maxCartonWeightLb: 50, preferLtl: false, overrides: {} };
    }
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw) as OptimizerState;
    } catch {
      // ignore
    }
    return { maxCartonWeightLb: 50, preferLtl: false, overrides: {} };
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [key, state]);

  return [state, setState] as const;
}

function planForSku(row: OptimizerSkuRow, override: SkuOverride | undefined, maxW: number): PerSkuPlan {
  const units = Math.max(0, Math.floor(row.units || 0));
  const upc = Math.max(0, Math.floor(override?.unitsPerCase || 0));
  const unitW = Math.max(0, Number(override?.unitWeightLb) || 0);

  const missing: string[] = [];
  if (upc <= 0) missing.push("units/case");
  if (unitW <= 0) missing.push("unit weight");

  // Cap per-carton by weight when known; otherwise just use case pack.
  const weightCap = unitW > 0 ? Math.max(1, Math.floor(maxW / unitW)) : Infinity;
  const perCarton = upc > 0 ? Math.min(upc, weightCap) : units > 0 ? units : 0;

  const cartons = perCarton > 0 ? Math.ceil(units / perCarton) : 0;
  const fullCartons = perCarton > 0 ? Math.floor(units / perCarton) : 0;
  const partialUnits = perCarton > 0 ? units - fullCartons * perCarton : 0;
  const cartonWeightLb = unitW > 0 ? perCarton * unitW : 0;

  return {
    sku: row.sku,
    title: row.title,
    units,
    unitsPerCase: upc,
    unitWeightLb: unitW,
    unitsPerCarton: perCarton,
    cartons,
    fullCartons,
    partialUnits,
    cartonWeightLb,
    missing,
  };
}

export default function WholesaleOptimizer({
  draftId,
  skuRows,
}: {
  draftId?: string | null;
  skuRows: OptimizerSkuRow[];
}) {
  const [state, setState] = useScopedState(draftId);

  const plans = useMemo(
    () => skuRows.filter((r) => (r.units ?? 0) > 0).map((r) => planForSku(r, state.overrides[r.sku], state.maxCartonWeightLb)),
    [skuRows, state.overrides, state.maxCartonWeightLb],
  );

  const totalUnits = plans.reduce((a, p) => a + p.units, 0);
  const totalCartons = plans.reduce((a, p) => a + p.cartons, 0);
  const totalWeight = plans.reduce((a, p) => a + p.cartonWeightLb * p.cartons, 0);
  const anyMissing = plans.some((p) => p.missing.length > 0);

  // FC split risk uses SKU count + carton count + completeness.
  let fcRisk: "unknown" | "low" | "medium" | "high" = "unknown";
  if (!anyMissing && plans.length > 0) {
    const skuCount = plans.length;
    if (totalCartons <= 4 && skuCount <= 2) fcRisk = "low";
    else if (totalCartons <= 12 && skuCount <= 4) fcRisk = "medium";
    else fcRisk = "high";
  }

  // Mode hint — only when weights known.
  const palletEstimate = !anyMissing && (state.preferLtl || totalUnits >= 300)
    ? Math.max(1, Math.ceil(totalCartons / 40))
    : null;
  const modeHint = anyMissing
    ? "—"
    : palletEstimate
    ? `LTL · ~${palletEstimate} pallet${palletEstimate > 1 ? "s" : ""}`
    : "SPD";

  const setOverride = (sku: string, patch: Partial<SkuOverride>) => {
    setState({
      ...state,
      overrides: {
        ...state.overrides,
        [sku]: { unitsPerCase: 0, unitWeightLb: 0, ...state.overrides[sku], ...patch },
      },
    });
  };

  return (
    <Card className="border-l-4 border-l-primary border border-white/10 bg-shipment-surface/60 p-4 text-white backdrop-blur-md">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Wholesale carton distribution</h3>
        <Badge className="ml-auto bg-primary/15 text-primary border-primary/30">Advisory only</Badge>
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-md bg-primary/5 border border-primary/15 p-2 text-[11px] text-white/70">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span>
          This is a <span className="text-white/90 font-medium">pre-planning estimate</span> to help you decide between
          small-parcel and pallet freight before Amazon. It does <span className="text-white/90 font-medium">not</span> change
          your shipment, boxes, or anything sent to Amazon — actual cartons, weights, and SPD/LTL are still chosen in Seller Central after handoff.
        </span>
      </div>

      {/* Global settings */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div>
          <Label className="text-xs text-white/70">Max carton weight (lb)</Label>
          <Input
            type="number"
            min="1"
            value={state.maxCartonWeightLb || ""}
            onChange={(e) => setState({ ...state, maxCartonWeightLb: Number(e.target.value) || 50 })}
            className="bg-white/5 text-white"
          />
          <p className="mt-1 text-[10px] text-white/40">Amazon's standard limit is 50 lb per carton.</p>
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 rounded-md bg-white/5 px-3 py-2 text-xs text-white/80 cursor-pointer">
            <input
              type="checkbox"
              checked={state.preferLtl}
              onChange={(e) => setState({ ...state, preferLtl: e.target.checked })}
            />
            Prefer pallet / LTL freight
          </label>
        </div>
        <div className="md:col-span-2 flex items-end">
          <div className="w-full rounded-md bg-white/5 px-3 py-2 text-[11px] text-white/60">
            Enter <span className="text-white/80">units per carton</span> and <span className="text-white/80">unit weight</span> for each SKU below to generate a real carton plan.
          </div>
        </div>
      </div>

      {plans.length === 0 ? (
        <div className="mt-4 flex items-center gap-2 rounded-md bg-white/5 p-3 text-xs text-white/60">
          <Info className="h-3.5 w-3.5 text-primary" />
          Add SKUs with quantities in Step 2 to generate a carton plan.
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-white/50">
              <tr className="text-left">
                <th className="py-2 pr-2 font-medium">SKU</th>
                <th className="py-2 pr-2 font-medium">Units</th>
                <th className="py-2 pr-2 font-medium">Units per carton (case pack)</th>
                <th className="py-2 pr-2 font-medium">Unit wt (lb)</th>
                <th className="py-2 pr-2 font-medium">Packed per carton</th>
                <th className="py-2 pr-2 font-medium">Cartons</th>
                <th className="py-2 pr-2 font-medium">Est. carton wt</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => {
                const ov = state.overrides[p.sku];
                const incomplete = p.missing.length > 0;
                return (
                  <tr key={p.sku} className="border-t border-white/5 align-top">
                    <td className="py-2 pr-2">
                      <div className="font-mono text-[11px] text-white/80">{p.sku}</div>
                      {p.title ? (
                        <div className="line-clamp-2 max-w-[260px] text-[10px] text-white/40">{p.title}</div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-2 text-white/90">{p.units.toLocaleString()}</td>
                    <td className="py-2 pr-2">
                      <Input
                        type="number"
                        min="0"
                        value={ov?.unitsPerCase || ""}
                        onChange={(e) => setOverride(p.sku, { unitsPerCase: Number(e.target.value) || 0 })}
                        className="h-8 w-20 bg-white/5 text-white"
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={ov?.unitWeightLb || ""}
                        onChange={(e) => setOverride(p.sku, { unitWeightLb: Number(e.target.value) || 0 })}
                        className="h-8 w-20 bg-white/5 text-white"
                      />
                    </td>
                    <td className="py-2 pr-2">
                      {incomplete ? (
                        <span className="text-white/40">—</span>
                      ) : (
                        <span className="font-semibold text-primary">{p.unitsPerCarton}</span>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      {incomplete ? (
                        <span className="text-white/40">—</span>
                      ) : (
                        <div>
                          <div className="font-semibold text-primary">{p.cartons}</div>
                          {p.partialUnits > 0 ? (
                            <div className="text-[10px] text-white/50">
                              {p.fullCartons} full + 1 partial ({p.partialUnits})
                            </div>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      {p.unitWeightLb > 0 ? (
                        <span className="text-white/80">~{p.cartonWeightLb.toFixed(1)} lb</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-amber-300">
                          <AlertTriangle className="h-3 w-3" /> needs weight
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-white/10 text-white/80">
                <td className="py-2 pr-2 text-white/60">Totals</td>
                <td className="py-2 pr-2 font-semibold">{totalUnits.toLocaleString()}</td>
                <td className="py-2 pr-2" />
                <td className="py-2 pr-2" />
                <td className="py-2 pr-2" />
                <td className="py-2 pr-2 font-semibold text-primary">
                  {anyMissing ? <span className="text-white/40">—</span> : totalCartons}
                </td>
                <td className="py-2 pr-2">
                  {anyMissing ? (
                    <span className="text-white/40">—</span>
                  ) : (
                    <span>~{totalWeight.toFixed(1)} lb</span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Roll-up summary */}
      {plans.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryTile icon={Package} label="Total cartons" value={anyMissing ? "—" : String(totalCartons)} />
          <SummaryTile
            icon={Truck}
            label="Mode hint"
            value={modeHint}
            help={anyMissing ? "Add weights to estimate mode" : undefined}
          />
          <SummaryTile
            icon={Boxes}
            label="FC split risk"
            value={fcRisk === "unknown" ? "—" : fcRisk}
            tone={fcRisk === "low" ? "good" : fcRisk === "high" ? "warn" : fcRisk === "medium" ? "warn" : "neutral"}
            help={
              fcRisk === "unknown"
                ? "Needs case-pack + weight on every SKU"
                : `${plans.length} SKU${plans.length > 1 ? "s" : ""} · ${totalCartons} cartons`
            }
          />
          <SummaryTile
            icon={AlertTriangle}
            label="Missing inputs"
            value={anyMissing ? `${plans.filter((p) => p.missing.length).length} SKU(s)` : "None"}
            tone={anyMissing ? "warn" : "good"}
          />
        </div>
      ) : null}

      {plans.length > 0 ? (
        <div className="mt-3 rounded-md border border-white/10 bg-white/5 p-3 text-[11px] text-white/70">
          <div className="mb-1 font-medium text-white/90">SPD vs LTL — quick guide</div>
          <ul className="space-y-1">
            <li><span className="text-white/90 font-medium">SPD</span> (Small Parcel Delivery): individual cartons via UPS/FedEx. Best when you have a few cartons (~&lt; 15) and each is under 50 lb.</li>
            <li><span className="text-white/90 font-medium">LTL / pallet</span> (Less-Than-Truckload): cartons stacked on pallets, picked up by a freight carrier. Usually cheaper per unit once you're around <span className="text-white/90">≥ 15–20 cartons</span> or shipping <span className="text-white/90">heavy/bulky</span> goods.</li>
            <li className="text-white/50">Amazon will offer the actual SPD vs LTL options (and prices) after you create the inbound plan — this estimate just helps you anticipate which one you'll likely pick.</li>
          </ul>
        </div>
      ) : null}

      <p className="mt-3 text-[10px] text-white/40">
        Carton counts, mode hint, and split risk are estimates only. Your boxes, shipment, and Amazon handoff are never changed automatically.
      </p>
    </Card>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  value,
  help,
  tone = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  help?: string;
  tone?: "good" | "warn" | "neutral";
}) {
  const border =
    tone === "good" ? "border-emerald-400/40" : tone === "warn" ? "border-amber-400/40" : "border-white/10";
  const valueColor =
    tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-primary";
  return (
    <div className={`rounded-md border ${border} bg-white/5 p-3`}>
      <div className="flex items-center gap-2 text-[11px] text-white/60">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`mt-1 text-base font-semibold capitalize ${valueColor}`}>{value}</div>
      {help ? <div className="mt-0.5 text-[10px] text-white/40">{help}</div> : null}
    </div>
  );
}
