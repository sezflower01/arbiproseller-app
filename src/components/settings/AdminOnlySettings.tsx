import { Link } from "react-router-dom";
import { Radio, LayoutDashboard, Sun, ListChecks, Activity, Stethoscope, Shield, ShieldCheck, FilePlus, FileText, Receipt, AlertTriangle, Printer, Package, Globe, Search, LineChart, type LucideIcon } from "lucide-react";

type StandaloneCard = {
  title: string;
  desc: string;
  path: string;
  Icon: LucideIcon;
  accent: string;
  badge?: string;
};

// Cards moved out of the main Tools Hub so they're only reachable from here.
// Add more entries to this list as additional cards get moved in.
const STANDALONE_CARDS: StandaloneCard[] = [
  {
    title: "Live Sales — Mobile View",
    desc: "Compact, mobile-optimized Today's sales view — great for a phone-sized window.",
    path: "/m/live-sales",
    Icon: Radio,
    accent: "from-emerald-500/15 to-emerald-500/5 border-emerald-400/30 text-emerald-300",
    badge: "Live",
  },
  {
    title: "Dashboard Overview",
    desc: "Live business snapshot: profit, inventory, repricing, shipments and alerts.",
    path: "/tools/dashboard",
    Icon: LayoutDashboard,
    accent: "from-slate-500/15 to-slate-500/5 border-slate-400/30 text-slate-300",
  },
  {
    title: "Inventory Restoration",
    desc: "One-click guided reconcile: Summaries (available + reserved) + FBA report (inbound) in safe order.",
    path: "/tools/inventory-restoration",
    Icon: ShieldCheck,
    accent: "from-emerald-500/15 to-teal-500/5 border-emerald-400/30 text-emerald-300",
  },
  {
    title: "Inventory Review Queue",
    desc: "SKUs missing from FBA reports — review and decide. No stock is changed automatically.",
    path: "/tools/inventory-review",
    Icon: ListChecks,
    accent: "from-amber-500/15 to-orange-500/5 border-amber-400/30 text-amber-300",
  },
  {
    title: "Create Listing",
    desc: "Create a new Amazon listing from scratch with guided fields and validation.",
    path: "/tools/create-listing",
    Icon: FilePlus,
    accent: "from-indigo-500/15 to-blue-500/5 border-indigo-400/30 text-indigo-300",
  },
  {
    title: "Reports & Accounting",
    desc: "Generate detailed business reports.",
    path: "/tools/reports",
    Icon: FileText,
    accent: "from-indigo-500/15 to-blue-500/5 border-indigo-400/30 text-indigo-300",
  },
  {
    title: "Shipment Profit & Loss",
    desc: "Per-shipment cost breakdown: COGS, Amazon inbound fees, manual costs and totals.",
    path: "/tools/shipment-accounting",
    Icon: Receipt,
    accent: "from-emerald-500/15 to-teal-500/5 border-emerald-400/30 text-emerald-300",
  },
  {
    title: "Price Discrepancy Audit",
    desc: "Compare My Price vs Sales Report vs Live Mobile per order to diagnose revenue mismatches.",
    path: "/tools/price-discrepancy-audit",
    Icon: AlertTriangle,
    accent: "from-orange-500/15 to-red-500/5 border-orange-400/30 text-orange-300",
  },
  {
    title: "Label Printing",
    desc: "Print FNSKU and shipping labels easily.",
    path: "/tools/label-printing",
    Icon: Printer,
    accent: "from-pink-500/15 to-rose-500/5 border-pink-400/30 text-pink-300",
  },
  {
    title: "Print Without PDF",
    desc: "Direct thermal printing without PDF files.",
    path: "/tools/printing-without-pdf",
    Icon: Package,
    accent: "from-fuchsia-500/15 to-pink-500/5 border-fuchsia-400/30 text-fuchsia-300",
  },
  {
    title: "Worldwide Tracking",
    desc: "Track packages from any carrier globally.",
    path: "/tools/tracking",
    Icon: Globe,
    accent: "from-cyan-500/15 to-teal-500/5 border-cyan-400/30 text-cyan-300",
  },
  {
    title: "Fetch Listing Price",
    desc: "Compare listing prices across US, CA, MX, BR.",
    path: "/tools/fetch-listing-price",
    Icon: Search,
    accent: "from-blue-500/15 to-cyan-500/5 border-blue-400/30 text-blue-300",
  },
  {
    title: "Price History",
    desc: "Track ASIN price changes over time with charts.",
    path: "/tools/price-history",
    Icon: LineChart,
    accent: "from-purple-500/15 to-indigo-500/5 border-purple-400/30 text-purple-300",
  },
];

