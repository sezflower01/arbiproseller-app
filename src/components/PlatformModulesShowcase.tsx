
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { visibleCategories, type ModuleCategory, type ModuleItem } from "@/config/moduleCategories";
import { getModuleCopy, slugify, MODULE_COPY } from "@/config/moduleCopy";

function ModuleCard({ module }: { module: ModuleItem }) {
  const Icon = module.icon;

  // Prefer the richer marketing "hero" copy from moduleCopy.ts when a module has an override;
  // falls back to the terser moduleCategories.ts description otherwise.
  const { hero } = getModuleCopy(module.label, module.description);

  // Only modules with a real MODULE_COPY entry have an actual public explainer page worth
  // sending marketing traffic to — everything else falls back to generic filler copy there.
  const slug = slugify(module.label);
  const hasExplainer = slug in MODULE_COPY;

  return (
    <div className="relative h-full rounded-2xl border border-border bg-card shadow-sm backdrop-blur-sm p-6 transition-all duration-300 hover:border-primary/20">
      <div
        className={`inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br ${module.color} text-white mb-4 shadow-lg`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <h4 className="font-semibold text-lg text-card-foreground mb-2">
        {hasExplainer ? (
          <Link
            to={`/products/modules/${slug}`}
            className="underline decoration-dotted decoration-muted-foreground/40 underline-offset-4 hover:text-primary hover:decoration-primary hover:decoration-solid transition-colors"
          >
            {module.label}
          </Link>
        ) : (
          module.label
        )}
      </h4>
      <p className="text-sm text-muted-foreground leading-relaxed">{hero}</p>
    </div>
  );
}

function CategoryGroup({ category }: { category: ModuleCategory }) {
  const Icon = category.icon;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div
          className={`inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${category.accent} text-white shadow-lg shrink-0`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-xl font-bold text-foreground">
              <span className="mr-1.5">{category.emoji}</span>
              {category.label}
            </h3>
            {category.featured && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-primary/20 text-primary border border-primary/30">
                <Sparkles className="h-3 w-3" />
                Featured
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{category.tagline}</p>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
        {category.modules.map((mod) => (
          <ModuleCard key={mod.label} module={mod} />
        ))}
      </div>
    </div>
  );
}

// Seller-workflow narrative for this showcase specifically: get oriented → manage
// stock → find products to sell → price them intelligently → track profit → ship
// orders. Scoped to this component only — moduleCategories.ts's declaration order
// stays untouched since it also drives ToolsHub and the navbar mega-menu.
const CATEGORY_ORDER = ["dashboard", "inventory", "sourcing", "repricing", "finance", "logistics"];

// Modules retired from the InventoryHub theme rollout entirely — hidden here
// without touching moduleCategories.ts, since Create Listing still needs to
// exist there for the live dark ToolsHub/navbar. Superseded by the Create
// Listing browser extension, so it won't get a themed page going forward.
const THEMED_HIDDEN_PATHS = new Set<string>(["/tools/create-listing"]);

const PlatformModulesShowcase = () => {
  const categories = [...visibleCategories(false)]
    .map((c) => ({ ...c, modules: c.modules.filter((m) => !THEMED_HIDDEN_PATHS.has(m.path ?? "")) }))
    .filter((c) => c.modules.length > 0)
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.id) - CATEGORY_ORDER.indexOf(b.id));

  return (
    <section className="relative py-24 overflow-hidden bg-background">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-primary/5 rounded-full blur-[150px]" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16 max-w-2xl mx-auto">
          <p className="text-xs uppercase tracking-[0.25em] text-primary font-semibold mb-3">Everything Included</p>
          <h2 className="font-ih-display text-3xl md:text-4xl lg:text-5xl font-bold text-foreground mb-4">
            One Platform. Every Tool You Need.
          </h2>
          <p className="text-lg text-muted-foreground">
            The repricer is just the beginning. Every module below is included with your subscription — no add-ons,
            no hidden fees.
          </p>
        </div>

        <div className="max-w-7xl mx-auto space-y-14">
          {categories.map((category) => (
            <CategoryGroup key={category.id} category={category} />
          ))}
        </div>

        <div className="mt-16 text-center">
          <p className="text-sm text-muted-foreground">
            All modules are available on every plan. Start your free trial to unlock the full platform.
          </p>
        </div>
      </div>
    </section>
  );
};

export default PlatformModulesShowcase;
