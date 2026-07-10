import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useBusinessMode } from "@/hooks/use-business-mode";
import { getModeConfig } from "@/lib/shipment/businessMode";
import { Boxes, Truck, Users, Info, AlertTriangle, Calculator, Gauge, Lightbulb, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import WholesaleOptimizer from "./WholesaleOptimizer";

export interface BusinessModePanelsDraftLike {
  id: string;
  numberOfBoxes?: number;
  identicalBoxes?: boolean;
  boxQuantities?: Record<string, number[]>;
  boxWeights?: Array<{ weight: number; unit: "lb" | "kg" }>;
}

/**
 * Mode-gated optional panels rendered above the Shipment Builder steps.
 * IMPORTANT: These panels are INFORMATIONAL ONLY and do not modify the
 * existing OA save/box/plan logic. Values entered here are persisted in
 * localStorage scoped per-draft so they survive reload without touching
 * the `shipment_builder_drafts` schema.
 */
export default function BusinessModePanels({ draft }: { draft?: BusinessModePanelsDraftLike | null }) {
  const { mode } = useBusinessMode();
  const draftId = draft?.id ?? null;
  getModeConfig(mode); // ensure config exists

  if (mode === "oa") return <OaHelpers draft={draft} />;
  if (mode === "wholesale") return <WholesalePanels draftId={draftId} draft={draft} />;
  if (mode === "hybrid") return <HybridPanels draftId={draftId} draft={draft} />;
  if (mode === "prep_center") return <PrepCenterPanels draftId={draftId} />;
  return null;
}

function sumUnitsFromDraft(draft?: BusinessModePanelsDraftLike | null): number {
  if (!draft?.boxQuantities) return 0;
  let sum = 0;
  for (const arr of Object.values(draft.boxQuantities)) {
    for (const q of arr ?? []) sum += Number(q) || 0;
  }
  return sum;
}

function skuRowsFromDraft(draft?: BusinessModePanelsDraftLike | null) {
  if (!draft?.boxQuantities) return [];
  return Object.entries(draft.boxQuantities).map(([sku, arr]) => ({
    sku,
    units: (arr ?? []).reduce((a, b) => a + (Number(b) || 0), 0),
  }));
}

function PanelCard({ children, icon: Icon, title, hint, tone }: { children: React.ReactNode; icon: React.ComponentType<{ className?: string }>; title: string; hint?: string; tone?: "warn" | "good" | "neutral" }) {
  const ring = tone === "warn" ? "border-amber-400/40" : tone === "good" ? "border-emerald-400/40" : "border-white/10";
  return (
    <Card className={`${ring} bg-shipment-surface/60 p-4 text-white backdrop-blur-md border`}>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <Badge className="ml-auto bg-white/10 text-white/70 border-white/15">{hint}</Badge> : null}
      </div>
      {children}
    </Card>
  );
}

/* ---------- OA helpers ---------- */
function computeBoxScore(draft?: BusinessModePanelsDraftLike | null) {
  if (!draft) return null;
  const n = draft.numberOfBoxes ?? 0;
  if (n < 2) return null;

  // Identical-box score: % of SKUs whose per-box quantities are all equal.
  const skus = Object.keys(draft.boxQuantities ?? {});
  let identical = 0;
  skus.forEach((sku) => {
    const arr = (draft.boxQuantities?.[sku] ?? []).slice(0, n);
    if (arr.length === 0) return;
    const first = arr[0] ?? 0;
    if (arr.every((q) => (q ?? 0) === first)) identical += 1;
  });
  const identicalPct = skus.length > 0 ? Math.round((identical / skus.length) * 100) : 0;

  // Weight variance (lb-normalized).
  const weights = (draft.boxWeights ?? []).slice(0, n).map((w) => {
    const v = Number(w?.weight) || 0;
    return w?.unit === "kg" ? v * 2.20462 : v;
  });
  const validW = weights.filter((w) => w > 0);
  let variancePct = 0;
  let maxDeltaLb = 0;
  if (validW.length >= 2) {
    const mean = validW.reduce((a, b) => a + b, 0) / validW.length;
    const min = Math.min(...validW);
    const max = Math.max(...validW);
    maxDeltaLb = max - min;
    variancePct = mean > 0 ? Math.round(((max - min) / mean) * 100) : 0;
  }

  return { identicalPct, variancePct, maxDeltaLb, boxes: n, skuCount: skus.length };
}

