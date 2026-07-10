
import { Shield, TrendingDown, AlertTriangle, Lock } from 'lucide-react';

const safeguards = [
  { icon: Shield, text: 'Never goes below your cost' },
  { icon: TrendingDown, text: 'Prevents sudden price drops' },
  { icon: AlertTriangle, text: 'Limits risky price changes' },
  { icon: Lock, text: 'Keeps your account safe' },
];

const SafetySection = () => {
  return (
    <section className="py-20 bg-gradient-to-br from-[hsl(230,50%,10%)] to-[hsl(222,84%,4.9%)] relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.015)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.015)_1px,transparent_1px)] bg-[size:80px_80px]" />
      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-green-500/10 mb-6">
            <Shield className="w-7 h-7 text-green-400" />
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
            Built to protect your business
          </h2>
          <p className="text-muted-foreground mb-10 text-lg">
            Every price change goes through multiple safety checks.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
            {safeguards.map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={i} className="flex items-center gap-4 bg-white/5 border border-white/10 rounded-xl px-6 py-4">
                  <Icon className="w-6 h-6 text-green-400 flex-shrink-0" />
                  <span className="text-gray-200 text-lg">{s.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};

export default SafetySection;
