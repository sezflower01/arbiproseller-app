import { Users } from 'lucide-react';

// Re-themed copy of ComparisonSection.tsx. Copy is untouched — only
// classNames changed. Same background reasoning as SmartPricingSectionThemed.

const whoIsFor = [
  { emoji: '🆕', text: 'New sellers — no experience needed' },
  { emoji: '⏰', text: 'Busy sellers — no time to manage pricing' },
  { emoji: '🚀', text: 'Advanced sellers — full automation at scale' },
  { emoji: '🎯', text: 'Arbitrage sellers — who want to scale with real data' },
];

const ComparisonSectionThemed = () => {
  return (
    <section className="py-20 bg-background relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(hsl(var(--foreground)/0.02)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.02)_1px,transparent_1px)] bg-[size:80px_80px]" />
      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center max-w-2xl mx-auto">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-6">
            <Users className="w-7 h-7 text-primary" />
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-2">
            Built for every Amazon seller
          </h2>
          <p className="text-muted-foreground text-lg">
            Built by a real Amazon seller. Designed for real workflows.
          </p>
          <div className="space-y-4 text-left max-w-md mx-auto mt-10">
            {whoIsFor.map((item, i) => (
              <div key={i} className="flex items-center gap-4 bg-card border border-border rounded-xl px-6 py-4 shadow-sm">
                <span className="text-2xl">{item.emoji}</span>
                <span className="text-foreground text-lg">{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default ComparisonSectionThemed;
