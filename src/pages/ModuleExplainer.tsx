import React, { useMemo } from "react";
import { Helmet } from "react-helmet-async";
import { useNavigate, useParams, Link } from "react-router-dom";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, CheckCircle2, Sparkles, Users, Workflow, ExternalLink, ChevronRight } from "lucide-react";
import { MODULE_CATEGORIES, type ModuleItem, type ModuleCategory } from "@/config/moduleCategories";
import { getModuleCopy, slugify } from "@/config/moduleCopy";
import RequireAuthLink from "@/components/RequireAuthLink";
import { cn } from "@/lib/utils";

type Found = { module: ModuleItem; category: ModuleCategory } | null;

function findBySlug(slug: string): Found {
  for (const c of MODULE_CATEGORIES) {
    for (const m of c.modules) {
      if (slugify(m.label) === slug) return { module: m, category: c };
    }
  }
  return null;
}

const ModuleExplainer: React.FC = () => {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const found = useMemo(() => findBySlug(slug), [slug]);

  if (!found) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-[hsl(222,84%,4.9%)] flex items-center justify-center px-4">
          <div className="text-center">
            <h1 className="text-3xl font-bold text-white mb-4">Module not found</h1>
            <Button onClick={() => navigate("/")}>Back to home</Button>
          </div>
        </div>
        <Footer />
      </>
    );
  }

  const { module, category } = found;
  const Icon = module.icon;
  const copy = getModuleCopy(module.label, module.description);

  // Sibling modules (same category) for "explore more"
  const siblings = category.modules.filter((m) => m.label !== module.label).slice(0, 6);

  return (
    <>
      <Helmet>
        <title>{module.label} — ArbiProSeller</title>
        <meta name="description" content={copy.tagline} />
        <link rel="canonical" href={`https://arbiproseller.com/products/modules/${slug}`} />
      </Helmet>
      <Navbar />

      <main className="min-h-screen bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,8%)] to-[hsl(260,50%,7%)]">
        {/* Hero */}
        <section className="relative overflow-hidden pt-28 pb-16 md:pt-36 md:pb-24">
          <div className="absolute -top-32 -left-24 w-96 h-96 bg-primary/20 rounded-full blur-[140px]" />
          <div className="absolute -bottom-32 -right-24 w-96 h-96 bg-violet-500/20 rounded-full blur-[140px]" />
          <div className="container mx-auto px-4 relative z-10">
            <div className="flex items-center gap-2 text-xs text-white/60 mb-6">
              <Link to="/" className="hover:text-primary">Home</Link>
              <ChevronRight className="w-3 h-3" />
              <RequireAuthLink to="/tools" className="hover:text-primary">Modules</RequireAuthLink>
              <ChevronRight className="w-3 h-3" />
              <span className="text-white/80">{category.label}</span>
            </div>

            <div className="grid lg:grid-cols-[1fr,auto] gap-8 items-start">
              <div>
                <Badge className={`mb-4 bg-gradient-to-r ${category.accent} text-white border-0`}>
                  {category.emoji} {category.label}
                </Badge>
                <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight mb-4">
                  {module.label}
                </h1>
                <p className="text-xl md:text-2xl text-primary/90 font-medium mb-5">
                  {copy.tagline}
                </p>
                <p className="text-base md:text-lg text-white/70 max-w-3xl leading-relaxed">
                  {copy.hero}
                </p>

                <div className="mt-8 flex flex-wrap gap-3">
                  <Button
                    size="lg"
                    onClick={() => navigate("/signup")}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
                  >
                    Start your 60-day free trial
                    <ArrowRight className="ml-2 w-4 h-4" />
                  </Button>
                  {module.path && (
                    <RequireAuthLink
                      to={module.path}
                      className={cn(
                        buttonVariants({ size: "lg", variant: "outline" }),
                        "bg-white text-[#0f1c3f] border-white hover:bg-white/90 hover:text-[#0f1c3f] font-semibold"
                      )}
                    >
                      Open {module.label}
                      <ExternalLink className="ml-2 w-4 h-4" />
                    </RequireAuthLink>
                  )}
                </div>
              </div>

              <div className="hidden lg:block">
                <div
                  className={`w-40 h-40 rounded-3xl bg-gradient-to-br ${module.color} shadow-2xl shadow-primary/30 flex items-center justify-center`}
                >
                  <Icon className="w-20 h-20 text-white" />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Key capabilities */}
        <section className="py-16 md:py-20">
          <div className="container mx-auto px-4">
            <div className="flex items-center gap-2 mb-8">
              <Sparkles className="w-5 h-5 text-primary" />
              <h2 className="text-2xl md:text-3xl font-bold text-white">Key capabilities</h2>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              {copy.bullets.map((b, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 p-5 rounded-2xl bg-white/[0.03] border border-white/10 hover:border-primary/30 transition-colors"
                >
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  <p className="text-white/85 leading-relaxed">{b}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="py-16 md:py-20 bg-white/[0.02]">
          <div className="container mx-auto px-4">
            <div className="flex items-center gap-2 mb-8">
              <Workflow className="w-5 h-5 text-primary" />
              <h2 className="text-2xl md:text-3xl font-bold text-white">How it works</h2>
            </div>
            <div className="grid md:grid-cols-3 gap-5">
              {copy.how.map((s, i) => (
                <div
                  key={i}
                  className="p-6 rounded-2xl bg-gradient-to-br from-white/[0.04] to-white/[0.01] border border-white/10"
                >
                  <div className="w-10 h-10 rounded-xl bg-primary/15 text-primary flex items-center justify-center font-bold mb-4">
                    {i + 1}
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-2">{s.title}</h3>
                  <p className="text-sm text-white/70 leading-relaxed">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Audience */}
        <section className="py-16 md:py-20">
          <div className="container mx-auto px-4">
            <div className="flex items-center gap-2 mb-8">
              <Users className="w-5 h-5 text-primary" />
              <h2 className="text-2xl md:text-3xl font-bold text-white">Built for</h2>
            </div>
            <div className="flex flex-wrap gap-3">
              {copy.audience.map((a, i) => (
                <span
                  key={i}
                  className="px-4 py-2 rounded-full bg-primary/10 border border-primary/30 text-primary font-medium"
                >
                  {a}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Explore more in this category */}
        {siblings.length > 0 && (
          <section className="py-16 md:py-20 bg-white/[0.02]">
            <div className="container mx-auto px-4">
              <h2 className="text-2xl md:text-3xl font-bold text-white mb-8">
                More in {category.label}
              </h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {siblings.map((s) => {
                  const SIcon = s.icon;
                  const sslug = slugify(s.label);
                  return (
                    <Link
                      key={s.label}
                      to={`/products/modules/${sslug}`}
                      className="group p-5 rounded-2xl bg-white/[0.03] border border-white/10 hover:border-primary/40 hover:bg-white/[0.06] transition-all"
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={`w-10 h-10 rounded-xl bg-gradient-to-br ${s.color} flex items-center justify-center shrink-0`}
                        >
                          <SIcon className="w-5 h-5 text-white" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-white font-semibold group-hover:text-primary transition-colors">
                            {s.label}
                          </p>
                          <p className="text-xs text-white/60 line-clamp-2 mt-1">
                            {s.description}
                          </p>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* Final CTA */}
        <section className="py-20">
          <div className="container mx-auto px-4">
            <div className="rounded-3xl p-10 md:p-14 text-center bg-gradient-to-br from-primary/15 via-violet-500/10 to-fuchsia-500/10 border border-primary/30">
              <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
                Get {module.label} — and every other module
              </h2>
              <p className="text-white/75 max-w-2xl mx-auto mb-8">
                One subscription unlocks the full ArbiProSeller platform. 60-day free trial. No credit card required.
              </p>
              <div className="flex flex-wrap gap-3 justify-center">
                <Button
                  size="lg"
                  onClick={() => navigate("/signup")}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
                >
                  Start free trial
                  <ArrowRight className="ml-2 w-4 h-4" />
                </Button>
                <RequireAuthLink
                  to="/tools"
                  className={cn(
                    buttonVariants({ size: "lg", variant: "outline" }),
                    "border-white/20 text-white hover:bg-white/10"
                  )}
                >
                  Back to overview
                </RequireAuthLink>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
};

export default ModuleExplainer;
