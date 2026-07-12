import type React from "react";
import { useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useSearchParams } from "react-router-dom";
import { Calculator, Crown, ExternalLink, Sparkles, Warehouse, Radio, ScanLine, Lock, Sun, ListChecks, Activity, Stethoscope } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useSubscription } from "@/hooks/use-subscription";
import { useInventoryHubTheme } from "@/hooks/use-inventoryhub-theme";
import NavbarThemed from "@/components/navbar/NavbarThemed";
import {
  visibleCategories,
  type ModuleBadge,
  type ModuleCategory,
  type ModuleItem,
} from "@/config/moduleCategories";

// Re-themed preview of ToolsHub.tsx for the "InventoryHub" light identity.
// Logic (visibleCategories/visibleModules, badge rules, locked/download/navigate
// variants, sticky quick-jump nav, mobile condensed cards) is untouched — only
// classNames changed, swapping hardcoded dark literals for semantic tokens so
// the .theme-inventoryhub wrapper re-skins everything automatically.
// Footer is intentionally omitted here (same call as /new) since that shared
// component is hardcoded-dark and would clash with the light page. Navbar is
// now a real, themed, functional NavbarThemed (Platform Modules menu, both
// alert bells, account menu) — see NavbarThemed.tsx.
// Add ?simulateLocked=1 to preview the subscription-expired card state without
// needing a real expired-subscription test account.