const DAILY_FLOW_STEPS = [
  {
    step: "1",
    when: "Morning · 2–5 min",
    title: "Executive Review",
    desc: "Start the day with the high-level health snapshot.",
    path: "/tools/executive",
    Icon: Sun,
    accent: "from-blue-500/15 to-indigo-500/5 border-blue-400/30 text-blue-300",
  },
  {
    step: "2",
    when: "Operational review",
    title: "Operator Queue",
    desc: "Approve, snooze, or escalate today's suggested actions.",
    path: "/tools/repricer/operator-queue",
    Icon: ListChecks,
    accent: "from-emerald-500/15 to-emerald-500/5 border-emerald-400/30 text-emerald-300",
  },
  {
    step: "3",
    when: "Investigate behavior",
    title: "Repricer Monitor",
    desc: "Look into unusual pricing or strategy behavior.",
    path: "/tools/repricer/monitor",
    Icon: Activity,
    accent: "from-violet-500/15 to-violet-500/5 border-violet-400/30 text-violet-300",
  },
  {
    step: "4",
    when: "Diagnose performance",
    title: "Cron Diagnostics",
    desc: "Inspect jobs, queues, and platform health.",
    path: "/tools/cron-diagnostics",
    Icon: Stethoscope,
    accent: "from-amber-500/15 to-amber-500/5 border-amber-400/30 text-amber-300",
  },
];

export default function AdminOnlySettings() {
  return (
    <div className="space-y-10">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Shield className="h-5 w-5 text-rose-300" />
          <h2 className="text-xl font-bold text-white">Admin Only</h2>
        </div>
        <p className="text-sm text-gray-400">
          Internal tools moved out of the main Tools Hub — visible only to admin accounts.
        </p>
      </div>

      <section>
        <div className="grid gap-5 sm:grid-cols-2">
          {STANDALONE_CARDS.map((c) => (
            <Link
              key={c.path}
              to={c.path}
              className={`group relative flex items-center gap-4 overflow-hidden rounded-2xl border bg-gradient-to-br ${c.accent} p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg`}
            >
              <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-white/10 border border-white/10 shrink-0">
                <c.Icon className="h-6 w-6" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-bold text-white">{c.title}</h3>
                  {c.badge ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-white/10 border border-white/20">
                      <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                      {c.badge}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-white/60 mt-0.5">{c.desc}</p>
              </div>
              <div className="text-sm font-medium shrink-0">Open →</div>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <header className="mb-5">
          <h3 className="text-lg font-bold text-white">Admin Daily Flow</h3>
          <p className="text-sm text-gray-400">Your routine: review → operate → investigate → diagnose.</p>
        </header>
        <div className="grid gap-5 sm:grid-cols-2">
          {DAILY_FLOW_STEPS.map(({ step, when, title, desc, path, Icon, accent }) => (
            <Link
              key={path}
              to={path}
              className={`group relative block overflow-hidden rounded-2xl border bg-gradient-to-br ${accent} p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="inline-flex items-center justify-center h-11 w-11 rounded-xl bg-white/10 border border-white/10">
                  <Icon className="h-5 w-5" />
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/60">
                  Step {step}
                </span>
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-white/50 mb-1">
                {when}
              </div>
              <h4 className="text-lg font-bold text-white mb-1">{title}</h4>
              <p className="text-xs text-white/70 leading-relaxed">{desc}</p>
              <div className="mt-3 text-xs font-medium text-white/80 group-hover:text-white">
                Open →
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
