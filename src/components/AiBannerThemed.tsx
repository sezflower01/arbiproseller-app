import React from "react";
import { Brain, Zap, TrendingUp } from "lucide-react";

// Re-themed copy of AiBanner.tsx. Copy is untouched — only the background
// wash, glow colors, and text classes changed. The section's primary-token
// radial glow and grid pattern were already token-driven and are reused as-is.

const AiBannerThemed = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      {/* Light violet/indigo wash — same hue family as the original dark banner */}
      <div className="absolute inset-0 bg-gradient-to-r from-violet-50 via-indigo-50 to-fuchsia-50" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,hsl(var(--primary)/0.12),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,hsl(270,70%,65%,0.12),transparent_60%)]" />

      {/* Subtle grid pattern (already token-driven) */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage: "linear-gradient(hsl(var(--primary)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--primary)) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          {/* Chip */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/15 border border-primary/25 text-primary text-sm font-medium backdrop-blur-sm">
            <Brain className="w-4 h-4" />
            AI Repricer Powered by Real-Time Intelligence
          </div>

          {/* Main headline */}
          <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-foreground">
            Instant price adjustments — no delays.
          </h2>

          {/* Sub-headline */}
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Continuously improves your results with AI reviewed by Gemini.
          </p>

          {/* Feature pills */}
          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-card/80 border border-border backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-emerald-500/15">
                <Zap className="w-4 h-4 text-emerald-600" />
              </div>
              <span className="text-sm font-medium text-foreground">⚡ Instant Repricing</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-card/80 border border-border backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-blue-500/15">
                <Brain className="w-4 h-4 text-blue-600" />
              </div>
              <span className="text-sm font-medium text-foreground">🧠 Self-Learning Engine</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-card/80 border border-border backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-purple-500/15">
                <TrendingUp className="w-4 h-4 text-purple-600" />
              </div>
              <span className="text-sm font-medium text-foreground">💰 Profit Optimization</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default AiBannerThemed;
