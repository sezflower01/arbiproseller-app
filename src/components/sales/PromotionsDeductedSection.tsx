/**
 * Shared collapsible "Promotions Deducted" block.
 *
 * Used by Sales Report (LiveSales.tsx) AND Live Sales (desktop + mobile).
 * All three call the SAME `fetchPromotionDeductions()` helper so the value
 * shown here is the exact USD amount that PeriodStatsBlocks subtracts from
 * net profit. There is no separate calculation path.
 *
 * Verification surface (per user request):
 *   • Total promotions deducted (header chip)
 *   • Marketplace breakdown
 *   • Per-order rows: date, order_id (clickable → Seller Central), ASIN,
 *     marketplace, source field, amount
 *   • Source badge showing whether it came from sales_orders or FEC
 */

import { useEffect, useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  fetchPromotionDeductions,
  type PromoDeductionRow,
  type PromotionDeductionsResult,
} from "@/lib/sales/promotionDeductions";
import { useAuth } from "@/contexts/AuthContext";

const AMAZON_SC_DOMAIN: Record<string, string> = {
  US: "sellercentral.amazon.com",
  CA: "sellercentral.amazon.ca",
  MX: "sellercentral.amazon.com.mx",
  BR: "sellercentral.amazon.com.br",
  UK: "sellercentral.amazon.co.uk",
  DE: "sellercentral.amazon.de",
  FR: "sellercentral.amazon.fr",
  IT: "sellercentral.amazon.it",
  ES: "sellercentral.amazon.es",
  JP: "sellercentral.amazon.co.jp",
  AU: "sellercentral.amazon.com.au",
};

function orderUrl(orderId: string, mkt: string | null | undefined): string {
  const key = String(mkt || "US").toUpperCase();
  const domain = AMAZON_SC_DOMAIN[key] || AMAZON_SC_DOMAIN.US;
  const clean = orderId.replace(/-REFUND(-\d+)?$/, "");
  return `https://${domain}/orders-v3/order/${clean}`;
}

const fmtUsd = (n: number) =>
  `${n < 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

type Props = {
  rangeStart: string;
  rangeEnd: string;
  label: string;
  marketplace?: string;   // "ALL" / "US" / "CA" / ...
  dark?: boolean;
};

export function PromotionsDeductedSection({
  rangeStart,
  rangeEnd,
  label,
  marketplace = "ALL",
  dark = false,
}: Props) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PromotionDeductionsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id || !rangeStart || !rangeEnd) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPromotionDeductions({
      userId: user.id,
      rangeStart,
      rangeEnd,
      marketplace,
    })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, rangeStart, rangeEnd, marketplace]);

  const marketplaceEntries = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.byMarketplace)
      .filter(([, v]) => v !== 0)
      .sort((a, b) => b[1] - a[1]);
  }, [data]);

  const total = data?.totalUsd ?? 0;
  const rows: PromoDeductionRow[] = data?.rows ?? [];

  const baseBg = dark
    ? "bg-white/5 border-white/10 text-white"
    : "bg-white border-slate-200 text-slate-900";
  const subText = dark ? "text-white/70" : "text-slate-600";
  const rowBorder = dark ? "border-white/10" : "border-slate-200";
  const headerHover = dark ? "hover:bg-white/5" : "hover:bg-slate-50";

  return (
    <div className={`rounded-lg border ${baseBg}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center justify-between px-4 py-3 ${headerHover} rounded-lg`}
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="font-medium">Promotions Deducted</span>
          <span className={`text-xs ${subText}`}>· {label}</span>
          {marketplace && marketplace !== "ALL" && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${dark ? "bg-white/10" : "bg-slate-100"}`}>
              {marketplace}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin opacity-70" />}
          <span className={`text-sm font-semibold ${total > 0 ? "text-red-500" : subText}`}>
            {total > 0 ? `−$${total.toFixed(2)}` : "$0.00"}
          </span>
        </div>
      </button>

      {open && (
        <div className={`border-t ${rowBorder} px-4 py-3`}>
          {error && (
            <div className="text-xs text-red-500 mb-2">Failed to load promotions: {error}</div>
          )}

          {!loading && rows.length === 0 && !error && (
            <div className={`text-sm ${subText}`}>
              No promotional rebates deducted in this period
              {marketplace && marketplace !== "ALL" ? ` for ${marketplace}` : ""}.
            </div>
          )}

          {rows.length > 0 && (
            <>
              {/* Marketplace summary */}
              <div className="flex flex-wrap gap-2 mb-3">
                {marketplaceEntries.map(([mp, amt]) => (
                  <span
                    key={mp}
                    className={`text-xs px-2 py-1 rounded ${dark ? "bg-white/10" : "bg-slate-100"}`}
                  >
                    {mp}: <span className="font-semibold text-red-500">−${amt.toFixed(2)}</span>
                  </span>
                ))}
                {data && (
                  <span className={`text-xs ${subText} self-center`}>
                    SO: −${data.bySource.sales_orders.toFixed(2)} · FEC: −${data.bySource.fec.toFixed(2)}
                  </span>
                )}
              </div>

              {/* Row table */}
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-xs">
                  <thead className={subText}>
                    <tr className={`border-b ${rowBorder}`}>
                      <th className="text-left px-2 py-1.5 font-medium">Date</th>
                      <th className="text-left px-2 py-1.5 font-medium">Order ID</th>
                      <th className="text-left px-2 py-1.5 font-medium">ASIN</th>
                      <th className="text-left px-2 py-1.5 font-medium">Mkt</th>
                      <th className="text-left px-2 py-1.5 font-medium">Source</th>
                      <th className="text-left px-2 py-1.5 font-medium">Field</th>
                      <th className="text-right px-2 py-1.5 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className={`border-b ${rowBorder} last:border-0`}>
                        <td className="px-2 py-1.5 whitespace-nowrap">{r.event_date}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {r.order_id ? (
                            <a
                              href={orderUrl(r.order_id, r.marketplace)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline hover:no-underline"
                            >
                              {r.order_id}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap font-mono">{r.asin || "—"}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{r.marketplace || "—"}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              r.source === "fec"
                                ? "bg-blue-500/20 text-blue-400"
                                : "bg-amber-500/20 text-amber-500"
                            }`}
                          >
                            {r.source === "fec" ? "FEC / settlement" : "sales_orders"}
                          </span>
                        </td>
                        <td className={`px-2 py-1.5 whitespace-nowrap font-mono ${subText}`}>
                          {r.source_field}
                        </td>
                        <td
                          className={`px-2 py-1.5 whitespace-nowrap text-right font-semibold ${
                            r.amount_usd >= 0 ? "text-red-500" : "text-emerald-500"
                          }`}
                        >
                          {fmtUsd(r.amount_usd)}
                        </td>
                      </tr>
                    ))}
                    <tr className={`border-t ${rowBorder}`}>
                      <td colSpan={6} className="px-2 py-2 text-right font-semibold">
                        Total deducted from profit
                      </td>
                      <td className="px-2 py-2 text-right font-bold text-red-500">
                        −${total.toFixed(2)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className={`text-[11px] mt-2 ${subText}`}>
                This amount is subtracted from net profit in both Sales Report and Live Sales totals.
                Profit numbers shown on this page are already net of promotions.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default PromotionsDeductedSection;
