import { useState } from "react";
import type { CustomerFlagLevel, CustomerProfile } from "@/lib/customers/useCustomerProfile";
import { CustomerHistorySheet } from "./CustomerHistorySheet";

interface Props {
  profile: CustomerProfile | null | undefined;
  compact?: boolean;
}

const STYLE: Record<CustomerFlagLevel, { label: string; cls: string; emoji: string }> = {
  new:       { label: "New",        emoji: "🟢", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  returning: { label: "Returning",  emoji: "🔵", cls: "bg-sky-500/10 text-sky-400 border-sky-500/30" },
  refunder:  { label: "Refunder",   emoji: "🟡", cls: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  replacer:  { label: "Replacer",   emoji: "🟠", cls: "bg-orange-500/10 text-orange-400 border-orange-500/30" },
  review:    { label: "Review",     emoji: "🔴", cls: "bg-red-500/10 text-red-400 border-red-500/40" },
};

export function CustomerBadge({ profile, compact }: Props) {
  const [open, setOpen] = useState(false);
  if (!profile) return null;
  const s = STYLE[profile.flag_level] || STYLE.new;
  const suffix =
    profile.flag_level === "returning" ? ` ${profile.orders_count}x` :
    profile.flag_level === "refunder" ? ` ${profile.refund_orders_count}` :
    profile.flag_level === "replacer" ? ` ${profile.replacement_orders_count}` :
    profile.flag_level === "review" ? "" : "";
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-tight ${s.cls}`}
        aria-label={`Customer: ${s.label}`}
        title={`${s.label} customer — click for history`}
      >
        <span aria-hidden>{s.emoji}</span>
        {!compact && <span>{s.label}{suffix}</span>}
      </button>
      {open && <CustomerHistorySheet profile={profile} onClose={() => setOpen(false)} />}
    </>
  );
}
