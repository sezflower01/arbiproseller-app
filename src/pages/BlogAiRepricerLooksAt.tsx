import React from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { Brain, Eye, ShieldCheck, TrendingUp, Package, Swords, Clock, BarChart3, Ban, Layers, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

const signals = [
  { icon: Eye, num: "1", title: "Buy Box Position", color: "blue", description: "Who owns the Buy Box? At what price? Did you just lose it? Are you close to winning?", insight: "If you're close → small adjustment wins it. If you're far → chasing may not be worth it. If you own it → opportunity to increase profit." },
  { icon: TrendingUp, num: "2", title: "Your Price vs Market Price", color: "cyan", description: "Compares your price against Buy Box, lowest FBA, and lowest overall offer.", insight: "Determines whether to lower, raise, or hold — not by guessing, but by measuring the gap." },
  { icon: ShieldCheck, num: "3", title: "Profit Protection (Min Price / ROI)", color: "emerald", description: "Checks your minimum price, ROI target, and cost before any change.", insight: "If lowering breaks profit → the price will NOT drop. Margin comes first, always." },
  { icon: Package, num: "4", title: "Inventory & Stock Awareness", color: "amber", description: "Checks unit count, whether stock is low or high, and if inventory needs to move.", insight: "Low stock → raise price, slow sales, maximize profit. High stock → compete harder, sell faster." },
  { icon: Swords, num: "5", title: "Competition Strength", color: "red", description: "Analyzes how many sellers are active, how aggressive they are, and price change frequency.", insight: "Stable market → safe to raise. Price war → controlled response. Few sellers → profit extraction." },
  { icon: BarChart3, num: "6", title: "Price Movement & Volatility", color: "purple", description: "Monitors how often prices change and how fast the market reacts.", insight: "Volatile markets get faster reactions. Stable markets get patient, profit-maximizing moves." },
  { icon: Clock, num: "7", title: "Timing & Cooldown", color: "teal", description: "Controls repricing frequency — when to wait and when to act immediately.", insight: "Too many changes hurt stability. Too few miss opportunities. The system balances both." },
  { icon: Brain, num: "8", title: "Learning from Past Outcomes", color: "indigo", description: "Tracks Buy Box wins/losses, which price changes worked, and which didn't.", insight: "Detects patterns like 'this product always loses BB' and adjusts behavior accordingly." },
  { icon: Ban, num: "9", title: "Safety Constraints", color: "rose", description: "Blocks actions when price drops below minimum, ROI is unsafe, data is missing, or risk is too high.", insight: "Not every opportunity is a good decision. Sometimes the best move is no move." },
  { icon: Layers, num: "10", title: "Strategy Type (Situation-Based)", color: "orange", description: "Switches behavior based on context: recapture, profit extraction, controlled undercut, or hold.", insight: "This is what makes it intelligent — not one rule, but the right rule for each moment." },
];

const colorMap: Record<string, { bg: string; border: string; text: string; glow: string }> = {
  blue: { bg: "bg-blue-500/10", border: "border-blue-500/20", text: "text-blue-400", glow: "shadow-blue-500/5" },
  cyan: { bg: "bg-cyan-500/10", border: "border-cyan-500/20", text: "text-cyan-400", glow: "shadow-cyan-500/5" },
  emerald: { bg: "bg-emerald-500/10", border: "border-emerald-500/20", text: "text-emerald-400", glow: "shadow-emerald-500/5" },
  amber: { bg: "bg-amber-500/10", border: "border-amber-500/20", text: "text-amber-400", glow: "shadow-amber-500/5" },
  red: { bg: "bg-red-500/10", border: "border-red-500/20", text: "text-red-400", glow: "shadow-red-500/5" },
  purple: { bg: "bg-purple-500/10", border: "border-purple-500/20", text: "text-purple-400", glow: "shadow-purple-500/5" },
  teal: { bg: "bg-teal-500/10", border: "border-teal-500/20", text: "text-teal-400", glow: "shadow-teal-500/5" },
  indigo: { bg: "bg-indigo-500/10", border: "border-indigo-500/20", text: "text-indigo-400", glow: "shadow-indigo-500/5" },
  rose: { bg: "bg-rose-500/10", border: "border-rose-500/20", text: "text-rose-400", glow: "shadow-rose-500/5" },
  orange: { bg: "bg-orange-500/10", border: "border-orange-500/20", text: "text-orange-400", glow: "shadow-orange-500/5" },
};

const BlogAiRepricerLooksAt = () => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet>
        <title>What an AI Amazon Repricer Checks Before Changing Price | ArbiProSeller</title>
        <meta name="description" content="Discover the 10 signals an AI Amazon repricer analyzes before every price change — Buy Box, profit, inventory, competition, timing, and more. Full transparency." />
        <meta name="keywords" content="AI repricer signals, Amazon repricer how it works, Buy Box repricing strategy, automated pricing Amazon FBA, best AI repricer Amazon, repricer profit protection, Amazon repricing tool" />
        <link rel="canonical" href="https://arbiproseller.com/blog/what-ai-repricer-looks-at" />
        <meta property="og:type" content="article" />
        <meta property="og:title" content="What an AI Amazon Repricer Checks Before Changing Price" />
        <meta property="og:description" content="The 10 signals an AI Amazon repricer analyzes before every price change — Buy Box, profit, inventory, competition, timing, and more." />
        <meta property="og:url" content="https://arbiproseller.com/blog/what-ai-repricer-looks-at" />
        <meta name="twitter:title" content="What an AI Amazon Repricer Checks Before Changing Price" />
        <meta name="twitter:description" content="The 10 signals an AI Amazon repricer analyzes before every price change." />
        <script type="application/ld+json">{`
          {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            "headline": "What an AI Repricer Actually Looks At Before Changing Your Price",
            "description": "Discover the 10 signals an AI Amazon repricer analyzes before every price change.",
            "author": { "@type": "Person", "name": "Sam Shomali" },
            "publisher": { "@type": "Organization", "name": "ArbiProSeller" },
            "datePublished": "2026-04-15",
            "keywords": ["AI repricer signals", "Amazon repricer", "Buy Box strategy", "automated pricing"],
            "mainEntityOfPage": { "@type": "WebPage", "@id": "https://arbiproseller.com/blog/what-ai-repricer-looks-at" }
          }
        `}</script>
      </Helmet>

      <Navbar />

      <main className="flex-grow pt-16">
        {/* Hero */}
        <section className="relative overflow-hidden py-20 md:py-28">
          <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900" />
          <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.15) 1px, transparent 0)', backgroundSize: '40px 40px' }} />
          <div className="absolute top-20 left-20 w-72 h-72 bg-indigo-500/10 rounded-full blur-3xl" />
          <div className="absolute bottom-10 right-10 w-96 h-96 bg-purple-500/5 rounded-full blur-3xl" />

          <div className="container mx-auto px-4 relative z-10">
            <div className="max-w-3xl mx-auto text-center">
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-sm font-medium mb-6">
                <Brain className="w-4 h-4" />
                ArbiProSeller Blog
              </div>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight mb-6">
                What an AI Repricer <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">Actually Looks At</span> Before Changing Your Price
              </h1>
              <div className="flex items-center justify-center gap-4 text-indigo-200/70 text-sm mb-6">
                <span>By <strong className="text-white">Sam Shomali</strong></span>
                <span>•</span>
                <span>April 15, 2026</span>
                <span>•</span>
                <span>8 min read</span>
              </div>
              <p className="text-lg text-slate-300 max-w-2xl mx-auto">
                Most people think a repricer does one thing: "If someone lowers the price… match it." That's not how a real system works. Here are the <strong className="text-white">10 signals</strong> analyzed before every single decision.
              </p>
            </div>
          </div>
        </section>

        {/* Intro */}
        <section className="py-16 bg-slate-950">
          <div className="container mx-auto px-4 max-w-3xl">
            <div className="bg-gradient-to-r from-indigo-500/5 to-purple-500/5 border border-indigo-500/10 rounded-2xl p-8 mb-12">
              <h2 className="text-2xl font-bold text-white mb-4">🧠 It starts with one simple question</h2>
              <p className="text-slate-300 text-lg leading-relaxed">
                Before touching your price, the system asks: <strong className="text-indigo-300">"What's really happening around this product right now?"</strong>
              </p>
              <p className="text-slate-400 mt-3">
                Not just one data point. Not just the Buy Box price. It gathers <strong className="text-white">10 different signals</strong> — and only then makes a decision.
              </p>
            </div>
          </div>
        </section>

        {/* 10 Signals */}
        <section className="py-16 bg-slate-900/50">
          <div className="container mx-auto px-4 max-w-4xl">
            <h2 className="text-3xl font-bold text-white text-center mb-4">The 10 Signals Behind Every Decision</h2>
            <p className="text-slate-400 text-center mb-12 max-w-2xl mx-auto">Each signal is checked in real time. Together, they form a complete picture — not a guess.</p>

            <div className="space-y-6">
              {signals.map((s) => {
                const c = colorMap[s.color];
                const Icon = s.icon;
                return (
                  <div key={s.num} className={`relative rounded-2xl border ${c.border} bg-slate-900/80 p-6 md:p-8 shadow-lg ${c.glow}`}>
                    <div className="flex items-start gap-5">
                      <div className={`flex-shrink-0 w-14 h-14 rounded-xl ${c.bg} flex items-center justify-center`}>
                        <Icon className={`w-7 h-7 ${c.text}`} />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <span className={`text-xs font-bold ${c.text} ${c.bg} px-2 py-0.5 rounded-full`}>#{s.num}</span>
                          <h3 className="text-xl font-bold text-white">{s.title}</h3>
                        </div>
                        <p className="text-slate-300 mb-3">{s.description}</p>
                        <div className={`${c.bg} rounded-lg p-3 border ${c.border}`}>
                          <p className={`text-sm font-medium ${c.text}`}>💡 {s.insight}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* How it comes together */}
        <section className="py-16 bg-slate-950">
          <div className="container mx-auto px-4 max-w-3xl">
            <h2 className="text-3xl font-bold text-white text-center mb-8">🔁 How It All Comes Together</h2>
            <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 border border-slate-700/50 rounded-2xl p-8">
              <p className="text-slate-300 text-lg mb-6">Before every decision, the AI combines:</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
                {["Buy Box status", "Price gap", "Profit limits", "Inventory", "Competition", "Timing", "Past outcomes", "Safety rules", "Strategy context"].map((item) => (
                  <div key={item} className="bg-blue-500/5 border border-blue-500/10 rounded-lg px-3 py-2 text-center">
                    <span className="text-blue-300 text-sm font-medium">{item}</span>
                  </div>
                ))}
              </div>
              <p className="text-slate-300 text-lg">Then it decides: <strong className="text-emerald-400">lower</strong>, <strong className="text-blue-400">raise</strong>, <strong className="text-amber-400">hold</strong>, or <strong className="text-slate-400">wait</strong>.</p>
            </div>
          </div>
        </section>

        {/* Final thought */}
        <section className="py-16 bg-slate-900/50">
          <div className="container mx-auto px-4 max-w-3xl text-center">
            <h2 className="text-3xl font-bold text-white mb-6">🏁 Final Thought</h2>
            <div className="bg-gradient-to-r from-indigo-500/5 to-purple-500/5 border border-indigo-500/10 rounded-2xl p-8">
              <p className="text-slate-300 text-lg mb-4">
                A simple repricer changes price. A real AI system <strong className="text-white">understands the situation</strong> before making a decision.
              </p>
              <p className="text-slate-400 mb-6">
                Success isn't about always being the cheapest or always winning the Buy Box. It's about <strong className="text-indigo-300">making the right decision at the right time — consistently</strong>.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-lg mx-auto">
                <div className="bg-red-500/5 border border-red-500/10 rounded-lg p-4">
                  <p className="text-red-400 font-medium text-sm">❌ Reacting blindly</p>
                </div>
                <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-4">
                  <p className="text-emerald-400 font-medium text-sm">✅ Making the right move</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* CTA + Related blogs */}
        <section className="py-16 bg-gradient-to-br from-indigo-950 to-slate-900">
          <div className="container mx-auto px-4 max-w-3xl text-center">
            <h2 className="text-3xl font-bold text-white mb-4">Ready to See It in Action?</h2>
            <p className="text-slate-300 mb-8">Start your free trial and watch the AI make smarter decisions for every product.</p>
            <Link to="/signup" className="inline-flex items-center gap-2 px-8 py-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold rounded-xl hover:from-indigo-500 hover:to-purple-500 transition-all shadow-lg shadow-indigo-500/25">
              Start Free Trial <ArrowRight className="w-5 h-5" />
            </Link>

            <div className="mt-12 pt-8 border-t border-slate-700/50">
              <p className="text-slate-400 text-sm mb-4">📖 More from the blog</p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link to="/blog/ai-repricer-behind-the-scenes" className="text-indigo-400 hover:text-indigo-300 transition-colors text-sm underline underline-offset-4">
                  How an AI Repricer Works →
                </Link>
                <Link to="/blog/real-ai-decisions-live-asins" className="text-indigo-400 hover:text-indigo-300 transition-colors text-sm underline underline-offset-4">
                  Real AI Decisions from Live ASINs →
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
};

export default BlogAiRepricerLooksAt;
