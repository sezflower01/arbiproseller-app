import React from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Package, Sparkles, Zap, Library } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MODULE_CATEGORIES } from "@/config/moduleCategories";
import { slugify } from "@/config/moduleCopy";

/**
 * Public marketing mega-menu listing every module from the platform.
 * Each item links to /products/modules/:slug — a dynamic explainer page.
 */
export default function ProductsMegaMenu() {
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const close = () => setOpen(false);

  // For the public menu we show every module (don't filter admin-only),
  // because these are marketing pages — not gated tool routes.
  const categories = MODULE_CATEGORIES;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-9 rounded-full border border-primary/30 bg-primary/10 px-4 backdrop-blur-sm hover:bg-primary/20 hover:border-primary/50 transition-all duration-200 group"
        >
          <Package className="mr-1.5 h-3.5 w-3.5 text-primary group-hover:scale-110 transition-transform" />
          <span className="font-bold text-primary text-xs tracking-wide uppercase">
            Products
          </span>
          <ChevronDown className="ml-1.5 h-3 w-3 text-primary/60 group-hover:text-primary transition-colors" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={10}
        className="w-[min(96vw,1100px)] rounded-2xl border border-white/15 bg-[hsl(222,84%,4.9%)]/95 p-3 shadow-[0_30px_80px_-20px_hsl(var(--primary)/0.5)] backdrop-blur-2xl"
      >
        {/* Header */}
        <div className="mb-3 flex items-center justify-between gap-3 px-2 py-1.5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary/80">
              Inventory S.P.R.I.N.T. Platform
            </p>
            <p className="text-sm text-white/80">
              Every module — click any to see how it works
            </p>
          </div>
          <Sparkles className="h-4 w-4 text-primary" />
        </div>

        {/* Featured: AI Repricer + Product Library quick links */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <button
            type="button"
            onClick={() => {
              navigate("/products/ai-repricer");
              close();
            }}
            className="flex items-start gap-2.5 rounded-xl px-3 py-3 text-left bg-gradient-to-br from-primary/15 via-violet-500/10 to-fuchsia-500/5 ring-1 ring-primary/30 hover:ring-primary/60 transition"
          >
            <Zap className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">AI Repricer</p>
              <p className="text-[11px] text-white/60">Automated pricing engine</p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              navigate("/products/product-library");
              close();
            }}
            className="flex items-start gap-2.5 rounded-xl px-3 py-3 text-left bg-white/[0.04] ring-1 ring-white/10 hover:ring-primary/40 transition"
          >
            <Library className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">Product Library</p>
              <p className="text-[11px] text-white/60">Your Amazon product database</p>
            </div>
          </button>
        </div>

        <ScrollArea className="max-h-[70vh] pr-2">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {categories.map((c) => {
              const CIcon = c.icon;
              return (
                <div
                  key={c.id}
                  className={`rounded-xl p-3 ${
                    c.featured
                      ? "bg-gradient-to-br from-primary/10 via-violet-500/5 to-fuchsia-500/5 ring-1 ring-primary/30"
                      : "bg-white/[0.02] ring-1 ring-white/5"
                  }`}
                >
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <div
                      className={`inline-flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br ${c.accent} text-white`}
                    >
                      <CIcon className="h-3.5 w-3.5" />
                    </div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/90 truncate">
                      {c.emoji} {c.label}
                    </p>
                  </div>
                  <div className="space-y-0.5">
                    {c.modules.map((m) => {
                      const Icon = m.icon;
                      const slug = slugify(m.label);
                      return (
                        <button
                          key={m.label}
                          type="button"
                          onClick={() => {
                            navigate(`/products/modules/${slug}`);
                            close();
                          }}
                          className="w-full flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all hover:bg-white/5 hover:-translate-y-0.5 group"
                        >
                          <div
                            className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${m.color} text-white shadow-sm group-hover:scale-105 transition-transform`}
                          >
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-white truncate group-hover:text-primary transition-colors">
                              {m.label}
                            </p>
                            <p className="text-[11px] text-gray-400 line-clamp-1">
                              {m.description}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
