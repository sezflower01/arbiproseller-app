import { Download, CheckCircle, Zap, TrendingUp, ShieldCheck, ArrowUpCircle, RefreshCw } from 'lucide-react';
import { Button } from "@/components/ui/button";
import LiveAiDemoCompactThemed from "@/components/LiveAiDemoCompactThemed";

// Re-themed copy of Hero.tsx for the "InventoryHub" light identity. Copy,
// structure, and the hidden CTA/trust-indicator blocks (they're `hidden` +
// aria-hidden in the original too — not a bug, left exactly as-is) are
// untouched — only classNames changed. The section's dark navy gradient was
// a literal copy of the dark theme's own --background/--card values (not a
// distinct brand color), so it maps directly to the token page background.

const HeroThemed = () => {
  const handleDownloadClick = () => {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'cta_click', { event_category: 'engagement', event_label: 'hero_download_button', value: 1 });
    }
    window.location.href = '/signup';
  };

  return (
    <div className="relative min-h-screen flex items-center overflow-hidden bg-background">
      {/* Ambient gradient orbs (token-based) */}
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/10 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/10 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />

      {/* Grid pattern overlay */}
      <div className="absolute inset-0 bg-[linear-gradient(hsl(var(--foreground)/0.03)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <div className="container mx-auto px-4 py-20 md:py-24 relative z-10">
        <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] gap-10 lg:gap-12 items-center">
          {/* Left: Copy */}
          <div className="w-full max-w-2xl min-w-0 text-center lg:text-left mx-auto lg:mx-0">
            <div className="w-full max-w-[calc(100vw-2rem)] min-w-0 rounded-2xl border border-border bg-card/70 p-5 shadow-2xl backdrop-blur-xl sm:p-6 md:p-8">
            <div className="inline-flex items-start gap-2 px-4 py-1.5 rounded-2xl border border-primary/30 bg-primary/10 text-primary text-xs sm:text-sm font-medium mb-6 animate-fade-in max-w-full min-w-0">
              <Zap className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span className="break-words">Source Smarter. Price Smarter. Scale With Confidence.</span>
            </div>

            <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold mb-4 animate-fade-in leading-tight">
              <span className="text-foreground">Make better sourcing decisions. Price smarter with AI. Scale with confidence.</span>
            </h1>

            <p className="text-base md:text-lg text-muted-foreground mb-6 animate-slide-up leading-relaxed" style={{ animationDelay: '0.15s' }}>
              Organize proven Amazon products, track suppliers, and automate pricing with AI that protects your margins — and gets smarter over time.
            </p>

            <div className="mb-7 animate-slide-up text-left w-full" style={{ animationDelay: '0.25s' }}>
              <div className="space-y-2">
                <div className="flex items-start gap-3 text-muted-foreground">
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <span className="break-words min-w-0">Organize and store your proven Amazon products</span>
                </div>
                <div className="flex items-start gap-3 text-muted-foreground">
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <span className="break-words min-w-0">Track supplier links and product history in one place</span>
                </div>
                <div className="flex items-start gap-3 text-muted-foreground">
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <span className="break-words min-w-0">Reorder faster with direct supplier access</span>
                </div>
                <div className="flex items-start gap-3 text-muted-foreground">
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <span className="break-words min-w-0">Know what to reorder before you run out</span>
                </div>
                <div className="flex items-start gap-3 text-muted-foreground">
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <span className="break-words min-w-0">Automate pricing with AI reviewed by Gemini to improve performance over time</span>
                </div>
              </div>
            </div>
            </div>

            {/* CTA Button (hidden in the original too — preserved as-is, not a content change) */}
            <div className="hidden justify-center lg:justify-start mb-3 animate-slide-up" style={{ animationDelay: '0.4s' }} aria-hidden="true">
              <Button
                size="lg"
                className="font-semibold text-lg px-8 py-6 h-auto shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 transition-all duration-300 group"
                onClick={handleDownloadClick}
              >
                <Download className="mr-2 group-hover:-translate-y-0.5 transition-transform" size={22} />
                Start Your 60-Day Free Trial
              </Button>
            </div>

            {/* Trust indicators (also hidden in the original) */}
            <div className="hidden flex-wrap items-center justify-center lg:justify-start gap-x-5 gap-y-2 text-sm text-muted-foreground animate-slide-up" style={{ animationDelay: '0.5s' }} aria-hidden="true">
              <span className="flex items-center">
                <span className="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse" />
                No Credit Card Required
              </span>
            </div>
          </div>

          {/* Right: Live AI Demo + AI Pricing Points */}
          <div className="animate-fade-in w-full max-w-md mx-auto lg:max-w-none flex flex-col gap-6" style={{ animationDelay: '0.3s' }}>
            <LiveAiDemoCompactThemed />

            {/* AI Pricing Points - Moved from SmartPricingSection */}
            <div className="bg-card/70 border border-border rounded-2xl p-5 backdrop-blur-sm">
              <h3 className="text-lg font-bold text-foreground mb-1">
                <span className="bg-gradient-to-r from-primary to-purple-500 bg-clip-text text-transparent">AI Pricing Powered by Gemini</span> — Not Just Undercutting
              </h3>
              <p className="text-muted-foreground text-sm mb-4">Your pricing engine acts instantly — Gemini ensures it keeps improving.</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
                  <TrendingUp className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-muted-foreground text-xs">Doesn't blindly lower prices</span>
                </div>
                <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
                  <ShieldCheck className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-muted-foreground text-xs">Avoids unprofitable sales</span>
                </div>
                <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
                  <ArrowUpCircle className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-muted-foreground text-xs">Raises prices when the market allows</span>
                </div>
                <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
                  <RefreshCw className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-muted-foreground text-xs">Adapts automatically in real time</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeroThemed;
