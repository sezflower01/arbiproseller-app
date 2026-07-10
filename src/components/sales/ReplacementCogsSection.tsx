/**
 * Replacement / Free-Shipment COGS Section.
 *
 * Collapsible block shown in Live Sales (desktop + mobile) and P&L. Lists
 * every Amazon-shipped $0 revenue order (replacements, exchanges, free
 * shipments) along with the cost-of-goods that still hit profit.
 *
 * Profit rule (single source of truth):
 *   • Revenue = $0
 *   • COGS = unit_cost × quantity      ← deducted from net profit
 *   • Fees = FEC fees if present, else $0
 *   • ROI = N/A
 *
 * These rows are NOT missing-price errors — they are correctly priced at $0.
 */

import { useEffect, useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  fetchReplacementCogs,
  type ReplacementRow,
  type ReplacementCogsResult,
} from "@/lib/sales/replacementCogs";
import { ReplacementBadge } from "./ReplacementBadge";

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
  return `https://${domain}/orders-v3/order/${orderId}`;
}

const REASON_LABEL: Record<string, string> = {
  orders_api_replacement: "Amazon Replacement",
  orders_api_is_replacement_flag: "Amazon flagged as Replacement",
  fec_zero_principal_shipped: "Hidden: $0 shipment",
  manual_fix_replacement: "Manual fix",
  heuristic_zero_price_afn: "Heuristic",
  unknown: "Unknown",
};

type Props = {
  rangeStart: string;
  rangeEnd: string;
  label: string;
  marketplace?: string;
  dark?: boolean;
};

