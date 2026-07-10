import React from "react";
import { ShoppingCart, TrendingUp, Package, Bell } from "lucide-react";

const NeedBuyAgainBanner = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      <div className="absolute inset-0 bg-gradient-to-r from-[hsl(25,60%,8%)] via-[hsl(35,55%,11%)] to-[hsl(15,60%,8%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,hsl(30,80%,50%,0.12),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,hsl(40,70%,45%,0.1),transparent_60%)]" />

      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(30,60%,50%) 1px, transparent 1px), linear-gradient(90deg, hsl(30,60%,50%) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-orange-500/15 border border-orange-400/25 text-orange-400 text-sm font-medium backdrop-blur-sm">
            <ShoppingCart className="w-4 h-4" />
            Need Buy Again — Smart Reorder Alerts
          </div>

          <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white">
            Know exactly what to reorder — before you run out.
          </h2>

          <p className="text-lg md:text-xl text-muted-foreground/90 max-w-2xl mx-auto leading-relaxed">
            Uses your sales velocity, current stock, inbound units, and safety buffer to calculate exactly how many units to reorder — with direct supplier links for one-click purchasing.
          </p>

          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-orange-500/15">
                <TrendingUp className="w-4 h-4 text-orange-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Sales Velocity Forecast</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-amber-500/15">
                <Package className="w-4 h-4 text-amber-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Smart Replenish Qty</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-yellow-500/15">
                <Bell className="w-4 h-4 text-yellow-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Supplier Quick Links</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default NeedBuyAgainBanner;
