import React from "react";
import { Activity, BarChart3, Clock, Eye } from "lucide-react";

// Re-themed copy of SalesDashboardBanner.tsx. Copy is untouched — only the
// background wash, glow colors, and text classes changed.

const SalesDashboardBannerThemed = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      {/* Light emerald/green wash — same hue family as the original dark banner */}
      <div className="absolute inset-0 bg-gradient-to-r from-emerald-50 via-green-50 to-lime-50" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,hsl(140,65%,60%,0.12),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,hsl(160,55%,62%,0.1),transparent_60%)]" />

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
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-400/25 text-emerald-700 text-sm font-medium backdrop-blur-sm">
            <Activity className="w-4 h-4" />
            See Your Repricer in Action
          </div>

          <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-foreground">
            Watch your sales happen — live.
          </h2>

          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Real-time revenue charts, per-ASIN breakdowns, and daily sales graphs — for today and the entire month. Data syncs every 60 seconds so you always know what's selling right now.
          </p>

          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-card/80 border border-border backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-emerald-500/15">
                <Eye className="w-4 h-4 text-emerald-600" />
              </div>
              <span className="text-sm font-medium text-foreground">Live Sales Today</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-card/80 border border-border backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-green-500/15">
                <BarChart3 className="w-4 h-4 text-green-600" />
              </div>
              <span className="text-sm font-medium text-foreground">Monthly Revenue Chart</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-card/80 border border-border backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-lime-500/15">
                <Clock className="w-4 h-4 text-lime-600" />
              </div>
              <span className="text-sm font-medium text-foreground">Auto-Sync Every 60s</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default SalesDashboardBannerThemed;
