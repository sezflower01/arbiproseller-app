import type React from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { Calculator, Crown, ExternalLink, Sparkles, Warehouse, Radio, ScanLine, Lock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { useSubscription } from "@/hooks/use-subscription";
import {
  visibleCategories,
  type ModuleBadge,
  type ModuleCategory,
  type ModuleItem,
} from "@/config/moduleCategories";

const BADGE_STYLES: Record<ModuleBadge, { label: string; cls: string; icon?: typeof Crown }> = {
  free: {
    label: "Free",
    cls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  },
  subscribe: {
    label: "Subscribe",
    cls: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    icon: Crown,
  },
  "admin-live": {
    label: "Admin · Live",
    cls: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  },
  admin: {
    label: "Admin",
    cls: "bg-rose-500/20 text-rose-300 border-rose-500/30",
  },
  soon: {
    label: "Coming soon",
    cls: "bg-slate-500/20 text-slate-300 border-slate-500/30",
  },
};

function ModuleBadges({ badges, isAdmin }: { badges?: ModuleBadge[]; isAdmin: boolean }) {
  if (!badges?.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {badges.map((b) => {
        // Show "Subscribed" instead of "Subscribe" for admins
        const isSub = b === "subscribe" && isAdmin;
        const meta = BADGE_STYLES[b];
        const Icon = meta.icon;
        const label = isSub ? "Subscribed" : meta.label;
        const cls = isSub
          ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
          : meta.cls;
        return (
          <span
            key={b}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${cls}`}
          >
            {Icon ? <Icon className="h-3 w-3" /> : null}
            {label}
          </span>
        );
      })}
    </span>
  );
}

function ModuleCard({
  tool,
  isAdmin,
  source,
  featured,
  locked,
}: {
  tool: ModuleItem;
  isAdmin: boolean;
  source: string;
  featured?: boolean;
  locked?: boolean;
}) {
  const Icon = tool.icon;
  const navigate = useNavigate();
  const isDownload = !!tool.downloadUrl;
  const disabled = !tool.path && !isDownload;

  const trackClick = () => {
    if (window.gtag && tool.ga) {
      window.gtag("event", "tool_used", { tool_name: tool.label, source });
    }
  };

  const handleDownload = async (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    trackClick();
    try {
      const res = await fetch(tool.downloadUrl!);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = tool.downloadFilename || "download.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast.success(`Downloading ${tool.downloadFilename}…`);
    } catch (err: any) {
      toast.error(`Download failed: ${err.message || err}`);
    }
  };

  const InnerBody = (
    <>
      <div
        className={`absolute inset-0 bg-gradient-to-br ${tool.color} opacity-0 group-hover:opacity-5 transition-opacity duration-300 pointer-events-none`}
      />
      <div className="relative p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div
            className={`inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${tool.color} text-white shadow-lg group-hover:scale-110 transition-transform duration-300`}
          >
            <Icon className="h-6 w-6" />
          </div>
          {locked ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border bg-red-500/20 text-red-300 border-red-500/30">
              <Lock className="h-3 w-3" />
              Locked
            </span>
          ) : !disabled ? (
            <div className="w-7 h-7 shrink-0" aria-hidden="true" />
          ) : null}
        </div>

        <div className="flex items-start gap-2 flex-wrap mb-2">
          <h3 className="font-semibold text-base text-white group-hover:text-primary transition-colors break-words min-w-0">
            {tool.label}
          </h3>
          <ModuleBadges badges={tool.badges} isAdmin={isAdmin} />
        </div>

        <p className="text-sm text-gray-400 leading-relaxed mb-4 line-clamp-3">{tool.description}</p>

        {!disabled ? (
          <div className={`flex items-center text-sm font-medium ${locked ? "text-red-300" : "text-primary"}`}>
            <span>{locked ? "🔒 Subscribe to unlock" : isDownload ? "↓ Download .zip" : "→ Open"}</span>
          </div>
        ) : null}
      </div>
    </>
  );

  const cardClasses = `group relative h-full overflow-hidden rounded-2xl border backdrop-blur-sm transition-all duration-300 ${
    disabled
      ? "border-white/5 bg-white/[0.02] cursor-not-allowed opacity-60"
      : locked
      ? "border-red-500/20 bg-white/[0.03] hover:border-red-500/40 cursor-pointer"
      : "border-white/10 bg-white/[0.03] hover:border-primary/30 hover:shadow-xl hover:shadow-primary/10 hover:-translate-y-1"
  } ${featured ? "ring-1 ring-primary/20" : ""}`;

  if (disabled) {
    return <div className={cardClasses}>{InnerBody}</div>;
  }

  if (isDownload && !locked) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={handleDownload}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleDownload(e); }}
        className={cardClasses}
        aria-label={`Download ${tool.label}`}
      >
        {InnerBody}
      </div>
    );
  }

  if (locked) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          toast.error("Your subscription has expired. Subscribe to unlock this module.");
          navigate("/subscriptions");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            toast.error("Your subscription has expired. Subscribe to unlock this module.");
            navigate("/subscriptions");
          }
        }}
        className={cardClasses}
        aria-label={`${tool.label} (locked)`}
      >
        {InnerBody}
      </div>
    );
  }

  return (
    <div className={cardClasses}>
      <Link
        to={tool.path}
        onClick={trackClick}
        className="block h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-2xl"
        aria-label={tool.label}
      >
        {InnerBody}
      </Link>
      {/* New-tab icon sits OUTSIDE the <Link> to avoid nested <a> and event-bubbling navigation */}
      <a
        href={tool.path}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="absolute top-6 right-6 z-10 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center w-7 h-7 rounded-lg bg-white/10 hover:bg-white/20 text-white/80 hover:text-white border border-white/10"
        title="Open in new tab"
        aria-label={`Open ${tool.label} in new tab`}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

function CategorySection({ category, isAdmin, locked }: { category: ModuleCategory; isAdmin: boolean; locked: boolean }) {
  const Icon = category.icon;
  const featured = category.featured;

  return (
    <section
      id={`category-${category.id}`}
      className={`scroll-mt-28 ${
        featured
          ? "rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/[0.06] via-violet-500/[0.04] to-fuchsia-500/[0.04] p-6 md:p-8 shadow-[0_12px_40px_-20px_hsl(var(--primary)/0.3)]"
          : ""
      }`}
    >
      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div
            className={`inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br ${category.accent} text-white shadow-lg`}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold text-white">
                <span className="mr-2">{category.emoji}</span>
                {category.label}
              </h2>
              {featured ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-primary/20 text-primary border border-primary/30">
                  <Sparkles className="h-3 w-3" />
                  Featured
                </span>
              ) : null}
            </div>
            <p className="text-sm text-gray-400">{category.tagline}</p>
          </div>
        </div>
        <span className="text-xs text-gray-500">
          {category.modules.length} module{category.modules.length === 1 ? "" : "s"}
        </span>
      </header>

      <div
        className={`grid gap-5 ${
          featured
            ? "sm:grid-cols-2 lg:grid-cols-3"
            : "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        }`}
      >
        {category.modules.map((tool) => (
          <ModuleCard
            key={`${category.id}:${tool.label}`}
            tool={tool}
            isAdmin={isAdmin}
            source="tools_hub"
            featured={featured}
            locked={locked}
          />
        ))}
      </div>
    </section>
  );
}

const ToolsHub = () => {
  const { isAdmin, isExpired } = useSubscription();
  // "dashboard" (Overview) moved to Account Settings > Admin Only — hidden here for everyone.
  const categories = visibleCategories(isAdmin).filter((c) => c.id !== "dashboard");
  const locked = isExpired && !isAdmin;

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] relative overflow-hidden">
      {/* Animated gradient orbs */}
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse" />
      <div
        className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse"
        style={{ animationDelay: "1s" }}
      />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <Helmet>
        <title>ArbiProSeller Platform Modules</title>
        <meta
          name="description"
          content="Categorized core modules to manage and scale your Amazon FBA business — inventory, finance, shipments, repricing, sourcing and more."
        />
      </Helmet>

      <Navbar />

      <main className="flex-grow pt-28 pb-16 relative z-10">
        <div className="container mx-auto px-4">
          {/* Hero (hidden on mobile to keep focus on Live Sales) */}
          <div className="hidden md:block text-center mb-12">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-primary/30 bg-primary/10 text-primary text-sm font-medium mb-6">
              <Warehouse className="h-4 w-4" />
              <span>Inventory S.P.R.I.N.T. Platform</span>
            </div>
            <h1 className="text-5xl md:text-6xl font-bold mb-6">
              <span className="text-white">Inventory S.P.R.I.N.T. </span>
              <span className="bg-gradient-to-r from-primary via-blue-400 to-purple-400 bg-clip-text text-transparent">
                Platform Modules
              </span>
            </h1>
            <p className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
              Source → Analyze → Buy → Ship → Track → Reprice → Profit. Every step, in one place.
            </p>
          </div>

          {/* Mobile-only: single Live Sales card */}
          <div className="md:hidden max-w-md mx-auto">
            <Link
              to="/m/live-sales"
              className="group relative block overflow-hidden rounded-2xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/15 via-emerald-500/5 to-transparent p-6 shadow-lg shadow-emerald-500/10 active:scale-[0.99] transition-transform"
              aria-label="Open Live Sales"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-emerald-500/20 border border-emerald-400/30 text-emerald-300">
                  <Radio className="h-6 w-6" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold text-white">Live Sales</h2>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Live
                    </span>
                  </div>
                  <p className="text-xs text-white/60 mt-0.5">Today's Amazon sales — per ASIN</p>
                </div>
              </div>
              <div className="text-sm text-emerald-300 font-medium">→ Open</div>
            </Link>

            {/* Mobile-only: Barcode Scanner card */}
            <Link
              to="/m/scan"
              className="group relative mt-4 block overflow-hidden rounded-2xl border border-blue-400/30 bg-gradient-to-br from-blue-500/15 via-blue-500/5 to-transparent p-6 shadow-lg shadow-blue-500/10 active:scale-[0.99] transition-transform"
              aria-label="Open Barcode Scanner"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-blue-500/20 border border-blue-400/30 text-blue-300">
                  <ScanLine className="h-6 w-6" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-bold text-white">Scan UPC</h2>
                  <p className="text-xs text-white/60 mt-0.5">Camera barcode → Amazon product</p>
                </div>
              </div>
              <div className="text-sm text-blue-300 font-medium">→ Open</div>
            </Link>

            {/* Mobile-only: Inventory Valuation card */}
            <Link
              to="/m/inventory-valuation"
              className="group relative mt-4 block overflow-hidden rounded-2xl border border-amber-400/30 bg-gradient-to-br from-amber-500/15 via-amber-500/5 to-transparent p-6 shadow-lg shadow-amber-500/10 active:scale-[0.99] transition-transform"
              aria-label="Open Inventory Valuation"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-amber-500/20 border border-amber-400/30 text-amber-300">
                  <Warehouse className="h-6 w-6" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-bold text-white">Inventory Valuation</h2>
                  <p className="text-xs text-white/60 mt-0.5">Live stock value, units & SKUs</p>
                </div>
              </div>
              <div className="text-sm text-amber-300 font-medium">→ Open</div>
            </Link>

            <p className="mt-4 text-center text-[11px] text-white/40">
              Other modules are available on desktop.
            </p>
          </div>

          {/* Category quick-jump (desktop / tablet only) */}
          <nav className="hidden md:flex mb-12 flex-wrap items-center justify-center gap-2">
            {categories.map((c) => (
              <a
                key={c.id}
                href={`#category-${c.id}`}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-all ${
                  c.featured
                    ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
                    : "border-white/10 bg-white/5 text-gray-300 hover:border-primary/30 hover:text-white"
                }`}
              >
                <span>{c.emoji}</span>
                <span>{c.label}</span>
              </a>
            ))}
          </nav>

          {/* Categorized sections (desktop / tablet only) */}
          <div className="hidden md:block max-w-7xl mx-auto space-y-12">
            {categories.map((c) => (
              <CategorySection key={c.id} category={c} isAdmin={isAdmin} locked={locked} />
            ))}
          </div>

          {/* Bottom CTA (desktop only) */}
          <div className="hidden md:block mt-16 text-center">
            <div className="inline-flex items-center gap-3 px-6 py-3 rounded-full bg-white/[0.05] border border-white/10 text-gray-400 text-sm">
              <Calculator className="h-5 w-5" />
              <span>More modules coming soon. Stay tuned!</span>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default ToolsHub;
