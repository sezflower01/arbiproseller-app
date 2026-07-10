/**
 * One-line readout of Replacement / Free-Shipment COGS for a period.
 *
 * Designed to sit next to the existing Refunds / Promotions / COGS / Fees
 * line items in PeriodStatsBlocks (desktop + mobile). Revenue is $0 on these
 * orders but the unit cost is still deducted from profit, so it must be
 * visible alongside the other deductions.
 *
 * Click expands the full audit list (the larger ReplacementCogsSection lives
 * lower on the same page and is the source of truth).
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { fetchReplacementCogs } from "@/lib/sales/replacementCogs";

interface Props {
  rangeStart: string;
  rangeEnd: string;
  marketplace?: string;
  className?: string;
}

const cache = new Map<string, { cogs: number; fees: number; orders: number; units: number }>();

export function ReplacementCogsLine({
  rangeStart,
  rangeEnd,
  marketplace = "ALL",
  className,
}: Props) {
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
      .catch(() => { /* silent; section below shows full error */ });
    return () => { cancelled = true; };
  }, [key, user?.id, rangeStart, rangeEnd, marketplace]);

  if (!data || (data.cogs <= 0 && data.fees <= 0)) return null;

  const total = data.cogs + data.fees;
  const hasFees = data.fees > 0;

  return (
    <div
      className={"flex justify-between text-xs mb-2 " + (className || "")}
      title={`Amazon shipped your inventory at $0 revenue (replacement / free shipment). Revenue is $0 but unit cost${hasFees ? " and FBA fees are" : " is"} deducted from profit. Breakdown: COGS $${data.cogs.toFixed(2)}${hasFees ? ` + fees $${data.fees.toFixed(2)}` : ""}. See the Replacement / Free Shipments section below for the full audit.`}
    >
      <span className="text-muted-foreground">
        Replacement / Free Ship.{" "}
        <span className="text-[10px] opacity-70">
          ({hasFees ? "COGS + fees" : "COGS"})
        </span>
      </span>
      <span className="font-medium text-amber-500">
        −${total.toFixed(2)}
        <span className="text-[10px] text-muted-foreground/70 ml-1">
          {hasFees
            ? `· $${data.cogs.toFixed(2)} cogs + $${data.fees.toFixed(2)} fees · ${data.orders} ord · ${data.units} u`
            : `· ${data.orders} ord · ${data.units} u`}
        </span>
      </span>
    </div>
  );
}

export default ReplacementCogsLine;
