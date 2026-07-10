import React from "react";
import { PieChart, DollarSign, TrendingDown, Calculator } from "lucide-react";

const InventoryValuationBanner = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      <div className="absolute inset-0 bg-gradient-to-r from-[hsl(30,60%,8%)] via-[hsl(40,50%,10%)] to-[hsl(20,60%,8%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,hsl(35,80%,50%,0.12),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,hsl(45,70%,45%,0.1),transparent_60%)]" />

      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(35,60%,50%) 1px, transparent 1px), linear-gradient(90deg, hsl(35,60%,50%) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-500/15 border border-amber-400/25 text-amber-400 text-sm font-medium backdrop-blur-sm">
            <PieChart className="w-4 h-4" />
            Inventory Valuation — Know Your True Worth
          </div>

          <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white">
            See exactly what your inventory is worth — in real time.
          </h2>

          <p className="text-lg md:text-xl text-muted-foreground/90 max-w-2xl mx-auto leading-relaxed">
            Track total stock value, per-unit costs, profit margins, and capital tied up across all your ASINs — sorted by highest value first.
          </p>

          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-amber-500/15">
                <DollarSign className="w-4 h-4 text-amber-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Total Stock Value</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-yellow-500/15">
                <Calculator className="w-4 h-4 text-yellow-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Per-Unit Cost Tracking</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-orange-500/15">
                <TrendingDown className="w-4 h-4 text-orange-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Capital At Risk</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default InventoryValuationBanner;