interface FixSuggestion {
  id: string;
  severity: "warn" | "info" | "good";
  title: string;
  detail: string;
}

function computeFixSuggestions(draft?: BusinessModePanelsDraftLike | null): FixSuggestion[] {
  if (!draft) return [];
  const n = draft.numberOfBoxes ?? 0;
  const suggestions: FixSuggestion[] = [];
  if (n < 2) return suggestions;

  const skus = Object.keys(draft.boxQuantities ?? {});

  // 1) Per-SKU rebalance hints: move units from heaviest box to lightest box for that SKU.
  skus.forEach((sku) => {
    const arr = (draft.boxQuantities?.[sku] ?? []).slice(0, n).map((q) => Number(q) || 0);
    if (arr.length < 2) return;
    const total = arr.reduce((a, b) => a + b, 0);
    if (total === 0) return;
    const maxQ = Math.max(...arr);
    const minQ = Math.min(...arr);
    if (maxQ - minQ < 2) return;
    const maxIdx = arr.indexOf(maxQ);
    const minIdx = arr.indexOf(minQ);
    const moveBy = Math.floor((maxQ - minQ) / 2);
    if (moveBy < 1) return;
    suggestions.push({
      id: `move-${sku}`,
      severity: "info",
      title: `Move ${moveBy} unit${moveBy > 1 ? "s" : ""} of ${sku} from Box ${maxIdx + 1} to Box ${minIdx + 1}`,
      detail: `Box ${maxIdx + 1} has ${maxQ}, Box ${minIdx + 1} has ${minQ}. Evening them out improves your identical-box score.`,
    });
  });

  // 2) Heavy/light box callouts.
  const weights = (draft.boxWeights ?? []).slice(0, n).map((w) => {
    const v = Number(w?.weight) || 0;
    return w?.unit === "kg" ? v * 2.20462 : v;
  });
  const validW = weights.filter((w) => w > 0);
  if (validW.length >= 2) {
    const mean = validW.reduce((a, b) => a + b, 0) / validW.length;
    weights.forEach((w, idx) => {
      if (w <= 0) return;
      const delta = w - mean;
      if (Math.abs(delta) >= 5) {
        suggestions.push({
          id: `weight-${idx}`,
          severity: "warn",
          title: `Box ${idx + 1} is ${Math.abs(delta).toFixed(1)} lb ${delta > 0 ? "heavier" : "lighter"} than average`,
          detail: `Average box weight is ${mean.toFixed(1)} lb. Rebalance to avoid handling issues and oversized-box fees.`,
        });
      }
    });
  }

  // 3) Distribution suggestion.
  let identical = 0;
  skus.forEach((sku) => {
    const arr = (draft.boxQuantities?.[sku] ?? []).slice(0, n);
    if (arr.length === 0) return;
    const first = arr[0] ?? 0;
    if (arr.every((q) => (q ?? 0) === first)) identical += 1;
  });
  const identicalPct = skus.length > 0 ? Math.round((identical / skus.length) * 100) : 0;
  if (skus.length > 0 && identicalPct < 60) {
    // Suggest the largest divisor of all SKU totals (>=2, <=n*2) as a target box count.
    const totals = skus.map((sku) =>
      ((draft.boxQuantities?.[sku] ?? []).reduce((a, b) => a + (Number(b) || 0), 0)) | 0
    ).filter((t) => t > 0);
    if (totals.length > 0) {
      const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
      const g = totals.reduce((acc, t) => gcd(acc, t), totals[0]);
      const target = g >= 2 && g <= Math.max(n + 3, 10) ? g : null;
      suggestions.push({
        id: `distribution`,
        severity: "info",
        title: `Identical-box score is low (${identicalPct}%) because SKU distribution differs across boxes`,
        detail: target
          ? `Try creating ${target} equal boxes — every SKU divides evenly into ${target}, which reduces placement risk.`
          : `Try grouping SKUs so each box holds the same SKUs in equal counts.`,
      });
    }
  }

  if (suggestions.length === 0) {
    suggestions.push({
      id: "ok",
      severity: "good",
      title: "No rebalancing needed",
      detail: "Boxes look well-balanced. You're good to continue to Amazon.",
    });
  }

  return suggestions.slice(0, 6);
}

