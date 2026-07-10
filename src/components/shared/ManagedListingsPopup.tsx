import React, { useState } from "react";
import { Zap, Globe, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { SubscriptionPlan } from "@/hooks/use-subscription";

interface ManagedListingsPopupProps {
  trigger: React.ReactNode;
  activeListings: number;
  effectivePlan?: SubscriptionPlan;
  marketplaceCounts: Record<string, number>;
  loading: boolean;
}

const MP_FLAGS: Record<string, string> = {
  US: "🇺🇸", CA: "🇨🇦", MX: "🇲🇽", BR: "🇧🇷",
  UK: "🇬🇧", GB: "🇬🇧", DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
  IN: "🇮🇳", JP: "🇯🇵", AU: "🇦🇺", SG: "🇸🇬", AE: "🇦🇪", SA: "🇸🇦",
  TR: "🇹🇷", NL: "🇳🇱", SE: "🇸🇪", PL: "🇵🇱", BE: "🇧🇪", EG: "🇪🇬",
};

const ManagedListingsPopup: React.FC<ManagedListingsPopupProps> = ({
  trigger,
  activeListings,
  effectivePlan,
  marketplaceCounts,
  loading,
}) => {
  const [open, setOpen] = useState(false);

  const limit = effectivePlan?.listing_limit || 2000;
  const assignedCount = activeListings;
  const usagePct = Math.min((assignedCount / limit) * 100, 100);
  const isOver = assignedCount > limit;
  const overBy = assignedCount - limit;
  const remaining = limit - assignedCount;

  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (circumference * Math.min(usagePct, 100)) / 100;
  const marketplaces = Object.entries(marketplaceCounts).filter(([, count]) => count > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-[520px] p-0 border-0 bg-transparent overflow-hidden [&>button]:hidden">
        <DialogDescription className="sr-only">View your managed listings usage and marketplace breakdown</DialogDescription>
        <div className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] border border-white/10">
          <div className="absolute -top-20 -left-20 w-52 h-52 bg-primary/20 rounded-full blur-[100px] pointer-events-none" />
          <div className="absolute -bottom-16 -right-16 w-44 h-44 bg-purple-500/15 rounded-full blur-[100px] pointer-events-none" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:48px_48px] pointer-events-none" />

          <button
            onClick={() => setOpen(false)}
            className="absolute top-4 right-4 z-20 flex items-center justify-center w-8 h-8 rounded-full bg-white/[0.06] border border-white/10 text-gray-400 hover:text-white hover:bg-white/[0.12] transition-all duration-200 backdrop-blur-sm"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="relative z-10 p-6">
            <DialogHeader className="mb-6">
              <DialogTitle className="flex items-center gap-2 text-white text-lg font-bold">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-purple-500 shadow-lg shadow-primary/25">
                  <Zap className="w-4 h-4 text-white" />
                </div>
                Managed Listings
              </DialogTitle>
            </DialogHeader>

            <div className="flex items-center gap-6 mb-6">
              <div className="relative flex-shrink-0" style={{ width: 120, height: 120 }}>
                <svg width="120" height="120" viewBox="0 0 120 120" className="transform -rotate-90">
                  <circle cx="60" cy="60" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
                  <circle
                    cx="60"
                    cy="60"
                    r={radius}
                    fill="none"
                    stroke={isOver ? "hsl(0, 84%, 60%)" : "url(#gaugeGradient)"}
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    className="transition-all duration-1000 ease-out"
                  />
                  <defs>
                    <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="hsl(217, 91%, 60%)" />
                      <stop offset="100%" stopColor="hsl(270, 60%, 65%)" />
                    </linearGradient>
                  </defs>
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className={`text-2xl font-extrabold leading-none ${isOver ? 'text-red-400' : 'bg-gradient-to-r from-primary to-purple-400 bg-clip-text text-transparent'}`}>
                    {loading ? '…' : `${Math.round(usagePct)}%`}
                  </span>
                  <span className="mt-1 text-[11px] text-gray-400 font-medium tracking-wide uppercase">used</span>
                </div>
              </div>

              <div className="flex flex-col gap-2 min-w-0">
                <div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-3xl font-extrabold text-white tabular-nums">
                      {loading ? '—' : assignedCount.toLocaleString()}
                    </span>
                    <span className="text-sm text-gray-500 font-medium">/ {limit.toLocaleString()}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">active listings across all marketplaces</p>
                </div>
                {loading ? (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 w-fit">
                    <span className="text-xs font-medium text-gray-300">Loading managed listings…</span>
                  </div>
                ) : isOver ? (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/20 w-fit">
                    <span className="w-1.5 h-1.5 bg-red-400 rounded-full animate-pulse" />
                    <span className="text-xs font-semibold text-red-400">{overBy.toLocaleString()} over limit</span>
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 w-fit">
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                    <span className="text-xs font-medium text-gray-300">{remaining.toLocaleString()} slots remaining</span>
                  </div>
                )}
              </div>
            </div>

            {!loading && marketplaces.length > 0 && (
              <div className="mb-2">
                <div className="flex items-center gap-2 mb-3">
                  <Globe className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Marketplace Breakdown</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {marketplaces.map(([mp, count]) => (
                    <div
                      key={mp}
                      className="flex items-center justify-between rounded-xl bg-white/[0.04] border border-white/[0.06] px-3.5 py-2.5 hover:bg-white/[0.06] transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-base">{MP_FLAGS[mp] || '🌐'}</span>
                        <span className="text-sm font-semibold text-white">{mp}</span>
                      </div>
                      <span className="text-sm font-bold tabular-nums text-gray-300">{count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ManagedListingsPopup;
