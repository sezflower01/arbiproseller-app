import React from "react";
import { Activity, BarChart3, Clock, Eye } from "lucide-react";

const SalesDashboardBanner = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      <div className="absolute inset-0 bg-gradient-to-r from-[hsl(140,50%,8%)] via-[hsl(160,45%,10%)] to-[hsl(130,50%,8%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,hsl(140,70%,40%,0.12),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,hsl(160,60%,45%,0.1),transparent_60%)]" />

      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(140,60%,45%) 1px, transparent 1px), linear-gradient(90deg, hsl(140,60%,45%) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-400/25 text-emerald-400 text-sm font-medium backdrop-blur-sm">
            <Activity className="w-4 h-4" />
            See Your Repricer in Action
          </div>

          <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white">
            Watch your sales happen — live.
          </h2>

          <p className="text-lg md:text-xl text-muted-foreground/90 max-w-2xl mx-auto leading-relaxed">
            Real-time revenue charts, per-ASIN breakdowns, and daily sales graphs — for today and the entire month. Data syncs every 60 seconds so you always know what's selling right now.
          </p>

          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-emerald-500/15">
                <Eye className="w-4 h-4 text-emerald-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Live Sales Today</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-green-500/15">
                <BarChart3 className="w-4 h-4 text-green-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Monthly Revenue Chart</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-lime-500/15">
                <Clock className="w-4 h-4 text-lime-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Auto-Sync Every 60s</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default SalesDashboardBanner;
