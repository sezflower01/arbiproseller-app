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

const GettingStartedSettings = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white mb-1">4 Simple Steps</h2>
        <p className="text-gray-400 text-sm">Get started in minutes — your repricer works while you sleep.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {steps.map((step, i) => {
          const Icon = step.icon;
          return (
            <div key={i} className="bg-white/5 border border-white/10 rounded-2xl p-6 hover:bg-white/[0.07] hover:border-primary/30 transition-all duration-300">
              <div className="flex items-start gap-4">
                <div className={`flex-shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${step.accent} text-white shadow-lg`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <span className="text-3xl font-bold bg-gradient-to-b from-primary/40 to-transparent bg-clip-text text-transparent">{step.num}</span>
                  <h3 className="text-lg font-semibold text-white mt-1 mb-1">{step.title}</h3>
                  <p className="text-gray-400 text-sm leading-relaxed">{step.description}</p>

                  {'cta' in step && step.cta && (
                    <a href="/subscriptions" className="inline-block mt-3 px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:opacity-90 transition-opacity">
                      Start Free Trial
                    </a>
                  )}

                  {step.details && (
                    <div className="mt-3 space-y-1.5 border-t border-white/10 pt-3">
                      {step.details.map((d, j) => {
                        const DIcon = d.icon;
                        return (
                          <div key={j} className="flex items-center gap-2 text-xs text-gray-300">
                            <DIcon className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                            <span>{d.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Autopilot strip */}
      <div className="bg-gradient-to-r from-primary/10 to-purple-500/10 border border-primary/20 rounded-2xl p-6 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-green-500 to-emerald-500 text-white shadow-lg mb-3">
          <Zap className="w-6 h-6" />
        </div>
        <h3 className="text-xl font-bold text-white mb-2">Then autopilot takes over</h3>
        <p className="text-gray-400 max-w-xl mx-auto text-sm leading-relaxed">
          Your prices adjust 24/7 — competing for the Buy Box, raising prices when possible, and protecting your margins from price drops.
        </p>
      </div>
    </div>
  );
};

export default GettingStartedSettings;
