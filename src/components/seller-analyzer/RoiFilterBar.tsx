import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type RoiSort = "newest" | "roi_desc" | "roi_asc";

export const ROI_MIN = 0;
export const ROI_MAX = 300;

interface Props {
  range: [number, number];
  onRangeChange: (r: [number, number]) => void;
  minConfidence: number;
  onMinConfidenceChange: (n: number) => void;
  sort: RoiSort;
  onSortChange: (s: RoiSort) => void;
  /** Rows that produced a real ROI and fall inside the range. */
  matching: number;
  /** Rows with a real ROI that the range excluded. */
  filteredOut: number;
  /** Rows that could not produce an ROI at all. Never silently dropped. */
  unavailable: number;
  onReset: () => void;
}

export default function RoiFilterBar({
  range, onRangeChange, minConfidence, onMinConfidenceChange,
  sort, onSortChange, matching, filteredOut, unavailable, onReset,
}: Props) {
  const active = range[0] !== ROI_MIN || range[1] !== ROI_MAX;

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-medium">ROI filter</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {range[0]}% – {range[1]}{range[1] >= ROI_MAX ? "%+" : "%"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Select value={sort} onValueChange={(v) => onSortChange(v as RoiSort)}>
            <SelectTrigger className="h-8 w-[168px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="roi_desc">ROI: highest first</SelectItem>
              <SelectItem value="roi_asc">ROI: lowest first</SelectItem>
            </SelectContent>
          </Select>
          {(active || minConfidence !== 40) && (
            <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={onReset}>
              Reset
            </Button>
          )}
        </div>
      </div>

      {/* Dual handle. 300% is the ceiling AND an open top end -- a 900% ROI is
          almost always a mispriced or mismatched candidate, not a find, so it
          collapses into "300%+" rather than stretching the scale. */}
      <Slider
        min={ROI_MIN}
        max={ROI_MAX}
        step={5}
        value={range}
        onValueChange={(v) => onRangeChange([v[0], v[1]] as [number, number])}
        aria-label="ROI range"
      />

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground whitespace-nowrap">Min match confidence</span>
          <input
            type="number"
            min={0}
            max={100}
            value={minConfidence}
            onChange={(e) => onMinConfidenceChange(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
            className="h-7 w-16 rounded-md border bg-background px-2 text-xs tabular-nums"
          />
          <span className="text-muted-foreground">%</span>
        </label>

        {/* Every row is accounted for. A filter that quietly drops rows it could
            not evaluate is how a listing that merely lacks a price becomes
            invisible instead of actionable. */}
        <p className="text-xs text-muted-foreground tabular-nums">
          {matching} shown
          {filteredOut > 0 && <> · {filteredOut} outside range</>}
          {unavailable > 0 && <> · {unavailable} no ROI yet</>}
        </p>
      </div>

      {minConfidence > 0 && (
        <p className="text-xs text-muted-foreground">
          Candidates below {minConfidence}% confidence are treated as no ROI — a low-confidence
          match usually means the wrong product was found, not a bad deal.
        </p>
      )}
    </div>
  );
}
