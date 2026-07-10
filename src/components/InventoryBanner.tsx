import React from "react";
import { Package, BarChart3, DollarSign, TrendingUp } from "lucide-react";

const InventoryBanner = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      {/* Gradient background — warm/amber tone to differentiate from AI banner */}
      <div className="absolute inset-0 bg-gradient-to-r from-[hsl(200,70%,10%)] via-[hsl(180,60%,12%)] to-[hsl(220,70%,10%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,hsl(180,70%,40%,0.15),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,hsl(200,80%,50%,0.1),transparent_60%)]" />

      {/* Subtle grid */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(180,60%,50%) 1px, transparent 1px), linear-gradient(90deg, hsl(180,60%,50%) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          {/* Chip */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-teal-500/15 border border-teal-400/25 text-teal-400 text-sm font-medium backdrop-blur-sm">
            <Package className="w-4 h-4" />
            Inventory — Real-Time Amazon FBA Data
          </div>

          {/* Main headline */}
          <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white">
            Monitor everything from a single view.
          </h2>

          {/* Sub-headline */}
          <p className="text-lg md:text-xl text-muted-foreground/90 max-w-2xl mx-auto leading-relaxed">
            Pricing, costs, stock levels, sales velocity, and restock needs — all in one place.
          </p>

          {/* Feature pills */}
          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-teal-500/15">
                <DollarSign className="w-4 h-4 text-teal-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Cost & Pricing</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-cyan-500/15">
                <BarChart3 className="w-4 h-4 text-cyan-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Stock Levels</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-sky-500/15">
                <TrendingUp className="w-4 h-4 text-sky-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Sales Velocity & Restock</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default InventoryBanner;