export function ReplacementCogsSection({
  rangeStart,
  rangeEnd,
  label,
  marketplace = "ALL",
  dark = false,
}: Props) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ReplacementCogsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasonFilter, setReasonFilter] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id || !rangeStart || !rangeEnd) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchReplacementCogs({ userId: user.id, rangeStart, rangeEnd, marketplace })
      .then((res) => { if (!cancelled) setData(res); })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id, rangeStart, rangeEnd, marketplace]);

  const marketplaceEntries = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.byMarketplace)
      .filter(([, v]) => v.cogs > 0)
      .sort((a, b) => b[1].cogs - a[1].cogs);
  }, [data]);

  const reasonEntries = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.byReason)
      .filter(([, v]) => v.cogs > 0)
      .sort((a, b) => b[1].cogs - a[1].cogs);
  }, [data]);

  const total = data?.totalProfitImpactUsd ?? 0;
  const allRows: ReplacementRow[] = data?.rows ?? [];
  const rows = reasonFilter
    ? allRows.filter((r) => (r.replacement_reason || "unknown") === reasonFilter)
    : allRows;

  const baseBg = dark
    ? "bg-white/5 border-white/10 text-white"
    : "bg-white border-slate-200 text-slate-900";
  const subText = dark ? "text-white/70" : "text-slate-600";
  const rowBorder = dark ? "border-white/10" : "border-slate-200";
  const headerHover = dark ? "hover:bg-white/5" : "hover:bg-slate-50";
  const chipBg = dark ? "bg-white/10" : "bg-slate-100";

  return (
    <div className={`rounded-lg border ${baseBg}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center justify-between px-4 py-3 ${headerHover} rounded-lg`}
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="font-medium">Replacement / Free Shipments</span>
          <span className={`text-xs ${subText}`}>· {label}</span>
          {data && data.orderCount > 0 && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${chipBg}`}>
              {data.orderCount} {data.orderCount === 1 ? "order" : "orders"} · {data.unitsLost} units
            </span>
          )}
          {marketplace && marketplace !== "ALL" && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${chipBg}`}>{marketplace}</span>
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
            <div className="text-xs text-red-500 mb-2">
              Failed to load replacements: {error}
            </div>
          )}

          {!loading && rows.length === 0 && !error && (
            <div className={`text-sm ${subText}`}>
              No replacement or free-shipment orders in this period
              {marketplace && marketplace !== "ALL" ? ` for ${marketplace}` : ""}.
            </div>
          )}

          {rows.length > 0 && data && (
            <>
              {/* Summary chips */}
              <div className="flex flex-wrap gap-2 mb-3">
                {marketplaceEntries.map(([mp, v]) => (
                  <span key={mp} className={`text-xs px-2 py-1 rounded ${chipBg}`}>
                    {mp}: <span className="font-semibold text-red-500">−${v.cogs.toFixed(2)}</span>
                    <span className={subText}> · {v.orders} ord · {v.units} u</span>
                  </span>
                ))}
              </div>
              {reasonEntries.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {reasonEntries.map(([reason, v]) => {
                    const active = reasonFilter === reason;
                    return (
                      <button
                        type="button"
                        key={reason}
                        onClick={() => setReasonFilter(active ? null : reason)}
                        className={`text-xs px-2 py-1 rounded transition ${chipBg} ${active ? "ring-2 ring-blue-500" : "opacity-90 hover:opacity-100"}`}
                        title={active ? "Click to clear filter" : "Click to filter orders by this reason"}
                      >
                        <span className={subText}>{REASON_LABEL[reason] || reason}:</span>{" "}
                        <span className="font-semibold text-red-500">−${v.cogs.toFixed(2)}</span>
                        <span className={subText}> · {v.orders} {v.orders === 1 ? "order" : "orders"}</span>
                      </button>
                    );
                  })}
                  {reasonFilter && (
                    <button
                      type="button"
                      onClick={() => setReasonFilter(null)}
                      className={`text-xs px-2 py-1 rounded ${chipBg} underline`}
                    >
                      Clear filter
                    </button>
                  )}
                </div>
              )}

              {/* Audit table */}
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-xs">
                  <thead className={subText}>
                    <tr className={`border-b ${rowBorder}`}>
                      <th className="text-left px-2 py-1.5 font-medium">Date</th>
                      <th className="text-left px-2 py-1.5 font-medium">Order ID</th>
                      <th className="text-left px-2 py-1.5 font-medium">ASIN</th>
                      <th className="text-left px-2 py-1.5 font-medium">Title</th>
                      <th className="text-left px-2 py-1.5 font-medium">Mkt</th>
                      <th className="text-right px-2 py-1.5 font-medium">Qty</th>
                      <th className="text-right px-2 py-1.5 font-medium">Unit Cost</th>
                      <th className="text-right px-2 py-1.5 font-medium">COGS</th>
                      <th className="text-left px-2 py-1.5 font-medium">Reason</th>
                      <th className="text-left px-2 py-1.5 font-medium">ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className={`border-b ${rowBorder} last:border-0`}>
                        <td className="px-2 py-1.5 whitespace-nowrap">{r.order_date}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <a
                            href={orderUrl(r.order_id, r.marketplace)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:no-underline"
                          >
                            {r.order_id}
                          </a>
                          {r.related_order_id && (
                            <span className={`ml-1 text-[10px] ${subText}`}>
                              ↳ {r.related_order_id}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap font-mono">
                          {r.asin || "—"}
                        </td>
                        <td className="px-2 py-1.5 max-w-[220px] truncate" title={r.title || ""}>
                          {r.title || "—"}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{r.marketplace || "—"}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-right tabular-nums">
                          {r.quantity}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-right tabular-nums">
                          ${r.unit_cost.toFixed(2)}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-right font-semibold text-red-500 tabular-nums">
                          −${r.cogs_usd.toFixed(2)}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <ReplacementBadge row={r} />
                          <span className={`ml-1 text-[10px] ${subText}`}>
                            {REASON_LABEL[r.replacement_reason || "unknown"] || r.replacement_reason}
                          </span>
                        </td>
                        <td className={`px-2 py-1.5 whitespace-nowrap text-[10px] ${subText}`}>
                          N/A
                        </td>
                      </tr>
                    ))}
                    <tr className={`border-t ${rowBorder}`}>
                      <td colSpan={7} className="px-2 py-2 text-right font-semibold">
                        Total COGS impact (revenue is $0)
                      </td>
                      <td className="px-2 py-2 text-right font-bold text-red-500 tabular-nums">
                        −${data.totalCogsUsd.toFixed(2)}
                      </td>
                      <td colSpan={2} className={`px-2 py-2 text-[11px] ${subText}`}>
                        {data.totalFeesUsd > 0
                          ? `+ $${data.totalFeesUsd.toFixed(2)} FEC fees`
                          : "no FEC fees"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className={`text-[11px] mt-2 ${subText}`}>
                Amazon shipped these units to customers at $0 revenue (replacements / free
                shipments). Revenue stays at $0 but the unit cost is deducted from net profit so
                totals are not overstated. ROI is N/A because revenue is zero. These are NOT
                missing-price errors.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default ReplacementCogsSection;
