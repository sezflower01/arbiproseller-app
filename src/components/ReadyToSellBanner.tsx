import React from "react";
import { Sparkles, CheckCircle2, XCircle, AlertCircle, Filter, ShoppingCart, Zap } from "lucide-react";

const ReadyToSellBanner = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-r from-[hsl(180,70%,10%)] via-[hsl(200,80%,12%)] to-[hsl(160,60%,10%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,hsl(160,80%,45%,0.2),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,hsl(190,80%,50%,0.15),transparent_60%)]" />

      {/* Subtle grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(160,80%,50%) 1px, transparent 1px), linear-gradient(90deg, hsl(160,80%,50%) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          {/* Coming Soon chip */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 text-sm font-medium backdrop-blur-sm">
            <Sparkles className="w-4 h-4" />
            Ready-to-Sell Deals · Coming Soon
          </div>

          {/* Main headline */}
          <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white">
            Get bulk-approved products ready to source — in seconds
          </h2>

          {/* Sub-headline */}
          <p className="text-lg md:text-xl text-muted-foreground/90 max-w-2xl mx-auto leading-relaxed">
            Not a traditional scanning tool. A curated system designed for speed and action.
          </p>

          {/* Approval status badges */}
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 text-xs font-semibold backdrop-blur-sm">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Approved
            </div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-400/30 text-amber-300 text-xs font-semibold backdrop-blur-sm">
              <AlertCircle className="w-3.5 h-3.5" />
              Needs Approval
            </div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-rose-500/15 border border-rose-400/30 text-rose-300 text-xs font-semibold backdrop-blur-sm">
              <XCircle className="w-3.5 h-3.5" />
              Restricted
            </div>
          </div>

          {/* Bullet feature pills */}
          <div className="grid sm:grid-cols-2 gap-3 max-w-2xl mx-auto pt-4 text-left">
            <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
              <span className="text-sm font-medium text-white/90">Bulk-approved products, ready to source</span>
            </div>
            <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <Filter className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
              <span className="text-sm font-medium text-white/90">Filter by category, competition & approval</span>
            </div>
            <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <Zap className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <span className="text-sm font-medium text-white/90">No wasted time on restricted products</span>
            </div>
            <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <ShoppingCart className="w-5 h-5 text-purple-400 flex-shrink-0 mt-0.5" />
              <span className="text-sm font-medium text-white/90">Build a ready-to-buy list to act faster</span>
            </div>
          </div>

          {/* Positioning */}
          <div className="pt-4 space-y-2">
            <p className="text-xl md:text-2xl font-semibold text-white">
              Built for action — not analysis
            </p>
            <p className="text-base text-muted-foreground/90">
              Skip complex filters and start sourcing immediately
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};

export default ReadyToSellBanner;
