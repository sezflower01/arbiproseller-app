import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, ExternalLink, LayoutGrid, Sparkles, Flame, ArrowRight, RotateCcw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  visibleCategories,
  type ModuleCategory,
  type ModuleItem,
} from "@/config/moduleCategories";
import {
  getTopUsed,
  recordUsage,
  subscribeUsage,
  clearUsage,
  hydrateUsageFromServer,
} from "@/lib/moduleUsageTracker";
import { supabase } from "@/integrations/supabase/client";

// Light "InventoryHub" re-theme of PlatformModulesMenu.tsx — identical logic
// (category filtering, most-used tracking, GA events), only classNames changed
// from hardcoded dark literals to semantic tokens.

interface PlatformModulesMenuThemedProps {
  isAdmin: boolean;
}

function ModuleRow({ tool, onNavigate }: { tool: ModuleItem; onNavigate: () => void }) {
  const Icon = tool.icon;
  const disabled = !tool.path;

  const trackClick = () => {
    if (window.gtag && tool.ga) {
      window.gtag("event", "tool_used", { tool_name: tool.label, source: "navbar_mega" });
    }
    if (tool.path) recordUsage(tool.path, tool.label);
    onNavigate();
  };

  if (disabled || !tool.path) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 opacity-50 cursor-not-allowed">
        <div
          className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${tool.color} text-white shadow-sm`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground/80 truncate">
            {tool.label}
            <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
              · soon
            </span>
          </p>
          <p className="text-[11px] text-muted-foreground line-clamp-1">{tool.description}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative">
      <Link
        to={tool.path}
        onClick={trackClick}
        className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-all hover:bg-accent hover:-translate-y-0.5"
      >
        <div
          className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${tool.color} text-white shadow-sm group-hover:scale-105 transition-transform`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
            {tool.label}
          </p>
          <p className="text-[11px] text-muted-foreground line-clamp-1">{tool.description}</p>
        </div>
      </Link>
      <a
        href={tool.path}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent hover:bg-accent/70 text-muted-foreground hover:text-foreground"
        title="Open in new tab"
        aria-label={`Open ${tool.label} in new tab`}
      >
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

function MostUsedPopover({
  modulesByPath,
  onNavigate,
}: {
  modulesByPath: Map<string, ModuleItem>;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeUsage(() => setTick((t) => t + 1)), []);

  const top = useMemo(() => {
    // Pull a generous list; render all tracked items, falling back gracefully
    // when a stored path no longer maps to a registered module (renamed/removed).
    return getTopUsed(50)
      .map((u) => ({ ...u, mod: modulesByPath.get(u.path) }))
      .filter((x) => !!x.path);
  }, [tick, modulesByPath, open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all hover:bg-accent hover:-translate-y-0.5 group"
        >
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-600 text-white shadow-sm group-hover:scale-105 transition-transform">
            <Flame className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
              Most Used
            </p>
            <p className="text-[11px] text-muted-foreground line-clamp-1">
              Your top modules &amp; tools, sorted by activity.
            </p>
          </div>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={12}
        className="w-80 rounded-xl border border-border bg-popover/95 p-2 shadow-2xl shadow-primary/10 backdrop-blur-xl"
      >
        <div className="flex items-center justify-between px-2 py-1.5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-orange-600">
              🔥 Most Used
            </p>
            <p className="text-[11px] text-muted-foreground">Click to jump straight in</p>
          </div>
          {top.length > 0 && (
            <button
              type="button"
              onClick={() => clearUsage()}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent"
              title="Reset usage history"
            >
              <RotateCcw className="h-3 w-3" /> reset
            </button>
          )}
        </div>
        <div className="max-h-[60vh] overflow-y-auto space-y-0.5">
          {top.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No usage yet. Open any module from this menu — it will start tracking automatically.
            </div>
          ) : (
            top.map(({ path, mod, count, label }) => {
              const Icon = mod?.icon;
              const targetPath = mod?.path || path;
              const displayLabel = mod?.label || label || path;
              const colorClass = mod?.color || "from-slate-500 to-slate-700";
              return (
                <Link
                  key={path}
                  to={targetPath}
                  onClick={() => {
                    recordUsage(targetPath, displayLabel);
                    setOpen(false);
                    onNavigate();
                  }}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-accent group/row"
                >
                  <div
                    className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br ${colorClass} text-white shadow-sm`}
                  >
                    {Icon ? <Icon className="h-3.5 w-3.5" /> : <Flame className="h-3.5 w-3.5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate group-hover/row:text-primary transition-colors">
                      {displayLabel}
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate">{targetPath}</p>
                  </div>
                  <span className="text-[10px] font-bold text-orange-600 tabular-nums">
                    {count}×
                  </span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground group-hover/row:text-foreground transition-colors" />
                </Link>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CategoryColumn({
  category,
  onNavigate,
  modulesByPath,
}: {
  category: ModuleCategory;
  onNavigate: () => void;
  modulesByPath: Map<string, ModuleItem>;
}) {
  const Icon = category.icon;
  return (
    <div
      className={`rounded-xl p-3 ${
        category.featured
          ? "bg-gradient-to-br from-primary/10 via-violet-500/5 to-fuchsia-500/5 ring-1 ring-primary/30"
          : "bg-muted/40 ring-1 ring-border"
      }`}
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <div
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br ${category.accent} text-white`}
        >
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-foreground truncate">
            {category.emoji} {category.label}
          </p>
        </div>
        {category.featured ? (
          <Sparkles className="h-3 w-3 text-primary ml-auto" />
        ) : null}
      </div>
      <div className="space-y-0.5">
        {category.modules.map((m) => (
          <ModuleRow key={`${category.id}:${m.label}`} tool={m} onNavigate={onNavigate} />
        ))}
        {category.id === "dashboard" && (
          <MostUsedPopover modulesByPath={modulesByPath} onNavigate={onNavigate} />
        )}
      </div>
    </div>
  );
}

export default function PlatformModulesMenuThemed({ isAdmin }: PlatformModulesMenuThemedProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const categories = visibleCategories(isAdmin);
  const close = () => setOpen(false);

  // Pull cross-device usage on mount + whenever the user signs in.
  useEffect(() => {
    void hydrateUsageFromServer();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        void hydrateUsageFromServer();
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const modulesByPath = useMemo(() => {
    const map = new Map<string, ModuleItem>();
    for (const c of categories) {
      for (const m of c.modules) {
        if (m.path) map.set(m.path, m);
      }
    }
    return map;
  }, [categories]);


  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="group h-10 rounded-xl border border-border bg-card px-4 backdrop-blur-xl shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:bg-accent hover:border-primary/40"
          onClick={() => {
            if (window.gtag) {
              window.gtag("event", "tool_used", {
                tool_name: "platform_modules",
                source: "navbar",
              });
            }
          }}
        >
          <LayoutGrid className="mr-2 h-4 w-4 text-primary transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3" />
          <span className="font-semibold text-foreground text-xs tracking-wide">Platform Modules</span>
          <ChevronDown className="ml-1.5 h-3 w-3 text-muted-foreground group-hover:text-foreground transition-colors" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={10}
        className="w-[min(96vw,1100px)] rounded-2xl border border-border bg-popover/95 p-3 shadow-2xl shadow-primary/10 backdrop-blur-2xl"
      >
        {/* Header */}
        <div className="mb-3 flex items-center justify-between gap-3 px-2 py-1.5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary/80">
              InventoryHub Platform
            </p>
            <p className="text-sm text-muted-foreground">Source → Buy → Ship → Reprice → Profit</p>
          </div>
          <button
            type="button"
            onClick={() => {
              navigate("/new/tools");
              close();
            }}
            className="text-xs font-medium text-primary hover:text-primary/80 underline-offset-4 hover:underline"
          >
            View all →
          </button>
        </div>

        <ScrollArea className="max-h-[70vh] pr-2">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {categories.map((c) => (
              <CategoryColumn key={c.id} category={c} onNavigate={close} modulesByPath={modulesByPath} />
            ))}
          </div>
        </ScrollArea>

        <p className="mt-2 px-2 text-[10px] text-muted-foreground">
          Tip: Hover any module and click the <ExternalLink className="inline h-2.5 w-2.5" /> icon
          to open it in a new tab.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
