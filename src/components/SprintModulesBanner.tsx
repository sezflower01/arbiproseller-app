import { Search, TrendingUp, FileBarChart, Package, Bell, Truck } from "lucide-react";

const modules = [
  { letter: "S", name: "Sourcing", desc: "Find and validate profitable products", icon: Search, color: "violet" },
  { letter: "P", name: "Pricing", desc: "AI-powered repricer", icon: TrendingUp, color: "primary" },
  { letter: "R", name: "Reports", desc: "Profit & loss, always current", icon: FileBarChart, color: "blue" },
  { letter: "I", name: "Inventory", desc: "Live stock and valuation", icon: Package, color: "emerald" },
  { letter: "N", name: "Notifications", desc: "Alerts before problems cost you", icon: Bell, color: "amber" },
  { letter: "T", name: "Tracking", desc: "Shipments, start to finish", icon: Truck, color: "cyan" },
] as const;

const colorClasses: Record<string, { text: string; bg: string; border: string }> = {
  violet: { text: "text-violet-400", bg: "bg-violet-500/15", border: "border-violet-400/25" },
  primary: { text: "text-primary", bg: "bg-primary/15", border: "border-primary/25" },
  blue: { text: "text-blue-400", bg: "bg-blue-500/15", border: "border-blue-400/25" },
  emerald: { text: "text-emerald-400", bg: "bg-emerald-500/15", border: "border-emerald-400/25" },
  amber: { text: "text-amber-400", bg: "bg-amber-500/15", border: "border-amber-400/25" },
  cyan: { text: "text-cyan-400", bg: "bg-cyan-500/15", border: "border-cyan-400/25" },
};

const SprintModulesBanner = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      <div className="absolute inset-0 bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,hsl(var(--primary)/0.12),transparent_60%)]" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-3xl mx-auto text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-3">
            What <span className="bg-gradient-to-r from-primary to-purple-400 bg-clip-text text-transparent">S.P.R.I.N.T.</span> Stands For
          </h2>
          <p className="text-white/90 text-lg">
            The six core modules that make up your InventorySprint platform.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 md:gap-5 max-w-5xl mx-auto">
          {modules.map((m) => {
            const Icon = m.icon;
            const c = colorClasses[m.color];
            return (
              <div
                key={m.letter}
                className={`flex items-start gap-4 rounded-2xl border ${c.border} bg-white/[0.04] backdrop-blur-sm p-5`}
              >
                <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${c.bg} font-display text-2xl font-bold ${c.text}`}>
                  {m.letter}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <Icon className={`h-4 w-4 shrink-0 ${c.text}`} />
                    <h3 className="text-base font-bold text-white truncate">{m.name}</h3>
                  </div>
                  <p className="text-sm text-white/90 leading-snug">{m.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default SprintModulesBanner;
