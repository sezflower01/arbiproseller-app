/**
 * Compact "Replacement / Free Ship." readout — sits next to
 * Fees / COGS / Refunds / Promotions / Adjustments on Live Sales
 * (desktop and mobile). Renders NOTHING when the period has no
 * $0-revenue Amazon shipments, so it never produces an empty column.
 *
 * Revenue stays $0; only the COGS impact deducted from profit is shown.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { fetchReplacementCogs } from "@/lib/sales/replacementCogs";

type Variant =
  /** Inline chip — single <span>, used in mobile flex row. */
  | { variant: "chip"; label?: string }
  /** Column block — full <div> with uppercase label + value + optional left divider. Used in desktop summary bar. */
  | {
      variant: "column";
      label: string;
      withLeftDivider?: boolean;
    };

type Props = {
  rangeStart: string;
  rangeEnd: string;
  marketplace?: string;
  colorClass?: string;
  className?: string;
  currencySymbol?: string;
} & Variant;

const cache = new Map<string, { cogs: number; fees: number; orders: number; units: number }>();

export function ReplacementCogsChip(props: Props) {
  const {
    rangeStart,
    rangeEnd,
    marketplace = "ALL",
    colorClass = "text-rose-500",
    className = "",
    currencySymbol = "$",
  } = props;
  const { user } = useAuth();
  const key = `${user?.id || ""}|${rangeStart}|${rangeEnd}|${marketplace}`;
  const [data, setData] = useState<{ cogs: number; fees: number; orders: number; units: number } | null>(
    cache.get(key) ?? null,
  );

  useEffect(() => {
    if (!user?.id || !rangeStart || !rangeEnd) return;
    if (cache.has(key)) { setData(cache.get(key)!); return; }
    let cancelled = false;
    fetchReplacementCogs({ userId: user.id, rangeStart, rangeEnd, marketplace })
      .then((res) => {
        if (cancelled) return;
        const v = { cogs: res.totalCogsUsd, fees: res.totalFeesUsd, orders: res.orderCount, units: res.unitsLost };
        cache.set(key, v);
        setData(v);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [key, user?.id, rangeStart, rangeEnd, marketplace]);

  if (!data || (data.cogs <= 0 && data.fees <= 0)) return null;

  const total = data.cogs + data.fees;
  const breakdown = data.fees > 0
    ? `COGS ${currencySymbol}${data.cogs.toFixed(2)} + fees ${currencySymbol}${data.fees.toFixed(2)}`
    : `COGS only`;
  const tooltip = `Amazon shipped ${data.units} unit${data.units === 1 ? "" : "s"} across ${data.orders} order${data.orders === 1 ? "" : "s"} at $0 revenue (replacements / free shipments). Revenue stays $0, but unit cost ${data.fees > 0 ? "and Amazon FBA fees are" : "is"} deducted from profit. Breakdown: ${breakdown}. See the Replacement / Free Shipments section below for the full audit.`;
  const valueText = `−${currencySymbol}${total.toFixed(2)}`;
  const subText = data.fees > 0
    ? `${currencySymbol}${data.cogs.toFixed(2)} cogs + ${currencySymbol}${data.fees.toFixed(2)} fees`
    : null;

  if (props.variant === "chip") {
    return (
      <span className={`${colorClass} ${className}`} title={tooltip}>
        {(props.label ?? "Replacement / Free Ship.")} {valueText}
        {subText && <span className="opacity-70 ml-1">({subText})</span>}
      </span>
    );
  }

  return (
    <>
      {props.withLeftDivider && <div className="w-px h-8 bg-border" />}
      <div className="flex flex-col items-end" title={tooltip}>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          {props.label}
        </span>
        <span className={`text-lg font-bold tabular-nums leading-tight ${colorClass} ${className}`}>
          {valueText}
        </span>
        {subText && (
          <span className="text-[9px] text-muted-foreground tabular-nums leading-tight">
            {subText}
          </span>
        )}
      </div>
    </>
  );
}

export default ReplacementCogsChip;
