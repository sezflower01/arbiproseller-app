
import { Users } from 'lucide-react';

const whoIsFor = [
  { emoji: '🆕', text: 'New sellers — no experience needed' },
  { emoji: '⏰', text: 'Busy sellers — no time to manage pricing' },
  { emoji: '🚀', text: 'Advanced sellers — full automation at scale' },
  { emoji: '🎯', text: 'Arbitrage sellers — who want to scale with real data' },
];

const ComparisonSection = () => {
  return (
    <section className="py-20 bg-gradient-to-br from-[hsl(222,84%,4.9%)] to-[hsl(230,50%,10%)] relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.015)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.015)_1px,transparent_1px)] bg-[size:80px_80px]" />
      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center max-w-2xl mx-auto">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-6">
            <Users className="w-7 h-7 text-primary" />
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-2">
            Built for every Amazon seller
          </h2>
          <p className="text-muted-foreground text-lg">
            Built by a real Amazon seller. Designed for real workflows.
          </p>
          <div className="space-y-4 text-left max-w-md mx-auto mt-10">
            {whoIsFor.map((item, i) => (
              <div key={i} className="flex items-center gap-4 bg-white/5 border border-white/10 rounded-xl px-6 py-4">
                <span className="text-2xl">{item.emoji}</span>
                <span className="text-gray-200 text-lg">{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default ComparisonSection;
