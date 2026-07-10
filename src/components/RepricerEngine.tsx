
import { TrendingUp, Shield, Zap, Eye, Brain } from 'lucide-react';

const features = [
  {
    icon: Brain,
    title: 'Smarter Price Increases',
    description: 'Captures more profit when the market allows.',
    accent: 'from-purple-500 to-violet-500',
  },
  {
    icon: Shield,
    title: 'Never Lose Money',
    description: 'Minimum price protection keeps every sale profitable.',
    accent: 'from-green-500 to-emerald-500',
  },
  {
    icon: Zap,
    title: 'Fast Reactions',
    description: 'Your most important listings stay competitive at all times.',
    accent: 'from-orange-500 to-amber-500',
  },
  {
    icon: Eye,
    title: 'Smart Competition',
    description: 'Ignores bad sellers and unrealistic prices.',
    accent: 'from-blue-500 to-cyan-500',
  },
  {
    icon: TrendingUp,
    title: 'Buy Box Visibility',
    description: 'See when you win or lose — in real time.',
    accent: 'from-indigo-500 to-blue-500',
  },
];

const RepricerEngine = () => {
  return (
    <section id="repricer-engine" className="py-24 bg-gradient-to-b from-background to-secondary/30 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(hsl(var(--border)/0.3)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--border)/0.3)_1px,transparent_1px)] bg-[size:80px_80px]" />
      
      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-5xl font-bold text-foreground mb-6">
            Why it works
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Built for results — not complexity.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
          {features.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <div key={i} className="group relative">
                <div className="absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl blur-xl -z-10" />
                <div className="bg-card border border-border rounded-2xl p-6 hover:border-primary/30 transition-all duration-300 h-full">
                  <div className={`inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${feature.accent} text-white shadow-lg mb-4`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <h3 className="text-lg font-semibold text-card-foreground mb-2">{feature.title}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">{feature.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default RepricerEngine;
