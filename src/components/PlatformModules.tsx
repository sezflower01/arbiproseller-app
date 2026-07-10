import { Warehouse, ListChecks, Tags, Search, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useModuleAccess } from '@/hooks/useModuleAccess';

const modules = [
  {
    icon: Tags,
    title: 'Repricer',
    description: 'Fully autonomous repricing — auto-generates min/max from your costs, assigns intelligent rules, lowers prices to win the Buy Box, and raises them back to extract maximum profit. Zero setup, zero babysitting.',
    accent: 'from-rose-500 to-red-600',
    highlight: true,
    href: '/tools/repricer',
  },
  {
    icon: Warehouse,
    title: 'Live Inventory Sync',
    description: 'Real-time FBA inventory pulled straight from Amazon — available, reserved, inbound, and unfulfillable units. Includes BSR tracking, ROI calculations, replenishment suggestions, and valuation reports.',
    accent: 'from-orange-500 to-amber-600',
    href: '/tools/synced-inventory',
  },
  {
    icon: ShieldCheck,
    title: 'Inventory Restoration',
    description: 'One-click guided reconcile that pulls Summaries (available + reserved) and the FBA report (inbound) in the safe order. Use it to clean up drift after a manual-only stabilization period.',
    accent: 'from-emerald-500 to-teal-600',
    href: '/tools/inventory-restoration',
    badge: 'New',
    adminOnly: true,
  },
  {
    icon: ListChecks,
    title: 'Product Library',
    description: 'Your saved product catalog with built-in supplier links, search by ASIN, SKU, or title, and quick reorder access. View cost, units, FNSKU, and ROI at a glance — bulk import via Excel, print labels, and update pricing in one click.',
    accent: 'from-teal-500 to-cyan-600',
    href: '/tools/my-database-products',
  },
  {
    icon: Search,
    title: 'Supplier Discovery',
    description: 'Look up any ASIN and instantly see supplier candidates our team has already discovered, ranked, and price-extracted. Browse pre-scanned profitable supplier-to-Amazon matches — no API credits required, updated continuously.',
    accent: 'from-cyan-500 to-blue-600',
    adminOnly: true,
    href: '/tools/supplier-discovery',
  },
];

const PlatformModules = () => {
  const { isAdmin } = useModuleAccess();

  const visibleModules = modules.filter((mod) => !mod.adminOnly || isAdmin);

  return (
    <section className="relative py-24 overflow-hidden bg-gradient-to-b from-[hsl(222,84%,4.9%)] via-[hsl(225,40%,7%)] to-[hsl(222,84%,4.9%)]">
      {/* Subtle glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-primary/5 rounded-full blur-[150px]" />

      <div className="container mx-auto px-4 relative z-10">
        {/* Section header */}
        <div className="text-center mb-16">
          <p className="text-xs uppercase tracking-[0.25em] text-primary font-semibold mb-3">Everything Included</p>
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-4">
            One Platform. Every Tool You Need.
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            The repricer is just the beginning. Every module below is included with your subscription — no add-ons, no hidden fees.
          </p>
        </div>

        {/* Modules grid */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 max-w-7xl mx-auto">
          {visibleModules.map((mod) => {
            const Icon = mod.icon;
            const cardClasses = `group relative block rounded-2xl border backdrop-blur-sm p-6 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-primary/5 ${
              mod.highlight
                ? 'bg-primary/5 border-primary/30 hover:border-primary/50'
                : 'bg-white/[0.02] border-gray-700/40 hover:border-gray-600/60'
            }`;

            const content = (
              <>
                {/* Icon */}
                <div className={`inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br ${mod.accent} text-white mb-4 shadow-lg group-hover:scale-110 transition-transform duration-300`}>
                  <Icon className="h-5 w-5" />
                </div>

                {/* Highlight / New badge */}
                {mod.highlight && (
                  <span className="absolute top-4 right-4 text-[10px] uppercase tracking-wider font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                    Core
                  </span>
                )}
                {mod.badge && !mod.highlight && (
                  <span className="absolute top-4 right-4 text-[10px] uppercase tracking-wider font-bold text-emerald-300 bg-emerald-400/10 px-2 py-0.5 rounded-full">
                    {mod.badge}
                  </span>
                )}

                <h3 className="font-semibold text-lg text-gray-100 mb-2 group-hover:text-white transition-colors">
                  {mod.title}
                </h3>
                <p className="text-sm text-gray-500 leading-relaxed">
                  {mod.description}
                </p>
              </>
            );

            return mod.href ? (
              <Link key={mod.title} to={mod.href} className={cardClasses}>
                {content}
              </Link>
            ) : (
              <div key={mod.title} className={cardClasses}>
                {content}
              </div>
            );
          })}
        </div>

        {/* Bottom note */}
        <div className="mt-14 text-center">
          <p className="text-sm text-gray-500">
            All modules are available on every plan. The only variable is the number of active Smart Listings for the Repricer.
          </p>
        </div>
      </div>
    </section>
  );
};

export default PlatformModules;
