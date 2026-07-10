import React from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { BookOpen, Package, Link2, DollarSign, Layers, Upload, RefreshCw, Brain, ArrowRight, ShoppingCart, ClipboardList } from "lucide-react";
import { Link } from "react-router-dom";

const sections = [
  {
    icon: Brain,
    title: "The Hidden Problem with Arbitrage Sourcing",
    color: "red",
    content: [
      "Most sellers think the challenge is finding profitable products, beating competition, or winning the Buy Box.",
      "But the real problem is something else: there's no system to remember what actually worked.",
      "Good ASINs, reliable suppliers, profitable products — they're scattered in notes, spreadsheets, browser history, or just… in your memory.",
    ],
    highlight: "And that's where things start breaking down.",
  },
  {
    icon: Package,
    title: "What a Product Library Really Is",
    color: "blue",
    content: [
      "Think of it like this: your personal database of everything that has ever made you money.",
      "Not just a list of products — but a system that tracks your costs, your suppliers, your purchase history, your profitability, and your notes and decisions.",
    ],
    highlight: "Over time, this becomes a sourcing system — not just a sourcing process.",
  },
  {
    icon: RefreshCw,
    title: "Every Product Becomes Reusable",
    color: "emerald",
    content: [
      "Normally, you find a product, buy it, sell it, and forget it.",
      "With a Product Library: it stays saved, the supplier link is attached, cost is recorded, and ROI is calculated.",
    ],
    highlight: "You don't search again — you go back to what already worked.",
  },
  {
    icon: Link2,
    title: "Supplier Management Becomes Simple",
    color: "purple",
    content: [
      "One of the biggest struggles in arbitrage is remembering where you bought things.",
      "Now every product has multiple supplier links, discount codes are saved, and everything is organized.",
      "No more digging through emails, searching past orders, or guessing where you found it.",
    ],
    highlight: "Everything is connected to the product.",
  },
  {
    icon: DollarSign,
    title: "You Always Know If a Product Is Still Profitable",
    color: "amber",
    content: [
      "Markets change. Prices move. Fees change.",
      "Instead of guessing, the system recalculates Amazon fees, profit, margin, and ROI.",
    ],
    highlight: "Before you reorder, you already know: is this still worth buying?",
  },
  {
    icon: Layers,
    title: "Multiple Purchases — One Clean View",
    color: "cyan",
    content: [
      "Sometimes you buy the same product multiple times — different dates, different quantities, different costs.",
      "Instead of messy tracking, everything is grouped into one product: total units, total cost, updated averages.",
    ],
    highlight: "Clean, simple, accurate.",
  },
  {
    icon: Upload,
    title: "Bulk Sourcing Without Chaos",
    color: "indigo",
    content: [
      "When you find multiple deals, you don't want to add them one by one.",
      "With bulk import: upload a file, import hundreds of products, and track everything instantly.",
    ],
    highlight: "No more manual entry, lost leads, or broken workflows.",
  },
  {
    icon: ShoppingCart,
    title: "Knowing Exactly What to Reorder",
    color: "orange",
    content: [
      "Instead of guessing what to buy again, the system checks your inventory, your sales speed, and your past purchases.",
      "Then it tells you what is selling, what is running low, and what needs to be reordered — with direct supplier links ready.",
    ],
    highlight: "This is where arbitrage stops being random and starts being a system.",
  },
];

const colorMap: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  red: { bg: "bg-red-500/10", border: "border-red-500/20", text: "text-red-400", accent: "from-red-500/10 to-red-500/5" },
  blue: { bg: "bg-blue-500/10", border: "border-blue-500/20", text: "text-blue-400", accent: "from-blue-500/10 to-blue-500/5" },
  emerald: { bg: "bg-emerald-500/10", border: "border-emerald-500/20", text: "text-emerald-400", accent: "from-emerald-500/10 to-emerald-500/5" },
  purple: { bg: "bg-purple-500/10", border: "border-purple-500/20", text: "text-purple-400", accent: "from-purple-500/10 to-purple-500/5" },
  amber: { bg: "bg-amber-500/10", border: "border-amber-500/20", text: "text-amber-400", accent: "from-amber-500/10 to-amber-500/5" },
  cyan: { bg: "bg-cyan-500/10", border: "border-cyan-500/20", text: "text-cyan-400", accent: "from-cyan-500/10 to-cyan-500/5" },
  indigo: { bg: "bg-indigo-500/10", border: "border-indigo-500/20", text: "text-indigo-400", accent: "from-indigo-500/10 to-indigo-500/5" },
  orange: { bg: "bg-orange-500/10", border: "border-orange-500/20", text: "text-orange-400", accent: "from-orange-500/10 to-orange-500/5" },
};

