import React, { useEffect, useState } from "react";
import {
  BookOpen,
  Database,
  Link2,
  RotateCcw,
  Search,
  History,
  ExternalLink,
  AlertTriangle,
  TrendingUp,
  Calendar,
  PackageCheck,
  Lock,
  CheckCircle2,
  ArrowRight,
  ClipboardCopy,
  Zap,
  ShieldCheck,
  Package,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

const proofLabels = [
  "Proven Products",
  "Supplier Tracking",
  "Need Buy Again Alerts",
];

const needBuyAgainPreviewItems = [
  {
    title: "Funko Pop! Animation: Kpop Demon Hunters - Rumi Huntr/x Vinyl Figure Collectibles Bundled with Box Protector",
    asin: "B0G4B3117X",
    stock: "0 avail / 2 inbound / 41 reserved",
    sales: "87·7d 180·30d 180·90d",
    supplier: "funko.com",
    orderQty: 136,
  },
  {
    title: "Burts Bees Hand Cream Trio 1oz Lavender and Honey With Shea Butter, Wild Rose and Berry, Watermelon and Mint Unisex 3 Pc",
    asin: "B0B52QHYGW",
    stock: "0 avail / 0 inbound / 0 reserved",
    sales: "12·7d 75·30d 75·90d",
    supplier: "burtsbees.com",
    orderQty: 116,
  },
  {
    title: "POP TV: Stranger Things - Dustin Henderson (Season 5) Funko Vinyl Figure (Bundled with Compatible Box Protector Case), Multicolor, 3.75 inches",
    asin: "B0G54JL52W",
    stock: "17 avail / 16 inbound / 37 reserved",
    sales: "74·7d 102·30d 102·90d",
    supplier: "funko.com",
    orderQty: 77,
  },
  {
    title: 'Simpson Strong-Tie PSCL 3/4-R50-20-Gauge Panel Sheathing Clip for 3/4" Plywood 50ct',
    asin: "B0CKJNCZLY",
    stock: "9 avail / 0 inbound / 2 reserved",
    sales: "1·7d 60·30d 172·90d",
    supplier: "homedepot.com",
    orderQty: 67,
  },
  {
    title: "Cream Of The West Roasted Wheat (12x24 OZ)",
    asin: "B00JNR7928",
    stock: "0 avail / 0 inbound / 0 reserved",
    sales: "36·7d 52·30d 142·90d",
    supplier: "creamofthewest.com",
    orderQty: 58,
  },
  {
    title: "Yamaha Yamalube Fuel Stabilizer & Conditioner- 32 Ounce, #ACC-FSTAB-PL-32",
    asin: "B0CMJ83BVY",
    stock: "0 avail / 0 inbound / 0 reserved",
    sales: "0·7d 36·30d 36·90d",
    supplier: "yamahaonlineparts.com",
    orderQty: 58,
  },
  {
    title: "Tupperware Snack-Stor Large Container",
    asin: "B0CKGQZTHD",
    stock: "5 avail / 0 inbound / 2 reserved",
    sales: "17·7d 33·30d 33·90d",
    supplier: "tupperware.com",
    orderQty: 55,
  },
  {
    title: "Squishmallow Official Kellytoy Squishy Soft Plush 8 Inch, Cheshire The Cat",
    asin: "B0CFF4C9DC",
    stock: "0 avail / 0 inbound / 0 reserved",
    sales: "0·7d 28·30d 37·90d",
    supplier: "walmart.com",
    orderQty: 52,
  },
];

const subCards = [
  {
    badge: "01",
    icon: Database,
    accent: "from-violet-500/20 to-violet-500/5",
    iconBg: "bg-violet-500/15",
    iconColor: "text-violet-300",
    title: "Organize proven products",
    description:
      "Build a private database of winners. Every ASIN you've validated, organized and instantly searchable.",
    features: [
      { icon: Lock, text: "Private database of winning ASINs" },
      { icon: PackageCheck, text: "Aggregate duplicate buys into one clean product row" },
      { icon: History, text: "Full product history at your fingertips" },
      { icon: Search, text: "Instant search across your entire catalog" },
    ],
  },
  {
    badge: "02",
    icon: Link2,
    accent: "from-fuchsia-500/20 to-fuchsia-500/5",
    iconBg: "bg-fuchsia-500/15",
    iconColor: "text-fuchsia-300",
    title: "Supplier tracking",
    description:
      "Never lose a supplier again. Direct links, full cost history, and one-click access to where you bought it.",
    features: [
      { icon: Link2, text: "Direct supplier links saved per product" },
      { icon: Calendar, text: "Supplier history by cost and date" },
      { icon: ExternalLink, text: "One-click jump back to supplier site" },
      { icon: CheckCircle2, text: "Verified, organized, always available" },
    ],
  },
  {
    badge: "03",
    icon: RotateCcw,
    accent: "from-purple-500/20 to-purple-500/5",
    iconBg: "bg-purple-500/15",
    iconColor: "text-purple-300",
    title: "Reorder Workflow",
    subtitle: "Know what to reorder — before you run out.",
    description:
      "Track stock levels and sales velocity to get clear signals on when to restock.",
    features: [
      { icon: AlertTriangle, text: 'Press "Need Buy Again" to see exactly what to reorder — sorted by priority' },
      { icon: ClipboardCopy, text: "Quantities already calculated for each product" },
      { icon: Calendar, text: "Days of stock remaining" },
      { icon: PackageCheck, text: "See stock, supplier, and reorder data in one place" },
    ],
    supportingLine: "No spreadsheets. No guessing. Just a ready-to-use buying list.",
  },
  {
    badge: "04",
    icon: Package,
    accent: "from-sky-500/20 to-sky-500/5",
    iconBg: "bg-sky-500/15",
    iconColor: "text-sky-300",
    title: "Build your Amazon shipment plan in minutes",
    subtitle: "No spreadsheets. No extra tools.",
    description: "Search your synced inventory and we build your inbound plan instantly — no re-typing ASINs in Seller Central.",
    features: [
      { icon: ClipboardCopy, text: "1. Name your shipment & pick the marketplace" },
      { icon: Search, text: "2. Search your synced inventory for products to send" },
      { icon: ShieldCheck, text: "3. Set prep requirements (polybag, fragile, liquid…)" },
      { icon: Package, text: "4. We build your ready-to-ship inbound plan" },
      { icon: Zap, text: "5. Confirm box split, quantities, dimensions & weight directly in Seller Central" },
    ],
    supportingLine: "From product list → Amazon shipment in minutes. Box split, quantities, dimensions and weight are confirmed directly in Seller Central.",
  },
];

const ProductLibraryBanner = () => {
  const [showNeedBuyAgainPreview, setShowNeedBuyAgainPreview] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowNeedBuyAgainPreview(true), 1500);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <section className="relative overflow-hidden py-20 md:py-28">
      {/* Deep blue premium background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[hsl(225,55%,7%)] via-[hsl(235,50%,10%)] to-[hsl(245,55%,8%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_10%,hsl(250,80%,55%,0.18),transparent_55%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_85%_90%,hsl(220,80%,50%,0.15),transparent_55%)]" />

      {/* Subtle grid */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(230,70%,60%) 1px, transparent 1px), linear-gradient(90deg, hsl(230,70%,60%) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="container mx-auto px-4 relative z-10">
        {/* Header */}
        <div className="max-w-4xl mx-auto text-center space-y-6 mb-14">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-500/15 border border-violet-400/25 text-violet-300 text-sm font-medium backdrop-blur-sm">
            <BookOpen className="w-4 h-4" />
            Product Library — Your Operations System
          </div>

          <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-[1.05]">
            Product Library — Your private database of{" "}
            <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-indigo-300 bg-clip-text text-transparent">
              proven Amazon products
            </span>
          </h2>

          <p className="text-lg md:text-xl text-white/70 max-w-3xl mx-auto leading-relaxed">
            Store winning ASINs, track suppliers, build action-ready buying lists, and know what to buy again
            before you run out.
          </p>

          {/* Proof labels */}
          <div className="flex flex-wrap justify-center gap-2 pt-4">
            {proofLabels.map((label) => (
              <span
                key={label}
                className="px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs font-medium text-white/80 backdrop-blur-sm"
              >
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Sub-cards grid */}
        <div className="grid md:grid-cols-2 gap-5 lg:gap-6 max-w-6xl mx-auto">
          {subCards.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.badge}
                className="group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025] backdrop-blur-sm p-7 md:p-8 hover:border-white/[0.18] hover:bg-white/[0.04] transition-all duration-300"
              >
                {/* Card glow */}
                <div
                  className={`absolute -top-20 -right-20 w-64 h-64 rounded-full bg-gradient-to-br ${card.accent} blur-3xl opacity-60 group-hover:opacity-100 transition-opacity`}
                />

                <div className="relative z-10 space-y-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className={`p-3 rounded-xl ${card.iconBg} border border-white/[0.06]`}>
                      <Icon className={`w-6 h-6 ${card.iconColor}`} />
                    </div>
                    <span className="text-xs font-mono text-white/30 tracking-widest">
                      {card.badge}
                    </span>
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-xl md:text-2xl font-bold text-white tracking-tight">
                      {card.title}
                    </h3>
                    {card.subtitle && (
                      <p className="text-base font-medium text-white/90">
                        {card.subtitle}
                      </p>
                    )}
                    <p className="text-sm md:text-base text-white/65 leading-relaxed">
                      {card.description}
                    </p>
                  </div>

                  {card.badge === "03" ? (
                    <div className="pt-2">
                      {!showNeedBuyAgainPreview ? (
                        <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-5 text-white/80">
                          <div className="flex items-center gap-3 text-sm font-medium">
                            <div className="h-4 w-4 rounded-full border-2 border-white/30 border-t-orange-400 animate-spin" />
                            <span>Calculating replenishment...</span>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3 md:p-4">
                          <div className="space-y-3 max-h-[560px] overflow-y-auto pr-1">
                            {needBuyAgainPreviewItems.map((item) => (
                              <div
                                key={item.asin}
                                className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold text-white leading-snug">
                                      {item.title}
                                    </p>
                                    <p className="mt-1 text-xs font-mono text-white/55">{item.asin}</p>
                                    <p className="mt-2 text-xs text-white/70">Stock: {item.stock}</p>
                                    <p className="text-xs text-white/70">Sales: {item.sales}</p>
                                    <p className="text-xs text-white/70">Supplier: {item.supplier}</p>
                                  </div>
                                  <div className="w-20 shrink-0 text-right">
                                    <div className="text-2xl font-bold text-white leading-none">
                                      {item.orderQty}
                                    </div>
                                    <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-orange-300/80">
                                      to order
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                  <ul className="space-y-2.5 pt-2">
                    {card.features.map((feature, idx) => {
                      const FIcon = feature.icon;
                      return (
                        <li key={idx} className="flex items-start gap-3">
                          <div className={`mt-0.5 p-1 rounded-md ${card.iconBg} shrink-0`}>
                            <FIcon className={`w-3.5 h-3.5 ${card.iconColor}`} />
                          </div>
                          <span className="text-sm text-white/80 leading-relaxed">
                            {feature.text}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  )}

                  {card.supportingLine && (
                    <p className="text-sm text-white/60 italic pt-2 border-t border-white/10 mt-4">
                      {card.supportingLine}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* CTAs */}
        <div className="mt-14 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Button
            asChild
            size="lg"
            className="bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-400 hover:to-fuchsia-400 text-white border-0 shadow-lg shadow-violet-500/30 px-8 h-12 text-base font-semibold"
          >
            <Link to="/signup">
              Start building your product library
              <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
};

export default ProductLibraryBanner;
