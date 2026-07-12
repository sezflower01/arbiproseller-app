import { TrendingUp, ShieldCheck, ArrowUpCircle, RefreshCw, Brain } from 'lucide-react';

// Re-themed copy of SmartPricingSection.tsx. Copy is untouched — only
// classNames changed. The section's dark navy gradient was a literal copy of
// the dark theme's own --background/--card values, so it maps directly to
// the token page background (bg-background) rather than a distinct color.

const points = [
  { icon: TrendingUp, text: "Doesn't blindly lower prices" },
  { icon: ShieldCheck, text: 'Avoids unprofitable sales' },
  { icon: ArrowUpCircle, text: 'Raises prices when market allows' },
  { icon: RefreshCw, text: 'Adapts automatically in real time' },
  { icon: Brain, text: 'Continuously improved by Gemini AI review' },
];

const SmartPricingSectionThemed = () => {
  return (
    <section className="py-20 bg-background relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(hsl(var(--foreground)/0.02)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.02)_1px,transparent_1px)] bg-[size:80px_80px]" />
      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            AI Pricing Powered by Gemini — <span className="bg-gradient-to-r from-primary to-purple-500 bg-clip-text text-transparent">Not Just Undercutting</span>
          </h2>
          <p className="text-muted-foreground mb-10 text-lg">
            Your pricing engine acts instantly — Gemini ensures it keeps improving.
          </p>
          <div className="grid grid-cols-1 gap-3 max-w-xl mx-auto">
            {points.map((p, i) => {
              const Icon = p.icon;
              return (
                <div key={i} className="flex items-center gap-4 bg-card border border-border rounded-xl px-5 py-3.5 shadow-sm">
                  <Icon className="w-5 h-5 text-primary flex-shrink-0" />
                  <span className="text-foreground text-base">{p.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};

export default SmartPricingSectionThemed;
