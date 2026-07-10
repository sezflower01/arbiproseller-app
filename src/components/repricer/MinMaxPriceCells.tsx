import { memo } from "react";
import { TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";

/**
 * Memoized Min/Max price cells for AssignmentsTable rows.
 *
 * Path A of the repricer input-lag fix: parent state (editingMinPrice /
 * editingMaxPrice / pendingChanges) is preserved so cross-cell live
 * validation, live ROI-at-min, per-row Save indicator, and the async loop
 * around AssignmentsTable line ~2246 that reads editingMin/MaxPriceRef all
 * continue to work exactly as before.
 *
 * The win comes from React.memo on primitive-only props: when the user
 * types in one row, only that row's props change, so all other rows
 * short-circuit their re-render (previously ~N-row re-render storm per
 * keystroke — see session replay: sort-arrow SVG re-created in every
 * column header on every character).
 *
 * All callbacks are keyed by itemId so the parent can pass stable
 * useCallback references.
 */
export type MinMaxPriceCellsProps = {
  itemId: string;
  disabled: boolean;
  minOverride: number | null;
  invMin: number | null;
  maxOverride: number | null;
  invMax: number | null;
  currentPrice: number | null;
  roiAtMinPercent: number | null;
  roiAtMaxPercent: number | null;
  editingMin: string | undefined;
  editingMax: string | undefined;
  onMinChange: (id: string, value: string) => void;
  onMaxChange: (id: string, value: string) => void;
  onMinFocus: (id: string) => void;
  onMaxFocus: (id: string) => void;
  onMinBlur: (id: string) => void;
  onMaxBlur: (id: string) => void;
  onMinEscape: (id: string) => void;
  onMaxEscape: (id: string) => void;
};

function MinMaxPriceCellsImpl(props: MinMaxPriceCellsProps) {
  const {
    itemId, disabled,
    minOverride, invMin, maxOverride, invMax,
    currentPrice, roiAtMinPercent, roiAtMaxPercent,
    editingMin, editingMax,
    onMinChange, onMaxChange,
    onMinFocus, onMaxFocus,
    onMinBlur, onMaxBlur,
    onMinEscape, onMaxEscape,
  } = props;

  const minValNum = editingMin != null ? parseFloat(editingMin) : (minOverride ?? invMin);
  const maxValNum = editingMax != null ? parseFloat(editingMax) : (maxOverride ?? invMax);

  const minNumOk = minValNum != null && !isNaN(Number(minValNum));
  const maxNumOk = maxValNum != null && !isNaN(Number(maxValNum));
  const showMinGtMax = minNumOk && maxNumOk && Number(minValNum) > Number(maxValNum);
  const showMinGtPrice = minNumOk && currentPrice != null && Number(minValNum) > currentPrice;
  const showMaxLtPrice = maxNumOk && currentPrice != null && Number(maxValNum) < currentPrice;

  const minBorder = showMinGtMax ? "border-destructive" : (showMinGtPrice ? "border-orange-400" : "");
  const maxBorder = showMinGtMax ? "border-destructive" : (showMaxLtPrice ? "border-orange-400" : "");

  const minDisplayValue = editingMin ?? ((minOverride ?? invMin)?.toString() ?? "");
  const maxDisplayValue = editingMax ?? ((maxOverride ?? invMax)?.toString() ?? "");

  const baseInputCls = "h-7 w-[100px] text-xs text-right bg-shipment-control text-white border-white/20 placeholder:text-white/40 focus:ring-2 focus:ring-primary";
  const disabledCls = disabled ? "opacity-50 cursor-not-allowed " : "";

  return (
    <>
      {/* Min Price */}
      <TableCell className="text-right">
        <div className="flex flex-col items-end gap-0.5">
          <Input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            disabled={disabled}
            className={`${baseInputCls} ${disabledCls}${minBorder}`}
            value={minDisplayValue}
            onChange={(e) => onMinChange(itemId, e.target.value)}
            onFocus={(e) => {
              const input = e.currentTarget;
              onMinFocus(itemId);
              setTimeout(() => input.select(), 0);
            }}
            onBlur={() => onMinBlur(itemId)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") onMinEscape(itemId);
            }}
            placeholder="Min"
          />
          {showMinGtMax && (
            <span className="text-[9px] text-destructive font-medium">Min &gt; Max!</span>
          )}
          {!showMinGtMax && showMinGtPrice && (
            <span className="text-[9px] text-orange-500 font-medium">Min &gt; price</span>
          )}
          <span
            className={`text-[10px] font-mono ${
              roiAtMinPercent != null && roiAtMinPercent < 0
                ? "text-red-500"
                : "text-muted-foreground"
            }`}
          >
            {roiAtMinPercent != null ? `${roiAtMinPercent.toFixed(1)}%` : "—"}
          </span>
        </div>
      </TableCell>

      {/* Max Price */}
      <TableCell className="text-right">
        <div className="flex flex-col items-end gap-0.5">
          <Input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            disabled={disabled}
            className={`${baseInputCls} ${disabledCls}${maxBorder}`}
            value={maxDisplayValue}
            onChange={(e) => onMaxChange(itemId, e.target.value)}
            onFocus={(e) => {
              const input = e.currentTarget;
              onMaxFocus(itemId);
              setTimeout(() => input.select(), 0);
            }}
            onBlur={() => onMaxBlur(itemId)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") onMaxEscape(itemId);
            }}
            placeholder="Max"
          />
          {showMinGtMax && (
            <span className="text-[9px] text-destructive font-medium">Min &gt; Max!</span>
          )}
          {!showMinGtMax && showMaxLtPrice && (
            <span className="text-[9px] text-orange-500 font-medium">Max &lt; price</span>
          )}
          <span
            className={`text-[10px] font-mono ${
              roiAtMaxPercent != null && roiAtMaxPercent < 0
                ? "text-red-500"
                : "text-muted-foreground"
            }`}
          >
            {roiAtMaxPercent != null ? `${roiAtMaxPercent.toFixed(1)}%` : "—"}
          </span>
        </div>
      </TableCell>
    </>
  );
}

/**
 * All props are primitives or stable callbacks, so default shallow
 * comparison from React.memo is exactly what we want — no custom
 * comparator needed.
 */
export const MinMaxPriceCells = memo(MinMaxPriceCellsImpl);
MinMaxPriceCells.displayName = "MinMaxPriceCells";