function FixSuggestionsPanel({ draft }: { draft?: BusinessModePanelsDraftLike | null }) {
  const suggestions = computeFixSuggestions(draft);
  if (suggestions.length === 0) return null;
  const hasWarn = suggestions.some((s) => s.severity === "warn");
  const allGood = suggestions.every((s) => s.severity === "good");
  return (
    <PanelCard
      icon={Lightbulb}
      title="Fix suggestions"
      hint="Recommendations only"
      tone={hasWarn ? "warn" : allGood ? "good" : "neutral"}
    >
      <ul className="space-y-2">
        {suggestions.map((s) => (
          <li key={s.id} className="flex gap-2 rounded-md bg-white/5 p-2">
            <ArrowRight
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                s.severity === "warn" ? "text-amber-400" : s.severity === "good" ? "text-emerald-400" : "text-primary"
              }`}
            />
            <div>
              <div className="text-xs font-medium text-white">{s.title}</div>
              <div className="text-[11px] text-white/60">{s.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] text-white/40">
        These are recommendations only — your boxes are never changed automatically.
      </p>
    </PanelCard>
  );
}

function OaHelpers({ draft }: { draft?: BusinessModePanelsDraftLike | null }) {
  const { mode } = useBusinessMode();
  const score = computeBoxScore(draft);
  const splitRisk = score && score.identicalPct < 60;
  const placementRisk = score && score.skuCount > 0 && score.boxes >= 2 && score.identicalPct < 80;
  const weightWarn = score && (score.variancePct > 25 || score.maxDeltaLb > 5);

  // Phase 5 passive capture: silently upsert an outcome snapshot.
  // No UI, no reads. Debounced + dedup-hashed so we only write meaningful changes.
  useShipmentOutcomeCapture({ draft, score, mode, placementRisk: !!placementRisk, splitRisk: !!splitRisk, weightWarn: !!weightWarn });


  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <PanelCard icon={Gauge} title="Identical-box score" hint="OA" tone={score ? (score.identicalPct >= 80 ? "good" : "warn") : "neutral"}>
          {score ? (
            <>
              <div className="flex items-baseline gap-2">
                <div className="text-2xl font-bold text-primary">{score.identicalPct}%</div>
                <div className="text-xs text-white/60">of SKUs split identically across {score.boxes} boxes</div>
              </div>
              <p className="mt-2 text-xs text-white/60">
                {score.identicalPct >= 80
                  ? "Great — Amazon usually offers cheaper placement on identical boxes."
                  : "Try to balance quantities so each box holds the same SKUs in equal counts."}
              </p>
            </>
          ) : (
            <p className="text-xs text-white/60">Enter quantities and box counts to see your identical-box score.</p>
          )}
        </PanelCard>

        <PanelCard icon={AlertTriangle} title="Placement & split risk" hint="OA" tone={placementRisk || splitRisk ? "warn" : "good"}>
          {score ? (
            <ul className="space-y-1 text-xs text-white/70">
              <li>{placementRisk ? "⚠️ Mixed boxes may trigger placement fees." : "✓ Placement-fee risk looks low."}</li>
              <li>{splitRisk ? "⚠️ Amazon is more likely to split this shipment across FCs." : "✓ Split risk looks low."}</li>
            </ul>
          ) : (
            <p className="text-xs text-white/70">Build at least 2 boxes to see placement & split risk hints.</p>
          )}
        </PanelCard>

        <PanelCard icon={Boxes} title="Weight variance" hint="OA" tone={weightWarn ? "warn" : "good"}>
          {score && score.boxes >= 2 ? (
            <>
              <div className="flex items-baseline gap-2">
                <div className="text-2xl font-bold text-primary">{score.variancePct}%</div>
                <div className="text-xs text-white/60">spread · Δ {score.maxDeltaLb.toFixed(1)} lb</div>
              </div>
              <p className="mt-2 text-xs text-white/60">
                {weightWarn
                  ? "Boxes differ a lot in weight — consider rebalancing to avoid handling issues."
                  : "Boxes are well-balanced by weight."}
              </p>
            </>
          ) : (
            <p className="text-xs text-white/60">Enter per-box weights to compare variance.</p>
          )}
        </PanelCard>
      </div>

      {score ? <FixSuggestionsPanel draft={draft} /> : null}
    </div>
  );
}


/* ---------- Wholesale ---------- */
function useDraftScopedState<T>(key: string, draftId: string | null | undefined, initial: T) {
  const storageKey = useMemo(() => `arbi_mode_${key}_${draftId ?? "unscoped"}`, [key, draftId]);
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // ignore
    }
  }, [storageKey, value]);
  return [value, setValue] as const;
}

function CasePackCalculator({ draftId }: { draftId?: string | null }) {
  const [unitsPerCase, setUnitsPerCase] = useDraftScopedState<number>("case_units", draftId, 0);
  const [cases, setCases] = useDraftScopedState<number>("case_count", draftId, 0);
  const total = (Number(unitsPerCase) || 0) * (Number(cases) || 0);
  return (
    <PanelCard icon={Calculator} title="Case-pack calculator" hint="Wholesale">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-xs text-white/70">Units per carton</Label>
          <Input type="number" min="0" value={unitsPerCase || ""} onChange={(e) => setUnitsPerCase(Number(e.target.value) || 0)} className="bg-white/5 text-white" />
        </div>
        <div>
          <Label className="text-xs text-white/70">Cartons</Label>
          <Input type="number" min="0" value={cases || ""} onChange={(e) => setCases(Number(e.target.value) || 0)} className="bg-white/5 text-white" />
        </div>
        <div>
          <Label className="text-xs text-white/70">Total units</Label>
          <div className="mt-2 text-lg font-semibold text-primary">{total.toLocaleString()}</div>
        </div>
      </div>
      <p className="mt-2 text-xs text-white/50">Quick helper — copy the total into the Qty column of any SKU below.</p>
    </PanelCard>
  );
}

function LtlToggle({ draftId }: { draftId?: string | null }) {
  const [ltl, setLtl] = useDraftScopedState<boolean>("ltl", draftId, false);
  return (
    <PanelCard icon={Truck} title="Shipping mode hint" hint="Wholesale">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label className="text-sm text-white">Plan as LTL / pallet freight</Label>
          <p className="text-xs text-white/60">
            Tag this shipment as <span className="text-white/80">LTL</span> (pallets via freight carrier) for your own planning.
            Use <span className="text-white/80">SPD</span> (UPS/FedEx cartons) for small shipments. The actual mode is still chosen inside Amazon after handoff.
          </p>
        </div>
        <Switch checked={ltl} onCheckedChange={setLtl} />
      </div>
    </PanelCard>
  );
}

function TemplatesPlaceholder() {
  return (
    <PanelCard icon={Boxes} title="Shipment templates" hint="Coming soon">
      <p className="text-xs text-white/70">Save this shipment's SKU list as a template to reuse for replenishment in one click. Available in Phase 2.</p>
    </PanelCard>
  );
}

function WholesaleModeBanner() {
  return (
    <div className="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/10 p-3 text-xs text-white/80">
      <Truck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div>
        <div className="text-sm font-semibold text-white">Wholesale Mode</div>
        <p className="text-[11px] text-white/70">
          Built for case-pack quantities and pallet/LTL planning. The panels below are
          <span className="text-white/90 font-medium"> advisory only</span> — they help you anticipate cartons, pallets, and SPD vs LTL
          before you create the inbound plan. Amazon still controls placement, freight booking, and confirmation.
        </p>
      </div>
    </div>
  );
}

function WholesalePanels({ draftId, draft }: { draftId?: string | null; draft?: BusinessModePanelsDraftLike | null }) {
  const skuRows = skuRowsFromDraft(draft);
  return (
    <div className="space-y-3">
      <WholesaleModeBanner />
      <div className="grid gap-3 md:grid-cols-3">
        <CasePackCalculator draftId={draftId} />
        <LtlToggle draftId={draftId} />
        <TemplatesPlaceholder />
      </div>
      <WholesaleOptimizer draftId={draftId} skuRows={skuRows} />
    </div>
  );
}

/* ---------- Hybrid ---------- */
function HybridPanels({ draftId, draft }: { draftId?: string | null; draft?: BusinessModePanelsDraftLike | null }) {
  const skuRows = skuRowsFromDraft(draft);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <CasePackCalculator draftId={draftId} />
        <PanelCard icon={Info} title="Mixed entry" hint="Hybrid">
          <p className="text-xs text-white/70">Use the case-pack calculator for repeat SKUs, then enter per-unit qty for OA finds in the table below.</p>
        </PanelCard>
        <LtlToggle draftId={draftId} />
      </div>
      <WholesaleOptimizer draftId={draftId} skuRows={skuRows} />
    </div>
  );
}

/* ---------- Prep Center ---------- */
function PrepCenterPanels({ draftId }: { draftId?: string | null }) {
  const [client, setClient] = useDraftScopedState<string>("client_tag", draftId, "");
  const [batch, setBatch] = useDraftScopedState<string>("batch_id", draftId, "");
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <PanelCard icon={Users} title="Client tag" hint="Prep Center">
        <Label className="text-xs text-white/70">Client name / ID</Label>
        <Input value={client} onChange={(e) => setClient(e.target.value)} placeholder="e.g. AcmeCo" className="bg-white/5 text-white" />
        <p className="mt-2 text-xs text-white/50">Tag rolls up in your per-client reporting (Phase 2).</p>
      </PanelCard>
      <PanelCard icon={Info} title="Batch / customer identifier" hint="Prep Center">
        <Label className="text-xs text-white/70">Batch / PO #</Label>
        <Input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="e.g. PO-1042" className="bg-white/5 text-white" />
      </PanelCard>
      <PanelCard icon={Boxes} title="Multi-client organization" hint="Coming soon">
        <p className="text-xs text-white/70">Switch between client workspaces and view per-client cost & unit totals. Available in Phase 2.</p>
      </PanelCard>
    </div>
  );
}

/* ---------- Phase 5: passive outcome capture (no UI, no reads) ---------- */
interface CaptureArgs {
  draft?: BusinessModePanelsDraftLike | null;
  score: ReturnType<typeof computeBoxScore>;
  mode: string;
  placementRisk: boolean;
  splitRisk: boolean;
  weightWarn: boolean;
}

function useShipmentOutcomeCapture({ draft, score, mode, placementRisk, splitRisk, weightWarn }: CaptureArgs) {
  const lastHashRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!draft?.id || !score || (score.skuCount === 0 && score.boxes < 2)) return;

    const totalUnits = Object.values(draft.boxQuantities ?? {}).reduce(
      (sum, arr) => sum + (arr ?? []).reduce((a, b) => a + (Number(b) || 0), 0),
      0
    );

    const payload = {
      draft_id: draft.id,
      business_mode: mode,
      box_count: score.boxes,
      sku_count: score.skuCount,
      total_units: totalUnits,
      identical_pct: score.identicalPct,
      variance_pct: score.variancePct,
      max_delta_lb: Number(score.maxDeltaLb.toFixed(2)),
      placement_risk: placementRisk,
      split_risk: splitRisk,
      weight_warn: weightWarn,
    };
    const hash = JSON.stringify(payload);
    if (hash === lastHashRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        lastHashRef.current = hash;
        await supabase
          .from("shipment_outcomes")
          .upsert(
            { ...payload, user_id: user.id, updated_at: new Date().toISOString() },
            { onConflict: "user_id,draft_id" }
          );
      } catch {
        // silent — passive capture must never disrupt the builder
      }
    }, 2500);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [draft?.id, score?.boxes, score?.skuCount, score?.identicalPct, score?.variancePct, score?.maxDeltaLb, mode, placementRisk, splitRisk, weightWarn, draft?.boxQuantities]);
}

