import { Shield, TrendingDown, AlertTriangle, Lock } from 'lucide-react';

// Re-themed copy of SafetySection.tsx. Only classNames changed at retheme
// time — copy stays in sync with SafetySection.tsx's own edits (e.g. the
// "minimum price you set" correction) since both describe the same feature.
// Same background reasoning as SmartPricingSectionThemed.

const safeguards = [
  { icon: Shield, text: 'Never goes below the minimum price you set' },
  { icon: TrendingDown, text: 'Prevents sudden price drops' },
  { icon: AlertTriangle, text: 'Limits risky price changes' },
  { icon: Lock, text: 'Keeps your account safe' },
];

const SafetySectionThemed = () => {
  return (
    <section className="py-20 bg-background relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(hsl(var(--foreground)/0.02)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.02)_1px,transparent_1px)] bg-[size:80px_80px]" />
      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-green-500/10 mb-6">
            <Shield className="w-7 h-7 text-green-600" />
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Built to protect your business
          </h2>
          <p className="text-muted-foreground mb-10 text-lg">
            Every price change goes through multiple safety checks.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
            {safeguards.map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={i} className="flex items-center gap-4 bg-card border border-border rounded-xl px-6 py-4 shadow-sm">
                  <Icon className="w-6 h-6 text-green-600 flex-shrink-0" />
                  <span className="text-foreground text-lg">{s.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};

export default SafetySectionThemed;
