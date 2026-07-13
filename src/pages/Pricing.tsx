import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Check, Sparkles, Zap, Shield, Rocket, Clock, Gift, TrendingUp, Star, Crown } from "lucide-react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface Plan {
  id: string;
  name: string;
  listing_limit: number;
  monthly_price: number;        // discounted (18% OFF) — what they pay
  monthly_list_price: number;   // original list price (strikethrough)
  annual_price: number;         // monthly equivalent of yearly plan
  yearly_total: number;         // total billed yearly
  badge?: "Most Popular" | "Best Value";
}

// Hardcoded pricing — single source of truth for the public marketing page.
const PLANS: Plan[] = [
  { id: "tier_100",   name: "Starter",     listing_limit: 100,   monthly_list_price: 199,  monthly_price: 163,  annual_price: 163,  yearly_total: 1959 },
  { id: "tier_250",   name: "Growth",      listing_limit: 250,   monthly_list_price: 225,  monthly_price: 185,  annual_price: 185,  yearly_total: 2214,  badge: "Most Popular" },
  { id: "tier_500",   name: "Scale",       listing_limit: 500,   monthly_list_price: 265,  monthly_price: 217,  annual_price: 217,  yearly_total: 2608 },
  { id: "tier_1000",  name: "Pro",         listing_limit: 1000,  monthly_list_price: 340,  monthly_price: 279,  annual_price: 279,  yearly_total: 3346,  badge: "Best Value" },
  { id: "tier_2000",  name: "Business",    listing_limit: 2000,  monthly_list_price: 480,  monthly_price: 394,  annual_price: 394,  yearly_total: 4723 },
  { id: "tier_5000",  name: "Advanced",    listing_limit: 5000,  monthly_list_price: 880,  monthly_price: 722,  annual_price: 722,  yearly_total: 8659 },
  { id: "tier_10000", name: "Elite",       listing_limit: 10000, monthly_list_price: 1480, monthly_price: 1214, annual_price: 1214, yearly_total: 14563 },
  { id: "tier_20000", name: "Enterprise",  listing_limit: 20000, monthly_list_price: 2580, monthly_price: 2116, annual_price: 2116, yearly_total: 25387 },
  { id: "tier_50000", name: "Enterprise+", listing_limit: 50000, monthly_list_price: 5680, monthly_price: 4658, annual_price: 4658, yearly_total: 55891 },
];

const SUITE_FEATURES = [
  { group: "Repricer", items: ["AI Smart Repricing Engine", "Buy Box Optimization", "Conditional & Scheduled Repricing", "Live Pricing Monitor", "Pricing Analytics & AI Insights"] },
  { group: "Sourcing", items: ["AI Sourcer", "Store Scan / Supplier Discovery", "Google & Keepa Product Search", "ASIN & UPC Lookup", "Replenish Search"] },
  { group: "Inventory", items: ["Synced Inventory", "Inventory Valuation", "Inventory Review & Restoration", "Disposition & Write-off", "Need-Buy-Again Replenishment"] },
  { group: "Listings & Shipments", items: ["Create Listing", "Label Printing (PDF + Direct)", "Shipment Builder", "Shipment Tracking", "Shipment Accounting"] },
  { group: "Sales & Accounting", items: ["Sales Dashboard & Live Sales", "Profit & Loss (P&L)", "Settlement Reports", "Reimbursements Tracking", "Expenses & COGS"] },
  { group: "Platform", items: ["Multi-Marketplace (US, CA, MX, BR + EU)", "Team Roles (Owner / Admin / Manager / Viewer)", "Mobile Scan App", "Email Center", "Cancel Anytime"] },
];

const HIGHLIGHT_PLAN_IDS = new Set(["tier_250", "tier_1000"]);