const BADGE_STYLES: Record<ModuleBadge, { label: string; cls: string; icon?: typeof Crown }> = {
  free: {
    label: "Free",
    cls: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  },
  subscribe: {
    label: "Subscribe",
    cls: "bg-amber-500/15 text-amber-700 border-amber-500/30",
    icon: Crown,
  },
  "admin-live": {
    label: "Admin · Live",
    cls: "bg-orange-500/15 text-orange-700 border-orange-500/30",
  },
  admin: {
    label: "Admin",
    cls: "bg-rose-500/15 text-rose-700 border-rose-500/30",
  },
  soon: {
    label: "Coming soon",
    cls: "bg-slate-500/15 text-slate-700 border-slate-500/30",
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
          ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/30"
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

// Modules that have a rebuilt /new/... page get their card routed there
// instead of the original /tools/... route from moduleCategories.ts (which
// stays untouched since the live dark ToolsHub also reads from it). Add one
// line here as each page gets its InventoryHub theme pass; everything not
// listed falls through to its original route automatically.
// Create Listing is intentionally excluded from this rollout going forward —
// see THEMED_HIDDEN_PATHS below — so it never gets an entry here either.
const THEMED_PATH_OVERRIDES: Record<string, string> = {
  "/tools/synced-inventory": "/new/inventory",
  "/tools/repricer": "/new/repricer",
};

// Modules retired from the InventoryHub theme rollout entirely — hidden here
// without touching moduleCategories.ts, since Create Listing still needs to
// exist there for the live dark ToolsHub/navbar. Superseded by the Create
// Listing browser extension, so it won't get a themed page going forward.
const THEMED_HIDDEN_PATHS = new Set<string>(["/tools/create-listing"]);

function resolveModulePath(path?: string): string | undefined {
  if (!path) return path;
  return THEMED_PATH_OVERRIDES[path] ?? path;
}

function filterHiddenModules(categories: ModuleCategory[]): ModuleCategory[] {
  return categories
    .map((c) => ({ ...c, modules: c.modules.filter((m) => !THEMED_HIDDEN_PATHS.has(m.path ?? "")) }))
    .filter((c) => c.modules.length > 0);
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
  const resolvedPath = resolveModulePath(tool.path);

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
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border bg-destructive/10 text-destructive border-destructive/30">
              <Lock className="h-3 w-3" />
              Locked
            </span>
          ) : !disabled ? (
            <div className="w-7 h-7 shrink-0" aria-hidden="true" />
          ) : null}
        </div>

        <div className="flex items-start gap-2 flex-wrap mb-2">
          <h3 className="font-semibold text-base text-foreground group-hover:text-primary transition-colors break-words min-w-0">
            {tool.label}
          </h3>
          <ModuleBadges badges={tool.badges} isAdmin={isAdmin} />
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed mb-4 line-clamp-3">{tool.description}</p>

        {!disabled ? (
          <div className={`flex items-center text-sm font-medium ${locked ? "text-destructive" : "text-primary"}`}>
            <span>{locked ? "🔒 Subscribe to unlock" : isDownload ? "↓ Download .zip" : "→ Open"}</span>
          </div>
        ) : null}
      </div>
    </>
  );

  const cardClasses = `group relative h-full overflow-hidden rounded-2xl border backdrop-blur-sm transition-all duration-300 ${
    disabled
      ? "border-border bg-muted/40 cursor-not-allowed opacity-60"
      : locked
      ? "border-destructive/20 bg-card hover:border-destructive/40 cursor-pointer"
      : "border-border bg-card hover:border-primary/30 hover:shadow-xl hover:shadow-primary/10 hover:-translate-y-1"
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
        to={resolvedPath}
        onClick={trackClick}
        className="block h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-2xl"
        aria-label={tool.label}
      >
        {InnerBody}
      </Link>
      {/* New-tab icon sits OUTSIDE the <Link> to avoid nested <a> and event-bubbling navigation */}
      <a
        href={resolvedPath}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="absolute top-6 right-6 z-10 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center w-7 h-7 rounded-lg bg-background/80 hover:bg-background text-muted-foreground hover:text-foreground border border-border"
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
              <h2 className="font-ih-display text-2xl font-bold text-foreground">
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
            <p className="text-sm text-muted-foreground">{category.tagline}</p>
          </div>
        </div>
        <span className="text-xs text-muted-foreground">
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
            source="tools_hub_themed"
            featured={featured}
            locked={locked}
          />
        ))}
      </div>
    </section>
  );
}

const ToolsHubThemed = () => {
  useInventoryHubTheme();
  const { isAdmin, isExpired } = useSubscription();
  const [searchParams] = useSearchParams();
  // Preview-only override so the locked/expired card state can be screenshotted
  // without a real expired-subscription account. Not present in ToolsHub.tsx.
  const simulateLocked = searchParams.get("simulateLocked") === "1";
  const categories = filterHiddenModules(visibleCategories(isAdmin));
  const locked = (isExpired && !isAdmin) || simulateLocked;

  // react-helmet-async only ADDS tags — it can't remove the static, globally
  // shared ArbiProSeller-branded og:*/twitter:*/author meta tags and JSON-LD
  // schema baked into index.html, so both would otherwise coexist in <head>.
  // Neutralize the static ones only while this route is mounted; restore them
  // on unmount so every other route keeps the real site's branding untouched.
  useEffect(() => {
    const overrides: Record<string, string> = {
      'meta[name="author"]': "InventoryHub",
      'meta[property="og:title"]': "Platform Modules — InventoryHub theme preview",
      'meta[property="og:description"]':
        "Categorized core modules to manage and scale your Amazon FBA business — inventory, finance, shipments, repricing, sourcing and more.",
      'meta[property="og:site_name"]': "InventoryHub",
      'meta[name="twitter:title"]': "Platform Modules — InventoryHub theme preview",
      'meta[name="twitter:description"]':
        "Categorized core modules to manage and scale your Amazon FBA business — inventory, finance, shipments, repricing, sourcing and more.",
    };
    const restoreMeta: Array<() => void> = [];
    for (const [selector, newValue] of Object.entries(overrides)) {
      document.querySelectorAll(selector).forEach((el) => {
        if (el.getAttribute("data-rh") === "true") return; // our own Helmet-managed tag
        const original = el.getAttribute("content");
        el.setAttribute("content", newValue);
        restoreMeta.push(() => {
          if (original !== null) el.setAttribute("content", original);
        });
      });
    }

    const jsonLdScript = document.querySelector('script[type="application/ld+json"]');
    const jsonLdParent = jsonLdScript?.parentNode ?? null;
    const jsonLdNext = jsonLdScript?.nextSibling ?? null;
    if (jsonLdScript && jsonLdParent) jsonLdParent.removeChild(jsonLdScript);

    return () => {
      restoreMeta.forEach((fn) => fn());
      if (jsonLdScript && jsonLdParent) jsonLdParent.insertBefore(jsonLdScript, jsonLdNext);
    };
  }, []);

  return (
    <div className="theme-inventoryhub font-ih-sans min-h-screen flex flex-col bg-gradient-to-b from-background to-[hsl(var(--background-gradient-end))] text-foreground relative overflow-hidden">
      <NavbarThemed isAdmin={isAdmin} />
      {/* Ambient glow (token-based, works in any theme) */}
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/10 rounded-full blur-[120px]" />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/10 rounded-full blur-[120px]" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />

      <Helmet>
        <title>Platform Modules — InventoryHub theme preview</title>
        <meta name="robots" content="noindex, nofollow" />
        <meta
          name="description"
          content="Categorized core modules to manage and scale your Amazon FBA business — inventory, finance, shipments, repricing, sourcing and more."
        />
        {/* Overrides for index.html's global (shared, ArbiProSeller-branded) social
            meta tags — react-helmet-async replaces these only while this route is
            active. The static JSON-LD schema block in index.html can't be overridden
            this way (it's plain markup, not Helmet-managed) — see chat for why. */}
        <meta name="author" content="InventoryHub" />
        <meta property="og:title" content="Platform Modules — InventoryHub theme preview" />
        <meta
          property="og:description"
          content="Categorized core modules to manage and scale your Amazon FBA business — inventory, finance, shipments, repricing, sourcing and more."
        />
        <meta property="og:site_name" content="InventoryHub" />
        <meta name="twitter:title" content="Platform Modules — InventoryHub theme preview" />
        <meta
          name="twitter:description"
          content="Categorized core modules to manage and scale your Amazon FBA business — inventory, finance, shipments, repricing, sourcing and more."
        />
      </Helmet>

      <main className="flex-grow pt-28 pb-16 relative z-10">
        <div className="container mx-auto px-4">
          {/* Hero (hidden on mobile to keep focus on Live Sales) */}
          <div className="hidden md:block text-center mb-12">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-primary/30 bg-primary/10 text-primary text-sm font-medium mb-6">
              <Warehouse className="h-4 w-4" />
              <span>Platform</span>
            </div>
            <h1 className="font-ih-display text-5xl md:text-6xl font-bold mb-6">
              <span className="text-primary">Modules</span>
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Source → Analyze → Buy → Ship → Track → Reprice → Profit. Every step, in one place.
            </p>
          </div>

          {/* Mobile-only: single Live Sales card */}
          <div className="md:hidden max-w-md mx-auto">
            <Link
              to="/m/live-sales"
              className="group relative block overflow-hidden rounded-2xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-6 shadow-lg shadow-emerald-500/10 active:scale-[0.99] transition-transform"
              aria-label="Open Live Sales"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-emerald-500/15 border border-emerald-400/30 text-emerald-600">
                  <Radio className="h-6 w-6" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="font-ih-display text-lg font-bold text-foreground">Live Sales</h2>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-700 border border-emerald-400/30">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      Live
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">Today's Amazon sales — per ASIN</p>
                </div>
              </div>
              <div className="text-sm text-emerald-700 font-medium">→ Open</div>
            </Link>

            {/* Mobile-only: Barcode Scanner card */}
            <Link
              to="/m/scan"
              className="group relative mt-4 block overflow-hidden rounded-2xl border border-blue-400/30 bg-gradient-to-br from-blue-500/10 via-blue-500/5 to-transparent p-6 shadow-lg shadow-blue-500/10 active:scale-[0.99] transition-transform"
              aria-label="Open Barcode Scanner"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-blue-500/15 border border-blue-400/30 text-blue-600">
                  <ScanLine className="h-6 w-6" />
                </div>
                <div className="flex-1">
                  <h2 className="font-ih-display text-lg font-bold text-foreground">Scan UPC</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Camera barcode → Amazon product</p>
                </div>
              </div>
              <div className="text-sm text-blue-700 font-medium">→ Open</div>
            </Link>

            {/* Mobile-only: Inventory Valuation card */}
            <Link
              to="/m/inventory-valuation"
              className="group relative mt-4 block overflow-hidden rounded-2xl border border-amber-400/30 bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent p-6 shadow-lg shadow-amber-500/10 active:scale-[0.99] transition-transform"
              aria-label="Open Inventory Valuation"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-amber-500/15 border border-amber-400/30 text-amber-600">
                  <Warehouse className="h-6 w-6" />
                </div>
                <div className="flex-1">
                  <h2 className="font-ih-display text-lg font-bold text-foreground">Inventory Valuation</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Live stock value, units & SKUs</p>
                </div>
              </div>
              <div className="text-sm text-amber-700 font-medium">→ Open</div>
            </Link>

            <p className="mt-4 text-center text-[11px] text-muted-foreground">
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
                    : "border-border bg-muted text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }`}
              >
                <span>{c.emoji}</span>
                <span>{c.label}</span>
              </a>
            ))}
          </nav>

          {/* Desktop: shortcut to the mobile-optimized Live Sales (small/compact view) */}
          <div className="hidden md:block max-w-7xl mx-auto mb-10">
            <Link
              to="/m/live-sales"
              className="group relative flex items-center gap-4 overflow-hidden rounded-2xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-5 shadow-lg shadow-emerald-500/10 transition-all hover:-translate-y-0.5 hover:shadow-xl"
              aria-label="Open Live Sales (mobile view)"
            >
              <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-emerald-500/15 border border-emerald-400/30 text-emerald-600 shrink-0">
                <Radio className="h-6 w-6" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="font-ih-display text-lg font-bold text-foreground">Live Sales — Mobile View</h2>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-700 border border-emerald-400/30">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Live
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Compact, mobile-optimized Today's sales view — great for a phone-sized window.
                </p>
              </div>
              <div className="text-sm text-emerald-700 font-medium shrink-0">Open →</div>
            </Link>
          </div>

          {/* Admin Daily Flow — quick access to the routine operating loop */}
          {isAdmin && (
            <section className="hidden md:block max-w-7xl mx-auto mb-12">
              <header className="mb-5 flex items-end justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-lg">
                    <Sun className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="font-ih-display text-2xl font-bold text-foreground">Admin Daily Flow</h2>
                    <p className="text-sm text-muted-foreground">Your routine: review → operate → investigate → diagnose.</p>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">Admin only</span>
              </header>
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    step: "1",
                    when: "Morning · 2–5 min",
                    title: "Executive Review",
                    desc: "Start the day with the high-level health snapshot.",
                    path: "/tools/executive",
                    Icon: Sun,
                    accent: "from-blue-500/10 to-indigo-500/5 border-blue-400/30 text-blue-600",
                  },
                  {
                    step: "2",
                    when: "Operational review",
                    title: "Operator Queue",
                    desc: "Approve, snooze, or escalate today's suggested actions.",
                    path: "/tools/repricer/operator-queue",
                    Icon: ListChecks,
                    accent: "from-emerald-500/10 to-emerald-500/5 border-emerald-400/30 text-emerald-600",
                  },
                  {
                    step: "3",
                    when: "Investigate behavior",
                    title: "Repricer Monitor",
                    desc: "Look into unusual pricing or strategy behavior.",
                    path: "/tools/repricer/monitor",
                    Icon: Activity,
                    accent: "from-violet-500/10 to-violet-500/5 border-violet-400/30 text-violet-600",
                  },
                  {
                    step: "4",
                    when: "Diagnose performance",
                    title: "Cron Diagnostics",
                    desc: "Inspect jobs, queues, and platform health.",
                    path: "/tools/cron-diagnostics",
                    Icon: Stethoscope,
                    accent: "from-amber-500/10 to-amber-500/5 border-amber-400/30 text-amber-600",
                  },
                ].map(({ step, when, title, desc, path, Icon, accent }) => (
                  <Link
                    key={path}
                    to={path}
                    className={`group relative block overflow-hidden rounded-2xl border bg-gradient-to-br ${accent} p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="inline-flex items-center justify-center h-11 w-11 rounded-xl bg-background/70 border border-border">
                        <Icon className="h-5 w-5" />
                      </div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Step {step}
                      </span>
                    </div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      {when}
                    </div>
                    <h3 className="text-lg font-bold text-foreground mb-1">{title}</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
                    <div className="mt-3 text-xs font-medium text-foreground/80 group-hover:text-foreground">
                      Open →
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Categorized sections (desktop / tablet only) */}
          <div className="hidden md:block max-w-7xl mx-auto space-y-12">
            {categories.map((c) => (
              <CategorySection key={c.id} category={c} isAdmin={isAdmin} locked={locked} />
            ))}
          </div>

          {/* Bottom CTA (desktop only) */}
          <div className="hidden md:block mt-16 text-center">
            <div className="inline-flex items-center gap-3 px-6 py-3 rounded-full bg-muted/60 border border-border text-muted-foreground text-sm">
              <Calculator className="h-5 w-5" />
              <span>More modules coming soon. Stay tuned!</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default ToolsHubThemed;
