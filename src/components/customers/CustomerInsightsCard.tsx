import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { X, HeartPulse } from "lucide-react";
import type { CustomerFlagLevel, CustomerProfile } from "@/lib/customers/useCustomerProfile";
import { CustomerHistorySheet } from "./CustomerHistorySheet";

interface Props {
  startDate: string; // ISO
  endDate: string;   // ISO
  showHealthCenterLink?: boolean;
}

const ORDER: CustomerFlagLevel[] = ["new", "returning", "refunder", "replacer", "review"];
const META: Record<CustomerFlagLevel, { label: string; emoji: string; cls: string }> = {
  new:       { label: "New",         emoji: "🟢", cls: "border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10" },
  returning: { label: "Returning",   emoji: "🔵", cls: "border-sky-500/30 text-sky-300 hover:bg-sky-500/10" },
  refunder:  { label: "Refunders",   emoji: "🟡", cls: "border-amber-500/30 text-amber-300 hover:bg-amber-500/10" },
  replacer:  { label: "Replacers",   emoji: "🟠", cls: "border-orange-500/30 text-orange-300 hover:bg-orange-500/10" },
  review:    { label: "Review",      emoji: "🔴", cls: "border-red-500/40 text-red-300 hover:bg-red-500/10" },
};

/**
 * Period-scoped customer intelligence summary. Reads customer_profiles rows
 * whose last_seen_at falls within the period, groups by flag_level.
 * Click a chip to open a list of matching customers.
 */
// Pattern-based chips shown when customer_profiles is empty (no PII/RDT yet).
type PatternKey = "refund_cluster" | "replacement_cluster" | "volume_with_returns" | "review";
const PATTERN_ORDER: PatternKey[] = ["refund_cluster", "replacement_cluster", "volume_with_returns", "review"];
const PATTERN_META: Record<PatternKey, { label: string; emoji: string; cls: string; reasons: string[] }> = {
  refund_cluster:       { label: "Refund Patterns",        emoji: "🟡", cls: "border-amber-500/30 text-amber-300 hover:bg-amber-500/10",  reasons: ["refund_cluster"] },
  replacement_cluster:  { label: "Replacement Patterns",   emoji: "🟠", cls: "border-orange-500/30 text-orange-300 hover:bg-orange-500/10", reasons: ["replacement_cluster"] },
  volume_with_returns:  { label: "High Volume + Returns",  emoji: "🟣", cls: "border-purple-500/30 text-purple-300 hover:bg-purple-500/10", reasons: ["volume_with_returns"] },
  review:               { label: "Review",                 emoji: "🔴", cls: "border-red-500/40 text-red-300 hover:bg-red-500/10",         reasons: ["shipto_loop", "refund_and_replacement"] },
};

