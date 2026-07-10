import { X } from "lucide-react";
import type { CustomerProfile } from "@/lib/customers/useCustomerProfile";

interface Props {
  profile: CustomerProfile;
  onClose: () => void;
}

function fmtUSD(n: number | null | undefined) {
  const v = Number(n || 0);
  return `$${v.toFixed(2)}`;
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
}

export function CustomerHistorySheet({ profile, onClose }: Props) {
  const orderIds = profile.order_ids || [];
  const asins = profile.distinct_asins || [];
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-[#0f1c3f] text-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-white/10 bg-[#0f1c3f] px-4 py-3">
          <h2 className="text-sm font-semibold">Customer History</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-white/10" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4 text-sm">
          <div>
            <div className="text-xs text-white/60">Buyer</div>
            <div className="font-mono text-xs break-all">
              {profile.buyer_email || profile.buyer_name || profile.customer_key}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Orders" value={String(profile.orders_count)} />
            <Stat label="Units" value={String(profile.units_count)} />
            <Stat label="Revenue" value={fmtUSD(profile.revenue_usd)} />
            <Stat label="Refunds" value={`${profile.refund_orders_count} · ${fmtUSD(profile.refund_amount_usd)}`} />
            <Stat label="Replacements" value={String(profile.replacement_orders_count)} />
            <Stat label="Distinct ASINs" value={String(profile.distinct_asins_count)} />
            <Stat label="First purchase" value={fmtDate(profile.first_seen_at)} />
            <Stat label="Last purchase" value={fmtDate(profile.last_seen_at)} />
          </div>

          {asins.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-white/60">ASINs</div>
              <div className="flex flex-wrap gap-1">
                {asins.map((a) => (
                  <span key={a} className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-mono">{a}</span>
                ))}
              </div>
            </div>
          )}

          {orderIds.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-white/60">All order IDs</div>
              <ul className="space-y-1">
                {orderIds.map((oid) => (
                  <li key={oid}>
                    <a
                      href={`https://sellercentral.amazon.com/orders-v3/order/${oid}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs text-sky-400 hover:underline break-all"
                    >
                      {oid}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-white/50">{label}</div>
      <div className="mt-0.5 text-sm font-medium">{value}</div>
    </div>
  );
}
