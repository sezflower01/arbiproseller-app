import { useState } from "react";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ChevronDown, RotateCcw } from "lucide-react";
import { BestCandidateGate, DEFAULT_GATE } from "./shared";

interface Props {
  gate: BestCandidateGate;
  onChange: (g: BestCandidateGate) => void;
}

/**
 * Compact tunable controls for the Best Candidate gate.
 * Strict defaults; users can loosen any threshold.
 */
export default function BestCandidateGateControls({ gate, onChange }: Props) {
  // Default OPEN so the ROI sliders are immediately visible (cost-control UX).
  const [open, setOpen] = useState(true);

  const reset = () => onChange({ ...DEFAULT_GATE });

  const roiBadge =
    gate.minRoiPct === 0 && gate.maxRoiPct === 0
      ? "ROI filter: off"
      : `ROI: ${gate.minRoiPct}%${gate.maxRoiPct > 0 ? ` – ${gate.maxRoiPct}%` : "+"}`;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <button className="text-xs text-muted-foreground hover:text-white inline-flex items-center gap-1">
              <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
              Best-candidate filters (strict by default)
            </button>
          </CollapsibleTrigger>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/30 font-mono">
            {roiBadge}
          </span>
        </div>
        {open && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={reset}>
            <RotateCcw className="h-3 w-3 mr-1" /> Reset
          </Button>
        )}
      </div>

      <CollapsibleContent className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 p-4 rounded-md border border-border/50 bg-muted/10">
        {/* ROI controls — top priority for cost & profitability filtering */}
        <div className="sm:col-span-2 space-y-3 pb-3 border-b border-border/40">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium text-foreground">Desired ROI range</Label>
            <span className="text-[10px] text-muted-foreground">
              Real ROI = (Amazon − est. Amazon fees − Source) ÷ Source
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <SliderRow
              label="Show items with ROI at least"
              value={gate.minRoiPct}
              min={0} max={200} step={5}
              suffix="%"
              hint={gate.minRoiPct === 0 ? "off" : undefined}
              footnote="Higher value = stricter = fewer items shown"
              onChange={(v) => onChange({ ...gate, minRoiPct: v })}
            />
            <SliderRow
              label="Hide items with ROI above"
              value={gate.maxRoiPct}
              min={0} max={500} step={10}
              suffix="%"
              hint={gate.maxRoiPct === 0 ? "no cap" : undefined}
              footnote="Optional upper cap (0 = no cap)"
              onChange={(v) => onChange({ ...gate, maxRoiPct: v })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground mr-1">Quick min ROI:</span>
            {[0, 10, 20, 30, 40, 50].map((v) => (
              <Button
                key={v}
                size="sm"
                variant={gate.minRoiPct === v ? "default" : "outline"}
                className="h-6 px-2 text-[11px]"
                onClick={() => onChange({ ...gate, minRoiPct: v })}
              >
                {v === 0 ? "Off" : `${v}%`}
              </Button>
            ))}
          </div>
        </div>

        <SliderRow
          label="Minimum match score"
          value={gate.minMatchScore}
          min={0} max={100} step={5}
          suffix=""
          onChange={(v) => onChange({ ...gate, minMatchScore: v })}
        />
        <SliderRow
          label="Minimum confidence"
          value={Math.round(gate.minConfidence * 100)}
          min={0} max={100} step={5}
          suffix="%"
          onChange={(v) => onChange({ ...gate, minConfidence: v / 100 })}
        />
        <SliderRow
          label="Max acceptable margin"
          value={gate.maxMarginPct}
          min={20} max={150} step={5}
          suffix="%"
          onChange={(v) => onChange({ ...gate, maxMarginPct: v })}
        />
        <SliderRow
          label="Min margin (loss tolerance)"
          value={gate.minMarginPct}
          min={-50} max={20} step={5}
          suffix="%"
          onChange={(v) => onChange({ ...gate, minMarginPct: v })}
        />

        <ToggleRow
          id="gate-trusted"
          label="Require trusted retailer (tier 1–2)"
          checked={gate.requireTrustedDomain}
          onCheckedChange={(v) => onChange({ ...gate, requireTrustedDomain: v })}
        />
        <ToggleRow
          id="gate-membership"
          label="Block membership-only (Costco, Sam's, BJ's)"
          checked={gate.blockMembership}
          onCheckedChange={(v) => onChange({ ...gate, blockMembership: v })}
        />
        <ToggleRow
          id="gate-social"
          label="Block social / unknown domains"
          checked={gate.blockSocial}
          onCheckedChange={(v) => onChange({ ...gate, blockSocial: v })}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function SliderRow({
  label, value, min, max, step, suffix, hint, footnote, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  suffix: string; hint?: string; footnote?: string; onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-xs font-mono text-foreground">
          {hint ? <span className="text-muted-foreground italic mr-1">{hint}</span> : null}
          {value}{suffix}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0] ?? value)}
      />
      {footnote ? (
        <p className="mt-1 text-[10px] text-muted-foreground/80 italic">{footnote}</p>
      ) : null}
    </div>
  );
}

function ToggleRow({
  id, label, checked, onCheckedChange,
}: {
  id: string; label: string; checked: boolean; onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground cursor-pointer">{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
