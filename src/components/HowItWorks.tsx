
import { Package, Zap, DollarSign, ArrowRight, CheckCircle, Shield, Target } from 'lucide-react';

const steps = [
  {
    num: '01',
    icon: Shield,
    title: 'Start your free trial',
    description: 'Try everything for 60 days — no risk.',
    accent: 'from-purple-500 to-violet-500',
    cta: true,
  },
  {
    num: '02',
    icon: Package,
    title: 'Connect your Amazon account',
    description: 'Your products sync automatically. Nothing to configure.',
    accent: 'from-blue-500 to-cyan-500',
  },
  {
    num: '03',
    icon: Target,
    title: 'Choose your pricing strategy',
    description: 'Pick the rule that fits your goal — the system does the rest.',
    accent: 'from-rose-500 to-pink-500',
    details: [
      { icon: CheckCircle, text: '📈 Momentum Builder ⭐ — Best balance of sales and profit' },
      { icon: CheckCircle, text: '⚖️ Balanced — Stable and low-risk pricing' },
      { icon: CheckCircle, text: '🚀 Aggressive Capture — Get more sales fast' },
      { icon: CheckCircle, text: '💰 Margin Protection — Higher profit, slower sales' },
      { icon: CheckCircle, text: '🏆 Profit Extractor — Maximize profit when competition is low' },
      { icon: CheckCircle, text: '🔥 Liquidation — Sell inventory quickly' },
    ],
  },
  {
    num: '04',
    icon: DollarSign,
    title: 'Enter your product cost',
    description: "That's all you need. The system takes care of the rest.",
    accent: 'from-amber-500 to-orange-500',
    details: [
      { icon: CheckCircle, text: 'Min & max prices are created automatically' },
      { icon: CheckCircle, text: 'Your chosen rule is applied automatically' },
      { icon: Shield, text: 'Your profit is always protected' },
    ],
  },
];

const HowItWorks = () => {
  return (
    <section id="how-it-works" className="py-24 bg-gradient-to-br from-[hsl(222,84%,4.9%)] to-[hsl(230,50%,10%)] relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.015)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.015)_1px,transparent_1px)] bg-[size:80px_80px]" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-5xl font-bold text-white mb-6">
            4 simple steps. No learning curve.
          </h2>
          <p className="text-lg text-muted-foreground">
            Get started in minutes — your repricer works while you sleep.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto mb-16">
          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={i} className="relative group">
                {i < steps.length - 1 && (
                  <div className="hidden lg:block absolute top-12 right-0 translate-x-1/2 z-20">
                    <ArrowRight className="w-6 h-6 text-gray-600" />
                  </div>
                )}
                
                <div className="bg-white/5 border border-white/10 rounded-2xl p-8 hover:bg-white/[0.07] hover:border-primary/30 transition-all duration-300 h-full">
                  <div className={`inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${step.accent} text-white shadow-lg mb-4`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <span className="block text-5xl font-bold bg-gradient-to-b from-primary/40 to-transparent bg-clip-text text-transparent">{step.num}</span>
                  <h3 className="text-xl font-semibold text-white mt-4 mb-3">{step.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">{step.description}</p>
                  
                  {'cta' in step && step.cta && (
                    <a href="/subscriptions" className="inline-block mt-4 px-5 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity">
                      Start Free Trial
                    </a>
                  )}
                  
                  {step.details && (
                    <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
                      {step.details.map((d, j) => {
                        const DIcon = d.icon;
                        return (
                          <div key={j} className="flex items-center gap-2 text-sm text-muted-foreground">
                            <DIcon className="w-4 h-4 text-primary flex-shrink-0" />
                            <span>{d.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Autopilot strip */}
        <div className="max-w-6xl mx-auto">
          <div className="bg-gradient-to-r from-primary/10 to-purple-500/10 border border-primary/20 rounded-2xl p-8 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-green-500 to-emerald-500 text-white shadow-lg mb-4">
              <Zap className="w-7 h-7" />
            </div>
            <h3 className="text-2xl font-bold text-white mb-3">Then autopilot takes over</h3>
            <p className="text-muted-foreground max-w-xl mx-auto leading-relaxed">
              Your prices adjust 24/7 — competing for the Buy Box, raising prices when possible, and protecting your margins from price drops.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HowItWorks;