const Pricing = () => {
  const navigate = useNavigate();
  const [billing, setBilling] = useState<"monthly" | "annual">("annual");
  const plans = PLANS;
  const loading = false;

  const featuredPlans = plans;

  return (
    <div className="min-h-screen bg-[hsl(222,84%,4.9%)]">
      <Helmet>
        <title>Pricing — InventorySprint Amazon Arbitrage Suite</title>
        <meta
          name="description"
          content="Repricer, sourcing, inventory, listings and analytics in one plan. 60-day free autopilot trial. Cancel anytime."
        />
        <meta name="keywords" content="amazon repricer pricing, amazon inventory software pricing, FBA seller software plans, inventory sprint pricing, amazon seller software subscription" />
        <link rel="canonical" href="https://inventorysprint.com/pricing" />
        <meta property="og:title" content="Pricing — InventorySprint Amazon Arbitrage Suite" />
        <meta property="og:description" content="Repricer, sourcing, inventory and analytics in one plan. 60-day free trial." />
        <meta property="og:url" content="https://inventorysprint.com/pricing" />
      </Helmet>
      <Navbar />

      <main className="pt-28 pb-20">
        {/* Hero */}
        <section className="container mx-auto px-4 text-center max-w-4xl">
          <Badge className="mb-4 bg-emerald-500/15 text-emerald-300 border border-emerald-400/30 px-3 py-1">
            <Gift className="h-3.5 w-3.5 mr-1.5" />
            60-Day Free Autopilot Trial
          </Badge>
          <h1 className="text-4xl md:text-6xl font-bold text-white leading-tight mb-4">
            Not Just a Repricer —{" "}
            <span className="bg-gradient-to-r from-blue-400 via-violet-400 to-fuchsia-400 bg-clip-text text-transparent">
              A Complete Arbitrage System
            </span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8">
            <span className="font-semibold text-white">Inventory S.P.R.I.N.T. Suite</span>{" "}
            combines repricing, sourcing, inventory, listings, shipments and
            analytics into one powerful platform — one login, one workflow.
          </p>

          {/* Billing toggle */}
          <div className="inline-flex rounded-full border border-white/15 bg-white/5 p-1 backdrop-blur-sm">
            <button
              onClick={() => setBilling("annual")}
              className={`px-5 py-2 text-sm font-semibold rounded-full transition-all ${
                billing === "annual"
                  ? "bg-blue-600 text-white shadow-lg"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              Annual <span className="ml-1 text-emerald-300 text-xs">Save 18%</span>
            </button>
            <button
              onClick={() => setBilling("monthly")}
              className={`px-5 py-2 text-sm font-semibold rounded-full transition-all ${
                billing === "monthly"
                  ? "bg-blue-600 text-white shadow-lg"
                  : "text-muted-foreground hover:text-white"
              }`}
            >
              Monthly
            </button>
          </div>
        </section>

        {/* Featured pricing cards */}
        <section className="container mx-auto px-4 mt-12 max-w-6xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {loading &&
              Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-80 rounded-2xl bg-white/5 animate-pulse"
                />
              ))}
            {featuredPlans.map((p) => {
              const popular = p.id === "tier_250";
              const best = p.id === "tier_1000";
              const price = billing === "annual" ? p.annual_price : p.monthly_list_price;
              const perAsin = (price / p.listing_limit).toFixed(2);
              return (
                <Card
                  key={p.id}
                  className={`relative overflow-hidden border bg-[hsl(222,80%,7%)]/80 backdrop-blur-sm transition-transform hover:-translate-y-1 ${
                    popular
                      ? "border-blue-500/50 shadow-[0_20px_60px_-20px_hsl(217,91%,60%/0.5)]"
                      : best
                      ? "border-fuchsia-500/40 shadow-[0_20px_60px_-20px_hsl(292,84%,61%/0.4)]"
                      : "border-white/10"
                  }`}
                >
                  {popular && (
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-bold uppercase tracking-widest px-4 py-1 rounded-b-lg flex items-center gap-1">
                      <Star className="h-3 w-3 fill-white" /> Most Popular
                    </div>
                  )}
                  {best && (
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 bg-gradient-to-r from-fuchsia-600 to-violet-600 text-white text-[10px] font-bold uppercase tracking-widest px-4 py-1 rounded-b-lg flex items-center gap-1">
                      <Crown className="h-3 w-3 fill-white" /> Best Value
                    </div>
                  )}
                  <CardContent className="p-6 pt-8">
                    <div className="mb-4">
                      <p className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">
                        {p.name}
                      </p>
                      <p className="text-2xl font-bold text-white mt-1">
                        {p.listing_limit.toLocaleString()} listings
                      </p>
                    </div>
                    <div className="mb-5">
                      <div className="flex items-baseline gap-1">
                        <span className="text-4xl font-bold text-white">
                          ${price}
                        </span>
                        <span className="text-muted-foreground text-sm">/mo</span>
                      </div>
                      {billing === "annual" && (
                        <p className="text-xs text-emerald-400 mt-1">
                          Billed ${p.yearly_total.toLocaleString()}/yr
                        </p>
                      )}
                      <p className="text-[11px] text-gray-500 mt-1">
                        ${perAsin} per active listing
                      </p>
                    </div>
                    <Button
                      className={`w-full ${
                        popular || best
                          ? "bg-blue-600 hover:bg-blue-700"
                          : "bg-white/10 hover:bg-white/20"
                      } text-white font-semibold`}
                      onClick={() => navigate("/signup")}
                    >
                      Start 60-Day Free Trial
                    </Button>
                    <p className="text-[10px] text-center text-gray-500 mt-2">
                      No card required • Cancel anytime
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

        <p className="text-center text-xs text-gray-500 mt-6">
          Need more than 50K listings?{" "}
          <button
            onClick={() => navigate("/contact")}
            className="text-blue-400 hover:underline"
          >
            Contact us
          </button>{" "}
          for custom Enterprise pricing.
        </p>

        {/* What's included grid */}
        <section className="container mx-auto px-4 mt-20 max-w-6xl">
          <div className="text-center mb-10">
            <Badge className="mb-3 bg-blue-500/15 text-blue-300 border border-blue-400/30">
              <Sparkles className="h-3 w-3 mr-1" />
              Everything Included
            </Badge>
            <h2 className="text-3xl font-bold text-white mb-2">
              The Full Inventory S.P.R.I.N.T. Suite
            </h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Every plan unlocks the complete platform — no feature gating, no
              add-ons. Choose only the capacity you need.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {SUITE_FEATURES.map((g) => (
              <Card
                key={g.group}
                className="border border-white/10 bg-[hsl(222,80%,7%)]/80 backdrop-blur-sm"
              >
                <CardContent className="p-5">
                  <h3 className="text-sm font-bold uppercase tracking-widest text-blue-300 mb-3">
                    {g.group}
                  </h3>
                  <ul className="space-y-2">
                    {g.items.map((it) => (
                      <li
                        key={it}
                        className="flex items-start gap-2 text-sm text-gray-200"
                      >
                        <Check className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                        {it}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Trial explainer */}
        <section className="container mx-auto px-4 mt-20 max-w-5xl">
          <Card className="border border-emerald-400/40 bg-white shadow-2xl">
            <CardContent className="p-8">
              <div className="flex items-start gap-5">
                <div className="bg-[#0f1c3f]/10 rounded-xl p-3 shrink-0">
                  <Gift className="h-8 w-8 text-[#0f1c3f]" />
                </div>
                <div className="flex-1">
                  <h3 className="text-2xl font-bold text-[#0f1c3f] mb-2">
                    Try Everything Free for 60 Days — No Credit Card
                  </h3>
                  <p className="text-[#0f1c3f] mb-2">
                    Sign up today and get full access to the entire Inventory S.P.R.I.N.T.
                    Suite — repricer, sourcing, inventory, listings, shipments
                    and analytics — for <span className="font-semibold">60 days, completely free</span>.
                  </p>
                  <p className="text-[#0f1c3f]/80 text-sm mb-5">
                    No credit card required. Pick any plan size during your trial.
                    On day 61, choose a plan to keep going — or cancel anytime
                    with one click. Why 60 days? Because real Amazon arbitrage
                    results take time. Here's what happens:
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {[
                      { w: "Days 1–14", title: "Setup & Learning", t: "Connect your Amazon account. The system imports your listings, learns your catalog, and sets smart price floors that protect your margins." },
                      { w: "Days 15–30", title: "Autopilot Takes Over", t: "The repricer adjusts prices 24/7. You'll need fewer manual changes as the AI gets to know your products and competitors." },
                      { w: "Days 31–60", title: "See Real Results", t: "Steady Buy Box wins, stable margins, and consistent profit — without price crashes. By day 60 you'll know exactly how it performs for your business." },
                    ].map((x) => (
                      <div
                        key={x.w}
                        className="bg-[#0f1c3f]/5 border border-[#0f1c3f]/10 rounded-lg p-4"
                      >
                        <p className="font-bold text-[#0f1c3f] text-[10px] uppercase tracking-widest mb-1">
                          {x.w}
                        </p>
                        <p className="font-semibold text-[#0f1c3f] text-sm mb-1.5">
                          {x.title}
                        </p>
                        <p className="text-xs text-[#0f1c3f]/80 leading-relaxed">{x.t}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* CTA */}
        <section className="container mx-auto px-4 mt-16 text-center max-w-3xl">
          <h2 className="text-3xl font-bold text-white mb-3">
            Ready to run your whole arbitrage business in one place?
          </h2>
          <p className="text-muted-foreground mb-6">
            Start your 60-day free trial. Upgrade, downgrade or cancel anytime.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button
              size="lg"
              className="bg-blue-600 hover:bg-blue-700 text-white font-semibold"
              onClick={() => navigate("/signup")}
            >
              <Rocket className="h-4 w-4 mr-2" />
              Start 60-Day Free Trial
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="bg-white border-2 border-[#0f1c3f] text-[#0f1c3f] hover:bg-[#0f1c3f] hover:text-white font-bold"
              onClick={() => navigate("/contact")}
            >
              Talk to Sales
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-5 mt-6 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><Shield className="h-3.5 w-3.5 text-emerald-400" />Cancel anytime</span>
            <span className="flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-emerald-400" />Full Smart Engine</span>
            <span className="flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-emerald-400" />All marketplaces</span>
            <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5 text-emerald-400" />No card required</span>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
};

export default Pricing;