export function CustomerInsightsCard({ startDate, endDate, showHealthCenterLink = true }: Props) {
  const { user } = useAuth();
  const [profiles, setProfiles] = useState<CustomerProfile[]>([]);
  const [patternCounts, setPatternCounts] = useState<Record<PatternKey, number>>({ refund_cluster: 0, replacement_cluster: 0, volume_with_returns: 0, review: 0 });
  const [loading, setLoading] = useState(false);
  const [openLevel, setOpenLevel] = useState<CustomerFlagLevel | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<CustomerProfile | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [profRes, patternRes] = await Promise.all([
        supabase
          .from("customer_profiles" as any)
          .select("*")
          .eq("user_id", user.id)
          .gte("last_seen_at", startDate)
          .lte("last_seen_at", endDate)
          .order("last_seen_at", { ascending: false })
          .limit(2000),
        supabase
          .from("business_health_issues" as any)
          .select("affected_entities")
          .eq("user_id", user.id)
          .eq("module", "customer_intelligence")
          .eq("status", "open")
          .limit(2000),
      ]);
      if (cancelled) return;
      setProfiles((profRes.data as any as CustomerProfile[]) || []);
      const pc: Record<PatternKey, number> = { refund_cluster: 0, replacement_cluster: 0, volume_with_returns: 0, review: 0 };
      for (const row of ((patternRes.data as any[]) || [])) {
        const reason = row?.affected_entities?.pattern_reason;
        if (!reason) continue;
        for (const key of PATTERN_ORDER) {
          if (PATTERN_META[key].reasons.includes(reason)) {
            pc[key] = (pc[key] || 0) + 1;
            break;
          }
        }
      }
      setPatternCounts(pc);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user?.id, startDate, endDate]);

  const counts = useMemo(() => {
    const c: Record<CustomerFlagLevel, number> = { new: 0, returning: 0, refunder: 0, replacer: 0, review: 0 };
    for (const p of profiles) c[p.flag_level] = (c[p.flag_level] || 0) + 1;
    return c;
  }, [profiles]);

  const total = profiles.length;
  const patternTotal = Object.values(patternCounts).reduce((a, b) => a + b, 0);
  const usePatternMode = total === 0 && patternTotal > 0;
  const filtered = openLevel ? profiles.filter((p) => p.flag_level === openLevel) : [];

  if (!user?.id) return null;

  return (
    <div className="rounded-md border border-white/10 bg-white/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-white/70">
          {usePatternMode ? "Customer Pattern Signals" : "Customer Insights"}{" "}
          {(usePatternMode ? patternTotal : total) > 0 && (
            <span className="text-white/40">({usePatternMode ? patternTotal : total})</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading && <span className="text-[10px] text-white/40">loading…</span>}
          {showHealthCenterLink && (
            <Link
              to="/tools/error-log"
              className="inline-flex items-center gap-1 rounded-full border border-red-400/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-200 hover:bg-red-500/20"
              title="Open Health Center — review flagged customer patterns"
            >
              <HeartPulse className="h-3 w-3" />
              Health Center
            </Link>
          )}
        </div>
      </div>
      {usePatternMode ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {PATTERN_ORDER.map((key) => {
              const n = patternCounts[key] || 0;
              const m = PATTERN_META[key];
              const disabled = n === 0;
              return (
                <Link
                  key={key}
                  to={`/tools/error-log?module=customer_intelligence&pattern=${key}`}
                  onClick={(e) => { if (disabled) e.preventDefault(); }}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${m.cls} ${disabled ? "opacity-40 pointer-events-none" : "cursor-pointer"}`}
                  title={`${m.label}: ${n} pattern${n === 1 ? "" : "s"}`}
                >
                  <span aria-hidden>{m.emoji}</span>
                  <span>{m.label}</span>
                  <span className="ml-0.5 rounded bg-white/10 px-1 tabular-nums">{n}</span>
                </Link>
              );
            })}
          </div>
          <div className="mt-2 text-[10px] italic text-white/40">
            Pattern-matched only — Amazon buyer identity (PII) not available. Counts reflect open Health Center patterns, not verified customers.
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {ORDER.map((lvl) => {
              const n = counts[lvl] || 0;
              const m = META[lvl];
              const disabled = n === 0;
              return (
                <button
                  key={lvl}
                  type="button"
                  disabled={disabled}
                  onClick={() => setOpenLevel(lvl)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${m.cls} ${disabled ? "opacity-40 cursor-default" : "cursor-pointer"}`}
                  title={`${m.label}: ${n}`}
                >
                  <span aria-hidden>{m.emoji}</span>
                  <span>{m.label}</span>
                  <span className="ml-0.5 rounded bg-white/10 px-1 tabular-nums">{n}</span>
                </button>
              );
            })}
          </div>
          {total === 0 && patternTotal === 0 && !loading && (
            <div className="mt-2 text-[11px] text-white/50">
              No customer profiles or patterns yet for this period.
            </div>
          )}
        </>
      )}

      {openLevel && (
        <CustomerListDrawer
          level={openLevel}
          profiles={filtered}
          onClose={() => setOpenLevel(null)}
          onPick={(p) => { setSelectedProfile(p); setOpenLevel(null); }}
        />
      )}
      {selectedProfile && (
        <CustomerHistorySheet profile={selectedProfile} onClose={() => setSelectedProfile(null)} />
      )}
    </div>
  );
}

function CustomerListDrawer({
  level,
  profiles,
  onClose,
  onPick,
}: {
  level: CustomerFlagLevel;
  profiles: CustomerProfile[];
  onClose: () => void;
  onPick: (p: CustomerProfile) => void;
}) {
  const m = META[level];
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-[#0f1c3f] text-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-white/10 bg-[#0f1c3f] px-4 py-3">
          <h2 className="text-sm font-semibold">
            <span aria-hidden className="mr-1">{m.emoji}</span>
            {m.label} ({profiles.length})
          </h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-white/10" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="divide-y divide-white/10">
          {profiles.map((p) => (
            <button
              key={p.customer_key}
              type="button"
              onClick={() => onPick(p)}
              className="block w-full px-4 py-2 text-left hover:bg-white/5"
            >
              <div className="truncate font-mono text-xs text-white/90">
                {p.buyer_email || p.buyer_name || p.customer_key}
              </div>
              <div className="mt-0.5 text-[10px] text-white/50">
                {p.orders_count} orders · ${Number(p.revenue_usd || 0).toFixed(2)}
                {p.refund_orders_count > 0 && ` · ${p.refund_orders_count} refunds ($${Number(p.refund_amount_usd || 0).toFixed(2)})`}
                {p.replacement_orders_count > 0 && ` · ${p.replacement_orders_count} replacements`}
              </div>
            </button>
          ))}
          {profiles.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-white/50">No customers in this segment.</div>
          )}
        </div>
      </div>
    </div>
  );
}