const BlogProductLibrary = () => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet>
        <title>Why Amazon Sellers Keep Starting Over — Product Library Fix | ArbiProSeller</title>
        <meta name="description" content="Stop sourcing from scratch. Learn how a Product Library helps Amazon FBA sellers track costs, suppliers, and reorder profitably. Built for online arbitrage." />
        <meta name="keywords" content="Amazon product library, Amazon FBA sourcing tool, online arbitrage software, Amazon seller tools, reorder Amazon products, supplier management Amazon, Amazon sourcing database, FBA product tracker" />
        <link rel="canonical" href="https://arbiproseller.com/blog/product-library-amazon-sellers" />
        <meta property="og:type" content="article" />
        <meta property="og:title" content="Why Amazon Sellers Keep Starting Over — Product Library Fix" />
        <meta property="og:description" content="How a Product Library helps Amazon FBA sellers track costs, suppliers, and reorder profitably." />
        <meta property="og:url" content="https://arbiproseller.com/blog/product-library-amazon-sellers" />
        <meta name="twitter:title" content="Why Amazon Sellers Keep Starting Over — Product Library Fix" />
        <meta name="twitter:description" content="How a Product Library helps Amazon FBA sellers track costs, suppliers, and reorder profitably." />
        <script type="application/ld+json">{`
          {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            "headline": "Why Most Amazon Sellers Keep Starting Over — And How a Product Library Changes Everything",
            "description": "Stop sourcing from scratch. Learn how a Product Library helps Amazon FBA sellers track costs, suppliers, and profitability.",
            "author": { "@type": "Person", "name": "Sam Shomali" },
            "publisher": { "@type": "Organization", "name": "ArbiProSeller" },
            "datePublished": "2026-04-15",
            "keywords": ["Amazon product library", "online arbitrage", "Amazon FBA sourcing", "supplier management"],
            "mainEntityOfPage": { "@type": "WebPage", "@id": "https://arbiproseller.com/blog/product-library-amazon-sellers" }
          }
        `}</script>
      </Helmet>

      <Navbar />

      <main className="flex-grow pt-16">
        {/* Hero */}
        <section className="relative overflow-hidden py-20 md:py-28">
          <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-emerald-950 to-slate-900" />
          <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.15) 1px, transparent 0)', backgroundSize: '40px 40px' }} />
          <div className="absolute top-20 right-20 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl" />
          <div className="absolute bottom-10 left-10 w-96 h-96 bg-teal-500/5 rounded-full blur-3xl" />

          <div className="container mx-auto px-4 relative z-10">
            <div className="max-w-3xl mx-auto text-center">
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm font-medium mb-6">
                <ClipboardList className="w-4 h-4" />
                ArbiProSeller Blog
              </div>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white leading-tight mb-6">
                Why Most Amazon Sellers <span className="bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">Keep Starting Over</span> — And How a Product Library Changes Everything
              </h1>
              <div className="flex items-center justify-center gap-4 text-emerald-200/70 text-sm mb-6">
                <span>By <strong className="text-white">Sam Shomali</strong></span>
                <span>•</span>
                <span>April 15, 2026</span>
                <span>•</span>
                <span>7 min read</span>
              </div>
              <p className="text-lg text-slate-300 max-w-2xl mx-auto">
                You spend hours sourcing. Find a good product. It sells. Then you move on — and start from zero again. There's a better way.
              </p>
            </div>
          </div>
        </section>

        {/* Intro hook */}
        <section className="py-16 bg-slate-950">
          <div className="container mx-auto px-4 max-w-3xl">
            <div className="bg-gradient-to-r from-red-500/5 to-orange-500/5 border border-red-500/10 rounded-2xl p-8 mb-8">
              <p className="text-slate-300 text-lg leading-relaxed mb-4">
                If you've done online arbitrage for any amount of time, you've probably felt this:
              </p>
              <div className="space-y-2 text-slate-400">
                <p>You spend hours sourcing.</p>
                <p>You find a good product. You test it. It sells.</p>
                <p>Then… you move on.</p>
              </div>
              <p className="text-slate-300 text-lg mt-4">A few weeks later, you're back to the same routine:</p>
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                {["Searching again", "Checking prices again", "Trying to find something new"].map((item) => (
                  <div key={item} className="bg-red-500/5 border border-red-500/10 rounded-lg px-4 py-3 text-center">
                    <span className="text-red-400 text-sm font-medium">🔄 {item}</span>
                  </div>
                ))}
              </div>
              <p className="text-white font-semibold text-lg mt-6 text-center">
                Starting from zero… over and over again.
              </p>
            </div>

            {/* Mindset shift */}
            <div className="bg-gradient-to-r from-emerald-500/5 to-teal-500/5 border border-emerald-500/10 rounded-2xl p-8">
              <h2 className="text-2xl font-bold text-white mb-4">🔁 The Mindset Shift</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-red-500/5 border border-red-500/10 rounded-lg p-5">
                  <p className="text-red-400 font-semibold text-sm mb-2">❌ Old way</p>
                  <p className="text-slate-300">"What should I source today?"</p>
                </div>
                <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-5">
                  <p className="text-emerald-400 font-semibold text-sm mb-2">✅ New way</p>
                  <p className="text-slate-300">"What should I <strong className="text-white">reorder</strong> today?"</p>
                </div>
              </div>
              <p className="text-slate-400 text-sm mt-4 text-center">That's a completely different mindset — and a completely different result.</p>
            </div>
          </div>
        </section>

        {/* Sections */}
        <section className="py-16 bg-slate-900/50">
          <div className="container mx-auto px-4 max-w-4xl">
            <h2 className="text-3xl font-bold text-white text-center mb-4">How a Product Library Works</h2>
            <p className="text-white/80 text-center mb-12 max-w-2xl mx-auto">Every feature is designed to eliminate wasted effort and turn one-time wins into repeatable profit.</p>

            <div className="space-y-6">
              {sections.map((s, i) => {
                const c = colorMap[s.color];
                const Icon = s.icon;
                return (
                  <div key={i} className={`relative rounded-2xl border ${c.border} bg-slate-900/80 p-6 md:p-8 shadow-lg`}>
                    <div className="flex items-start gap-5">
                      <div className={`flex-shrink-0 w-14 h-14 rounded-xl ${c.bg} flex items-center justify-center`}>
                        <Icon className={`w-7 h-7 ${c.text}`} />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-xl font-bold text-white mb-3">{s.title}</h3>
                        <div className="space-y-2 mb-4">
                          {s.content.map((p, j) => (
                            <p key={j} className="text-slate-300">{p}</p>
                          ))}
                        </div>
                        <div className={`${c.bg} rounded-lg p-3 border ${c.border}`}>
                          <p className={`text-sm font-medium ${c.text}`}>👉 {s.highlight}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Complete system flow */}
        <section className="py-16 bg-slate-950">
          <div className="container mx-auto px-4 max-w-3xl">
            <h2 className="text-3xl font-bold text-white text-center mb-8">🔗 Everything Connected Together</h2>
            <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 border border-slate-700/50 rounded-2xl p-8">
              <p className="text-slate-300 text-lg mb-6">Imagine this complete flow:</p>
              <div className="space-y-3">
                {[
                  { step: "1", text: "You find a product", color: "blue" },
                  { step: "2", text: "It gets saved in your library", color: "emerald" },
                  { step: "3", text: "Cost and supplier are recorded", color: "purple" },
                  { step: "4", text: "Profit is calculated automatically", color: "amber" },
                  { step: "5", text: "It gets repriced by AI", color: "cyan" },
                  { step: "6", text: "It sells", color: "emerald" },
                  { step: "7", text: "System tells you to reorder", color: "orange" },
                ].map((item) => (
                  <div key={item.step} className="flex items-center gap-4">
                    <div className={`w-8 h-8 rounded-full bg-${item.color}-500/20 flex items-center justify-center flex-shrink-0`}>
                      <span className={`text-${item.color}-400 text-sm font-bold`}>{item.step}</span>
                    </div>
                    <p className="text-slate-300">{item.text}</p>
                  </div>
                ))}
              </div>
              <p className="text-white font-semibold text-lg mt-6 text-center">
                That's not just sourcing anymore — that's a <span className="text-emerald-400">complete system</span>.
              </p>
            </div>
          </div>
        </section>

        {/* How arbitrage scales */}
        <section className="py-16 bg-slate-900/50">
          <div className="container mx-auto px-4 max-w-3xl text-center">
            <h2 className="text-3xl font-bold text-white mb-6">🧠 This Is How Arbitrage Scales</h2>
            <div className="bg-gradient-to-r from-emerald-500/5 to-teal-500/5 border border-emerald-500/10 rounded-2xl p-8">
              <p className="text-white text-lg mb-4">
                Most sellers stay stuck because they only focus on finding new deals — they don't build systems.
              </p>
              <p className="text-white/80 mb-6">
                But real growth comes from <strong className="text-white">repeating what works — faster and more efficiently</strong>.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-lg mx-auto">
                <div className="bg-red-500/5 border border-red-500/10 rounded-lg p-4">
                  <p className="text-red-400 font-medium text-sm">❌ Random sourcing</p>
                </div>
                <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-4">
                  <p className="text-emerald-400 font-medium text-sm">✅ Structured decision-making</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Final thought */}
        <section className="py-16 bg-slate-950">
          <div className="container mx-auto px-4 max-w-3xl text-center">
            <h2 className="text-3xl font-bold text-white mb-6">🏁 Final Thought</h2>
            <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 border border-slate-700/50 rounded-2xl p-8">
              <p className="text-slate-300 text-lg mb-4">
                Most sellers don't fail because they can't find products.
              </p>
              <p className="text-slate-300 text-lg mb-4">
                They fail because they don't track what works, don't organize their sourcing, and don't build repeatable systems.
              </p>
              <p className="text-white font-semibold text-lg mb-2">
                A Product Library fixes that.
              </p>
              <p className="text-emerald-300 text-lg">
                It turns every good product into a <strong>long-term asset</strong> — not a one-time win.
              </p>
              <p className="text-slate-400 mt-4">
                You stop chasing deals. And start building a system that brings them back.
              </p>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 bg-gradient-to-br from-emerald-950 to-slate-900">
          <div className="container mx-auto px-4 max-w-3xl text-center">
            <h2 className="text-3xl font-bold text-white mb-4">Ready to Build Your Product Library?</h2>
            <p className="text-slate-300 mb-8">Start saving every product, supplier, and profit calculation — and never source from scratch again.</p>
            <Link to="/signup" className="inline-flex items-center gap-2 px-8 py-4 bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-semibold rounded-xl hover:from-emerald-500 hover:to-teal-500 transition-all shadow-lg shadow-emerald-500/25">
              Start Free Trial <ArrowRight className="w-5 h-5" />
            </Link>

            <div className="mt-12 pt-8 border-t border-slate-700/50">
              <p className="text-slate-400 text-sm mb-4">📖 More from the blog</p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link to="/blog/ai-repricer-behind-the-scenes" className="text-emerald-400 hover:text-emerald-300 transition-colors text-sm underline underline-offset-4">
                  How an AI Repricer Works →
                </Link>
                <Link to="/blog/real-ai-decisions-live-asins" className="text-emerald-400 hover:text-emerald-300 transition-colors text-sm underline underline-offset-4">
                  Real AI Decisions from Live ASINs →
                </Link>
                <Link to="/blog/what-ai-repricer-looks-at" className="text-emerald-400 hover:text-emerald-300 transition-colors text-sm underline underline-offset-4">
                  What AI Looks At Before Repricing →
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

export default BlogProductLibrary;
